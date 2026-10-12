/**
 * RFQ matching — which Supplier Companies see a Request, and which Requests
 * land in a supplier's inbox.
 *
 * Requirements:
 *   4.1 a Request is visible to a Supplier Company only where ALL hold:
 *       Supplier_Approval_Status is Approved, Supplier_Status is Open or
 *       Limited, the pin is within the Company's Service_Radius of its
 *       Operating_Location, and Request_Status is Open.
 *   4.3 the RFQ inbox returns only Requests satisfying that rule.
 *   4.4 an out-of-radius pin excludes the Request from that Company's inbox.
 *   4.5 Cancelled and Expired Requests are excluded from every inbox.
 *   4.6 a Closed Supplier Company is excluded from matching.
 *   4.7 the Operating_Location and Service_Radius used are the Admin-configured
 *       values (task 3.2) — matching reads them, never sets them.
 *   5.3 an Open or Limited Supplier Company is included for in-radius Requests.
 *   9.4 Cancelled and Expired Requests never surface in supplier inboxes.
 *  16.3 a Pending Supplier Company is excluded from matching.
 *
 * The predicate is pure (`isEligibleSupplier` / `matchSuppliers`) and is the
 * single decision point: both directions of the same relation — "who sees this
 * Request" (used by NEW_RFQ dispatch on creation) and "what does this supplier
 * see" (the inbox) — run through it, so the two can never disagree.
 *
 * ## Window-end expiry
 *
 * A Request whose Delivery_Window has already ended is not inbox-visible
 * (`isWindowStillOpen`), and where a `RequestExpiryEvaluator` is wired this
 * module also has it recorded Expired as it reads (Requirement 9.3) so the
 * ledger agrees with the inbox. The mutation itself lives in the Request
 * service; the port below is how it gets here without a dependency cycle.
 *
 * Because the Request service depends on this one (for NEW_RFQ dispatch) and
 * this one depends on that evaluator, wiring the pair is a knot. Tie it with a
 * thunk rather than a mutable field:
 *
 * ```ts
 * let requests!: RequestService;
 * const matching = new MatchingService({
 *   repo,
 *   expiry: { expireIfWindowEnded: (r, n) => requests.expireIfWindowEnded(r, n) },
 * });
 * requests = new RequestService({ repo, admin, matching, notifier });
 * ```
 *
 * `isEligibleSupplier` deliberately stays status-only and clock-free — the
 * window check is an inbox concern layered on top — which keeps the matching
 * predicate a pure function of (Request, Supplier Company) exactly as
 * Requirement 4.1 states it.
 */

import {
  type AuthContext,
  type Company,
  type LatLng,
  type Request,
} from "@/domain/types";
import type { Repository } from "@/repository/repository";
import { requireAction } from "./authorization";
import { isWithinRadius, operatingLocationOf } from "./geo";
import { isMatchableSupplierStatus } from "./supplier";

/** The Request fields matching depends on: the pin and the status. */
export type MatchableRequest = Pick<Request, "pinLat" | "pinLng" | "status">;

/** The Supplier Company fields matching depends on (all Admin-set but status). */
export type MatchableSupplier = Pick<
  Company,
  | "kind"
  | "supplierApprovalStatus"
  | "supplierStatus"
  | "operatingLat"
  | "operatingLng"
  | "serviceRadiusMiles"
>;

/** The Request's delivery pin as a coordinate pair. */
export function requestPin(request: Pick<Request, "pinLat" | "pinLng">): LatLng {
  return { lat: request.pinLat, lng: request.pinLng };
}

/**
 * True when `request` is Open — the only Request_Status that matches
 * (Requirements 4.1, 4.5, 9.4). Accepted, Cancelled, and Expired all fail here,
 * which is what keeps a won, withdrawn, or stale load out of every inbox.
 */
export function isMatchableRequestStatus(
  request: Pick<Request, "status"> | null | undefined
): boolean {
  return request?.status === "open";
}

/**
 * True when the Request's Delivery_Window has not ended yet. Used by the inbox
 * only — see the module note on task 8.2. Inclusive of the boundary in the
 * supplier's favour is NOT the choice here: a window that ends exactly `now` is
 * over, so the comparison is strict (`windowEndsAt > now`).
 */
export function isWindowStillOpen(
  request: Pick<Request, "windowEndsAt">,
  now: Date
): boolean {
  const endsAt = request?.windowEndsAt;
  if (!(endsAt instanceof Date) || Number.isNaN(endsAt.getTime())) {
    // A malformed window end cannot be shown to be live, so fail closed.
    return false;
  }
  return endsAt.getTime() > now.getTime();
}

/**
 * The matching predicate (Requirement 4.1): every condition is required, and
 * each one on its own is sufficient to exclude.
 *
 * Fails closed throughout — a buyer company, a supplier with no Admin-set
 * Operating_Location or Service_Radius, a null status, or a malformed
 * coordinate all return false. An unconfigured supplier receives nothing rather
 * than everything.
 */
export function isEligibleSupplier(
  request: MatchableRequest,
  supplier: MatchableSupplier
): boolean {
  if (request == null || supplier == null) return false;

  // Supplier-only fields; a buyer company never matches. (Req 4.1)
  if (supplier.kind !== "supplier") return false;

  // Admin approval (Requirements 4.1, 16.3).
  if (supplier.supplierApprovalStatus !== "approved") return false;

  // Availability: Open or Limited, never Closed (Requirements 4.6, 5.3).
  if (!isMatchableSupplierStatus(supplier.supplierStatus)) return false;

  // Only Open Requests match (Requirements 4.1, 4.5, 9.4).
  if (!isMatchableRequestStatus(request)) return false;

  // Admin-configured radius around the Admin-configured origin
  // (Requirements 4.2, 4.4, 4.7).
  return isWithinRadius(
    requestPin(request),
    operatingLocationOf(supplier),
    supplier.serviceRadiusMiles
  );
}

/**
 * The Supplier Companies eligible to receive `request`, preserving input order.
 * Returns an empty list — never throws — for a non-Open Request, which is what
 * makes it safe to call unconditionally on the NEW_RFQ path.
 */
export function matchSuppliers<T extends MatchableSupplier>(
  request: MatchableRequest,
  suppliers: readonly T[]
): T[] {
  if (!Array.isArray(suppliers)) return [];
  return suppliers.filter((supplier) => isEligibleSupplier(request, supplier));
}

/**
 * A Request as it may arrive here: always matchable, and carrying its id and
 * window end when it came from the repository. The optional halves are what
 * makes lazy expiry possible without forcing every caller to hand over a full
 * record.
 */
export type MaybePersistedRequest = MatchableRequest &
  Partial<Pick<Request, "id" | "windowEndsAt">>;

/**
 * The window-end expiry port (Requirement 9.3), implemented by
 * `RequestService.expireIfWindowEnded`.
 *
 * Declared here rather than imported from `request.ts` on purpose: matching is
 * the lower layer (the Request service depends on it for NEW_RFQ dispatch), so
 * inverting the dependency keeps the two modules acyclic while still letting the
 * inbox flip a stale load to Expired the moment a dispatcher looks at it
 * (Requirement 9.4).
 */
export interface RequestExpiryEvaluator {
  expireIfWindowEnded(request: Request, now: Date): Promise<Request>;
}

export interface MatchingServiceDeps {
  repo: Repository;
  /**
   * Evaluates window-end expiry on the loads this service reads. Optional: omit
   * it and matching behaves exactly as before — past-window Requests are still
   * filtered out of the inbox, just not recorded Expired.
   */
  expiry?: RequestExpiryEvaluator;
}

export class MatchingService {
  private readonly repo: Repository;
  private readonly expiry?: RequestExpiryEvaluator;

  constructor(deps: MatchingServiceDeps) {
    this.repo = deps.repo;
    this.expiry = deps.expiry;
  }

  /**
   * Every Supplier Company that should see `request` (Requirement 4.1). This is
   * the read the NEW_RFQ dispatch uses on Request creation, so the suppliers
   * notified are exactly the suppliers whose inbox will show the load.
   */
  async listMatchedSuppliers(
    request: MaybePersistedRequest,
    now: Date = new Date()
  ): Promise<Company[]> {
    const evaluated = await this.evaluateExpiry(request, now);
    // Cancelled and Expired match nothing (Requirements 4.5, 9.4) — including a
    // load the evaluation above has just expired.
    if (!isMatchableRequestStatus(evaluated)) return [];
    const suppliers = await this.repo.listSupplierCompanies();
    return matchSuppliers(evaluated, suppliers);
  }

  /**
   * The supplier RFQ inbox (Requirement 4.3): the Open Requests this Supplier
   * Company is eligible for, newest first.
   *
   * Only `open` Requests are read, so Accepted, Cancelled, and Expired are
   * excluded structurally (Requirements 4.5, 9.4) as well as by the predicate.
   * Requests whose Delivery_Window has already ended are filtered out as well,
   * and — where an expiry evaluator is wired — recorded Expired in the same pass
   * (Requirement 9.3), which is what keeps the inbox and the ledger agreeing.
   *
   * `companyId` defaults to the caller's own Company; asking for another
   * Company's inbox is denied by the `own_company` scope rather than filtered,
   * so a supplier cannot read a competitor's RFQ flow.
   */
  async listRfqInbox(
    ctx: AuthContext,
    companyId?: string,
    now: Date = new Date()
  ): Promise<Request[]> {
    const target = companyId ?? ctx?.companyId;
    requireAction(ctx, "rfq.list", { companyId: target });

    const company = await this.repo.getCompany(target as string);
    /**
     * Fail closed on a missing company, or a supplier-role user attached to a
     * buyer company (a data defect): an empty inbox, not an error and certainly
     * not an unfiltered one.
     */
    if (!company || company.kind !== "supplier") return [];

    const openRequests = await this.repo.listRequestsByStatus("open");

    const live: Request[] = [];
    for (const request of openRequests) {
      // Sequential: each evaluation may write, and the pilot's repository has no
      // transactions.
      const evaluated = (await this.evaluateExpiry(request, now)) as Request;
      if (!isMatchableRequestStatus(evaluated)) continue;
      if (!isEligibleSupplier(evaluated, company)) continue;
      // Belt and braces: a past-window load stays out of the inbox even when no
      // evaluator is wired, or when its expiry write failed.
      if (!isWindowStillOpen(evaluated, now)) continue;
      live.push(evaluated);
    }

    return live.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Runs window-end expiry on a load, where that is possible and wired
   * (Requirement 9.3). Returns the record to match against.
   *
   * Never throws: a failed expiry write leaves the original record, which the
   * `isWindowStillOpen` filter still keeps out of the inbox. A dispatcher's
   * inbox going blank because a bookkeeping write failed would be the worse
   * outcome.
   */
  private async evaluateExpiry(
    request: MaybePersistedRequest,
    now: Date
  ): Promise<MaybePersistedRequest> {
    if (!this.expiry) return request;
    if (request?.status !== "open") return request;
    if (typeof request.id !== "string" || !(request.windowEndsAt instanceof Date)) {
      return request;
    }
    try {
      return await this.expiry.expireIfWindowEnded(request as Request, now);
    } catch {
      return request;
    }
  }
}
