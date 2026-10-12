/**
 * Prisma/PostgreSQL Repository implementation.
 *
 * The durable sibling of `InMemoryRepository`. Both adapters implement the
 * same `Repository` port and are held to the same behavioural contract by
 * `describeRepositoryContract` (see `repository-contract.ts`), which runs the
 * identical suite against each so they cannot drift.
 *
 * This file is a persistence adapter and nothing more: no validation, no
 * derived values, no business rules. It does exactly three things.
 *
 * ## 1. Translates database errors into the domain taxonomy
 *
 * The in-memory adapter hand-checks the unique constraints declared in
 * `prisma/schema.prisma` and raises a specific `ConflictError` code for each.
 * Postgres enforces the same constraints for real and Prisma reports the
 * violation as `P2002`, so every write that can collide maps `P2002` back to
 * the same code its in-memory counterpart raises:
 *
 *   User.phone                 -> USER_PHONE_TAKEN
 *   User.email                 -> USER_EMAIL_TAKEN
 *   Order.requestId            -> ORDER_REQUEST_TAKEN
 *   Order.offerId              -> ORDER_OFFER_TAKEN
 *   Delivery.orderId           -> DELIVERY_EXISTS
 *   CommissionInvoice.orderId  -> INVOICE_EXISTS
 *
 * Likewise `update*` on a row that is gone reports `P2025`, which maps to the
 * `*_NOT_FOUND` conflict the in-memory adapter throws. Reads return `null`
 * for a missing row and never throw — the same null-vs-throw split.
 *
 * ## 2. Converts at the type boundary
 *
 * `Offer.landedPricePerGal` is `Decimal(10,4)` and `CommissionInvoice.amount`
 * is `Decimal(12,4)`; Prisma hands those back as `Decimal` objects. They are
 * converted to plain JS numbers on read so the service layer keeps seeing the
 * `number` its domain types declare. Note the asymmetry this creates with the
 * in-memory adapter: Postgres quantises to four decimal places, so a price of
 * `3.14159` reads back as `3.1416`. Every price the service layer produces is
 * already money-shaped (cents, or tenths of a cent), so the pilot never sees
 * it, but it is the one place a value does not round-trip byte-for-byte.
 *
 * `AuditEntry.payload` is a nullable `Json` column, which Prisma distinguishes
 * from a JSON `null` literal: writes use `Prisma.DbNull` so a null payload is
 * a SQL NULL and reads back as `null`.
 *
 * ## 3. Imposes a deterministic read order
 *
 * The in-memory adapter returns records in insertion order, which for an
 * append-only store is creation order. Row order out of Postgres is otherwise
 * undefined, so every list method orders by `createdAt` ascending with `id` as
 * a tiebreaker. Services that need a display order (newest-first inboxes, most
 * owed first) still sort for themselves; this only guarantees the two adapters
 * agree.
 *
 * ## What the adapters do *not* share
 *
 * Foreign keys. Postgres rejects an Order that points at a company that does
 * not exist (`P2003`); the in-memory maps happily store it. That error is left
 * unmapped and propagates as-is, because it signals a bug in the caller rather
 * than a condition the service layer is meant to handle.
 *
 * The audit log keeps its append-only surface: this class exposes insert and
 * read only, with no update or delete path for `AuditEntry` (Requirement
 * 14.7).
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { ConflictError } from "@/domain/errors";
import type {
  AuditEntry,
  CommissionInvoice,
  Company,
  Delivery,
  NewAuditEntry,
  NewCommissionInvoice,
  NewCompany,
  NewDelivery,
  NewOffer,
  NewOrder,
  NewPilotGeofence,
  NewRequest,
  NewSite,
  NewUser,
  Offer,
  Order,
  PilotGeofence,
  Request,
  RequestStatus,
  Site,
  User,
} from "@/domain/types";
import type { Repository } from "./repository";

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/** A unique-constraint violation mapped to the code the port promises. */
interface UniqueConflict {
  /** Column name, matched against whatever Prisma reports as the target. */
  field: string;
  code: string;
  message: string;
}

interface ConflictMapping {
  /** P2002 — candidates are tried in order. */
  unique?: readonly UniqueConflict[];
  /** P2025 — the updated row does not exist. */
  notFound?: { code: string; message: string };
}

const UNIQUE_VIOLATION = "P2002";
const RECORD_NOT_FOUND = "P2025";

/**
 * Prisma reports `meta.target` as the column list on some connectors and the
 * constraint name (`User_phone_key`) on others; both are flattened to one
 * lowercase haystack so a column-name match works either way.
 */
function violationTarget(error: unknown): string {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return "";
  const target = error.meta?.target;
  if (typeof target === "string") return target.toLowerCase();
  if (Array.isArray(target)) return target.join(",").toLowerCase();
  return "";
}

function prismaErrorCode(error: unknown): string | null {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? error.code
    : null;
}

/**
 * Runs a write and rewrites the constraint failures the port specifies into
 * their `ConflictError` equivalents. Anything unrecognised propagates
 * untouched — a connection failure is not a domain conflict.
 */
async function mapConflicts<T>(
  mapping: ConflictMapping,
  write: () => Promise<T>
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const code = prismaErrorCode(error);

    if (code === UNIQUE_VIOLATION && mapping.unique?.length) {
      const target = violationTarget(error);
      const hit =
        mapping.unique.find((c) => target.includes(c.field.toLowerCase())) ??
        // With a single candidate the constraint is unambiguous even when the
        // connector declines to name it.
        (mapping.unique.length === 1 ? mapping.unique[0] : undefined);
      if (hit) throw new ConflictError(hit.code, hit.message);
    }

    if (code === RECORD_NOT_FOUND && mapping.notFound) {
      throw new ConflictError(
        mapping.notFound.code,
        mapping.notFound.message
      );
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Row -> domain mapping
// ---------------------------------------------------------------------------

/** Ascending creation order, `id` breaking ties. */
const BY_CREATION = [
  { createdAt: "asc" as const },
  { id: "asc" as const },
];

function toNumber(value: Prisma.Decimal): number {
  return value.toNumber();
}

function toOffer(row: {
  id: string;
  requestId: string;
  supplierCompanyId: string;
  createdByUserId: string;
  landedPricePerGal: Prisma.Decimal;
  holdHours: number;
  etaMinutes: number | null;
  createdAt: Date;
  expiresAt: Date;
  voided: boolean;
  status: Offer["status"];
}): Offer {
  return { ...row, landedPricePerGal: toNumber(row.landedPricePerGal) };
}

function toInvoice(row: {
  id: string;
  orderId: string;
  supplierCompanyId: string;
  bolGallons: number;
  amount: Prisma.Decimal;
  waived: boolean;
  paymentStatus: CommissionInvoice["paymentStatus"];
  paidByAdminId: string | null;
  paidAt: Date | null;
  createdAt: Date;
}): CommissionInvoice {
  return { ...row, amount: toNumber(row.amount) };
}

function toAuditEntry(row: {
  id: string;
  actorUserId: string | null;
  action: AuditEntry["action"];
  subjectId: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
}): AuditEntry {
  return {
    ...row,
    payload:
      row.payload === null
        ? null
        : (row.payload as Record<string, unknown>),
  };
}

function toJsonInput(
  payload: Record<string, unknown> | null
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  return payload === null ? Prisma.DbNull : (payload as Prisma.InputJsonValue);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PrismaRepository implements Repository {
  constructor(private readonly prisma: PrismaClient) {}

  // --- Company ---

  async createCompany(input: NewCompany): Promise<Company> {
    return this.prisma.company.create({ data: input });
  }

  async getCompany(id: string): Promise<Company | null> {
    return this.prisma.company.findUnique({ where: { id } });
  }

  async listCompanies(): Promise<Company[]> {
    return this.prisma.company.findMany({ orderBy: BY_CREATION });
  }

  async listSupplierCompanies(): Promise<Company[]> {
    return this.prisma.company.findMany({
      where: { kind: "supplier" },
      orderBy: BY_CREATION,
    });
  }

  async updateCompany(
    id: string,
    patch: Partial<Omit<Company, "id">>
  ): Promise<Company> {
    return mapConflicts(
      {
        notFound: {
          code: "COMPANY_NOT_FOUND",
          message: `Company ${id} not found`,
        },
      },
      () => this.prisma.company.update({ where: { id }, data: patch })
    );
  }

  // --- User ---

  async createUser(input: NewUser): Promise<User> {
    return mapConflicts(
      {
        unique: [
          {
            field: "phone",
            code: "USER_PHONE_TAKEN",
            message: `Phone ${input.phone} already in use`,
          },
          {
            field: "email",
            code: "USER_EMAIL_TAKEN",
            message: `Email ${input.email} already in use`,
          },
        ],
      },
      () => this.prisma.user.create({ data: input })
    );
  }

  async getUser(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async getUserByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async listUsersByCompany(companyId: string): Promise<User[]> {
    return this.prisma.user.findMany({
      where: { companyId },
      orderBy: BY_CREATION,
    });
  }

  // --- Site ---

  async createSite(input: NewSite): Promise<Site> {
    return this.prisma.site.create({ data: input });
  }

  async getSite(id: string): Promise<Site | null> {
    return this.prisma.site.findUnique({ where: { id } });
  }

  async listSitesByCompany(companyId: string): Promise<Site[]> {
    return this.prisma.site.findMany({
      where: { companyId },
      orderBy: BY_CREATION,
    });
  }

  // --- Request ---

  async createRequest(input: NewRequest): Promise<Request> {
    return this.prisma.request.create({ data: input });
  }

  async getRequest(id: string): Promise<Request | null> {
    return this.prisma.request.findUnique({ where: { id } });
  }

  async listRequestsByBuyerCompany(buyerCompanyId: string): Promise<Request[]> {
    return this.prisma.request.findMany({
      where: { buyerCompanyId },
      orderBy: BY_CREATION,
    });
  }

  async listRequestsByStatus(status: RequestStatus): Promise<Request[]> {
    return this.prisma.request.findMany({
      where: { status },
      orderBy: BY_CREATION,
    });
  }

  async updateRequest(
    id: string,
    patch: Partial<Omit<Request, "id">>
  ): Promise<Request> {
    return mapConflicts(
      {
        notFound: {
          code: "REQUEST_NOT_FOUND",
          message: `Request ${id} not found`,
        },
      },
      () => this.prisma.request.update({ where: { id }, data: patch })
    );
  }

  // --- Offer ---

  async createOffer(input: NewOffer): Promise<Offer> {
    return toOffer(await this.prisma.offer.create({ data: input }));
  }

  async getOffer(id: string): Promise<Offer | null> {
    const row = await this.prisma.offer.findUnique({ where: { id } });
    return row ? toOffer(row) : null;
  }

  async listOffersByRequest(requestId: string): Promise<Offer[]> {
    const rows = await this.prisma.offer.findMany({
      where: { requestId },
      orderBy: BY_CREATION,
    });
    return rows.map(toOffer);
  }

  async listOffersBySupplierCompany(
    supplierCompanyId: string
  ): Promise<Offer[]> {
    const rows = await this.prisma.offer.findMany({
      where: { supplierCompanyId },
      orderBy: BY_CREATION,
    });
    return rows.map(toOffer);
  }

  async updateOffer(
    id: string,
    patch: Partial<Omit<Offer, "id">>
  ): Promise<Offer> {
    const row = await mapConflicts(
      {
        notFound: { code: "OFFER_NOT_FOUND", message: `Offer ${id} not found` },
      },
      () => this.prisma.offer.update({ where: { id }, data: patch })
    );
    return toOffer(row);
  }

  // --- Order ---

  async createOrder(input: NewOrder): Promise<Order> {
    return mapConflicts(
      {
        unique: [
          {
            field: "requestId",
            code: "ORDER_REQUEST_TAKEN",
            message: `An order already exists for request ${input.requestId}`,
          },
          {
            field: "offerId",
            code: "ORDER_OFFER_TAKEN",
            message: `An order already exists for offer ${input.offerId}`,
          },
        ],
      },
      () => this.prisma.order.create({ data: input })
    );
  }

  async getOrder(id: string): Promise<Order | null> {
    return this.prisma.order.findUnique({ where: { id } });
  }

  async getOrderByRequest(requestId: string): Promise<Order | null> {
    return this.prisma.order.findUnique({ where: { requestId } });
  }

  async getOrderByOffer(offerId: string): Promise<Order | null> {
    return this.prisma.order.findUnique({ where: { offerId } });
  }

  async listOrdersByBuyerCompany(buyerCompanyId: string): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { buyerCompanyId },
      orderBy: BY_CREATION,
    });
  }

  async listOrdersBySupplierCompany(
    supplierCompanyId: string
  ): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { supplierCompanyId },
      orderBy: BY_CREATION,
    });
  }

  async updateOrder(
    id: string,
    patch: Partial<Omit<Order, "id">>
  ): Promise<Order> {
    return mapConflicts(
      {
        unique: [
          {
            field: "requestId",
            code: "ORDER_REQUEST_TAKEN",
            message: `An order already exists for request ${patch.requestId}`,
          },
          {
            field: "offerId",
            code: "ORDER_OFFER_TAKEN",
            message: `An order already exists for offer ${patch.offerId}`,
          },
        ],
        notFound: { code: "ORDER_NOT_FOUND", message: `Order ${id} not found` },
      },
      () => this.prisma.order.update({ where: { id }, data: patch })
    );
  }

  // --- Delivery ---

  async createDelivery(input: NewDelivery): Promise<Delivery> {
    return mapConflicts(
      {
        unique: [
          {
            field: "orderId",
            code: "DELIVERY_EXISTS",
            message: `A delivery already exists for order ${input.orderId}`,
          },
        ],
      },
      () => this.prisma.delivery.create({ data: input })
    );
  }

  async getDelivery(id: string): Promise<Delivery | null> {
    return this.prisma.delivery.findUnique({ where: { id } });
  }

  async getDeliveryByOrder(orderId: string): Promise<Delivery | null> {
    return this.prisma.delivery.findUnique({ where: { orderId } });
  }

  // --- CommissionInvoice ---

  async createCommissionInvoice(
    input: NewCommissionInvoice
  ): Promise<CommissionInvoice> {
    const row = await mapConflicts(
      {
        unique: [
          {
            field: "orderId",
            code: "INVOICE_EXISTS",
            message: `A commission invoice already exists for order ${input.orderId}`,
          },
        ],
      },
      () => this.prisma.commissionInvoice.create({ data: input })
    );
    return toInvoice(row);
  }

  async getCommissionInvoice(id: string): Promise<CommissionInvoice | null> {
    const row = await this.prisma.commissionInvoice.findUnique({
      where: { id },
    });
    return row ? toInvoice(row) : null;
  }

  async getCommissionInvoiceByOrder(
    orderId: string
  ): Promise<CommissionInvoice | null> {
    const row = await this.prisma.commissionInvoice.findUnique({
      where: { orderId },
    });
    return row ? toInvoice(row) : null;
  }

  async listCommissionInvoices(): Promise<CommissionInvoice[]> {
    const rows = await this.prisma.commissionInvoice.findMany({
      orderBy: BY_CREATION,
    });
    return rows.map(toInvoice);
  }

  async listCommissionInvoicesBySupplier(
    supplierCompanyId: string
  ): Promise<CommissionInvoice[]> {
    const rows = await this.prisma.commissionInvoice.findMany({
      where: { supplierCompanyId },
      orderBy: BY_CREATION,
    });
    return rows.map(toInvoice);
  }

  async updateCommissionInvoice(
    id: string,
    patch: Partial<Omit<CommissionInvoice, "id">>
  ): Promise<CommissionInvoice> {
    const row = await mapConflicts(
      {
        unique: [
          {
            field: "orderId",
            code: "INVOICE_EXISTS",
            message: `A commission invoice already exists for order ${patch.orderId}`,
          },
        ],
        notFound: {
          code: "INVOICE_NOT_FOUND",
          message: `Invoice ${id} not found`,
        },
      },
      () => this.prisma.commissionInvoice.update({ where: { id }, data: patch })
    );
    return toInvoice(row);
  }

  async countDeliveredOrdersBySupplier(
    supplierCompanyId: string
  ): Promise<number> {
    return this.prisma.order.count({
      where: { supplierCompanyId, status: "delivered" },
    });
  }

  // --- AuditEntry (append-only: insert and read only) ---

  async appendAuditEntry(input: NewAuditEntry): Promise<AuditEntry> {
    const row = await this.prisma.auditEntry.create({
      data: { ...input, payload: toJsonInput(input.payload) },
    });
    return toAuditEntry(row);
  }

  async listAuditEntries(): Promise<AuditEntry[]> {
    const rows = await this.prisma.auditEntry.findMany({
      orderBy: BY_CREATION,
    });
    return rows.map(toAuditEntry);
  }

  async listAuditEntriesBySubject(subjectId: string): Promise<AuditEntry[]> {
    const rows = await this.prisma.auditEntry.findMany({
      where: { subjectId },
      orderBy: BY_CREATION,
    });
    return rows.map(toAuditEntry);
  }

  async countAuditEntries(): Promise<number> {
    return this.prisma.auditEntry.count();
  }

  // --- PilotGeofence ---

  async getPilotGeofence(): Promise<PilotGeofence | null> {
    return this.prisma.pilotGeofence.findFirst({ orderBy: { id: "asc" } });
  }

  /**
   * Upserts the single geofence row. There is no natural unique key to upsert
   * on — the table holds at most one record by convention — so the existing
   * row is read first and its id preserved, matching the in-memory adapter's
   * guarantee that re-setting the geofence does not mint a new id.
   */
  async setPilotGeofence(input: NewPilotGeofence): Promise<PilotGeofence> {
    const existing = await this.prisma.pilotGeofence.findFirst({
      orderBy: { id: "asc" },
    });
    if (!existing) {
      return this.prisma.pilotGeofence.create({ data: input });
    }
    return this.prisma.pilotGeofence.update({
      where: { id: existing.id },
      data: input,
    });
  }
}
