/**
 * Audit service — the append-only record of who did what to which load.
 *
 * Requirements:
 *  14.1 a submitted Offer appends an entry recording the acting User, the
 *       Supplier Company, the Request, and the timestamp.
 *  14.2 an accepted Offer appends an entry recording the acting User, the
 *       accepted Offer, the Order, and the timestamp.
 *  14.3 a cancelled or expired Request appends an entry recording the acting
 *       User where any, the Request, the prior and new Request_Status, and the
 *       timestamp.
 *  14.4 an Order_Status change appends an entry recording the acting User, the
 *       Order, the prior status, the new status, and the timestamp.
 *  14.5 a Concierge_Order appends an entry recording the acting Admin, the
 *       Order, and the timestamp.
 *  14.6 an invoice marked Paid appends an entry recording the acting Admin, the
 *       Commission_Invoice, the prior and new Payment_Status, and the timestamp.
 *  14.7 the log is append-only: existing entries are preserved when new ones
 *       are added.
 *
 * ## Append-only by construction, not by convention
 *
 * The service's repository port is a `Pick` of exactly four methods — one
 * insert and three reads. There is no update or delete method to call, on this
 * port or on `Repository` itself, and `prisma/schema.prisma` declares the same
 * surface. So "append-only" is not a rule this code chooses to follow; it is
 * the only thing the type system lets it do (Requirement 14.7).
 *
 * ## Shape
 *
 * House style: pure normalisation at the top, a class over an injected port
 * with a caller-supplied `now` below. No `AuthContext` and no `requireAction`
 * here on purpose — the acting user is passed in as data because the audit row
 * is the marketplace's own bookkeeping written *after* a caller has already
 * been authorized for the action it describes. `actorUserId` is nullable for
 * exactly one reason: system-driven window-end expiry has no acting User
 * (Requirement 14.3, "where any").
 *
 * Each audited action gets its own named method rather than callers assembling
 * payloads inline, so the prior/new value keys (`priorStatus` / `newStatus`)
 * are identical across every state change and a reader of the log does not have
 * to know which service wrote the row.
 */

import { ValidationError } from "@/domain/errors";
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditEntry,
  type CommissionInvoice,
  type Delivery,
  type Offer,
  type Order,
  type OrderStatus,
  type PaymentStatus,
  type Request,
  type RequestStatus,
} from "@/domain/types";
import type { Repository } from "@/repository/repository";

// ---------------------------------------------------------------------------
// The port: insert and read only (Requirement 14.7)
// ---------------------------------------------------------------------------

/**
 * The only persistence this service can reach. Deliberately narrower than
 * `Repository`: no update, no delete, nothing but append and read.
 */
export type AuditRepository = Pick<
  Repository,
  | "appendAuditEntry"
  | "listAuditEntries"
  | "listAuditEntriesBySubject"
  | "countAuditEntries"
>;

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

/** What a caller supplies for one audited action. */
export interface AuditAppendInput {
  action: AuditAction;
  /** Null for system-driven actions (window-end expiry). */
  actorUserId?: string | null;
  /** The entity the entry is about; the log is indexed by this. */
  subjectId: string;
  /** Entity ids and prior/new values where relevant. */
  payload?: Record<string, unknown> | null;
}

/** Rejects anything outside the AuditAction union. */
export function requireAuditAction(
  value: unknown,
  field = "action"
): AuditAction {
  if (
    typeof value !== "string" ||
    !AUDIT_ACTIONS.includes(value as AuditAction)
  ) {
    throw new ValidationError(
      "AUDIT_ACTION_INVALID",
      `Audit action must be one of: ${AUDIT_ACTIONS.join(", ")}`,
      field
    );
  }
  return value as AuditAction;
}

/**
 * The subject id is how a dispute is ever answered — an entry about nothing is
 * worse than no entry, so a blank one is a validation error rather than a row.
 */
export function requireAuditSubjectId(
  value: unknown,
  field = "subjectId"
): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (id === "") {
    throw new ValidationError(
      "AUDIT_SUBJECT_REQUIRED",
      "An audit entry must name the entity it is about",
      field
    );
  }
  return id;
}

/**
 * Normalizes the acting User. Absent and blank both become null, which is the
 * honest reading of "where any" (Requirement 14.3): the system acted.
 */
export function normalizeActorUserId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Drops `undefined` values so an absent field is absent, not `undefined`. */
export function normalizeAuditPayload(
  payload: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (payload == null) return null;
  const entries = Object.entries(payload).filter(([, v]) => v !== undefined);
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AuditServiceDeps {
  repo: AuditRepository;
}

export class AuditService {
  private readonly repo: AuditRepository;

  constructor(deps: AuditServiceDeps) {
    this.repo = deps.repo;
  }

  /**
   * Appends one entry (Requirement 14.7). The only write this service has.
   *
   * `now` is the caller's clock, copied into the row, so the timestamp every
   * requirement in 14.x asks for is deterministic in tests and consistent with
   * the state change the entry describes.
   */
  async append(
    input: AuditAppendInput,
    now: Date = new Date()
  ): Promise<AuditEntry> {
    const action = requireAuditAction(input?.action);
    const subjectId = requireAuditSubjectId(input?.subjectId);

    return this.repo.appendAuditEntry({
      actorUserId: normalizeActorUserId(input?.actorUserId),
      action,
      subjectId,
      payload: normalizeAuditPayload(input?.payload),
      createdAt: new Date(now.getTime()),
    });
  }

  /** The whole log, oldest first. */
  async list(): Promise<AuditEntry[]> {
    return this.repo.listAuditEntries();
  }

  /** Every entry about one entity, oldest first — the dispute view. */
  async listBySubject(subjectId: string): Promise<AuditEntry[]> {
    const id = typeof subjectId === "string" ? subjectId.trim() : "";
    return id === "" ? [] : this.repo.listAuditEntriesBySubject(id);
  }

  /** Entry count; only ever increases (Requirement 14.7). */
  async count(): Promise<number> {
    return this.repo.countAuditEntries();
  }

  // -------------------------------------------------------------------------
  // Named actions — one per audited event, so payload keys never drift
  // -------------------------------------------------------------------------

  /** Requirement 14.1: a Supplier submitted an Offer. */
  async offerSubmitted(
    actorUserId: string | null,
    offer: Pick<Offer, "id" | "requestId" | "supplierCompanyId">,
    request: Pick<Request, "buyerCompanyId">,
    now: Date = new Date()
  ): Promise<AuditEntry> {
    return this.append(
      {
        action: "OFFER_SUBMITTED",
        actorUserId,
        subjectId: offer.id,
        payload: {
          offerId: offer.id,
          requestId: offer.requestId,
          supplierCompanyId: offer.supplierCompanyId,
          buyerCompanyId: request.buyerCompanyId,
        },
      },
      now
    );
  }

  /**
   * Requirement 14.2: a Buyer accepted an Offer. Subject is the Order — the
   * thing that now exists — with the winning Offer and the Request in the
   * payload.
   */
  async offerAccepted(
    actorUserId: string | null,
    order: Pick<
      Order,
      "id" | "requestId" | "offerId" | "buyerCompanyId" | "supplierCompanyId"
    >,
    now: Date = new Date()
  ): Promise<AuditEntry> {
    return this.append(
      {
        action: "OFFER_ACCEPTED",
        actorUserId,
        subjectId: order.id,
        payload: {
          orderId: order.id,
          offerId: order.offerId,
          requestId: order.requestId,
          buyerCompanyId: order.buyerCompanyId,
          supplierCompanyId: order.supplierCompanyId,
        },
      },
      now
    );
  }

  /** Requirement 14.3: the owning Buyer cancelled a Request. */
  async requestCancelled(
    actorUserId: string | null,
    request: Pick<Request, "id" | "buyerCompanyId">,
    priorStatus: RequestStatus,
    newStatus: RequestStatus,
    now: Date = new Date()
  ): Promise<AuditEntry> {
    return this.requestStatusChange(
      "REQUEST_CANCELLED",
      actorUserId,
      request,
      priorStatus,
      newStatus,
      now
    );
  }

  /**
   * Requirement 14.3: a Request's Delivery_Window ended while it was still
   * Open. System-driven, so `actorUserId` is null — nobody decided this, the
   * clock did.
   */
  async requestExpired(
    request: Pick<Request, "id" | "buyerCompanyId">,
    priorStatus: RequestStatus,
    newStatus: RequestStatus,
    now: Date = new Date()
  ): Promise<AuditEntry> {
    return this.requestStatusChange(
      "REQUEST_EXPIRED",
      null,
      request,
      priorStatus,
      newStatus,
      now
    );
  }

  private async requestStatusChange(
    action: Extract<AuditAction, "REQUEST_CANCELLED" | "REQUEST_EXPIRED">,
    actorUserId: string | null,
    request: Pick<Request, "id" | "buyerCompanyId">,
    priorStatus: RequestStatus,
    newStatus: RequestStatus,
    now: Date
  ): Promise<AuditEntry> {
    return this.append(
      {
        action,
        actorUserId,
        subjectId: request.id,
        payload: {
          requestId: request.id,
          buyerCompanyId: request.buyerCompanyId,
          priorStatus,
          newStatus,
        },
      },
      now
    );
  }

  /** Requirement 14.4: an Order_Status moved. */
  async orderStatusChanged(
    actorUserId: string | null,
    order: Pick<Order, "id" | "buyerCompanyId" | "supplierCompanyId">,
    priorStatus: OrderStatus,
    newStatus: OrderStatus,
    extra: Record<string, unknown> = {},
    now: Date = new Date()
  ): Promise<AuditEntry> {
    return this.append(
      {
        action: "STATUS_CHANGED",
        actorUserId,
        subjectId: order.id,
        payload: {
          orderId: order.id,
          buyerCompanyId: order.buyerCompanyId,
          supplierCompanyId: order.supplierCompanyId,
          priorStatus,
          newStatus,
          ...extra,
        },
      },
      now
    );
  }

  /** Requirements 14.5, 17.4: an Admin entered an off-app deal. */
  async conciergeCreated(
    actorUserId: string | null,
    order: Pick<Order, "id" | "buyerCompanyId" | "supplierCompanyId" | "status">,
    delivery: Pick<Delivery, "id" | "bolGallons" | "ticketNumber">,
    invoice: Pick<CommissionInvoice, "id" | "amount" | "waived"> | null,
    now: Date = new Date()
  ): Promise<AuditEntry> {
    return this.append(
      {
        action: "CONCIERGE_CREATED",
        actorUserId,
        subjectId: order.id,
        payload: {
          orderId: order.id,
          buyerCompanyId: order.buyerCompanyId,
          supplierCompanyId: order.supplierCompanyId,
          status: order.status,
          deliveryId: delivery.id,
          bolGallons: delivery.bolGallons,
          ticketNumber: delivery.ticketNumber,
          invoiceId: invoice?.id ?? null,
          invoiceAmount: invoice?.amount ?? null,
          invoiceWaived: invoice?.waived ?? null,
        },
      },
      now
    );
  }

  /** Requirement 14.6: an Admin marked a Commission_Invoice Paid. */
  async invoicePaid(
    actorUserId: string | null,
    invoice: Pick<
      CommissionInvoice,
      "id" | "orderId" | "supplierCompanyId" | "amount"
    >,
    priorStatus: PaymentStatus,
    newStatus: PaymentStatus,
    now: Date = new Date()
  ): Promise<AuditEntry> {
    return this.append(
      {
        action: "INVOICE_PAID",
        actorUserId,
        subjectId: invoice.id,
        payload: {
          invoiceId: invoice.id,
          orderId: invoice.orderId,
          supplierCompanyId: invoice.supplierCompanyId,
          amount: invoice.amount,
          priorStatus,
          newStatus,
        },
      },
      now
    );
  }
}
