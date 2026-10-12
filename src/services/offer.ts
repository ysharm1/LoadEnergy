/**
 * Offer service — the Supplier's quote, its 1-8 hour hold, and the Buyer's
 * view of the quotes on a load.
 *
 * Requirements:
 *   5.4 a Supplier whose Supplier_Status is Closed cannot submit an Offer.
 *   5.5 a Supplier whose Supplier_Approval_Status is Pending cannot submit an
 *       Offer.
 *   6.1 an Offer on an Open Request with a Landed_Price and Hold_Hours is
 *       created against that Request and the Supplier's Company.
 *   6.2 Offer_Expiry is the creation time plus Hold_Hours.
 *   6.3 an ETA is stored when provided.
 *   6.4 Landed_Price <= 0 is rejected with a validation error.
 *   6.5 Hold_Hours outside the inclusive range 1..8 is rejected with a
 *       validation error.
 *   6.6 the Buyer's offer list returns each Offer's Supplier name,
 *       Landed_Price, ETA, and Offer_Expiry.
 *   7.1 an Offer is active while now is before Offer_Expiry.
 *   7.2 an Offer is expired once now reaches Offer_Expiry.
 *   7.4 the Buyer's offer list indicates active or expired per Offer.
 *  13.2 the owning Buyer is notified when a Supplier submits an Offer.
 *
 * ## Shape
 *
 * Same shape as the services before it: pure validators plus pure predicates
 * (`computeExpiry`, `isActive`) at the top, a class over injected ports below,
 * a caller-supplied `now` so expiry is deterministic, and every entry point
 * through `requireAction`.
 *
 * Expiry is never a stored flag. It is derived by comparing `now` to
 * `expiresAt` every time it is asked for (design: "Offer expiry is evaluated
 * lazily at read and at acceptance"), so no scheduler has to run for a hold to
 * lapse and there is no window in which the database disagrees with the clock.
 *
 * ## Eligibility reuses the matching predicate
 *
 * Submission gating runs the request through `isEligibleSupplier` — the same
 * predicate that decides the RFQ inbox (task 5.3). A supplier can therefore
 * quote exactly the loads it can see, and the two can never drift apart. The
 * approval and availability checks are still made explicitly first, purely so
 * the rejection carries a specific code (`SUPPLIER_PENDING` /
 * `SUPPLIER_CLOSED`) instead of a generic ineligibility.
 */

import { ConflictError, ValidationError } from "@/domain/errors";
import {
  MAX_HOLD_HOURS,
  MIN_HOLD_HOURS,
  type AuthContext,
  type Company,
  type Offer,
  type OfferStatus,
  type Request,
} from "@/domain/types";
import type { Repository } from "@/repository/repository";
import type { AuditService } from "./audit";
import { requireAction } from "./authorization";
import { isEligibleSupplier } from "./matching";
import {
  newOfferMessage,
  recipientFromUser,
  type NotificationDispatcher,
  type Recipient,
} from "./notifications";

const MS_PER_HOUR = 3_600_000;

/**
 * `Offer.landedPricePerGal` is `Decimal(10, 4)`: four decimal places, six
 * integer digits. Prices are rounded to the column's scale on the way in and
 * anything past its ceiling is a validation error rather than a write that
 * fails at the database.
 */
export const LANDED_PRICE_DECIMALS = 4;
export const MAX_LANDED_PRICE_PER_GAL = 999_999.9999;

/** An ETA in minutes; a whole day is already far outside a pilot haul. */
export const MAX_ETA_MINUTES = 1440;

// ---------------------------------------------------------------------------
// Pure validators (Requirements 6.3, 6.4, 6.5)
// ---------------------------------------------------------------------------

/** Rounds to the `Decimal(10, 4)` scale the column actually stores. */
export function roundLandedPrice(value: number): number {
  const factor = 10 ** LANDED_PRICE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * Validates a Landed_Price (Requirement 6.4).
 *
 * Zero and negatives are rejected as the requirement states; NaN and Infinity
 * are rejected too, because a non-finite price would pass every downstream
 * comparison silently and land in an invoice. The returned value is rounded to
 * the stored scale, so what a Buyer is shown is exactly what was persisted.
 */
export function requireLandedPrice(
  value: unknown,
  field = "landedPricePerGal"
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(
      "LANDED_PRICE_INVALID",
      "Landed price must be a finite number",
      field
    );
  }
  if (value <= 0) {
    throw new ValidationError(
      "LANDED_PRICE_INVALID",
      "Landed price must be greater than zero",
      field
    );
  }
  const rounded = roundLandedPrice(value);
  /**
   * Rounding up from just under the ceiling is caught here too. A price that
   * rounds to zero (below half a hundredth of a cent) is not a price either.
   */
  if (rounded <= 0) {
    throw new ValidationError(
      "LANDED_PRICE_INVALID",
      "Landed price must be greater than zero",
      field
    );
  }
  if (rounded > MAX_LANDED_PRICE_PER_GAL) {
    throw new ValidationError(
      "LANDED_PRICE_INVALID",
      `Landed price must be at most ${MAX_LANDED_PRICE_PER_GAL}`,
      field
    );
  }
  return rounded;
}

/**
 * Validates Hold_Hours against the inclusive range [1, 8]
 * (Requirement 6.5, design: MIN_HOLD_HOURS / MAX_HOLD_HOURS).
 *
 * Both edges are accepted: 1 and 8 are valid holds, 0 and 9 are not. The value
 * must be a whole number — `holdHours` is an integer column and a 2.5-hour hold
 * would quietly become a different expiry than either party agreed to.
 */
export function requireHoldHours(value: unknown, field = "holdHours"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(
      "HOLD_HOURS_INVALID",
      "Hold hours must be a finite number",
      field
    );
  }
  if (!Number.isInteger(value)) {
    throw new ValidationError(
      "HOLD_HOURS_INVALID",
      "Hold hours must be a whole number of hours",
      field
    );
  }
  if (value < MIN_HOLD_HOURS || value > MAX_HOLD_HOURS) {
    throw new ValidationError(
      "HOLD_HOURS_INVALID",
      `Hold hours must be between ${MIN_HOLD_HOURS} and ${MAX_HOLD_HOURS} inclusive`,
      field
    );
  }
  return value;
}

/**
 * Normalizes the optional ETA (Requirement 6.3). Absent stays absent (null);
 * a supplied value must be a positive whole number of minutes. Zero is
 * rejected: "already there" is not an estimate a dispatcher means to send.
 */
export function normalizeOptionalEtaMinutes(
  value: unknown,
  field = "etaMinutes"
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(
      "ETA_INVALID",
      "ETA must be a finite number of minutes",
      field
    );
  }
  if (!Number.isInteger(value)) {
    throw new ValidationError(
      "ETA_INVALID",
      "ETA must be a whole number of minutes",
      field
    );
  }
  if (value <= 0) {
    throw new ValidationError(
      "ETA_INVALID",
      "ETA must be greater than zero minutes",
      field
    );
  }
  if (value > MAX_ETA_MINUTES) {
    throw new ValidationError(
      "ETA_INVALID",
      `ETA must be at most ${MAX_ETA_MINUTES} minutes`,
      field
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Pure expiry / activeness (Requirements 6.2, 7.1, 7.2)
// ---------------------------------------------------------------------------

/** Offer_Expiry = creation time + Hold_Hours (Requirement 6.2). */
export function computeExpiry(createdAt: Date, holdHours: number): Date {
  return new Date(createdAt.getTime() + holdHours * MS_PER_HOUR);
}

/** Offer statuses that still admit acceptance. */
const ACCEPTABLE_OFFER_STATUS: OfferStatus = "active";

/**
 * True while the Offer is still acceptable (Requirements 7.1, 7.2).
 *
 * The boundary is strict on `now`: active while `now < expiresAt`, expired the
 * instant `now` reaches it. A hold that has run out is not honoured for one
 * more millisecond.
 *
 * Status and the `voided` flag are part of the same question — an Offer voided
 * because a sibling won, or already accepted, is not active even mid-hold — so
 * a caller cannot accidentally treat a dead Offer as live by only checking the
 * clock. Fails closed on a malformed `expiresAt`.
 */
export function isActive(
  offer: Pick<Offer, "expiresAt" | "status" | "voided">,
  now: Date
): boolean {
  if (offer == null) return false;
  if (offer.voided) return false;
  if (offer.status !== ACCEPTABLE_OFFER_STATUS) return false;

  const expiresAt = offer.expiresAt;
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    return false;
  }
  return now.getTime() < expiresAt.getTime();
}

/** True once `now` has reached `expiresAt`, whatever the Offer's status. */
export function isExpired(offer: Pick<Offer, "expiresAt">, now: Date): boolean {
  const expiresAt = offer?.expiresAt;
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    return true;
  }
  return now.getTime() >= expiresAt.getTime();
}

// ---------------------------------------------------------------------------
// Buyer-facing projection (Requirements 6.6, 7.4)
// ---------------------------------------------------------------------------

export type OfferActiveness = "active" | "expired";

/** What a Buyer sees for one quote on their load. */
export interface OfferView {
  offerId: string;
  requestId: string;
  supplierCompanyId: string;
  /** Requirement 6.6: the Supplier's name, not just its id. */
  supplierName: string;
  landedPricePerGal: number;
  /** Null when the Supplier did not quote an ETA. */
  etaMinutes: number | null;
  holdHours: number;
  expiresAt: Date;
  /** The stored lifecycle status (`active`, `accepted`, `voided`, ...). */
  status: OfferStatus;
  /** Requirement 7.4: the active/expired indicator, evaluated against `now`. */
  activeness: OfferActiveness;
  /** Convenience for the client: `activeness === "active"`. */
  isActive: boolean;
}

/**
 * Projects one Offer for the Buyer (Requirements 6.6, 7.4). Pure, so the
 * indicator is a function of the Offer and the evaluation time alone.
 *
 * A voided or already-accepted Offer that is still inside its hold reports
 * `expired` rather than `active`: from the Buyer's side the only useful meaning
 * of the indicator is "can I tap Accept on this", and `isActive` is the single
 * source of that answer.
 */
export function toOfferView(
  offer: Offer,
  supplierName: string,
  now: Date
): OfferView {
  const active = isActive(offer, now);
  return {
    offerId: offer.id,
    requestId: offer.requestId,
    supplierCompanyId: offer.supplierCompanyId,
    supplierName,
    landedPricePerGal: offer.landedPricePerGal,
    etaMinutes: offer.etaMinutes,
    holdHours: offer.holdHours,
    expiresAt: offer.expiresAt,
    status: offer.status,
    activeness: active ? "active" : "expired",
    isActive: active,
  };
}

// ---------------------------------------------------------------------------
// Voiding (shared by acceptance, cancellation, and window-end expiry)
// ---------------------------------------------------------------------------

/** The repository surface the voiding helper needs — nothing more. */
export type OfferVoidingRepo = Pick<
  Repository,
  "listOffersByRequest" | "updateOffer"
>;

export interface VoidOffersOptions {
  /** The winning Offer on the acceptance path, which is claimed, not voided. */
  exceptOfferId?: string | null;
}

/**
 * Voids every still-active Offer on a Request and returns the voided records.
 *
 * One helper for the three paths that kill the quotes on a load — a sibling
 * winning (Requirement 8.3), the Buyer cancelling (Requirement 9.1), and the
 * Delivery_Window ending (Requirement 9.3) — so "voided" means exactly the same
 * thing however the load left Open, and the three can never drift apart.
 *
 * Deliberately clock-free. The set it touches is the Offers whose *stored*
 * status is still `active`, not the ones that are active by the clock: an Offer
 * whose hold already lapsed is dead either way, and marking it `voided` records
 * why it can never be accepted again. `isActive` remains the clock-sensitive
 * read (Requirements 7.1, 7.2); this is the write.
 *
 * Idempotent — a second call finds nothing left to void.
 */
export async function voidActiveOffersOnRequest(
  repo: OfferVoidingRepo,
  requestId: string,
  options: VoidOffersOptions = {}
): Promise<Offer[]> {
  const offers = await repo.listOffersByRequest(requestId);
  const voided: Offer[] = [];
  for (const offer of offers) {
    if (options.exceptOfferId != null && offer.id === options.exceptOfferId) {
      continue;
    }
    if (offer.voided || offer.status !== "active") continue;
    voided.push(
      await repo.updateOffer(offer.id, { status: "voided", voided: true })
    );
  }
  return voided;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CreateOfferInput {
  requestId: string;
  landedPricePerGal: number;
  /** Inclusive 1..8 (Requirement 6.5). */
  holdHours: number;
  /** Optional (Requirement 6.3). */
  etaMinutes?: number | null;
}

export interface OfferServiceDeps {
  repo: Repository;
  /** Carries the NEW_OFFER notification (task 7.4). Optional. */
  notifier?: NotificationDispatcher;
  /**
   * Records OFFER_SUBMITTED (Requirement 14.1). Optional, like `notifier`, so
   * the quote rules can be exercised on their own; wired in production so every
   * submitted quote is attributable.
   */
  audit?: AuditService;
}

export class OfferService {
  private readonly repo: Repository;
  private readonly notifier?: NotificationDispatcher;
  private readonly audit?: AuditService;

  constructor(deps: OfferServiceDeps) {
    this.repo = deps.repo;
    this.notifier = deps.notifier;
    this.audit = deps.audit;
  }

  /**
   * Submits an Offer on an Open Request (Requirements 6.1-6.5, 5.4, 5.5).
   *
   * Check order is deliberate, cheapest and most actionable first:
   *   1. authorization (403) — is the caller a Supplier at all;
   *   2. input shape and range (400) — price, hold, ETA, all fixable inline;
   *   3. the Request and the Supplier Company exist (400);
   *   4. Request_Status is Open (409) — refresh and look again;
   *   5. approval, availability, and radius eligibility (409).
   *
   * The Supplier Company and the acting User both come from the session, never
   * from the input, so a dispatcher can only quote for their own Company.
   */
  async createOffer(
    ctx: AuthContext,
    input: CreateOfferInput,
    now: Date = new Date()
  ): Promise<Offer> {
    const caller = requireAction(ctx, "offer.create");

    const landedPricePerGal = requireLandedPrice(input?.landedPricePerGal);
    const holdHours = requireHoldHours(input?.holdHours);
    const etaMinutes = normalizeOptionalEtaMinutes(input?.etaMinutes);

    const request = await this.requireRequest(input?.requestId);
    const company = await this.requireSupplierCompany(caller.companyId);

    /**
     * Requirement 6.1: only an Open Request can be quoted. Checked before the
     * gating below so a supplier quoting a load that has just been won is told
     * to refresh rather than told they are ineligible.
     *
     * A Request whose Delivery_Window has already ended but whose status is
     * still Open is deliberately still quotable here: flipping that status is
     * task 8.2's lazy expiry, and this service does not mutate Request state.
     */
    if (request.status !== "open") {
      throw new ConflictError(
        "REQUEST_NOT_OPEN",
        "This load is no longer open for quotes"
      );
    }

    // Requirement 5.5 — Pending cannot quote.
    if (company.supplierApprovalStatus !== "approved") {
      throw new ConflictError(
        "SUPPLIER_PENDING",
        "This supplier company is not approved to submit offers yet"
      );
    }

    // Requirement 5.4 — Closed cannot quote.
    if (company.supplierStatus === "closed") {
      throw new ConflictError(
        "SUPPLIER_CLOSED",
        "This supplier company is marked Closed and cannot submit offers"
      );
    }

    /**
     * The authoritative gate (Requirement 6.1, "in-radius"): the same predicate
     * that built the RFQ inbox. Approval and availability were already checked
     * above for their specific codes, so reaching here with a false means the
     * pin is outside the Admin-configured Service_Radius — or that no
     * Operating_Location / Service_Radius has been configured at all, which
     * fails closed by design.
     */
    if (!isEligibleSupplier(request, company)) {
      throw new ConflictError(
        "SUPPLIER_NOT_ELIGIBLE",
        "This load is outside the configured service radius for this supplier company"
      );
    }

    const createdAt = new Date(now.getTime());
    const offer = await this.repo.createOffer({
      requestId: request.id,
      supplierCompanyId: company.id,
      createdByUserId: caller.userId,
      landedPricePerGal,
      holdHours,
      etaMinutes,
      createdAt,
      // Requirement 6.2.
      expiresAt: computeExpiry(createdAt, holdHours),
      voided: false,
      status: "active",
    });

    // Requirement 14.1 — the quote is on the record with its author.
    await this.auditOfferSubmitted(caller.userId, offer, request, now);

    // Requirement 13.2, fire-and-forget — see `notifyNewOffer`.
    await this.notifyNewOffer(request, offer);

    return offer;
  }

  /**
   * Appends the OFFER_SUBMITTED entry (Requirement 14.1): the acting User, the
   * Supplier Company, the Request, and the timestamp.
   *
   * Written after the Offer exists, so the row can carry its id, and wrapped in
   * a catch for the same reason the notifications are: the quote is already
   * persisted and visible to the Buyer, so an audit write fault must not tell a
   * dispatcher their price did not save when it did. The log is append-only, so
   * a missed row can be reconstructed from the Offer itself; a phantom
   * rejection cannot be undone once the Buyer has seen the quote.
   */
  private async auditOfferSubmitted(
    actorUserId: string,
    offer: Offer,
    request: Request,
    now: Date
  ): Promise<void> {
    if (!this.audit) return;

    try {
      await this.audit.offerSubmitted(actorUserId, offer, request, now);
    } catch {
      // See above: recoverable from the Offer row, so never fatal to the quote.
    }
  }

  /**
   * The Buyer's quote list for one of their Requests (Requirements 6.6, 7.4),
   * newest quote first.
   *
   * Every Offer on the Request is returned, expired and voided ones included,
   * each carrying its own indicator: a Buyer comparing quotes needs to see that
   * the cheap one lapsed rather than watch it silently disappear.
   *
   * The Request is read before the guard so the ownership check has a company
   * to scope against. A missing Request and a Request owned by someone else
   * therefore both deny with 403 and are indistinguishable to the caller — no
   * probing another company's load ids.
   */
  async listOffersForRequest(
    ctx: AuthContext,
    requestId: string,
    now: Date = new Date()
  ): Promise<OfferView[]> {
    const id = typeof requestId === "string" ? requestId.trim() : "";
    const request = id === "" ? null : await this.repo.getRequest(id);
    requireAction(ctx, "offer.list", { companyId: request?.buyerCompanyId });

    const offers = await this.repo.listOffersByRequest(
      (request as Request).id
    );
    const views: OfferView[] = [];
    for (const offer of offers) {
      const supplier = await this.repo.getCompany(offer.supplierCompanyId);
      views.push(toOfferView(offer, supplier?.name ?? "Unknown supplier", now));
    }
    return views.sort((a, b) => {
      // Newest first; ties broken by id so the order is stable.
      const byExpiry = b.expiresAt.getTime() - a.expiresAt.getTime();
      return byExpiry !== 0 ? byExpiry : a.offerId.localeCompare(b.offerId);
    });
  }

  /** Resolves a Request id, reporting a missing one as malformed input. */
  private async requireRequest(requestId: unknown): Promise<Request> {
    const id = typeof requestId === "string" ? requestId.trim() : "";
    const request = id === "" ? null : await this.repo.getRequest(id);
    if (!request) {
      throw new ValidationError(
        "REQUEST_NOT_FOUND",
        "No such request",
        "requestId"
      );
    }
    return request;
  }

  /**
   * Resolves the caller's Supplier Company. Mirrors `SupplierService`: a
   * missing company, or one of buyer kind, is malformed input on the id rather
   * than a state conflict.
   */
  private async requireSupplierCompany(companyId: string): Promise<Company> {
    const id = typeof companyId === "string" ? companyId.trim() : "";
    const company = id === "" ? null : await this.repo.getCompany(id);

    if (!company) {
      throw new ValidationError(
        "SUPPLIER_COMPANY_NOT_FOUND",
        "No such supplier company",
        "companyId"
      );
    }
    if (company.kind !== "supplier") {
      throw new ValidationError(
        "COMPANY_NOT_SUPPLIER",
        "Only a supplier company can submit offers",
        "companyId"
      );
    }
    return company;
  }

  /**
   * Fires NEW_OFFER to the owning Buyer Company's buyer-role users
   * (Requirement 13.2).
   *
   * Wrapped whole in a catch for the same reason as NEW_RFQ: the Offer is
   * already persisted, so a user lookup or transport fault must not surface as
   * a failed quote. Per-recipient and per-channel isolation is already the
   * dispatcher's job (Requirement 13.7); this guard covers the steps around it.
   *
   * Only `buyer`-role users are paged. An admin or supplier seat that happens
   * to sit on a buyer company is skipped — accepting a quote is the
   * superintendent's decision.
   */
  private async notifyNewOffer(request: Request, offer: Offer): Promise<void> {
    if (!this.notifier) return;

    try {
      const users = await this.repo.listUsersByCompany(request.buyerCompanyId);
      const recipients: Recipient[] = users
        .filter((user) => user.role === "buyer")
        .map(recipientFromUser);
      if (recipients.length === 0) return;

      await this.notifier.dispatch(
        "NEW_OFFER",
        recipients,
        newOfferMessage(request, offer)
      );
    } catch {
      // Swallowed deliberately: notification is never a precondition of a
      // submitted quote. Transport failures are already in the failure log.
    }
  }
}
