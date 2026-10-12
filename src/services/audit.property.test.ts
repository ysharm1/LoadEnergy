/**
 * Property-based tests for the audit log: the row every audited action leaves
 * behind, and the guarantee that no row ever changes once it has landed.
 *
 * Feature: load-energy — Property 34 (task 12.4), Property 35 (task 12.5).
 *
 * The subject is real throughout: the real `AuditService` over the real
 * `InMemoryRepository`, wired into the real `OfferService`, `OrderService`,
 * `RequestService` and `CommissionService` exactly as production wires them.
 * Every audited row under test is produced by driving the marketplace — a quote
 * submitted, a load won, a window ended, a BOL recorded, an invoice settled —
 * never by calling `append` directly, so what is checked is the wiring as much
 * as the service. Nothing under test is mocked.
 *
 * Expected rows are built here from the entities the services returned, so the
 * assertion never reuses the payload the service assembled.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_HOLD_HOURS,
  MIN_HOLD_HOURS,
  type AuditEntry,
  type AuthContext,
  type Offer,
  type Order,
  type Request,
} from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import { AdminService } from "./admin";
import { AuditService } from "./audit";
import { CommissionService } from "./commission";
import { MatchingService } from "./matching";
import { OfferService } from "./offer";
import { OrderService } from "./order";
import { RequestService } from "./request";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A pin inside the pilot box, and the supplier's yard on top of it. */
const BUCKEYE = { lat: 33.3703, lng: -112.5838 };
const PILOT_FENCE = {
  minLat: 32.9,
  maxLat: 33.8,
  minLng: -112.9,
  maxLng: -111.9,
};
const SERVICE_RADIUS_MILES = 50;

// ---------------------------------------------------------------------------
// Harness — one Buyer Company, one approved Supplier Company, one Admin
// ---------------------------------------------------------------------------

interface Harness {
  repo: InMemoryRepository;
  audit: AuditService;
  requests: RequestService;
  offers: OfferService;
  orders: OrderService;
  commission: CommissionService;
  admin: AuthContext;
  buyer: AuthContext;
  supplier: AuthContext;
  buyerCompanyId: string;
  supplierCompanyId: string;
  /** Monotonic BOL ticket numbers, so a load is identifiable in a failure. */
  nextTicket(): string;
}

async function makeHarness(createdAt: Date): Promise<Harness> {
  const repo = new InMemoryRepository();
  const audit = new AuditService({ repo });
  const adminService = new AdminService({ repo });
  const matching = new MatchingService({ repo });
  const commission = new CommissionService({ repo, audit });
  const offers = new OfferService({ repo, audit });
  const orders = new OrderService({ repo, audit, commission });
  const requests = new RequestService({
    repo,
    admin: adminService,
    matching,
    audit,
  });

  const buyerCo = await repo.createCompany({
    name: "SW Valley Concrete",
    kind: "buyer",
    supplierApprovalStatus: null,
    supplierStatus: null,
    operatingLat: null,
    operatingLng: null,
    serviceRadiusMiles: null,
    createdAt,
  });
  const supplierCo = await repo.createCompany({
    name: "Buckeye Diesel",
    kind: "supplier",
    supplierApprovalStatus: "approved",
    supplierStatus: "open",
    operatingLat: BUCKEYE.lat,
    operatingLng: BUCKEYE.lng,
    serviceRadiusMiles: SERVICE_RADIUS_MILES,
    createdAt,
  });

  async function seat(
    companyId: string,
    role: AuthContext["role"],
    phone: string
  ): Promise<AuthContext> {
    const user = await repo.createUser({
      companyId,
      role,
      phone,
      email: null,
      passwordHash: "hash",
      createdAt,
    });
    return { userId: user.id, companyId, role };
  }

  const admin = await seat(buyerCo.id, "admin", "+16025550100");
  const buyer = await seat(buyerCo.id, "buyer", "+16025550101");
  const supplier = await seat(supplierCo.id, "supplier", "+16025550201");

  // The fence is Admin config, so it is set through the Admin service.
  await adminService.setGeofence(admin, PILOT_FENCE, createdAt);

  let ticket = 0;

  return {
    repo,
    audit,
    requests,
    offers,
    orders,
    commission,
    admin,
    buyer,
    supplier,
    buyerCompanyId: buyerCo.id,
    supplierCompanyId: supplierCo.id,
    nextTicket: () => {
      ticket += 1;
      return `BOL-${String(ticket).padStart(5, "0")}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Marketplace helpers — every load is posted, quoted, and won for real
// ---------------------------------------------------------------------------

async function postRequest(
  h: Harness,
  gallons: number,
  at: Date
): Promise<Request> {
  return h.requests.createRequest(
    h.buyer,
    {
      gallons,
      productType: "ulsd",
      deliveryMethod: "wet_hose",
      deliveryWindow: "today",
      lat: BUCKEYE.lat,
      lng: BUCKEYE.lng,
    },
    at
  );
}

async function postOffer(
  h: Harness,
  requestId: string,
  priceCents: number,
  holdHours: number,
  at: Date
): Promise<Offer> {
  return h.offers.createOffer(
    h.supplier,
    { requestId, landedPricePerGal: priceCents / 100, holdHours },
    at
  );
}

/** A won (Accepted) Order, with no Delivery yet. */
async function wonOrder(
  h: Harness,
  params: StepParams,
  at: Date
): Promise<Order> {
  const request = await postRequest(h, params.gallons, at);
  const offer = await postOffer(
    h,
    request.id,
    params.priceCents,
    params.holdHours,
    at
  );
  return h.orders.acceptOffer(h.buyer, offer.id, at);
}

/** A won Order carried to Delivered with its BOL and invoice on file. */
async function deliveredOrder(
  h: Harness,
  params: StepParams,
  at: Date
): Promise<Order> {
  const order = await wonOrder(h, params, at);
  await h.orders.recordDelivery(
    h.supplier,
    order.id,
    { bolGallons: params.gallons, ticketNumber: h.nextTicket() },
    at
  );
  return order;
}

// ---------------------------------------------------------------------------
// Observing the log around one step
// ---------------------------------------------------------------------------

interface Observation<T> {
  before: AuditEntry[];
  after: AuditEntry[];
  /** Exactly what this step added, in order. */
  appended: AuditEntry[];
  beforeCount: number;
  afterCount: number;
  result: T;
}

/** Runs one step and reports what it did to the log. */
async function observe<T>(
  h: Harness,
  run: () => Promise<T>
): Promise<Observation<T>> {
  const before = await h.audit.list();
  const beforeCount = await h.audit.count();
  const result = await run();
  const after = await h.audit.list();
  return {
    before,
    after,
    appended: after.slice(before.length),
    beforeCount,
    afterCount: await h.audit.count(),
    result,
  };
}

/** Runs a step that must be rejected, and reports what it did to the log. */
async function observeRejection(
  h: Harness,
  run: () => Promise<unknown>
): Promise<Observation<{ code: unknown }>> {
  return observe(h, async () => {
    try {
      await run();
    } catch (error) {
      return { code: (error as { code?: unknown })?.code };
    }
    throw new Error("this step was expected to be rejected but succeeded");
  });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** The seven audited actions (Requirements 14.1-14.6, 17.4). */
type AuditedKind =
  | "offer_submitted"
  | "offer_accepted"
  | "request_cancelled"
  | "request_expired"
  | "order_status_changed"
  | "concierge_created"
  | "invoice_paid";

/** Actions the marketplace refuses — nothing may be written for these. */
type RejectedKind =
  | "accept_expired_offer"
  | "cancel_settled_request"
  | "backward_status"
  | "concierge_by_non_admin"
  | "repeat_invoice_paid";

interface StepParams {
  gallons: number;
  priceCents: number;
  holdHours: number;
  /** Optional on the concierge path (Requirement 17.2). */
  ticketNumber: string | null;
  /** Which way an Order_Status change is driven (Requirements 10.2, 11.1). */
  statusRoute: "advance" | "deliver";
  offsetMinutes: number;
}

type Step =
  | { outcome: "audited"; kind: AuditedKind; params: StepParams }
  | { outcome: "rejected"; kind: RejectedKind; params: StepParams };

/** The row a step is expected to have appended. */
interface Expectation {
  label: string;
  action: AuditEntry["action"];
  /** Null for system-driven window-end expiry (Requirement 14.3). */
  actorUserId: string | null;
  subjectId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Drives one audited action for real and returns both what the log recorded
 * and, built independently from the entities the services returned, the row it
 * should have recorded.
 *
 * Setup for each step happens before the observation window opens, so the
 * window contains the audited action and nothing else. The action instant is
 * deliberately later than its setup, so a row carrying the setup's clock rather
 * than the action's would be caught.
 */
async function runAudited(
  h: Harness,
  kind: AuditedKind,
  params: StepParams,
  at: Date
): Promise<{ expected: Expectation; observation: Observation<unknown> }> {
  const actionAt = new Date(at.getTime() + params.offsetMinutes * MINUTE);

  switch (kind) {
    // Requirement 14.1 — the acting User, the Supplier Company, the Request.
    case "offer_submitted": {
      const request = await postRequest(h, params.gallons, at);
      const observation = await observe(h, () =>
        postOffer(
          h,
          request.id,
          params.priceCents,
          params.holdHours,
          actionAt
        )
      );
      const offer = observation.result as Offer;
      return {
        observation,
        expected: {
          label: `offer_submitted on ${params.gallons} gal`,
          action: "OFFER_SUBMITTED",
          actorUserId: h.supplier.userId,
          subjectId: offer.id,
          payload: {
            offerId: offer.id,
            requestId: request.id,
            supplierCompanyId: h.supplierCompanyId,
            buyerCompanyId: h.buyerCompanyId,
          },
          createdAt: actionAt,
        },
      };
    }

    // Requirement 14.2 — the acting User, the accepted Offer, the Order.
    case "offer_accepted": {
      const request = await postRequest(h, params.gallons, at);
      const offer = await postOffer(
        h,
        request.id,
        params.priceCents,
        params.holdHours,
        at
      );
      // Inside the hold, so the acceptance is admissible (Requirement 7.1).
      const acceptAt = new Date(
        at.getTime() +
          Math.min(params.offsetMinutes, params.holdHours * 60 - 1) * MINUTE
      );
      const observation = await observe(h, () =>
        h.orders.acceptOffer(h.buyer, offer.id, acceptAt)
      );
      const order = observation.result as Order;
      return {
        observation,
        expected: {
          label: `offer_accepted on ${params.gallons} gal`,
          action: "OFFER_ACCEPTED",
          actorUserId: h.buyer.userId,
          subjectId: order.id,
          payload: {
            orderId: order.id,
            offerId: offer.id,
            requestId: request.id,
            buyerCompanyId: h.buyerCompanyId,
            supplierCompanyId: h.supplierCompanyId,
          },
          createdAt: acceptAt,
        },
      };
    }

    // Requirement 14.3 — the acting User, the Request, both statuses.
    case "request_cancelled": {
      const request = await postRequest(h, params.gallons, at);
      const observation = await observe(h, () =>
        h.requests.cancelRequest(h.buyer, request.id, actionAt)
      );
      return {
        observation,
        expected: {
          label: `request_cancelled on ${params.gallons} gal`,
          action: "REQUEST_CANCELLED",
          actorUserId: h.buyer.userId,
          subjectId: request.id,
          payload: {
            requestId: request.id,
            buyerCompanyId: h.buyerCompanyId,
            priorStatus: "open",
            newStatus: "cancelled",
          },
          createdAt: actionAt,
        },
      };
    }

    /**
     * Requirement 14.3, the "where any" half: window-end expiry is driven by
     * the clock, so the row has no acting User.
     */
    case "request_expired": {
      const request = await postRequest(h, params.gallons, at);
      const expireAt = new Date(
        request.windowEndsAt.getTime() + params.offsetMinutes * MINUTE
      );
      const observation = await observe(h, () =>
        h.requests.expireRequest(request.id, expireAt)
      );
      return {
        observation,
        expected: {
          label: `request_expired on ${params.gallons} gal`,
          action: "REQUEST_EXPIRED",
          actorUserId: null,
          subjectId: request.id,
          payload: {
            requestId: request.id,
            buyerCompanyId: h.buyerCompanyId,
            priorStatus: "open",
            newStatus: "expired",
          },
          createdAt: expireAt,
        },
      };
    }

    /**
     * Requirement 14.4 — the prior and new status, by both routes to a status
     * change: the explicit en-route tap and recording the BOL, which carries
     * the Delivery on the row.
     */
    case "order_status_changed": {
      const order = await wonOrder(h, params, at);
      if (params.statusRoute === "advance") {
        const observation = await observe(h, () =>
          h.orders.advanceStatus(h.supplier, order.id, "en_route", actionAt)
        );
        return {
          observation,
          expected: {
            label: `order_status_changed (advance) on ${params.gallons} gal`,
            action: "STATUS_CHANGED",
            actorUserId: h.supplier.userId,
            subjectId: order.id,
            payload: {
              orderId: order.id,
              buyerCompanyId: h.buyerCompanyId,
              supplierCompanyId: h.supplierCompanyId,
              priorStatus: "accepted",
              newStatus: "en_route",
            },
            createdAt: actionAt,
          },
        };
      }

      const ticketNumber = h.nextTicket();
      const observation = await observe(h, () =>
        h.orders.recordDelivery(
          h.supplier,
          order.id,
          { bolGallons: params.gallons, ticketNumber },
          actionAt
        )
      );
      const delivery = observation.result as { id: string };
      return {
        observation,
        expected: {
          label: `order_status_changed (deliver) on ${params.gallons} gal`,
          action: "STATUS_CHANGED",
          actorUserId: h.supplier.userId,
          subjectId: order.id,
          payload: {
            orderId: order.id,
            buyerCompanyId: h.buyerCompanyId,
            supplierCompanyId: h.supplierCompanyId,
            priorStatus: "accepted",
            newStatus: "delivered",
            deliveryId: delivery.id,
            bolGallons: params.gallons,
          },
          createdAt: actionAt,
        },
      };
    }

    // Requirements 14.5, 17.4 — the acting Admin, the Order, the timestamp.
    case "concierge_created": {
      const observation = await observe(h, () =>
        h.orders.createConciergeOrder(
          h.admin,
          {
            buyerCompanyId: h.buyerCompanyId,
            supplierCompanyId: h.supplierCompanyId,
            bolGallons: params.gallons,
            ticketNumber: params.ticketNumber,
          },
          actionAt
        )
      );
      const order = observation.result as Order;
      const delivery = await h.repo.getDeliveryByOrder(order.id);
      const invoice = await h.commission.getInvoiceByOrder(order.id);
      return {
        observation,
        expected: {
          label: `concierge_created on ${params.gallons} gal`,
          action: "CONCIERGE_CREATED",
          actorUserId: h.admin.userId,
          subjectId: order.id,
          payload: {
            orderId: order.id,
            buyerCompanyId: h.buyerCompanyId,
            supplierCompanyId: h.supplierCompanyId,
            status: "delivered",
            deliveryId: delivery?.id,
            bolGallons: params.gallons,
            ticketNumber: params.ticketNumber,
            invoiceId: invoice?.id ?? null,
            invoiceAmount: invoice?.amount ?? null,
            invoiceWaived: invoice?.waived ?? null,
          },
          createdAt: actionAt,
        },
      };
    }

    // Requirement 14.6 — the acting Admin, the invoice, both payment statuses.
    case "invoice_paid": {
      const order = await deliveredOrder(h, params, at);
      const invoice = await h.commission.getInvoiceByOrder(order.id);
      const paidAt = actionAt;
      const observation = await observe(h, () =>
        h.commission.markInvoicePaid(h.admin, invoice!.id, paidAt)
      );
      return {
        observation,
        expected: {
          label: `invoice_paid on ${params.gallons} gal`,
          action: "INVOICE_PAID",
          actorUserId: h.admin.userId,
          subjectId: invoice!.id,
          payload: {
            invoiceId: invoice!.id,
            orderId: order.id,
            supplierCompanyId: h.supplierCompanyId,
            amount: invoice!.amount,
            priorStatus: "unpaid",
            newStatus: "paid",
          },
          createdAt: paidAt,
        },
      };
    }
  }
}

/** What a refused step is expected to look like. */
interface RejectedOutcome {
  label: string;
  /** Null where the action is a tolerated no-op rather than an error. */
  code: string | null;
  observation: Observation<unknown>;
}

/**
 * Drives one action the marketplace refuses. An action that did not happen has
 * nothing to record, so each of these must leave the log untouched — the audit
 * log is a record of what occurred, not of what was attempted.
 */
async function runRejected(
  h: Harness,
  kind: RejectedKind,
  params: StepParams,
  at: Date
): Promise<RejectedOutcome> {
  const actionAt = new Date(at.getTime() + params.offsetMinutes * MINUTE);

  switch (kind) {
    // Requirement 7.3 — the hold lapsed, so there is no acceptance to audit.
    case "accept_expired_offer": {
      const request = await postRequest(h, params.gallons, at);
      const offer = await postOffer(
        h,
        request.id,
        params.priceCents,
        params.holdHours,
        at
      );
      const lateAt = new Date(
        at.getTime() + params.holdHours * HOUR + params.offsetMinutes * MINUTE
      );
      return {
        label: "accept_expired_offer",
        code: "OFFER_EXPIRED",
        observation: await observeRejection(h, () =>
          h.orders.acceptOffer(h.buyer, offer.id, lateAt)
        ),
      };
    }

    // Requirement 9.2 — a second cancel changes nothing, so it records nothing.
    case "cancel_settled_request": {
      const request = await postRequest(h, params.gallons, at);
      await h.requests.cancelRequest(h.buyer, request.id, at);
      return {
        label: "cancel_settled_request",
        code: "REQUEST_NOT_OPEN",
        observation: await observeRejection(h, () =>
          h.requests.cancelRequest(h.buyer, request.id, actionAt)
        ),
      };
    }

    // Requirements 10.5, 14.4 — a refused backward move is not a status change.
    case "backward_status": {
      const order = await wonOrder(h, params, at);
      await h.orders.advanceStatus(h.supplier, order.id, "en_route", at);
      return {
        label: "backward_status",
        code: "ORDER_STATUS_BACKWARD",
        observation: await observeRejection(h, () =>
          h.orders.advanceStatus(h.supplier, order.id, "accepted", actionAt)
        ),
      };
    }

    // Requirement 17.5 — denied before anything is written.
    case "concierge_by_non_admin": {
      return {
        label: "concierge_by_non_admin",
        code: "ROLE_REQUIRED_ADMIN",
        observation: await observeRejection(h, () =>
          h.orders.createConciergeOrder(
            h.buyer,
            {
              buyerCompanyId: h.buyerCompanyId,
              supplierCompanyId: h.supplierCompanyId,
              bolGallons: params.gallons,
              ticketNumber: params.ticketNumber,
            },
            actionAt
          )
        ),
      };
    }

    /**
     * Requirements 12.6, 14.6 — a repeated tap on an already-Paid invoice is a
     * no-op rather than an error, and must not stack a second row claiming the
     * same payment twice.
     */
    case "repeat_invoice_paid": {
      const order = await deliveredOrder(h, params, at);
      const invoice = await h.commission.getInvoiceByOrder(order.id);
      await h.commission.markInvoicePaid(h.admin, invoice!.id, at);
      return {
        label: "repeat_invoice_paid",
        code: null,
        observation: await observe(h, () =>
          h.commission.markInvoicePaid(h.admin, invoice!.id, actionAt)
        ),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const auditedKind = fc.constantFrom<AuditedKind>(
  "offer_submitted",
  "offer_accepted",
  "request_cancelled",
  "request_expired",
  "order_status_changed",
  "concierge_created",
  "invoice_paid"
);

const rejectedKind = fc.constantFrom<RejectedKind>(
  "accept_expired_offer",
  "cancel_settled_request",
  "backward_status",
  "concierge_by_non_admin",
  "repeat_invoice_paid"
);

const stepParams: fc.Arbitrary<StepParams> = fc.record({
  // Whole gallons above zero, tanker-realistic plus the boundary at 1.
  gallons: fc.oneof(
    { arbitrary: fc.integer({ min: 1, max: 9_000 }), weight: 5 },
    { arbitrary: fc.constantFrom(1, 2, 500, 7_500), weight: 2 }
  ),
  priceCents: fc.integer({ min: 1, max: 900 }),
  holdHours: fc.integer({ min: MIN_HOLD_HOURS, max: MAX_HOLD_HOURS }),
  ticketNumber: fc.option(
    fc.integer({ min: 10_000, max: 99_999 }).map((n) => `T-${n}`),
    { nil: null }
  ),
  statusRoute: fc.constantFrom<StepParams["statusRoute"]>(
    "advance",
    "deliver"
  ),
  // Keeps the action instant strictly later than its setup.
  offsetMinutes: fc.integer({ min: 1, max: 600 }),
});

/** A mixed sequence: actions that happen, and actions the marketplace refuses. */
const steps = fc.array(
  fc.oneof(
    {
      arbitrary: fc
        .tuple(auditedKind, stepParams)
        .map(([kind, params]): Step => ({ outcome: "audited", kind, params })),
      weight: 3,
    },
    {
      arbitrary: fc
        .tuple(rejectedKind, stepParams)
        .map(([kind, params]): Step => ({ outcome: "rejected", kind, params })),
      weight: 1,
    }
  ),
  { minLength: 1, maxLength: 4 }
);

const instant = fc.date({
  min: new Date("2025-01-01T00:00:00.000Z"),
  max: new Date("2026-12-31T00:00:00.000Z"),
  noInvalidDate: true,
});

/** Byte-for-byte form of a run of entries, for comparing snapshots. */
function serialize(entries: AuditEntry[]): string {
  return JSON.stringify(entries);
}

// ---------------------------------------------------------------------------
// Property 34 (task 12.4) — Requirements 14.1-14.6, 17.4
// ---------------------------------------------------------------------------

describe("Property 34: Audited actions append matching entries", () => {
  // Feature: load-energy, Property 34: Audited actions append matching entries
  // **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 17.4**
  it("appends exactly one Audit_Log entry for any sequence of audited actions — offer submitted, offer accepted, request cancelled or expired, order status changed, concierge order created, invoice marked paid — each carrying the acting User where any (null for system-driven expiry), the subject entity ids, the prior and new values on every state change, and the action's own timestamp, and appends nothing at all for an action the marketplace refuses", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ sequence: steps, base: instant }),
        async ({ sequence, base }) => {
          const h = await makeHarness(base);
          const seen = new Set<string>();
          const observed: AuditEntry[] = [];
          let auditedSoFar = 0;

          for (const [index, step] of sequence.entries()) {
            // Each step gets its own day, so one step's clock cannot be
            // mistaken for another's.
            const at = new Date(base.getTime() + index * 3 * DAY);

            if (step.outcome === "rejected") {
              const { label, code, observation } = await runRejected(
                h,
                step.kind,
                step.params,
                at
              );
              const where = `step ${index}: ${label}`;

              if (code !== null) {
                expect(
                  (observation.result as { code?: unknown }).code,
                  where
                ).toBe(code);
              }
              // Nothing happened, so nothing is on the record.
              expect(observation.appended, where).toEqual([]);
              expect(observation.afterCount, where).toBe(
                observation.beforeCount
              );
              expect(serialize(observation.after), where).toBe(
                serialize(observation.before)
              );
              continue;
            }

            const { expected, observation } = await runAudited(
              h,
              step.kind,
              step.params,
              at
            );
            const where = `step ${index}: ${expected.label}`;

            // Exactly one row, and exactly one more row than before.
            expect(observation.appended, where).toHaveLength(1);
            expect(observation.afterCount, where).toBe(
              observation.beforeCount + 1
            );

            const entry = observation.appended[0];

            /**
             * The row itself: the action, the acting User where any — null for
             * window-end expiry (Requirement 14.3) — the subject, the entity
             * ids with the prior and new values where the action was a state
             * change, and the timestamp of the action rather than of its setup.
             */
            expect(entry.action, where).toBe(expected.action);
            expect(entry.actorUserId, where).toBe(expected.actorUserId);
            expect(entry.subjectId, where).toBe(expected.subjectId);
            expect(entry.payload, where).toEqual(expected.payload);
            expect(entry.createdAt.getTime(), where).toBe(
              expected.createdAt.getTime()
            );

            // A system-driven row names nobody; every other row names someone.
            if (step.kind === "request_expired") {
              expect(entry.actorUserId, where).toBeNull();
            } else {
              expect(typeof entry.actorUserId, where).toBe("string");
            }

            // Identifiable and distinct, so two rows are never one row.
            expect(typeof entry.id, where).toBe("string");
            expect(entry.id.length, where).toBeGreaterThan(0);
            expect(seen.has(entry.id), where).toBe(false);
            seen.add(entry.id);
            observed.push(entry);

            /**
             * Reachable by the subject — the dispute view. The entry is the
             * newest row about that entity, and every row in that view is
             * about it.
             */
            const bySubject = await h.audit.listBySubject(expected.subjectId);
            expect(bySubject.at(-1), where).toEqual(entry);
            for (const row of bySubject) {
              expect(row.subjectId, where).toBe(expected.subjectId);
            }

            auditedSoFar += 1;
          }

          /**
           * Every row observed above is still in the log, unchanged, and the
           * log holds exactly one row per audited action observed — the setup
           * each step needed (posting, quoting, winning a load) is audited too,
           * so the log is at least that long.
           */
          const finalLog = await h.audit.list();
          expect(await h.audit.count()).toBe(finalLog.length);
          expect(finalLog.length).toBeGreaterThanOrEqual(auditedSoFar);
          expect(finalLog.filter((row) => seen.has(row.id))).toHaveLength(
            auditedSoFar
          );
          for (const entry of observed) {
            expect(
              finalLog.find((row) => row.id === entry.id),
              `entry ${entry.action}`
            ).toEqual(entry);
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 35 (task 12.5) — Requirement 14.7
// ---------------------------------------------------------------------------

describe("Property 35: Audit log is append-only and monotonic", () => {
  // Feature: load-energy, Property 35: Audit log is append-only and monotonic
  // **Validates: Requirements 14.7**
  it("never modifies or removes an existing Audit_Log entry for any sequence of audited actions: every snapshot of the log is a byte-for-byte prefix of every later snapshot, new rows only ever land at the tail, the entry count only increases, and the order of the rows is stable across reads", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ sequence: steps, base: instant }),
        async ({ sequence, base }) => {
          const h = await makeHarness(base);

          const empty = await h.audit.list();
          expect(empty).toEqual([]);
          expect(await h.audit.count()).toBe(0);

          /** Every state the log has been in, oldest first. */
          const snapshots: AuditEntry[][] = [empty];
          let count = 0;

          for (const [index, step] of sequence.entries()) {
            const at = new Date(base.getTime() + index * 3 * DAY);
            const previous = snapshots[snapshots.length - 1];

            const label =
              step.outcome === "audited"
                ? `step ${index}: ${step.kind}`
                : `step ${index}: rejected ${step.kind}`;

            if (step.outcome === "audited") {
              await runAudited(h, step.kind, step.params, at);
            } else {
              await runRejected(h, step.kind, step.params, at);
            }

            const current = await h.audit.list();
            const currentCount = await h.audit.count();

            /**
             * Requirement 14.7. The whole of the previous log is still there,
             * at the same positions, with identical content — compared in
             * serialized form, so a changed field or a reordered row fails
             * rather than being absorbed by a loose match.
             */
            expect(
              serialize(current.slice(0, previous.length)),
              label
            ).toBe(serialize(previous));
            for (const [position, row] of previous.entries()) {
              expect(current[position], `${label} / row ${position}`).toEqual(
                row
              );
            }

            // Growth happens only at the tail, and only ever upward.
            expect(current.length, label).toBeGreaterThanOrEqual(
              previous.length
            );
            expect(currentCount, label).toBeGreaterThanOrEqual(count);
            expect(currentCount, label).toBe(current.length);

            // Ids are stable and unique, so no row was replaced by another.
            const ids = current.map((row) => row.id);
            expect(new Set(ids).size, label).toBe(ids.length);
            expect(
              ids.slice(0, previous.length),
              label
            ).toEqual(previous.map((row) => row.id));

            /**
             * Ordering is a property of the log, not of the moment it was read:
             * two reads in a row agree, and the per-subject view is the whole
             * log filtered in place rather than reordered.
             */
            expect(serialize(await h.audit.list()), label).toBe(
              serialize(current)
            );
            for (const subjectId of new Set(current.map((r) => r.subjectId))) {
              expect(
                serialize(await h.audit.listBySubject(subjectId)),
                `${label} / subject ${subjectId}`
              ).toBe(
                serialize(current.filter((r) => r.subjectId === subjectId))
              );
            }

            count = currentCount;
            snapshots.push(current);
          }

          /**
           * And from the other end: the final log still contains every state
           * the log was ever in, as a prefix. Nothing that was ever written was
           * later rewritten or dropped.
           */
          const final = await h.audit.list();
          expect(await h.audit.count()).toBe(final.length);
          for (const [index, snapshot] of snapshots.entries()) {
            expect(
              serialize(final.slice(0, snapshot.length)),
              `snapshot ${index}`
            ).toBe(serialize(snapshot));
          }

          // Monotonic: the sizes the log passed through never decreased.
          const sizes = snapshots.map((snapshot) => snapshot.length);
          for (let i = 1; i < sizes.length; i += 1) {
            expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
          }
        }
      )
    );
  });
});
