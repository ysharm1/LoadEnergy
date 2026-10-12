/**
 * In-memory Repository implementation.
 *
 * A deterministic, dependency-free adapter used by the pure service-layer
 * property and unit tests. It mirrors the constraints declared in
 * `prisma/schema.prisma` so tests exercise the same invariants as production:
 *
 *   - `User.phone` unique; `User.email` unique when supplied (optional).
 *   - `Order.requestId` / `Order.offerId` unique when supplied (both null on
 *     the concierge path).
 *   - `Delivery.orderId` unique — at most one Delivery per Order.
 *   - `CommissionInvoice.orderId` unique — exactly one invoice per Order.
 *   - `AuditEntry` is append-only: no update or delete method exists.
 *   - `PilotGeofence` is a single upserted record.
 *
 * Stored records are deep-cloned on write and read so callers cannot mutate
 * internal state by holding a reference. Ids come from a monotonic counter by
 * default, keeping property-test failures reproducible.
 */

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

export type IdGenerator = () => string;

/** Deterministic, per-instance sequential ids (`rec-1`, `rec-2`, ...). */
function sequentialIdGenerator(prefix = "rec"): IdGenerator {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryRepository implements Repository {
  private readonly companies = new Map<string, Company>();
  private readonly users = new Map<string, User>();
  private readonly sites = new Map<string, Site>();
  private readonly requests = new Map<string, Request>();
  private readonly offers = new Map<string, Offer>();
  private readonly orders = new Map<string, Order>();
  private readonly deliveries = new Map<string, Delivery>();
  private readonly invoices = new Map<string, CommissionInvoice>();
  private readonly auditEntries: AuditEntry[] = [];
  private pilotGeofence: PilotGeofence | null = null;

  private readonly nextId: IdGenerator;

  constructor(idGenerator: IdGenerator = sequentialIdGenerator()) {
    this.nextId = idGenerator;
  }

  /** Drops all stored records — convenient between property-test runs. */
  reset(): void {
    this.companies.clear();
    this.users.clear();
    this.sites.clear();
    this.requests.clear();
    this.offers.clear();
    this.orders.clear();
    this.deliveries.clear();
    this.invoices.clear();
    this.auditEntries.length = 0;
    this.pilotGeofence = null;
  }

  // --- Company ---

  async createCompany(input: NewCompany): Promise<Company> {
    const record: Company = { id: this.nextId(), ...input };
    this.companies.set(record.id, clone(record));
    return clone(record);
  }

  async getCompany(id: string): Promise<Company | null> {
    const found = this.companies.get(id);
    return found ? clone(found) : null;
  }

  async listCompanies(): Promise<Company[]> {
    return [...this.companies.values()].map(clone);
  }

  async listSupplierCompanies(): Promise<Company[]> {
    return [...this.companies.values()]
      .filter((c) => c.kind === "supplier")
      .map(clone);
  }

  async updateCompany(
    id: string,
    patch: Partial<Omit<Company, "id">>
  ): Promise<Company> {
    const existing = this.companies.get(id);
    if (!existing) {
      throw new ConflictError("COMPANY_NOT_FOUND", `Company ${id} not found`);
    }
    const updated: Company = { ...existing, ...patch, id: existing.id };
    this.companies.set(id, clone(updated));
    return clone(updated);
  }

  // --- User ---

  async createUser(input: NewUser): Promise<User> {
    for (const user of this.users.values()) {
      if (user.phone === input.phone) {
        throw new ConflictError(
          "USER_PHONE_TAKEN",
          `Phone ${input.phone} already in use`
        );
      }
      // email is optional; only a supplied value participates in uniqueness.
      if (input.email !== null && user.email === input.email) {
        throw new ConflictError(
          "USER_EMAIL_TAKEN",
          `Email ${input.email} already in use`
        );
      }
    }
    const record: User = { id: this.nextId(), ...input };
    this.users.set(record.id, clone(record));
    return clone(record);
  }

  async getUser(id: string): Promise<User | null> {
    const found = this.users.get(id);
    return found ? clone(found) : null;
  }

  async getUserByPhone(phone: string): Promise<User | null> {
    for (const user of this.users.values()) {
      if (user.phone === phone) return clone(user);
    }
    return null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    for (const user of this.users.values()) {
      if (user.email !== null && user.email === email) return clone(user);
    }
    return null;
  }

  async listUsersByCompany(companyId: string): Promise<User[]> {
    return [...this.users.values()]
      .filter((u) => u.companyId === companyId)
      .map(clone);
  }

  // --- Site ---

  async createSite(input: NewSite): Promise<Site> {
    const record: Site = { id: this.nextId(), ...input };
    this.sites.set(record.id, clone(record));
    return clone(record);
  }

  async getSite(id: string): Promise<Site | null> {
    const found = this.sites.get(id);
    return found ? clone(found) : null;
  }

  async listSitesByCompany(companyId: string): Promise<Site[]> {
    return [...this.sites.values()]
      .filter((s) => s.companyId === companyId)
      .map(clone);
  }

  // --- Request ---

  async createRequest(input: NewRequest): Promise<Request> {
    const record: Request = { id: this.nextId(), ...input };
    this.requests.set(record.id, clone(record));
    return clone(record);
  }

  async getRequest(id: string): Promise<Request | null> {
    const found = this.requests.get(id);
    return found ? clone(found) : null;
  }

  async listRequestsByBuyerCompany(buyerCompanyId: string): Promise<Request[]> {
    return [...this.requests.values()]
      .filter((r) => r.buyerCompanyId === buyerCompanyId)
      .map(clone);
  }

  async listRequestsByStatus(status: RequestStatus): Promise<Request[]> {
    return [...this.requests.values()]
      .filter((r) => r.status === status)
      .map(clone);
  }

  async updateRequest(
    id: string,
    patch: Partial<Omit<Request, "id">>
  ): Promise<Request> {
    const existing = this.requests.get(id);
    if (!existing) {
      throw new ConflictError("REQUEST_NOT_FOUND", `Request ${id} not found`);
    }
    const updated: Request = { ...existing, ...patch, id: existing.id };
    this.requests.set(id, clone(updated));
    return clone(updated);
  }

  // --- Offer ---

  async createOffer(input: NewOffer): Promise<Offer> {
    const record: Offer = { id: this.nextId(), ...input };
    this.offers.set(record.id, clone(record));
    return clone(record);
  }

  async getOffer(id: string): Promise<Offer | null> {
    const found = this.offers.get(id);
    return found ? clone(found) : null;
  }

  async listOffersByRequest(requestId: string): Promise<Offer[]> {
    return [...this.offers.values()]
      .filter((o) => o.requestId === requestId)
      .map(clone);
  }

  async listOffersBySupplierCompany(
    supplierCompanyId: string
  ): Promise<Offer[]> {
    return [...this.offers.values()]
      .filter((o) => o.supplierCompanyId === supplierCompanyId)
      .map(clone);
  }

  async updateOffer(
    id: string,
    patch: Partial<Omit<Offer, "id">>
  ): Promise<Offer> {
    const existing = this.offers.get(id);
    if (!existing) {
      throw new ConflictError("OFFER_NOT_FOUND", `Offer ${id} not found`);
    }
    const updated: Offer = { ...existing, ...patch, id: existing.id };
    this.offers.set(id, clone(updated));
    return clone(updated);
  }

  // --- Order ---

  async createOrder(input: NewOrder): Promise<Order> {
    // Mirrors the unique (nullable) Order.requestId / Order.offerId columns:
    // concierge orders carry null for both and never collide.
    for (const order of this.orders.values()) {
      if (input.requestId !== null && order.requestId === input.requestId) {
        throw new ConflictError(
          "ORDER_REQUEST_TAKEN",
          `An order already exists for request ${input.requestId}`
        );
      }
      if (input.offerId !== null && order.offerId === input.offerId) {
        throw new ConflictError(
          "ORDER_OFFER_TAKEN",
          `An order already exists for offer ${input.offerId}`
        );
      }
    }
    const record: Order = { id: this.nextId(), ...input };
    this.orders.set(record.id, clone(record));
    return clone(record);
  }

  async getOrder(id: string): Promise<Order | null> {
    const found = this.orders.get(id);
    return found ? clone(found) : null;
  }

  async getOrderByRequest(requestId: string): Promise<Order | null> {
    for (const order of this.orders.values()) {
      if (order.requestId === requestId) return clone(order);
    }
    return null;
  }

  async getOrderByOffer(offerId: string): Promise<Order | null> {
    for (const order of this.orders.values()) {
      if (order.offerId === offerId) return clone(order);
    }
    return null;
  }

  async listOrdersByBuyerCompany(buyerCompanyId: string): Promise<Order[]> {
    return [...this.orders.values()]
      .filter((o) => o.buyerCompanyId === buyerCompanyId)
      .map(clone);
  }

  async listOrdersBySupplierCompany(
    supplierCompanyId: string
  ): Promise<Order[]> {
    return [...this.orders.values()]
      .filter((o) => o.supplierCompanyId === supplierCompanyId)
      .map(clone);
  }

  async updateOrder(
    id: string,
    patch: Partial<Omit<Order, "id">>
  ): Promise<Order> {
    const existing = this.orders.get(id);
    if (!existing) {
      throw new ConflictError("ORDER_NOT_FOUND", `Order ${id} not found`);
    }
    const updated: Order = { ...existing, ...patch, id: existing.id };
    this.orders.set(id, clone(updated));
    return clone(updated);
  }

  // --- Delivery ---

  async createDelivery(input: NewDelivery): Promise<Delivery> {
    // Mirrors the unique constraint on Delivery.orderId.
    for (const delivery of this.deliveries.values()) {
      if (delivery.orderId === input.orderId) {
        throw new ConflictError(
          "DELIVERY_EXISTS",
          `A delivery already exists for order ${input.orderId}`
        );
      }
    }
    const record: Delivery = { id: this.nextId(), ...input };
    this.deliveries.set(record.id, clone(record));
    return clone(record);
  }

  async getDelivery(id: string): Promise<Delivery | null> {
    const found = this.deliveries.get(id);
    return found ? clone(found) : null;
  }

  async getDeliveryByOrder(orderId: string): Promise<Delivery | null> {
    for (const delivery of this.deliveries.values()) {
      if (delivery.orderId === orderId) return clone(delivery);
    }
    return null;
  }

  // --- CommissionInvoice ---

  async createCommissionInvoice(
    input: NewCommissionInvoice
  ): Promise<CommissionInvoice> {
    // Mirrors the unique constraint on CommissionInvoice.orderId.
    for (const invoice of this.invoices.values()) {
      if (invoice.orderId === input.orderId) {
        throw new ConflictError(
          "INVOICE_EXISTS",
          `A commission invoice already exists for order ${input.orderId}`
        );
      }
    }
    const record: CommissionInvoice = { id: this.nextId(), ...input };
    this.invoices.set(record.id, clone(record));
    return clone(record);
  }

  async getCommissionInvoice(id: string): Promise<CommissionInvoice | null> {
    const found = this.invoices.get(id);
    return found ? clone(found) : null;
  }

  async getCommissionInvoiceByOrder(
    orderId: string
  ): Promise<CommissionInvoice | null> {
    for (const invoice of this.invoices.values()) {
      if (invoice.orderId === orderId) return clone(invoice);
    }
    return null;
  }

  async listCommissionInvoices(): Promise<CommissionInvoice[]> {
    return [...this.invoices.values()].map(clone);
  }

  async listCommissionInvoicesBySupplier(
    supplierCompanyId: string
  ): Promise<CommissionInvoice[]> {
    return [...this.invoices.values()]
      .filter((i) => i.supplierCompanyId === supplierCompanyId)
      .map(clone);
  }

  async updateCommissionInvoice(
    id: string,
    patch: Partial<Omit<CommissionInvoice, "id">>
  ): Promise<CommissionInvoice> {
    const existing = this.invoices.get(id);
    if (!existing) {
      throw new ConflictError("INVOICE_NOT_FOUND", `Invoice ${id} not found`);
    }
    const updated: CommissionInvoice = {
      ...existing,
      ...patch,
      id: existing.id,
    };
    this.invoices.set(id, clone(updated));
    return clone(updated);
  }

  async countDeliveredOrdersBySupplier(
    supplierCompanyId: string
  ): Promise<number> {
    let count = 0;
    for (const order of this.orders.values()) {
      if (
        order.supplierCompanyId === supplierCompanyId &&
        order.status === "delivered"
      ) {
        count += 1;
      }
    }
    return count;
  }

  // --- AuditEntry (append-only: insert and read only) ---

  async appendAuditEntry(input: NewAuditEntry): Promise<AuditEntry> {
    const record: AuditEntry = { id: this.nextId(), ...input };
    this.auditEntries.push(clone(record));
    return clone(record);
  }

  async listAuditEntries(): Promise<AuditEntry[]> {
    return this.auditEntries.map(clone);
  }

  async listAuditEntriesBySubject(subjectId: string): Promise<AuditEntry[]> {
    return this.auditEntries
      .filter((e) => e.subjectId === subjectId)
      .map(clone);
  }

  async countAuditEntries(): Promise<number> {
    return this.auditEntries.length;
  }

  // --- PilotGeofence ---

  async getPilotGeofence(): Promise<PilotGeofence | null> {
    return this.pilotGeofence ? clone(this.pilotGeofence) : null;
  }

  async setPilotGeofence(input: NewPilotGeofence): Promise<PilotGeofence> {
    const record: PilotGeofence = {
      id: this.pilotGeofence?.id ?? this.nextId(),
      ...input,
    };
    this.pilotGeofence = clone(record);
    return clone(record);
  }
}
