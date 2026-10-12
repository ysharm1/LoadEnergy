/**
 * Request service — the Buyer's fuel request (RFQ) and work list.
 *
 * Requirements:
 *   3.1 a Request with gallons, Product_Type, Delivery_Method, an in-geofence
 *       pin, and a Delivery_Window is created with Request_Status Open.
 *   3.2 Product_Type is ULSD or Dyed.
 *   3.3 Delivery_Method is Wet_Hose or Yard_Tank.
 *   3.4 Delivery_Window is Today or Tomorrow_AM.
 *   3.5 gallons <= 0 is rejected with a validation error.
 *   3.6 a pin outside the Pilot_Geofence is rejected with a geofence error.
 *   3.7 notes are stored when provided.
 *   3.8 the Request links the creating Buyer and that Buyer's Company.
 *   3.9 the buyer work list returns the Company's Open Requests and its Orders.
 *   9.1 cancelling an Open Request sets Request_Status to Cancelled and voids
 *       every active Offer on it.
 *   9.2 cancelling a Request that is not Open is rejected with an error.
 *   9.3 when the Delivery_Window has ended and the Request is still Open, the
 *       Request_Status becomes Expired and every remaining active Offer is
 *       voided.
 *   9.4 Cancelled and Expired Requests never surface in supplier RFQ inboxes.
 *   9.5 a User outside the owning Buyer Company is denied cancellation with an
 *       authorization error.
 *
 * Shape matches the other services: a class over injected ports, a
 * caller-supplied `now`, no HTTP and no ambient clock, and every entry point
 * through `requireAction`. The geofence decision is split in two on purpose —
 * `isInsideGeofence` is the pure predicate, `AdminService.getGeofence` is the
 * read of the currently configured box (task 3.3) — so an Admin editing the
 * fence immediately governs the next Request without this service caching
 * anything.
 *
 * ## Leaving Open: cancel and expire
 *
 * Both exits are one-way and both kill the quotes on the load through the same
 * shared helper `voidActiveOffersOnRequest` (also used by acceptance), so a
 * voided Offer means the same thing however the Request left Open.
 *
 * Expiry is evaluated lazily — no scheduler. Any read of a Request runs
 * `expireIfWindowEnded`, and the RFQ inbox does the same through the
 * `RequestExpiryEvaluator` port in `matching.ts`, so a stale load flips to
 * Expired the first time anybody looks at it and Cancelled/Expired loads never
 * reach a dispatcher (Requirements 9.3, 9.4).
 *
 * Task 5.4 wires NEW_RFQ here: a created Request is matched against the
 * Supplier Companies eligible to see it and each one's supplier users are
 * notified (Requirement 13.1). That dispatch is fire-and-forget — see
 * `notifyNewRfq` — so a dead SMS carrier can never stop a superintendent from
 * posting a load.
 */

import { ConflictError, GeofenceError, ValidationError } from "@/domain/errors";
import {
  DELIVERY_METHODS,
  DELIVERY_WINDOWS,
  PRODUCT_TYPES,
  type AuthContext,
  type DeliveryMethod,
  type DeliveryWindow,
  type Order,
  type ProductType,
  type Request,
} from "@/domain/types";
import type { Repository } from "@/repository/repository";
import { requireLatLng, type AdminService } from "./admin";
import type { AuditService } from "./audit";
import { requireAction } from "./authorization";
import { isInsideGeofence } from "./geofence";
import type { MatchingService } from "./matching";
import {
  newRfqMessage,
  recipientFromUser,
  type NotificationDispatcher,
  type Recipient,
} from "./notifications";
import { voidActiveOffersOnRequest } from "./offer";

// ---------------------------------------------------------------------------
// Delivery_Window -> windowEndsAt derivation (pure, testable)
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * The pilot's local day is Phoenix time. Arizona does not observe DST, so a
 * fixed UTC offset is exact here and keeps the derivation pure and
 * machine-independent — deriving from the host's local timezone would make
 * `windowEndsAt` (and therefore expiry in task 8.2) depend on where the server
 * happens to run.
 */
export const PILOT_UTC_OFFSET_HOURS = -7;

/** `Tomorrow_AM` ends at noon pilot time: morning is through 12:00. */
export const TOMORROW_AM_END_HOUR = 12;

/** Start of the pilot-local day containing `instant`, as a UTC instant. */
function pilotDayStartMs(instant: Date): number {
  const offsetMs = PILOT_UTC_OFFSET_HOURS * MS_PER_HOUR;
  // Shift into pilot-local time, floor to the day, shift back.
  const local = instant.getTime() + offsetMs;
  return Math.floor(local / MS_PER_DAY) * MS_PER_DAY - offsetMs;
}

/**
 * Derives a Request's `windowEndsAt` from its Delivery_Window, relative to the
 * creation instant (Requirement 3.1; consumed by window-end expiry in
 * task 8.2).
 *
 * The requirements name the windows but do not pin their end times, so the
 * pilot rule is:
 *   - `today`       -> the last millisecond of the pilot-local day the Request
 *                      was created on (23:59:59.999 Phoenix time).
 *   - `tomorrow_am` -> 12:00:00.000 Phoenix time on the following day.
 *
 * Both are strictly after the creation instant, so a freshly created Request is
 * never already past its window — including one posted at 23:59:59.999, whose
 * `today` window ends at that same instant and expires on the next evaluation
 * rather than retroactively.
 */
export function deliveryWindowEndsAt(
  deliveryWindow: DeliveryWindow,
  now: Date
): Date {
  const dayStart = pilotDayStartMs(now);
  if (deliveryWindow === "today") {
    return new Date(dayStart + MS_PER_DAY - 1);
  }
  return new Date(dayStart + MS_PER_DAY + TOMORROW_AM_END_HOUR * MS_PER_HOUR);
}

/**
 * True once the Request's Delivery_Window has ended (Requirement 9.3).
 *
 * The boundary matches `isWindowStillOpen` in `matching.ts` exactly — a window
 * that ends at `now` is over — so the instant a load stops being inbox-visible
 * is the instant it becomes expirable, with no gap in either direction.
 *
 * Fails closed on a malformed `windowEndsAt`: an unreadable window end cannot be
 * shown to have passed, so expiry leaves the row alone rather than flipping a
 * live load to Expired on bad data. Matching fails closed the other way (it
 * hides such a Request), so neither path acts on a window it cannot read.
 */
export function hasWindowEnded(
  request: Pick<Request, "windowEndsAt">,
  now: Date
): boolean {
  const endsAt = request?.windowEndsAt;
  if (!(endsAt instanceof Date) || Number.isNaN(endsAt.getTime())) return false;
  return now.getTime() >= endsAt.getTime();
}

// ---------------------------------------------------------------------------
// Input validation (Requirements 3.2-3.5)
// ---------------------------------------------------------------------------

/**
 * Validates gallons (Requirement 3.5). Zero and negatives are rejected as the
 * requirement states; NaN, Infinity, and fractional values are rejected too,
 * because `Request.gallons` is an integer column and a non-finite gallon count
 * would poison every downstream comparison (matching, commission) silently.
 */
export function requireGallons(value: unknown, field = "gallons"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(
      "GALLONS_INVALID",
      "Gallons must be a finite number",
      field
    );
  }
  if (!Number.isInteger(value)) {
    throw new ValidationError(
      "GALLONS_INVALID",
      "Gallons must be a whole number",
      field
    );
  }
  if (value <= 0) {
    throw new ValidationError(
      "GALLONS_INVALID",
      "Gallons must be greater than zero",
      field
    );
  }
  return value;
}

/** Rejects any value outside the allowed set with a validation error. */
function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: string,
  field: string
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(
      code,
      `${field} must be one of: ${allowed.join(", ")}`,
      field
    );
  }
  return value as T;
}

/** Requirement 3.2: ULSD or Dyed. */
export function requireProductType(value: unknown): ProductType {
  return requireEnum(value, PRODUCT_TYPES, "PRODUCT_TYPE_INVALID", "productType");
}

/** Requirement 3.3: Wet_Hose or Yard_Tank. */
export function requireDeliveryMethod(value: unknown): DeliveryMethod {
  return requireEnum(
    value,
    DELIVERY_METHODS,
    "DELIVERY_METHOD_INVALID",
    "deliveryMethod"
  );
}

/** Requirement 3.4: Today or Tomorrow_AM. */
export function requireDeliveryWindow(value: unknown): DeliveryWindow {
  return requireEnum(
    value,
    DELIVERY_WINDOWS,
    "DELIVERY_WINDOW_INVALID",
    "deliveryWindow"
  );
}

/** Requirement 3.7: notes are stored when provided; blank becomes null. */
export function normalizeOptionalNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError("NOTES_INVALID", "Notes must be text", "notes");
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CreateRequestInput {
  gallons: number;
  productType: ProductType;
  deliveryMethod: DeliveryMethod;
  deliveryWindow: DeliveryWindow;
  /** The delivery location pin; must sit inside the Pilot_Geofence. */
  lat: number;
  lng: number;
  notes?: string | null;
}

/** The Buyer's work list (Requirement 3.9). */
export interface BuyerWorkList {
  /** Open Requests only; quoted/cancelled/expired ones are not live work. */
  requests: Request[];
  /** Every Order for the Company, at whatever stage it has reached. */
  orders: Order[];
}

export interface RequestServiceDeps {
  repo: Repository;
  /** Supplies the Admin-configured Pilot_Geofence (task 3.3). */
  admin: AdminService;
  /**
   * Resolves the Supplier Companies a new Request is visible to (task 5.3).
   * Optional: omit both this and `notifier` and Request creation simply posts
   * the load without notifying anyone, which is what the geofence-focused unit
   * tests do.
   */
  matching?: MatchingService;
  /** Carries the NEW_RFQ notification (task 5.4). */
  notifier?: NotificationDispatcher;
  /**
   * Records REQUEST_CANCELLED and REQUEST_EXPIRED (Requirement 14.3).
   * Optional, like `notifier`; wired in production so both exits from Open are
   * on the record. Expiry is system-driven, so its row carries a null acting
   * User.
   */
  audit?: AuditService;
}

export class RequestService {
  private readonly repo: Repository;
  private readonly admin: AdminService;
  private readonly matching?: MatchingService;
  private readonly notifier?: NotificationDispatcher;
  private readonly audit?: AuditService;

  constructor(deps: RequestServiceDeps) {
    this.repo = deps.repo;
    this.admin = deps.admin;
    this.matching = deps.matching;
    this.notifier = deps.notifier;
    this.audit = deps.audit;
  }

  /**
   * Creates a Request at Request_Status Open (Requirements 3.1-3.8).
   *
   * Order of checks is deliberate: shape and range validation first (400-class
   * problems the Buyer can fix inline), then geofence membership (422, "outside
   * service area", pin stays editable). A pin with an out-of-range coordinate
   * is therefore a validation error, not a geofence error — it is malformed
   * input rather than a location the pilot does not cover.
   *
   * The Buyer and Company both come from the session (Requirement 3.8), never
   * from the input, so a Request can only be posted for the caller's own
   * Company.
   */
  async createRequest(
    ctx: AuthContext,
    input: CreateRequestInput,
    now: Date = new Date()
  ): Promise<Request> {
    const caller = requireAction(ctx, "request.create");

    const gallons = requireGallons(input?.gallons);
    const productType = requireProductType(input?.productType);
    const deliveryMethod = requireDeliveryMethod(input?.deliveryMethod);
    const deliveryWindow = requireDeliveryWindow(input?.deliveryWindow);
    const notes = normalizeOptionalNotes(input?.notes);
    const pin = requireLatLng(input);

    const company = await this.repo.getCompany(caller.companyId);
    if (!company) {
      throw new ValidationError(
        "COMPANY_NOT_FOUND",
        "A Request must belong to an existing Company",
        "companyId"
      );
    }

    /**
     * Fail closed when no Admin has configured a Pilot_Geofence yet.
     *
     * The alternative — treating "no fence" as "everywhere" — would let the
     * pilot take Requests from anywhere in the world on a fresh or
     * misconfigured deployment, with no supplier able to serve them. So an
     * unconfigured pilot area is an error, reported in the `geofence` category
     * (422, the same "we can't serve this location" family) but with a
     * distinct code so the client can tell the two cases apart: an operator
     * needs to set the box, whereas `OUTSIDE_GEOFENCE` means the Buyer should
     * move the pin.
     */
    const fence = await this.admin.getGeofence();
    if (!fence) {
      throw new GeofenceError(
        "The pilot service area has not been configured yet",
        undefined,
        "GEOFENCE_NOT_CONFIGURED"
      );
    }

    if (!isInsideGeofence(pin, fence)) {
      throw new GeofenceError(
        "This location is outside the pilot service area",
        {
          fence: {
            minLat: fence.minLat,
            maxLat: fence.maxLat,
            minLng: fence.minLng,
            maxLng: fence.maxLng,
          },
        }
      );
    }

    const request = await this.repo.createRequest({
      buyerCompanyId: company.id,
      createdByUserId: caller.userId,
      gallons,
      productType,
      deliveryMethod,
      deliveryWindow,
      pinLat: pin.lat,
      pinLng: pin.lng,
      notes,
      status: "open",
      windowEndsAt: deliveryWindowEndsAt(deliveryWindow, now),
      createdAt: new Date(now.getTime()),
    });

    // Requirement 13.1. Awaited so the pilot's SMS actually goes out before the
    // response, but never allowed to fail the creation — see `notifyNewRfq`.
    await this.notifyNewRfq(request, now);

    return request;
  }

  /**
   * Fires NEW_RFQ to every matched Supplier Company's supplier users
   * (Requirement 13.1).
   *
   * Wrapped whole in a catch: the Request is already persisted by the time this
   * runs, so a matching read or a transport fault must not surface as a failed
   * post. `NotificationDispatcher.dispatch` already isolates per-recipient and
   * per-channel failures (Requirement 13.7); this outer guard covers the steps
   * around it — the supplier lookup and the user reads.
   *
   * Recipients are the `supplier`-role users of each matched Company. Admin or
   * buyer-role users who happen to sit on a supplier company are skipped: an RFQ
   * alert is dispatcher work, and notifying the wrong seat is how a pilot trains
   * people to ignore the messages.
   */
  private async notifyNewRfq(request: Request, now: Date): Promise<void> {
    if (!this.matching || !this.notifier) return;

    try {
      // `now` is threaded through so matching evaluates the load against the
      // caller's clock, never an ambient one.
      const suppliers = await this.matching.listMatchedSuppliers(request, now);
      if (suppliers.length === 0) return;

      const recipients: Recipient[] = [];
      for (const supplier of suppliers) {
        const users = await this.repo.listUsersByCompany(supplier.id);
        for (const user of users) {
          if (user.role === "supplier") recipients.push(recipientFromUser(user));
        }
      }
      if (recipients.length === 0) return;

      await this.notifier.dispatch("NEW_RFQ", recipients, newRfqMessage(request));
    } catch {
      // Swallowed deliberately: notification is never a precondition of a
      // posted load. Transport-level failures are already in the failure log.
    }
  }

  /**
   * Cancels an Open Request (Requirements 9.1, 9.2, 9.5).
   *
   * Owner-only: the Request is read before the guard so the ownership check has
   * a company to scope against, which also makes a missing Request and another
   * Company's Request indistinguishable 403s — no probing load ids
   * (Requirement 9.5).
   *
   * Write order mirrors acceptance: flip the status first, then void the quotes.
   * The status flip is the claim that makes the load unquotable and
   * unacceptable; a void that fails afterwards leaves quotes flagged active on a
   * Cancelled load, which is visible and inert rather than acceptable.
   *
   * A stale Open Request whose window has already ended is deliberately NOT
   * expired first here. The Buyer is standing in front of the load asking to
   * cancel it, both exits are terminal and both void the same quotes, and
   * "Cancelled" is the truthful record of why it ended. Turning an explicit
   * cancel into a `REQUEST_NOT_OPEN` rejection would be a worse answer for the
   * superintendent and no better for the ledger.
   */
  async cancelRequest(
    ctx: AuthContext,
    requestId: string,
    now: Date = new Date()
  ): Promise<Request> {
    const id = typeof requestId === "string" ? requestId.trim() : "";
    const found = id === "" ? null : await this.repo.getRequest(id);

    requireAction(ctx, "request.cancel", { companyId: found?.buyerCompanyId });

    const load = found as Request;

    // Requirement 9.2 — only an Open load can be cancelled. Covers a second
    // cancel, a won load, and an already-expired one.
    if (load.status !== "open") {
      throw new ConflictError(
        "REQUEST_NOT_OPEN",
        "Only an open load can be cancelled"
      );
    }

    const cancelled = await this.repo.updateRequest(load.id, {
      status: "cancelled",
    });

    // Requirement 9.1 — the same voiding path acceptance and expiry use.
    await voidActiveOffersOnRequest(this.repo, load.id);

    // Requirement 14.3 — who cancelled, and the status it moved from and to.
    await this.auditRequestExit(cancelled, load.status, ctx.userId, now);

    return cancelled;
  }

  /**
   * Expires a Request whose Delivery_Window has ended (Requirement 9.3).
   *
   * System-driven, so there is no `AuthContext`: nobody decides this, the clock
   * does. That is also why it is safe to call from any read path — see
   * `expireIfWindowEnded`, which is the evaluator the read paths and the RFQ
   * inbox share.
   *
   * Returns the Request as it now stands, unchanged when it was not expirable.
   */
  async expireRequest(requestId: string, now: Date = new Date()): Promise<Request> {
    const id = typeof requestId === "string" ? requestId.trim() : "";
    const found = id === "" ? null : await this.repo.getRequest(id);
    if (!found) {
      throw new ValidationError(
        "REQUEST_NOT_FOUND",
        "No such request",
        "requestId"
      );
    }
    return this.expireIfWindowEnded(found, now);
  }

  /**
   * The lazy expiry evaluator (Requirement 9.3): flips an Open Request past its
   * `windowEndsAt` to Expired and voids what is left of its quotes, then hands
   * back the current record.
   *
   * Structurally implements the `RequestExpiryEvaluator` port in `matching.ts`,
   * which is how the supplier RFQ inbox evaluates expiry without importing this
   * module (Requirement 9.4).
   *
   * Idempotent and cheap: a Request that is not Open, or whose window has not
   * ended, is returned untouched with no write at all. The re-read before the
   * write is the same guard acceptance uses — a load claimed between the caller's
   * read and this write (accepted or cancelled in the meantime) keeps that newer
   * status rather than being overwritten with Expired.
   */
  async expireIfWindowEnded(
    request: Request,
    now: Date = new Date()
  ): Promise<Request> {
    if (request == null) return request;
    if (request.status !== "open") return request;
    if (!hasWindowEnded(request, now)) return request;

    const current = await this.repo.getRequest(request.id);
    if (!current) return request;
    if (current.status !== "open") return current;

    const expired = await this.repo.updateRequest(current.id, {
      status: "expired",
    });

    // Requirement 9.3 — void what is left, through the shared helper.
    await voidActiveOffersOnRequest(this.repo, current.id);

    // Requirement 14.3 — expiry is system-driven, so the row has no actor.
    await this.auditRequestExit(expired, current.status, null, now);

    return expired;
  }

  /**
   * Appends the entry for a Request leaving Open (Requirement 14.3): the acting
   * User where any, the Request, the prior and new Request_Status, and the
   * timestamp.
   *
   * `actorUserId` is null for window-end expiry — nobody decided it, the clock
   * did — which is exactly the case `AuditEntry.actorUserId` is nullable for.
   *
   * Called only after the status write has landed, and swallowed on failure for
   * the same reason as elsewhere: the load has already left Open and its quotes
   * are already voided, so an audit fault must not report a failed cancel that
   * a retry would then reject as `REQUEST_NOT_OPEN`. The row is reconstructible
   * from the Request; a phantom rejection is not.
   */
  private async auditRequestExit(
    request: Request,
    priorStatus: Request["status"],
    actorUserId: string | null,
    now: Date
  ): Promise<void> {
    if (!this.audit) return;

    try {
      if (request.status === "expired") {
        await this.audit.requestExpired(
          request,
          priorStatus,
          request.status,
          now
        );
      } else {
        await this.audit.requestCancelled(
          actorUserId,
          request,
          priorStatus,
          request.status,
          now
        );
      }
    } catch {
      // See above: recoverable from the Request row, so never fatal.
    }
  }

  /**
   * Reads one of the Company's Requests, evaluating window-end expiry first
   * (Requirements 9.3, 3.9 scope).
   *
   * Owner-scoped exactly like the work list, and the read is where a stale load
   * actually flips to Expired, so the status a Buyer sees is never one the clock
   * has already invalidated.
   */
  async getRequest(
    ctx: AuthContext,
    requestId: string,
    now: Date = new Date()
  ): Promise<Request> {
    const id = typeof requestId === "string" ? requestId.trim() : "";
    const found = id === "" ? null : await this.repo.getRequest(id);

    requireAction(ctx, "request.list", { companyId: found?.buyerCompanyId });

    return this.expireIfWindowEnded(found as Request, now);
  }

  /**
   * The Buyer work list: the Company's Open Requests plus the Company's Orders
   * (Requirement 3.9).
   *
   * Window-end expiry is evaluated on the way through (Requirement 9.3), so a
   * load whose window has lapsed drops off the list and is recorded Expired in
   * the same pass instead of sitting on the work list looking live.
   *
   * `companyId` defaults to the caller's own Company; asking for another
   * Company's list is denied with an authorization error by the `own_company`
   * scope, so tenant isolation is enforced rather than merely filtered.
   */
  async getWorkList(
    ctx: AuthContext,
    companyId?: string,
    now: Date = new Date()
  ): Promise<BuyerWorkList> {
    const target = companyId ?? ctx?.companyId;
    requireAction(ctx, "request.list", { companyId: target });

    const [requests, orders] = await Promise.all([
      this.repo.listRequestsByBuyerCompany(target as string),
      this.repo.listOrdersByBuyerCompany(target as string),
    ]);

    const live: Request[] = [];
    for (const request of requests) {
      // Sequential, not Promise.all: each evaluation may write, and the pilot's
      // repository has no transactions.
      const evaluated = await this.expireIfWindowEnded(request, now);
      if (evaluated.status === "open") live.push(evaluated);
    }

    return { requests: live, orders };
  }
}
