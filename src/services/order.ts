/**
 * Order service — accepting one Offer, the forward-only Order_Status machine,
 * Delivery/BOL recording, and the Supplier's won-order list.
 *
 * Requirements:
 *   7.3 accepting an Offer whose Offer_Expiry has passed is rejected with an
 *       expiry error.
 *   8.1 accepting an active Offer on an Open Request creates an Order at
 *       Order_Status Accepted, linking the Request, the Offer, and the winning
 *       Supplier Company.
 *   8.2 acceptance sets the Request_Status to Accepted.
 *   8.3 acceptance voids every other active Offer on that Request.
 *   8.4 acceptance on a Request whose status is not Open is rejected (which is
 *       also what makes a second accept impossible).
 *   8.5 a User outside the owning Buyer Company is denied with an authorization
 *       error.
 *   8.6 an Offer owned by a Closed Supplier Company cannot be accepted.
 *   8.7 the Order is visible to the winning Supplier Company as a won order.
 *  10.1 Order_Status is one of Accepted, En_Route, or Delivered.
 *  10.2 marking a won Order en route sets Order_Status to En_Route.
 *  10.3 marking a won Order delivered sets Order_Status to Delivered.
 *  10.4 Order_Status advances only forward along Accepted -> En_Route ->
 *       Delivered, and a Delivery may be recorded directly from Accepted.
 *  10.5 a change that would move the status backward is rejected.
 *  10.6 a Buyer viewing an Order gets the current Order_Status.
 *  11.1 recording a Delivery with BOL_Gallons and a ticket number creates the
 *       Delivery against the Order and sets Order_Status to Delivered.
 *  11.2 at most one Delivery per Order.
 *  11.3 a second Delivery on the same Order is rejected.
 *  11.4 BOL_Gallons <= 0 is rejected with a validation error.
 *  11.5 a missing ticket number is rejected with a validation error.
 *  11.6 a supplied ticket photo is stored with the Delivery.
 *  11.7 anyone other than the winning Supplier Company is denied.
 *  12.1 an Order reaching Delivered generates its Commission_Invoice —
 *       delegated to `CommissionService`, the same origin-agnostic entry point
 *       the Admin concierge path uses (Requirement 17.3).
 *  13.3 the winning Supplier is notified on acceptance.
 *  13.4 the owning Buyer is notified when an Order reaches Delivered.
 *  14.2 acceptance appends an audit entry naming the acting User, the accepted
 *       Offer, and the Order.
 *  14.4 every Order_Status change appends an audit entry carrying the prior and
 *       new status.
 *  14.5 a Concierge_Order appends an audit entry naming the acting Admin.
 *  17.1 an Admin concierge entry creates an Order at Delivered with its
 *       Delivery.
 *  17.2 a concierge ticket number is stored when provided.
 *  17.3 a concierge Order is billed by the same commission rules, waived wins
 *       included.
 *  17.4 a concierge entry is audited.
 *  17.5 a non-Admin attempting a concierge entry is denied.
 *
 * Everything that creates or moves an Order lives in this one file — acceptance
 * included, rather than in `offer.ts` — so the status machine has a single
 * gatekeeper and no other service can write `Order.status` behind its back.
 *
 * ## Write ordering (the in-memory repository has no transactions)
 *
 * `acceptOffer` performs four writes. They are sequenced so that no
 * interleaving or partial failure can produce two accepted Offers or two Orders
 * on one Request:
 *
 *   1. **Claim the Request** — flip `open` -> `accepted`, guarded by a re-read
 *      that the status is still `open`. This is the exclusivity gate. A second
 *      acceptance that gets this far finds the Request no longer Open and is
 *      rejected (Requirements 8.2, 8.4), so the claim happens before anything
 *      derived from it exists.
 *   2. **Claim the winning Offer** — `active` -> `accepted`. Now exactly one
 *      Offer on the Request can ever hold that status.
 *   3. **Create the Order** — linking Request, Offer, and winning Supplier
 *      Company (Requirement 8.1). `Order.requestId` and `Order.offerId` are
 *      unique, so even if steps 1-2 were somehow raced past, the database
 *      refuses the second Order. That constraint is the backstop, not the
 *      primary guard.
 *   4. **Void the losing Offers** — every other still-active Offer on the
 *      Request (Requirement 8.3). Losers are voided last because a loser left
 *      active for a moment is harmless: the Request is no longer Open, so none
 *      of them can be accepted.
 *
 * The failure directions are deliberately asymmetric. If step 3 or 4 fails, the
 * worst state is a Request marked Accepted whose Order is missing or whose
 * losing quotes are still flagged active — visible, inert, and repairable. The
 * opposite order (Order first, claim later) would risk two Orders on one
 * Request, i.e. two suppliers both told they won the same load, which is not
 * repairable after trucks roll. A best-effort compensating rollback is
 * attempted if the Order write fails, and the original error is rethrown either
 * way.
 *
 * `recordDelivery` is sequenced on the same principle: the Delivery row is
 * written first and the Order is flipped to Delivered second. `Delivery.orderId`
 * is unique, so the insert is itself the exclusivity gate for "at most one
 * Delivery per Order" (Requirement 11.2), and the worst outcome of a failure
 * between the two writes is a recorded Delivery on an Order still reading
 * En_Route — the gallons and the ticket are safe and the status is repairable.
 * The opposite order could mark an Order Delivered with no BOL behind it, which
 * is the one state commission invoicing must never see. The invoice is written
 * last, once the Order reads Delivered and its gallons are on file.
 */

import { ConflictError, ValidationError } from "@/domain/errors";
import {
  ORDER_STATUSES,
  ORDER_STATUS_SEQUENCE,
  type AuthContext,
  type CommissionInvoice,
  type Company,
  type Delivery,
  type Offer,
  type Order,
  type OrderStatus,
  type Request,
} from "@/domain/types";
import type { Repository } from "@/repository/repository";
import type { AuditService } from "./audit";
import { requireAction, requireOrderParty } from "./authorization";
import type { CommissionService } from "./commission";
import {
  acceptedMessage,
  deliveredMessage,
  recipientFromUser,
} from "./notifications";
import type { NotificationDispatcher, Recipient } from "./notifications";
import { isActive, isExpired, voidActiveOffersOnRequest } from "./offer";
import { requireGallons } from "./request";

// ---------------------------------------------------------------------------
// The status sequence (Requirements 10.1, 10.4, 10.5)
// ---------------------------------------------------------------------------

/**
 * Position of a status in the forward sequence, or -1 for anything that is not
 * an Order_Status at all (Requirement 10.1). Comparing ranks is the whole
 * transition rule, so there is no table of allowed pairs to keep in step with
 * the enum.
 */
export function orderStatusRank(value: unknown): number {
  return ORDER_STATUS_SEQUENCE.indexOf(value as OrderStatus);
}

/**
 * True only for a strictly forward move (Requirement 10.4). Equal statuses are
 * not forward: re-sending the status an Order already holds advances nothing,
 * and treating it as a success would let a caller believe a transition happened.
 * Backward moves are false (Requirement 10.5), as is anything unrecognised.
 */
export function isForwardTransition(from: unknown, to: unknown): boolean {
  const fromRank = orderStatusRank(from);
  const toRank = orderStatusRank(to);
  if (fromRank < 0 || toRank < 0) return false;
  return toRank > fromRank;
}

/** Rejects anything that is not one of the three statuses (Requirement 10.1). */
export function requireOrderStatus(
  value: unknown,
  field = "status"
): OrderStatus {
  if (typeof value !== "string" || orderStatusRank(value) < 0) {
    throw new ValidationError(
      "ORDER_STATUS_INVALID",
      `Order status must be one of: ${ORDER_STATUSES.join(", ")}`,
      field
    );
  }
  return value as OrderStatus;
}

// ---------------------------------------------------------------------------
// Delivery input validation (Requirements 11.4, 11.5, 11.6)
// ---------------------------------------------------------------------------

/** A BOL ticket number is a short human reference, not a document. */
export const MAX_TICKET_NUMBER_LENGTH = 64;
/** An S3 object key; generous but bounded. */
export const MAX_TICKET_PHOTO_KEY_LENGTH = 512;

/**
 * Validates BOL_Gallons (Requirement 11.4) through the same whole-number,
 * greater-than-zero check Request gallons use, because `Delivery.bolGallons` is
 * the same integer column shape and feeds the same commission arithmetic.
 */
export function requireBolGallons(
  value: unknown,
  field = "bolGallons"
): number {
  return requireGallons(value, field);
}

/**
 * Validates the ticket number (Requirement 11.5). Whitespace-only is treated as
 * missing — a ticket number is the only link back to the driver's paperwork, so
 * a blank one is worse than useless in a dispute. The trimmed value is stored.
 */
export function requireTicketNumber(
  value: unknown,
  field = "ticketNumber"
): string {
  if (typeof value !== "string") {
    throw new ValidationError(
      "TICKET_NUMBER_REQUIRED",
      "A BOL ticket number is required",
      field
    );
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new ValidationError(
      "TICKET_NUMBER_REQUIRED",
      "A BOL ticket number is required",
      field
    );
  }
  if (trimmed.length > MAX_TICKET_NUMBER_LENGTH) {
    throw new ValidationError(
      "TICKET_NUMBER_INVALID",
      `Ticket number must be at most ${MAX_TICKET_NUMBER_LENGTH} characters`,
      field
    );
  }
  return trimmed;
}

/**
 * Normalizes an *optional* ticket number, which is the Admin concierge case
 * (Requirement 17.2) and only that case.
 *
 * A Supplier recording a Delivery must supply one (Requirement 11.5,
 * `requireTicketNumber`); an Admin writing down a deal that happened over the
 * phone may genuinely not have the paperwork, and inventing a placeholder
 * ticket number would put a fiction in the one field a dispute is settled from.
 * So absent and blank both become null, and a supplied value is trimmed and
 * bounded exactly as on the supplier path.
 */
export function normalizeOptionalTicketNumber(
  value: unknown,
  field = "ticketNumber"
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(
      "TICKET_NUMBER_INVALID",
      "Ticket number must be text",
      field
    );
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_TICKET_NUMBER_LENGTH) {
    throw new ValidationError(
      "TICKET_NUMBER_INVALID",
      `Ticket number must be at most ${MAX_TICKET_NUMBER_LENGTH} characters`,
      field
    );
  }
  return trimmed;
}

/**
 * Normalizes the optional ticket photo key (Requirement 11.6). Absent stays
 * absent; a blank string becomes null rather than an empty key that would look
 * like a stored photo pointing at nothing.
 */
export function normalizeOptionalTicketPhotoKey(
  value: unknown,
  field = "ticketPhotoKey"
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(
      "TICKET_PHOTO_KEY_INVALID",
      "Ticket photo key must be text",
      field
    );
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_TICKET_PHOTO_KEY_LENGTH) {
    throw new ValidationError(
      "TICKET_PHOTO_KEY_INVALID",
      `Ticket photo key must be at most ${MAX_TICKET_PHOTO_KEY_LENGTH} characters`,
      field
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Read projection (Requirement 10.6)
// ---------------------------------------------------------------------------

/** What a party to an Order sees when they read it (Requirement 10.6). */
export interface OrderView {
  orderId: string;
  /** Null on the concierge path. */
  requestId: string | null;
  /** Null on the concierge path. */
  offerId: string | null;
  buyerCompanyId: string;
  supplierCompanyId: string;
  /** The status produced by the last valid forward transition. */
  status: OrderStatus;
  isConcierge: boolean;
  createdAt: Date;
  /** Present once a Delivery has been recorded; null before that. */
  delivery: {
    deliveryId: string;
    bolGallons: number;
    /** Null only on a concierge entry with no ticket (Requirement 17.2). */
    ticketNumber: string | null;
    ticketPhotoKey: string | null;
    deliveredAt: Date;
  } | null;
}

/** Pure projection, so a read is a function of the stored rows alone. */
export function toOrderView(
  order: Order,
  delivery: Delivery | null
): OrderView {
  return {
    orderId: order.id,
    requestId: order.requestId,
    offerId: order.offerId,
    buyerCompanyId: order.buyerCompanyId,
    supplierCompanyId: order.supplierCompanyId,
    status: order.status,
    isConcierge: order.isConcierge,
    createdAt: order.createdAt,
    delivery: delivery
      ? {
          deliveryId: delivery.id,
          bolGallons: delivery.bolGallons,
          ticketNumber: delivery.ticketNumber,
          ticketPhotoKey: delivery.ticketPhotoKey,
          deliveredAt: delivery.deliveredAt,
        }
      : null,
  };
}

/** An off-app deal an Admin is writing down (Requirements 17.1, 17.2). */
export interface ConciergeOrderInput {
  buyerCompanyId: string;
  /** The winning Supplier Company — the one that gets the invoice. */
  supplierCompanyId: string;
  /** Must be a whole number greater than zero (Requirement 17.1). */
  bolGallons: number;
  /** Optional (Requirement 17.2): a phone deal may have no ticket on file. */
  ticketNumber?: string | null;
  /** Optional, for parity with the supplier path. */
  ticketPhotoKey?: string | null;
}

export interface RecordDeliveryInput {
  /** Must be a whole number greater than zero (Requirement 11.4). */
  bolGallons: number;
  /** Required (Requirement 11.5). */
  ticketNumber: string;
  /** Optional S3 key (Requirement 11.6). */
  ticketPhotoKey?: string | null;
}

export interface OrderServiceDeps {
  repo: Repository;
  /** Carries the ACCEPTED notification (task 7.4). Optional. */
  notifier?: NotificationDispatcher;
  /**
   * Bills the Delivered load (Requirements 12.1, 12.4). Optional so the state
   * machine can be exercised on its own; wired in production so a Delivered
   * Order always produces its invoice.
   */
  commission?: CommissionService;
  /**
   * Records OFFER_ACCEPTED and every Order_Status change (Requirements 14.2,
   * 14.4). Optional, like `notifier` and `commission`; wired in production so
   * the lifecycle of a load is attributable end to end.
   */
  audit?: AuditService;
}

export class OrderService {
  private readonly repo: Repository;
  private readonly notifier?: NotificationDispatcher;
  private readonly commission?: CommissionService;
  private readonly audit?: AuditService;

  constructor(deps: OrderServiceDeps) {
    this.repo = deps.repo;
    this.notifier = deps.notifier;
    this.commission = deps.commission;
    this.audit = deps.audit;
  }

  /**
   * Accepts one Offer, producing the Order (Requirements 8.1-8.3, 8.5-8.7).
   *
   * Rejection order among the conflict cases is chosen so each cause reports its
   * own code where it can:
   *   1. expiry (`OFFER_EXPIRED`, Requirement 7.3) — checked first, because an
   *      expired hold is the answer the Buyer needs regardless of what else has
   *      since happened to the load;
   *   2. Request not Open (`REQUEST_NOT_OPEN`, Requirements 8.4 and, by
   *      consequence, the second accept);
   *   3. Offer no longer active (`OFFER_NOT_ACTIVE`) — voided by a sibling win
   *      or already accepted;
   *   4. winning Supplier Closed (`SUPPLIER_CLOSED`, Requirement 8.6).
   */
  async acceptOffer(
    ctx: AuthContext,
    offerId: string,
    now: Date = new Date()
  ): Promise<Order> {
    const id = typeof offerId === "string" ? offerId.trim() : "";
    const offer = id === "" ? null : await this.repo.getOffer(id);
    const request = offer ? await this.repo.getRequest(offer.requestId) : null;

    /**
     * Requirement 8.5. The Offer and its Request are read before the guard so
     * the ownership check has an owning company to scope against. A missing
     * Offer, an Offer on another company's Request, and an Offer whose Request
     * vanished all deny with 403 and look identical from outside, so offer ids
     * cannot be probed.
     */
    requireAction(ctx, "offer.accept", { companyId: request?.buyerCompanyId });

    const winning = offer as Offer;
    const load = request as Request;

    // 1. Requirement 7.3 — an expired hold is not acceptable.
    if (isExpired(winning, now)) {
      throw new ConflictError(
        "OFFER_EXPIRED",
        "This offer's hold has expired and can no longer be accepted"
      );
    }

    // 2. Requirements 8.4 / 8.3 (second accept) — the load must still be Open.
    if (load.status !== "open") {
      throw new ConflictError(
        "REQUEST_NOT_OPEN",
        "This load is no longer open, so no offer on it can be accepted"
      );
    }

    // 3. Voided by a sibling win, or already accepted.
    if (!isActive(winning, now)) {
      throw new ConflictError(
        "OFFER_NOT_ACTIVE",
        "This offer is no longer active and cannot be accepted"
      );
    }

    // 4. Requirement 8.6 — a Closed supplier's offer is off the table.
    const supplier = await this.requireSupplierCompany(
      winning.supplierCompanyId
    );
    if (supplier.supplierStatus === "closed") {
      throw new ConflictError(
        "SUPPLIER_CLOSED",
        "This supplier company is marked Closed, so its offer cannot be accepted"
      );
    }

    const order = await this.commitAcceptance(ctx, load, winning, supplier, now);

    // Requirement 14.2 — who accepted which quote, and the Order it produced.
    await this.auditOfferAccepted(ctx.userId, order, now);

    // Requirement 13.3, fire-and-forget — see `notifyAccepted`.
    await this.notifyAccepted(load, winning, supplier);

    return order;
  }

  /**
   * The four writes, in the order the module note justifies: claim the Request,
   * claim the Offer, create the Order, void the losers.
   */
  private async commitAcceptance(
    ctx: AuthContext,
    load: Request,
    winning: Offer,
    supplier: Company,
    now: Date
  ): Promise<Order> {
    // 1. Claim the load. Re-read first so a Request claimed between the checks
    // above and here loses the race here rather than producing a second Order.
    const current = await this.repo.getRequest(load.id);
    if (!current || current.status !== "open") {
      throw new ConflictError(
        "REQUEST_NOT_OPEN",
        "This load is no longer open, so no offer on it can be accepted"
      );
    }
    await this.repo.updateRequest(load.id, { status: "accepted" });

    // 2. Claim the winning quote.
    await this.repo.updateOffer(winning.id, {
      status: "accepted",
      voided: false,
    });

    // 3. Create the Order (Requirement 8.1). Unique requestId/offerId backstop.
    let order: Order;
    try {
      order = await this.repo.createOrder({
        requestId: load.id,
        offerId: winning.id,
        buyerCompanyId: load.buyerCompanyId,
        supplierCompanyId: supplier.id,
        status: "accepted",
        isConcierge: false,
        createdAt: new Date(now.getTime()),
      });
    } catch (error) {
      // Best effort: put the load and the quote back so the Buyer can retry.
      // Swallowed on its own failure — the original error is what matters.
      try {
        await this.repo.updateRequest(load.id, { status: "open" });
        await this.repo.updateOffer(winning.id, {
          status: "active",
          voided: false,
        });
      } catch {
        // Leave the claim in place; a claimed load with no order is inert.
      }
      throw error;
    }

    // 4. Requirement 8.3 — void every other still-active quote on the load,
    // through the same helper cancellation and expiry use (Requirements 9.1,
    // 9.3), so a voided loser looks identical however the load left Open.
    await voidActiveOffersOnRequest(this.repo, load.id, {
      exceptOfferId: winning.id,
    });

    return order;
  }

  /**
   * The winning Supplier Company's won orders (Requirements 8.5, 8.7), newest
   * first.
   *
   * `companyId` defaults to the caller's own Company; naming another Company is
   * denied by the `own_company` scope rather than filtered, so one supplier can
   * never read another's book of business.
   */
  async listWonOrders(ctx: AuthContext, companyId?: string): Promise<Order[]> {
    const target = companyId ?? ctx?.companyId;
    requireAction(ctx, "order.listWon", { companyId: target });

    const orders = await this.repo.listOrdersBySupplierCompany(
      target as string
    );
    return orders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Moves a won Order forward (Requirements 10.2, 10.4, 10.5).
   *
   * The winning Supplier Company only — the `order.advance` policy row is
   * company-scoped, so an Order id belonging to someone else, and an id that
   * does not exist, both deny with 403 and are indistinguishable from outside.
   *
   * Forward-only is decided by rank comparison (`isForwardTransition`), so
   * En_Route -> Accepted, Delivered -> En_Route, and a repeat of the status the
   * Order already holds are all refused with a conflict rather than silently
   * ignored.
   *
   * Reaching Delivered additionally requires a recorded Delivery. The status is
   * the marketplace's claim that fuel landed, and commission invoicing bills
   * from BOL gallons, so a Delivered Order with no BOL behind it is the one
   * state worth making unreachable. `recordDelivery` is the way
   * there (Requirements 10.3, 11.1); this path only re-flags an Order whose
   * Delivery is already on file.
   */
  async advanceStatus(
    ctx: AuthContext,
    orderId: string,
    next: OrderStatus,
    now: Date = new Date()
  ): Promise<Order> {
    const order = await this.requireOrderForSupplier(ctx, orderId, "order.advance");
    const target = requireOrderStatus(next, "status");

    // Requirements 10.4, 10.5.
    if (!isForwardTransition(order.status, target)) {
      throw order.status === target
        ? new ConflictError(
            "ORDER_STATUS_UNCHANGED",
            `This order is already ${target}`
          )
        : new ConflictError(
            "ORDER_STATUS_BACKWARD",
            `An order at ${order.status} cannot move back to ${target}`
          );
    }

    const delivery =
      target === "delivered"
        ? await this.repo.getDeliveryByOrder(order.id)
        : null;
    if (target === "delivered" && !delivery) {
      throw new ConflictError(
        "DELIVERY_REQUIRED",
        "Record the BOL gallons and ticket number to mark this order delivered"
      );
    }

    const updated = await this.repo.updateOrder(order.id, { status: target });

    // Requirement 14.4 — the prior and new status, with who moved it.
    await this.auditStatusChange(ctx.userId, updated, order.status, target, now);

    if (delivery) {
      // Requirements 12.1, 12.4 — see `generateCommissionInvoice`. Reaching
      // Delivered here means the Delivery was recorded first and this tap only
      // re-flagged the status, so the invoice normally already exists;
      // generation is idempotent and this is the backstop for the case where it
      // does not.
      await this.generateCommissionInvoice(updated, now);

      // Requirement 13.4, fire-and-forget — see `notifyDelivered`.
      await this.notifyDelivered(updated, delivery);
    }

    return updated;
  }

  /**
   * Records the Delivery and its BOL detail (Requirements 11.1-11.7).
   *
   * Check order: authorization (403, Requirement 11.7), then input shape (400,
   * Requirements 11.4-11.6), then the one-per-Order state check (409,
   * Requirement 11.3). Input is validated before the duplicate check so a
   * dispatcher sending a bad gallon count on an already-delivered Order is told
   * about the gallons they can still fix.
   *
   * Permitted from Accepted and from En_Route alike (Requirement 10.4): the
   * explicit en-route tap is a courtesy to the Buyer, not a gate on the
   * paperwork.
   *
   * Returns the Delivery. The Order's new status is readable through
   * `readOrder`, and the Commission_Invoice is generated here
   * (Requirements 12.1, 12.4) once the Order reads Delivered.
   */
  async recordDelivery(
    ctx: AuthContext,
    orderId: string,
    input: RecordDeliveryInput,
    now: Date = new Date()
  ): Promise<Delivery> {
    const order = await this.requireOrderForSupplier(
      ctx,
      orderId,
      "delivery.record"
    );

    const bolGallons = requireBolGallons(input?.bolGallons);
    const ticketNumber = requireTicketNumber(input?.ticketNumber);
    const ticketPhotoKey = normalizeOptionalTicketPhotoKey(
      input?.ticketPhotoKey
    );

    /**
     * Requirements 11.2, 11.3. Read first so the rejection carries a clear
     * message; the unique `Delivery.orderId` is the actual gate and raises the
     * same `DELIVERY_EXISTS` code if two dispatchers tap Deliver at once.
     */
    const existing = await this.repo.getDeliveryByOrder(order.id);
    if (existing) {
      throw new ConflictError(
        "DELIVERY_EXISTS",
        "This order already has a recorded delivery"
      );
    }

    // Requirement 11.6: a supplied photo key rides along with the row.
    const delivery = await this.repo.createDelivery({
      orderId: order.id,
      bolGallons,
      ticketNumber,
      ticketPhotoKey,
      deliveredAt: new Date(now.getTime()),
    });

    // Requirements 11.1, 10.3 — the BOL is on file, so the Order is Delivered.
    const delivered =
      order.status === "delivered"
        ? order
        : await this.repo.updateOrder(order.id, { status: "delivered" });

    // Requirement 14.4 — recording the BOL is itself a status change, so it is
    // audited through the same path as an explicit advance, with the Delivery
    // on the row. Skipped when the Order already read Delivered and nothing
    // moved.
    if (delivered.status !== order.status) {
      await this.auditStatusChange(
        ctx.userId,
        delivered,
        order.status,
        delivered.status,
        now,
        { deliveryId: delivery.id, bolGallons: delivery.bolGallons }
      );
    }

    // Requirements 12.1, 12.4 — bill the winning Supplier Company. Runs after
    // the Order reads Delivered so the commission service sees a billable load.
    await this.generateCommissionInvoice(delivered, now);

    // Requirement 13.4, fire-and-forget — see `notifyDelivered`.
    await this.notifyDelivered(delivered, delivery);

    return delivery;
  }

  /**
   * Records a deal arranged off-app (Requirements 17.1-17.5).
   *
   * Lives here rather than on `AdminService` for the reason stated at the top
   * of this file: every write to `Order.status` goes through one gatekeeper, so
   * the concierge path cannot grow its own notion of what a Delivered Order
   * looks like. Admin-only — the `order.createConcierge` policy row carries
   * Requirement 17.5, and a non-Admin is denied before anything is read.
   *
   * Approval and availability are deliberately not checked. The concierge path
   * exists so the pilot loop closes before suppliers self-serve, which means
   * the winning company is routinely one an Admin has not finished onboarding;
   * gating on `supplierApprovalStatus` here would block the very deals this
   * feature is for. The Admin-only guard is the control.
   *
   * ## Write ordering
   *
   * Order (at Delivered) -> Delivery -> invoice -> audit. The Order has to
   * exist before the Delivery can point at it, so there is a moment where it
   * reads Delivered with no BOL behind it. That state is inert rather than
   * wrong: `generateInvoiceForOrder` refuses to bill an Order with no Delivery
   * (Requirement 12.5), so a failure between the two writes leaves an
   * unbillable record an Admin can see and re-enter, never a phantom
   * commission.
   *
   * Requirement 17.3 is satisfied by delegation, not by repetition: the invoice
   * comes from the same `CommissionService.generateInvoiceForOrder` the app
   * delivery path calls, so the waived-first-two-wins rule applies to concierge
   * orders because it is literally the same code — a concierge order also
   * *counts* toward the supplier's completed wins, since it is a Delivered
   * Order like any other.
   */
  async createConciergeOrder(
    ctx: AuthContext,
    input: ConciergeOrderInput,
    now: Date = new Date()
  ): Promise<Order> {
    // Requirement 17.5.
    const admin = requireAction(ctx, "order.createConcierge");

    // Requirement 17.1 — gallons greater than zero; 17.2 — ticket optional.
    const bolGallons = requireBolGallons(input?.bolGallons);
    const ticketNumber = normalizeOptionalTicketNumber(input?.ticketNumber);
    const ticketPhotoKey = normalizeOptionalTicketPhotoKey(
      input?.ticketPhotoKey
    );

    const buyer = await this.requireCompanyOfKind(
      input?.buyerCompanyId,
      "buyer",
      "buyerCompanyId"
    );
    const supplier = await this.requireCompanyOfKind(
      input?.supplierCompanyId,
      "supplier",
      "supplierCompanyId"
    );

    // Requirement 17.1 — the Order lands Delivered; `requestId` and `offerId`
    // are null because there was no RFQ and no quote, and `isConcierge` marks
    // it as entered rather than transacted.
    const order = await this.repo.createOrder({
      requestId: null,
      offerId: null,
      buyerCompanyId: buyer.id,
      supplierCompanyId: supplier.id,
      status: "delivered",
      isConcierge: true,
      createdAt: new Date(now.getTime()),
    });

    // Requirements 17.1, 17.2 — the Delivery, with the ticket when there is one.
    const delivery = await this.repo.createDelivery({
      orderId: order.id,
      bolGallons,
      ticketNumber,
      ticketPhotoKey,
      deliveredAt: new Date(now.getTime()),
    });

    // Requirement 17.3 — the shared, origin-agnostic commission path.
    const invoice = await this.generateConciergeInvoice(order, now);

    // Requirements 17.4, 14.5 — the acting Admin, the Order, the timestamp.
    await this.auditConciergeCreated(admin.userId, order, delivery, invoice, now);

    return order;
  }

  /**
   * One Order as a party to it sees it, current status included
   * (Requirement 10.6).
   *
   * Open to the owning Buyer Company, the winning Supplier Company, and an
   * Admin (`requireOrderParty`). A missing Order denies for a trading company
   * exactly as another company's Order would, so order ids cannot be probed;
   * only an Admin, who may read every Order, is told it does not exist.
   */
  async readOrder(ctx: AuthContext, orderId: string): Promise<OrderView> {
    const id = typeof orderId === "string" ? orderId.trim() : "";
    const order = id === "" ? null : await this.repo.getOrder(id);

    requireAction(ctx, "order.read");
    requireOrderParty(
      ctx,
      order ?? { buyerCompanyId: "", supplierCompanyId: "" }
    );
    if (!order) {
      throw new ConflictError("ORDER_NOT_FOUND", "No such order");
    }

    const delivery = await this.repo.getDeliveryByOrder(order.id);
    return toOrderView(order, delivery);
  }

  /**
   * Resolves an Order for a winning-Supplier-only write (Requirements 10.2,
   * 11.7). The Order is read before the guard so the company scope has a target;
   * a missing Order therefore denies rather than 404s.
   */
  private async requireOrderForSupplier(
    ctx: AuthContext,
    orderId: string,
    action: "order.advance" | "delivery.record"
  ): Promise<Order> {
    const id = typeof orderId === "string" ? orderId.trim() : "";
    const order = id === "" ? null : await this.repo.getOrder(id);
    requireAction(ctx, action, { companyId: order?.supplierCompanyId });
    return order as Order;
  }

  /**
   * Resolves a Company an Admin named on a concierge entry and asserts its
   * kind. A missing company, and a company of the wrong kind, are both
   * validation errors on the field the Admin typed: unlike the trading paths
   * there is no id to probe here (the caller is already an Admin), so the
   * honest answer is the useful one. Billing a buyer company for commission, or
   * crediting a supplier company with someone else's fuel, is a typo worth
   * catching before the invoice exists.
   */
  private async requireCompanyOfKind(
    companyId: unknown,
    kind: Company["kind"],
    field: string
  ): Promise<Company> {
    const id = typeof companyId === "string" ? companyId.trim() : "";
    const company = id === "" ? null : await this.repo.getCompany(id);

    if (!company) {
      throw new ValidationError(
        kind === "buyer" ? "BUYER_COMPANY_NOT_FOUND" : "SUPPLIER_COMPANY_NOT_FOUND",
        `No such ${kind} company`,
        field
      );
    }
    if (company.kind !== kind) {
      throw new ValidationError(
        kind === "buyer" ? "COMPANY_NOT_BUYER" : "COMPANY_NOT_SUPPLIER",
        `This field must name a ${kind} company`,
        field
      );
    }
    return company;
  }

  /**
   * Resolves the Offer's Supplier Company. A missing company, or one of buyer
   * kind, is a data defect on an already-stored Offer; reported as a conflict
   * rather than a validation error because the caller supplied nothing wrong.
   */
  private async requireSupplierCompany(companyId: string): Promise<Company> {
    const company = await this.repo.getCompany(companyId);
    if (!company || company.kind !== "supplier") {
      throw new ConflictError(
        "OFFER_SUPPLIER_UNRESOLVED",
        "The supplier company behind this offer could not be resolved"
      );
    }
    return company;
  }

  /**
   * Bills the Delivered load (Requirements 12.1, 12.4), delegating to the
   * shared, origin-agnostic entry point the Admin concierge path also uses
   * (Requirement 17.3) so there is one set of commission rules, not two.
   *
   * Swallowed on failure, like the notifications: the Delivery row and the
   * Delivered status are already on file, and failing the call here would tell
   * a dispatcher their paperwork did not save when it did — and a retry would
   * then be refused as a duplicate delivery. Generation is idempotent and keyed
   * on the Order, so a transient fault costs a replay (any Delivered Order
   * without an invoice regenerates cleanly), not a lost load.
   */
  private async generateCommissionInvoice(
    order: Order,
    now: Date
  ): Promise<void> {
    if (!this.commission) return;

    try {
      await this.commission.generateInvoiceForOrder(order.id, now);
    } catch {
      // See above: replayable, so never fatal to the delivery record.
    }
  }

  /**
   * Bills a concierge entry through the shared path (Requirement 17.3),
   * returning the invoice so the audit row can name it.
   *
   * Swallowed on failure for the same reason as the app path: the Order and its
   * Delivery are already on file, generation is idempotent and keyed on the
   * Order, so a transient fault costs a replay rather than the record of the
   * deal.
   */
  private async generateConciergeInvoice(
    order: Order,
    now: Date
  ): Promise<CommissionInvoice | null> {
    if (!this.commission) return null;

    try {
      return await this.commission.generateInvoiceForOrder(order.id, now);
    } catch {
      return null;
    }
  }

  /**
   * Appends the CONCIERGE_CREATED entry (Requirements 17.4, 14.5): the acting
   * Admin, the Order, and the timestamp, with the Delivery and the invoice it
   * produced on the payload. Swallowed on failure like every other post-commit
   * step, and reconstructible from the `isConcierge` Order itself.
   */
  private async auditConciergeCreated(
    actorUserId: string,
    order: Order,
    delivery: Delivery,
    invoice: CommissionInvoice | null,
    now: Date
  ): Promise<void> {
    if (!this.audit) return;

    try {
      await this.audit.conciergeCreated(
        actorUserId,
        order,
        delivery,
        invoice,
        now
      );
    } catch {
      // See above: recoverable from the Order row, so never fatal.
    }
  }

  /**
   * Appends the OFFER_ACCEPTED entry (Requirement 14.2): the acting User, the
   * accepted Offer, the Order, and the timestamp.
   *
   * Swallowed on failure like the notifications and the invoice: the Request is
   * claimed, the Order exists, and the losing quotes are voided, so an audit
   * write fault must not report a failed acceptance — a retry would then be
   * refused as `REQUEST_NOT_OPEN` and the Buyer would believe they had lost the
   * load. The log is append-only, so a missed row is reconstructible from the
   * Order; a phantom rejection is not.
   */
  private async auditOfferAccepted(
    actorUserId: string,
    order: Order,
    now: Date
  ): Promise<void> {
    if (!this.audit) return;

    try {
      await this.audit.offerAccepted(actorUserId, order, now);
    } catch {
      // See above: recoverable from the Order row, so never fatal.
    }
  }

  /**
   * Appends a STATUS_CHANGED entry (Requirement 14.4): the acting User, the
   * Order, the prior status, the new status, and the timestamp.
   *
   * Only ever called after the status write has landed, so the row describes a
   * move that actually happened — a rejected backward transition
   * (Requirement 10.5) writes nothing, since nothing changed. Swallowed on
   * failure for the same reason as the rest of the post-commit steps.
   */
  private async auditStatusChange(
    actorUserId: string,
    order: Order,
    priorStatus: OrderStatus,
    newStatus: OrderStatus,
    now: Date,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    if (!this.audit) return;

    try {
      await this.audit.orderStatusChanged(
        actorUserId,
        order,
        priorStatus,
        newStatus,
        extra,
        now
      );
    } catch {
      // See above: recoverable from the Order row, so never fatal.
    }
  }

  /**
   * Fires ACCEPTED to the winning Supplier Company's supplier-role users
   * (Requirement 13.3).
   *
   * Wrapped whole in a catch: by the time this runs the Order exists and the
   * losing quotes are voided, so a user lookup or transport fault must never
   * surface as a failed acceptance. Only `supplier`-role users are paged —
   * hauling the load is dispatcher work.
   */
  private async notifyAccepted(
    load: Request,
    winning: Offer,
    supplier: Company
  ): Promise<void> {
    if (!this.notifier) return;

    try {
      const users = await this.repo.listUsersByCompany(supplier.id);
      const recipients: Recipient[] = users
        .filter((user) => user.role === "supplier")
        .map(recipientFromUser);
      if (recipients.length === 0) return;

      await this.notifier.dispatch(
        "ACCEPTED",
        recipients,
        acceptedMessage(load, winning)
      );
    } catch {
      // Swallowed deliberately: notification is never a precondition of a won
      // load. Transport failures are already in the failure log.
    }
  }

  /**
   * Fires DELIVERED to the owning Buyer Company's buyer-role users
   * (Requirement 13.4).
   *
   * Wrapped whole in a catch for the same reason as ACCEPTED: the Delivery is
   * already on file and the Order already reads Delivered, so a user lookup or
   * transport fault must never surface as a failed delivery record.
   *
   * The originating Request is looked up to summarise what was ordered against
   * what landed; a concierge Order has none (`requestId` is null), and the
   * message simply omits that line.
   */
  private async notifyDelivered(
    order: Order,
    delivery: Delivery
  ): Promise<void> {
    if (!this.notifier) return;

    try {
      const users = await this.repo.listUsersByCompany(order.buyerCompanyId);
      const recipients: Recipient[] = users
        .filter((user) => user.role === "buyer")
        .map(recipientFromUser);
      if (recipients.length === 0) return;

      const request = order.requestId
        ? await this.repo.getRequest(order.requestId)
        : null;

      await this.notifier.dispatch(
        "DELIVERED",
        recipients,
        deliveredMessage(delivery, request)
      );
    } catch {
      // Swallowed deliberately: see `notifyAccepted`.
    }
  }
}
