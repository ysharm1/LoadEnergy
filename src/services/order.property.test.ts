/**
 * Property-based tests for offer acceptance and the Order it produces.
 *
 * Feature: load-energy — Property 16 (task 7.10), Property 17 (task 7.11),
 * Property 18 (task 7.12), Property 19 (task 7.13), Property 23 (task 9.4),
 * Property 24 (task 9.5), Property 25 (task 9.6).
 *
 * The subject is real throughout: the real `OrderService.acceptOffer` and
 * `listWonOrders` over the real `OfferService` and the real
 * `InMemoryRepository` (which enforces the unique `Order.requestId` /
 * `Order.offerId` constraints the Prisma schema declares), with a real
 * `NotificationDispatcher` over in-memory transports. Nothing under test is
 * mocked.
 *
 * Every generator isolates the cause its property is about. `acceptOffer`
 * reports conflicts in a fixed order — expiry, then a non-Open Request, then an
 * inactive Offer, then a Closed Supplier — so a case meant to land on
 * `REQUEST_NOT_OPEN` or `SUPPLIER_CLOSED` is built with a live hold on an
 * otherwise acceptable quote.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ConflictError, ValidationError } from "@/domain/errors";
import {
  MAX_HOLD_HOURS,
  MIN_HOLD_HOURS,
  ORDER_STATUSES,
  type AuthContext,
  type Company,
  type Offer,
  type Order,
  type OrderStatus,
  type Request,
  type RequestStatus,
} from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import {
  NotificationDispatcher,
  type EmailSender,
  type SmsSender,
} from "./notifications";
import { MAX_ETA_MINUTES, OfferService, isActive, isExpired } from "./offer";
import {
  MAX_TICKET_NUMBER_LENGTH,
  OrderService,
  orderStatusRank,
  type RecordDeliveryInput,
} from "./order";

const HOUR = 3_600_000;

const BUCKEYE = { lat: 33.3703, lng: -112.5838 };
const GOODYEAR = { lat: 33.4353, lng: -112.3576 };
const SERVICE_RADIUS_MILES = 50;

const NOW = new Date("2025-03-01T09:00:00Z");

class RecordingSmsSender implements SmsSender {
  readonly calls: Array<{ to: string; body: string }> = [];
  async send(to: string, body: string): Promise<void> {
    this.calls.push({ to, body });
  }
}

class RecordingEmailSender implements EmailSender {
  readonly calls: Array<{ to: string; subject: string }> = [];
  async send(to: string, subject: string): Promise<void> {
    this.calls.push({ to, subject });
  }
}

// ---------------------------------------------------------------------------
// Harness — one Buyer Company and `supplierCount` eligible Supplier Companies
// ---------------------------------------------------------------------------

interface SupplierSeat {
  company: Company;
  ctx: AuthContext;
}

interface Harness {
  repo: InMemoryRepository;
  offers: OfferService;
  orders: OrderService;
  sms: RecordingSmsSender;
  buyer: AuthContext;
  suppliers: SupplierSeat[];
  request: Request;
}

async function makeHarness(
  supplierCount: number,
  createdAt: Date = NOW
): Promise<Harness> {
  const repo = new InMemoryRepository();
  const sms = new RecordingSmsSender();
  const notifier = new NotificationDispatcher({
    sms,
    email: new RecordingEmailSender(),
    clock: () => createdAt,
  });
  const offers = new OfferService({ repo, notifier });
  const orders = new OrderService({ repo, notifier });

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
  const buyerUser = await repo.createUser({
    companyId: buyerCo.id,
    role: "buyer",
    phone: "+16025550101",
    email: "super@swvalley.example",
    passwordHash: "hash",
    createdAt,
  });

  const suppliers: SupplierSeat[] = [];
  for (let index = 0; index < supplierCount; index += 1) {
    const company = await repo.createCompany({
      name: `Supplier ${index} Diesel`,
      kind: "supplier",
      supplierApprovalStatus: "approved",
      // Open and Limited both quote and both can win (Requirement 5.3).
      supplierStatus: index % 2 === 0 ? "open" : "limited",
      operatingLat: BUCKEYE.lat,
      operatingLng: BUCKEYE.lng,
      serviceRadiusMiles: SERVICE_RADIUS_MILES,
      createdAt,
    });
    const user = await repo.createUser({
      companyId: company.id,
      role: "supplier",
      phone: `+1602555${String(2000 + index).padStart(4, "0")}`,
      email: null,
      passwordHash: "hash",
      createdAt,
    });
    suppliers.push({
      company,
      ctx: { userId: user.id, companyId: company.id, role: "supplier" },
    });
  }

  const request = await repo.createRequest({
    buyerCompanyId: buyerCo.id,
    createdByUserId: buyerUser.id,
    gallons: 500,
    productType: "ulsd",
    deliveryMethod: "wet_hose",
    deliveryWindow: "today",
    pinLat: GOODYEAR.lat,
    pinLng: GOODYEAR.lng,
    notes: null,
    status: "open",
    windowEndsAt: new Date(createdAt.getTime() + 8 * HOUR),
    createdAt,
  });

  return {
    repo,
    offers,
    orders,
    sms,
    buyer: { userId: buyerUser.id, companyId: buyerCo.id, role: "buyer" },
    suppliers,
    request,
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Prices at the stored Decimal(10,4) scale, weighted to the realistic band. */
const validPrice = fc.oneof(
  {
    arbitrary: fc
      .integer({ min: 20_000, max: 60_000 })
      .map((tenThousandths) => tenThousandths / 10_000),
    weight: 5,
  },
  {
    arbitrary: fc
      .integer({ min: 1, max: 9_999_999_999 })
      .map((tenThousandths) => tenThousandths / 10_000),
    weight: 1,
  },
  { arbitrary: fc.constantFrom(0.0001, 2.999, 3.4567, 4.5), weight: 2 }
);

const validHoldHours = fc.oneof(
  {
    arbitrary: fc.integer({ min: MIN_HOLD_HOURS, max: MAX_HOLD_HOURS }),
    weight: 4,
  },
  { arbitrary: fc.constantFrom(MIN_HOLD_HOURS, MAX_HOLD_HOURS), weight: 2 }
);

const optionalEta = fc.oneof(
  { arbitrary: fc.constant(undefined), weight: 2 },
  { arbitrary: fc.constant(null), weight: 1 },
  { arbitrary: fc.integer({ min: 1, max: MAX_ETA_MINUTES }), weight: 3 }
);

const instant = fc.date({
  min: new Date("2025-01-01T00:00:00.000Z"),
  max: new Date("2026-12-31T23:59:59.000Z"),
  noInvalidDate: true,
});

interface QuoteSpec {
  price: number;
  holdHours: number;
  etaMinutes: number | null | undefined;
}

const quoteSpec: fc.Arbitrary<QuoteSpec> = fc.record({
  price: validPrice,
  holdHours: validHoldHours,
  etaMinutes: optionalEta,
});

/** Submits one quote per spec, each from its own Supplier Company. */
async function quoteAll(
  h: Harness,
  quotes: readonly QuoteSpec[],
  createdAt: Date
): Promise<Offer[]> {
  const created: Offer[] = [];
  for (const [index, quote] of quotes.entries()) {
    created.push(
      await h.offers.createOffer(
        h.suppliers[index].ctx,
        {
          requestId: h.request.id,
          landedPricePerGal: quote.price,
          holdHours: quote.holdHours,
          etaMinutes: quote.etaMinutes,
        },
        createdAt
      )
    );
  }
  return created;
}

/** The instant a whole batch of quotes is still live: strictly inside every hold. */
function liveAcceptanceTime(
  quotes: readonly QuoteSpec[],
  createdAt: Date,
  spread: number
): Date {
  const shortestMs = Math.min(...quotes.map((q) => q.holdHours)) * HOUR;
  const offset = Math.min(Math.round(spread * (shortestMs - 1)), shortestMs - 1);
  return new Date(createdAt.getTime() + Math.max(0, offset));
}

// ---------------------------------------------------------------------------
// Property 16 (task 7.10) — Requirement 7.3
// ---------------------------------------------------------------------------

/**
 * Acceptance instants at or past the expiry: the expiry instant itself
 * (Requirement 7.2 makes the boundary expired), the first millisecond past it,
 * and times arbitrarily far beyond.
 */
const pastExpiryOffsetMs = fc.oneof(
  { arbitrary: fc.constantFrom(0, 1, 2), weight: 4 },
  { arbitrary: fc.integer({ min: 0, max: 30 * 24 * HOUR }), weight: 3 },
  {
    arbitrary: fc.constantFrom(1000, HOUR, 8 * HOUR, 24 * HOUR, 365 * 24 * HOUR),
    weight: 2,
  }
);

describe("Property 16: Expired offers cannot be accepted", () => {
  // Feature: load-energy, Property 16: Expired offers cannot be accepted
  // **Validates: Requirements 7.3**
  it("rejects acceptance with an expiry error whenever the acceptance time has reached the Offer's expiresAt, leaving the load Open and creating no Order, while the same quote accepted one millisecond earlier wins", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          quote: quoteSpec,
          createdAt: instant,
          offsetMs: pastExpiryOffsetMs,
        }),
        async ({ quote, createdAt, offsetMs }) => {
          const h = await makeHarness(1, createdAt);
          const [offer] = await quoteAll(h, [quote], createdAt);

          // At or after the hold's end. Everything else is in order: the load
          // is Open, the quote is active and unvoided, the seller is Approved
          // and Open — so expiry is the only reason to reject.
          const acceptAt = new Date(offer.expiresAt.getTime() + offsetMs);
          const label = `hold ${quote.holdHours}h, accept ${offsetMs}ms past expiry`;

          expect(isExpired(offer, acceptAt), label).toBe(true);
          expect(isActive(offer, acceptAt), label).toBe(false);

          // The Buyer is already being told the quote lapsed before they tap.
          const beforeViews = await h.offers.listOffersForRequest(
            h.buyer,
            h.request.id,
            acceptAt
          );
          expect(beforeViews, label).toHaveLength(1);
          expect(beforeViews[0], label).toMatchObject({
            offerId: offer.id,
            isActive: false,
            activeness: "expired",
          });

          const pagedBefore = h.sms.calls.length;

          let thrown: unknown;
          try {
            await h.orders.acceptOffer(h.buyer, offer.id, acceptAt);
          } catch (error) {
            thrown = error;
          }

          // Requirement 7.3: an expiry error (409 at the API boundary).
          expect(thrown, label).toBeInstanceOf(ConflictError);
          const error = thrown as ConflictError;
          expect(error.category, label).toBe("conflict");
          expect(error.httpStatus, label).toBe(409);
          expect(error.code, label).toBe("OFFER_EXPIRED");

          // Nothing moved: no Order, the load is still Open for a fresh quote,
          // and the lapsed quote was not claimed.
          expect(
            await h.repo.listOrdersByBuyerCompany(h.buyer.companyId),
            label
          ).toEqual([]);
          expect(await h.repo.getOrderByOffer(offer.id), label).toBeNull();
          expect(await h.repo.getOrderByRequest(h.request.id), label).toBeNull();
          expect(await h.repo.getRequest(h.request.id), label).toMatchObject({
            status: "open",
          });
          expect(await h.repo.getOffer(offer.id), label).toMatchObject({
            status: "active",
            voided: false,
          });
          expect(
            await h.orders.listWonOrders(h.suppliers[0].ctx),
            label
          ).toEqual([]);
          // No one was told they won a load they did not win.
          expect(h.sms.calls.length, label).toBe(pagedBefore);

          /**
           * The load survives the refusal: the same dispatcher re-quotes at the
           * refused instant and that fresh hold is acceptable immediately. So
           * the rejection above was about the lapsed hold and nothing else —
           * not the Buyer's standing, not the load, not the seller.
           */
          const requoted = await h.offers.createOffer(
            h.suppliers[0].ctx,
            {
              requestId: h.request.id,
              landedPricePerGal: quote.price,
              holdHours: quote.holdHours,
              etaMinutes: quote.etaMinutes,
            },
            acceptAt
          );
          const order = await h.orders.acceptOffer(
            h.buyer,
            requoted.id,
            acceptAt
          );
          expect(order, label).toMatchObject({
            offerId: requoted.id,
            requestId: h.request.id,
            status: "accepted",
          });
          /**
           * The lapsed quote is never the winner. It is voided as a loser of
           * that win, because expiry is lazy: nothing rewrote its stored status
           * when the hold ran out, so it was still one of the load's active
           * rows when the fresh quote was accepted.
           */
          expect(await h.repo.getOffer(offer.id), label).toMatchObject({
            status: "voided",
            voided: true,
          });
          expect(await h.repo.getOrderByOffer(offer.id), label).toBeNull();

          /**
           * The boundary is the discriminator, so exercise the other side of it
           * on an identical load: one millisecond before the same expiry, the
           * same quote wins.
           */
          const control = await makeHarness(1, createdAt);
          const [live] = await quoteAll(control, [quote], createdAt);
          const justInTime = new Date(live.expiresAt.getTime() - 1);
          expect(isExpired(live, justInTime), label).toBe(false);
          const won = await control.orders.acceptOffer(
            control.buyer,
            live.id,
            justInTime
          );
          expect(won, label).toMatchObject({
            offerId: live.id,
            status: "accepted",
          });
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 17 (task 7.11) — Requirements 8.1, 8.2, 8.3, 8.7
// ---------------------------------------------------------------------------

/**
 * The stored lifecycle a sibling quote can already be sitting in when the Buyer
 * taps Accept. Requirement 8.3 is about voiding the *active* losers, so the
 * quotes that were already dead — voided by an earlier sibling win, or marked
 * expired — have to come out the other side exactly as they went in.
 */
type PreState = "active" | "voided" | "expired";

const preState: fc.Arbitrary<PreState> = fc.oneof(
  { arbitrary: fc.constant<PreState>("active"), weight: 6 },
  { arbitrary: fc.constant<PreState>("voided"), weight: 2 },
  { arbitrary: fc.constant<PreState>("expired"), weight: 2 }
);

const acceptanceCase = fc
  .record({
    quotes: fc.array(
      fc.record({
        price: validPrice,
        holdHours: validHoldHours,
        etaMinutes: optionalEta,
        pre: preState,
      }),
      { minLength: 1, maxLength: 5 }
    ),
    winnerSeed: fc.nat(),
    spread: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ quotes, winnerSeed, spread }) => {
    // The property needs at least one active quote to accept; the winner is
    // drawn from the active ones, and index 0 is forced active when a draw
    // leaves none.
    const withWinner = quotes.map((q, index) =>
      index === 0 && !quotes.some((other) => other.pre === "active")
        ? { ...q, pre: "active" as PreState }
        : q
    );
    const activeIndexes = withWinner
      .map((q, index) => (q.pre === "active" ? index : -1))
      .filter((index) => index >= 0);
    return {
      quotes: withWinner,
      winnerIndex: activeIndexes[winnerSeed % activeIndexes.length],
      spread,
    };
  });

describe("Property 17: Acceptance produces one exclusive, linked, visible order", () => {
  // Feature: load-energy, Property 17: Acceptance produces one exclusive, linked, visible order
  // **Validates: Requirements 8.1, 8.2, 8.3, 8.7**
  it("creates exactly one Accepted Order linking the Request, the winning Offer, and the winning Supplier Company, sets the Request to Accepted, voids every other active Offer while leaving already-dead ones alone, and shows the Order in the winner's won-orders and in no one else's", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ c: acceptanceCase, createdAt: instant }),
        async ({ c, createdAt }) => {
          const h = await makeHarness(c.quotes.length, createdAt);
          const created = await quoteAll(h, c.quotes, createdAt);

          // Move the already-dead siblings into their stored state the way an
          // earlier sibling win or a lapse would have moved them.
          for (const [index, quote] of c.quotes.entries()) {
            if (quote.pre === "voided") {
              await h.repo.updateOffer(created[index].id, {
                status: "voided",
                voided: true,
              });
            } else if (quote.pre === "expired") {
              await h.repo.updateOffer(created[index].id, {
                status: "expired",
              });
            }
          }

          const acceptAt = liveAcceptanceTime(c.quotes, createdAt, c.spread);
          const winner = created[c.winnerIndex];
          const winnerSeat = h.suppliers[c.winnerIndex];
          const label = `${c.quotes.length} quotes, winner ${c.winnerIndex}, accept at +${
            acceptAt.getTime() - createdAt.getTime()
          }ms`;

          // Precondition of the property: the winner's hold is still live.
          expect(isActive(winner, acceptAt), label).toBe(true);

          const order = await h.orders.acceptOffer(h.buyer, winner.id, acceptAt);

          // Requirement 8.1: one Order at Accepted, carrying all three links.
          expect(order, label).toMatchObject({
            requestId: h.request.id,
            offerId: winner.id,
            buyerCompanyId: h.buyer.companyId,
            supplierCompanyId: winnerSeat.company.id,
            status: "accepted",
            isConcierge: false,
          });
          expect(await h.repo.getOrder(order.id), label).toMatchObject({
            id: order.id,
            status: "accepted",
          });
          // The Order is stamped at the acceptance instant, not at some later
          // wall clock the service reached for on its own.
          expect(order.createdAt.getTime(), label).toBe(acceptAt.getTime());

          // Exactly one Order exists for this load, by every route to it.
          const buyerOrders = await h.repo.listOrdersByBuyerCompany(
            h.buyer.companyId
          );
          expect(buyerOrders, label).toHaveLength(1);
          expect(buyerOrders[0].id, label).toBe(order.id);
          expect(
            (await h.repo.getOrderByRequest(h.request.id))?.id,
            label
          ).toBe(order.id);
          expect((await h.repo.getOrderByOffer(winner.id))?.id, label).toBe(
            order.id
          );

          // Requirement 8.2: the load is Accepted, so nothing else can be
          // accepted on it.
          expect(await h.repo.getRequest(h.request.id), label).toMatchObject({
            status: "accepted",
          });

          /**
           * Requirement 8.3: the winner is claimed, every quote that was still
           * active is voided, and the ones that were already dead are left in
           * the state they were in — a quote voided by an earlier win is not
           * re-voided into something else, and a lapsed one is not relabelled.
           */
          const after = await h.repo.listOffersByRequest(h.request.id);
          expect(after, label).toHaveLength(created.length);
          for (const [index, quote] of c.quotes.entries()) {
            const stored = after.find((o) => o.id === created[index].id);
            const perOffer = `${label} / offer ${index} (${quote.pre})`;
            expect(stored, perOffer).toBeDefined();
            const offer = stored as Offer;

            if (index === c.winnerIndex) {
              expect(offer.status, perOffer).toBe("accepted");
              expect(offer.voided, perOffer).toBe(false);
            } else if (quote.pre === "active") {
              expect(offer.status, perOffer).toBe("voided");
              expect(offer.voided, perOffer).toBe(true);
            } else if (quote.pre === "voided") {
              expect(offer.status, perOffer).toBe("voided");
              expect(offer.voided, perOffer).toBe(true);
            } else {
              expect(offer.status, perOffer).toBe("expired");
              expect(offer.voided, perOffer).toBe(false);
            }

            // Whatever route it took, no quote but the winner is acceptable
            // now — mid-hold or not.
            if (index !== c.winnerIndex) {
              expect(isActive(offer, acceptAt), perOffer).toBe(false);
            }
          }

          /**
           * The same exclusivity as the Buyer sees it: their list still shows
           * every quote on the load, and not one of them is offered as
           * acceptable any more.
           */
          const views = await h.offers.listOffersForRequest(
            h.buyer,
            h.request.id,
            acceptAt
          );
          expect(views, label).toHaveLength(created.length);
          expect(views.filter((v) => v.isActive), label).toEqual([]);
          expect(
            views.find((v) => v.offerId === winner.id)?.status,
            label
          ).toBe("accepted");

          // Requirement 8.7: the winner sees the won load, with the same links
          // the Order carries; a loser's book is untouched.
          const won = await h.orders.listWonOrders(winnerSeat.ctx);
          expect(won.map((o) => o.id), label).toEqual([order.id]);
          expect(won[0], label).toMatchObject({
            offerId: winner.id,
            requestId: h.request.id,
            supplierCompanyId: winnerSeat.company.id,
            status: "accepted",
          });
          for (const [index, seat] of h.suppliers.entries()) {
            if (index === c.winnerIndex) continue;
            expect(
              await h.orders.listWonOrders(seat.ctx),
              `${label} / loser ${index}`
            ).toEqual([]);
            expect(
              await h.repo.listOrdersBySupplierCompany(seat.company.id),
              `${label} / loser ${index}`
            ).toEqual([]);
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 18 (task 7.12) — Requirement 8.4
// ---------------------------------------------------------------------------

const NON_OPEN_STATUSES: readonly RequestStatus[] = [
  "accepted",
  "cancelled",
  "expired",
];

/**
 * Either a load moved out of Open behind the Buyer's back, or a load that has
 * already been won — the second-accept path, which Requirement 8.4 is what makes
 * impossible. Holds stay live in both branches so the rejection is about the
 * Request's status and not about expiry.
 */
const notOpenCase = fc.oneof(
  fc.record({
    mode: fc.constant("status" as const),
    status: fc.constantFrom(...NON_OPEN_STATUSES),
    quotes: fc.array(quoteSpec, { minLength: 1, maxLength: 3 }),
    targetSeed: fc.nat(),
    spread: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
  fc.record({
    mode: fc.constant("second-accept" as const),
    status: fc.constant<RequestStatus>("accepted"),
    quotes: fc.array(quoteSpec, { minLength: 2, maxLength: 4 }),
    targetSeed: fc.nat(),
    spread: fc.double({ min: 0, max: 1, noNaN: true }),
  })
);

describe("Property 18: Acceptance requires an Open request", () => {
  // Feature: load-energy, Property 18: Acceptance requires an Open request
  // **Validates: Requirements 8.4**
  it("rejects any acceptance attempt on a Request that is not Open — including a second accept on a load already won — and creates no additional Order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ c: notOpenCase, createdAt: instant }),
        async ({ c, createdAt }) => {
          const h = await makeHarness(c.quotes.length, createdAt);
          const created = await quoteAll(h, c.quotes, createdAt);
          const acceptAt = liveAcceptanceTime(c.quotes, createdAt, c.spread);

          let expectedOrderCount = 0;
          let firstWinner: Offer | null = null;

          if (c.mode === "second-accept") {
            // The load is won legitimately first; the Request_Status it lands in
            // is what every later attempt runs into.
            firstWinner = created[0];
            await h.orders.acceptOffer(h.buyer, firstWinner.id, acceptAt);
            expectedOrderCount = 1;
          } else {
            await h.repo.updateRequest(h.request.id, { status: c.status });
          }

          const request = await h.repo.getRequest(h.request.id);
          expect(request?.status).toBe(c.status);

          // Every offer on the load is a candidate, the already-accepted one
          // included: none of them may produce an Order now.
          const candidates =
            c.mode === "second-accept"
              ? [created[1 + (c.targetSeed % (created.length - 1))], created[0]]
              : [created[c.targetSeed % created.length]];

          for (const candidate of candidates) {
            const label = `mode ${c.mode}, status ${c.status}, offer ${candidate.id}`;

            // The hold is still live, so expiry cannot be the cause.
            expect(isExpired(candidate, acceptAt), label).toBe(false);

            // What every quote on the load looks like before the refused tap,
            // so the refusal can be shown to have changed nothing at all.
            const before = await h.repo.listOffersByRequest(h.request.id);

            let thrown: unknown;
            try {
              await h.orders.acceptOffer(h.buyer, candidate.id, acceptAt);
            } catch (error) {
              thrown = error;
            }

            // Requirement 8.4: rejected as a state conflict (409), naming the
            // Request rather than the quote.
            expect(thrown, label).toBeInstanceOf(ConflictError);
            const error = thrown as ConflictError;
            expect(error.category, label).toBe("conflict");
            expect(error.httpStatus, label).toBe(409);
            expect(error.code, label).toBe("REQUEST_NOT_OPEN");

            // No extra Order, and the Request_Status is unchanged by the
            // refused attempt.
            expect(
              await h.repo.listOrdersByBuyerCompany(h.buyer.companyId),
              label
            ).toHaveLength(expectedOrderCount);
            expect(await h.repo.getRequest(h.request.id), label).toMatchObject({
              status: c.status,
            });

            // A refused candidate never gains an Order of its own, and no quote
            // on the load moved: the refusal is inert, not a partial write.
            if (candidate.id !== firstWinner?.id) {
              expect(
                await h.repo.getOrderByOffer(candidate.id),
                label
              ).toBeNull();
            }
            const afterRefusal = await h.repo.listOffersByRequest(h.request.id);
            expect(
              afterRefusal.map((o) => ({
                id: o.id,
                status: o.status,
                voided: o.voided,
              })),
              label
            ).toEqual(
              before.map((o) => ({
                id: o.id,
                status: o.status,
                voided: o.voided,
              }))
            );
          }

          if (firstWinner) {
            // The one legitimate win stands, and it is still the only one.
            const orders = await h.repo.listOrdersByBuyerCompany(
              h.buyer.companyId
            );
            expect(orders).toHaveLength(1);
            expect(orders[0].offerId).toBe(firstWinner.id);
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 19 (task 7.13) — Requirement 8.6
// ---------------------------------------------------------------------------

const closedSupplierCase = fc
  .record({
    quotes: fc.array(quoteSpec, { minLength: 1, maxLength: 4 }),
    targetSeed: fc.nat(),
    spread: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ quotes, targetSeed, spread }) => ({
    quotes,
    targetIndex: targetSeed % quotes.length,
    spread,
  }));

describe("Property 19: Offers from Closed suppliers cannot be accepted", () => {
  // Feature: load-energy, Property 19: Offers from Closed suppliers cannot be accepted
  // **Validates: Requirements 8.6**
  it("rejects acceptance of an Offer whose Supplier Company went Closed after quoting, leaving the load Open and creating no Order, while the same quote from a reopened seller wins", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ c: closedSupplierCase, createdAt: instant }),
        async ({ c, createdAt }) => {
          const h = await makeHarness(c.quotes.length, createdAt);
          const created = await quoteAll(h, c.quotes, createdAt);

          const target = created[c.targetIndex];
          const targetSeat = h.suppliers[c.targetIndex];

          // The dispatcher closes up after quoting — the load is still Open and
          // the hold is still live, so a Closed seller is the only cause left.
          await h.repo.updateCompany(targetSeat.company.id, {
            supplierStatus: "closed",
          });

          const acceptAt = liveAcceptanceTime(c.quotes, createdAt, c.spread);
          const label = `${c.quotes.length} quotes, closed supplier ${c.targetIndex}`;

          expect(isExpired(target, acceptAt), label).toBe(false);
          expect(isActive(target, acceptAt), label).toBe(true);
          expect(await h.repo.getRequest(h.request.id), label).toMatchObject({
            status: "open",
          });

          let thrown: unknown;
          try {
            await h.orders.acceptOffer(h.buyer, target.id, acceptAt);
          } catch (error) {
            thrown = error;
          }

          // Requirement 8.6: rejected as a state conflict (409) on the seller's
          // availability.
          expect(thrown, label).toBeInstanceOf(ConflictError);
          const error = thrown as ConflictError;
          expect(error.category, label).toBe("conflict");
          expect(error.httpStatus, label).toBe(409);
          expect(error.code, label).toBe("SUPPLIER_CLOSED");

          // No Order, the load is left Open so the Buyer can accept someone
          // else, and no quote on it was claimed or voided.
          expect(
            await h.repo.listOrdersByBuyerCompany(h.buyer.companyId),
            label
          ).toEqual([]);
          expect(await h.repo.getRequest(h.request.id), label).toMatchObject({
            status: "open",
          });
          for (const offer of await h.repo.listOffersByRequest(h.request.id)) {
            expect(offer, `${label} / offer ${offer.id}`).toMatchObject({
              status: "active",
              voided: false,
            });
          }
          expect(await h.orders.listWonOrders(targetSeat.ctx), label).toEqual(
            []
          );

          /**
           * The seller's availability is the whole cause: reopen the same
           * company — Open or Limited, both trade (Requirement 5.3) — and the
           * very same quote, at the very same instant, wins. Nothing else about
           * the attempt changed.
           */
          const reopened: "open" | "limited" =
            c.targetIndex % 2 === 0 ? "open" : "limited";
          await h.repo.updateCompany(targetSeat.company.id, {
            supplierStatus: reopened,
          });
          const order = await h.orders.acceptOffer(
            h.buyer,
            target.id,
            acceptAt
          );
          expect(order, `${label} / reopened ${reopened}`).toMatchObject({
            offerId: target.id,
            requestId: h.request.id,
            supplierCompanyId: targetSeat.company.id,
            status: "accepted",
          });
          expect(
            await h.orders.listWonOrders(targetSeat.ctx),
            `${label} / reopened ${reopened}`
          ).toHaveLength(1);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Order lifecycle, delivery, and BOL recording — Property 23 (task 9.4),
// Property 24 (task 9.5), Property 25 (task 9.6).
//
// Same real subject as above: `OrderService` over `OfferService` over
// `InMemoryRepository`, which enforces the unique `Delivery.orderId` the Prisma
// schema declares. The Order under test is always a genuinely won one — quoted
// through `createOffer` and accepted through `acceptOffer` — so the status it
// starts from is the one acceptance actually produces.
// ---------------------------------------------------------------------------

/** A won Order on the harness's load, taken by supplier 0 at `createdAt`. */
async function wonOrder(h: Harness, createdAt: Date): Promise<Order> {
  const [offer] = await quoteAll(
    h,
    [{ price: 3.4, holdHours: MAX_HOLD_HOURS, etaMinutes: null }],
    createdAt
  );
  const order = await h.orders.acceptOffer(h.buyer, offer.id, createdAt);
  // Drop the NEW_OFFER / ACCEPTED traffic so later assertions about who was
  // paged are about the lifecycle step under test.
  h.sms.calls.length = 0;
  return order;
}

async function expectConflict(
  attempt: () => Promise<unknown>,
  code: string,
  label: string
): Promise<void> {
  let thrown: unknown;
  try {
    await attempt();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, label).toBeInstanceOf(ConflictError);
  const error = thrown as ConflictError;
  expect(error.category, label).toBe("conflict");
  expect(error.httpStatus, label).toBe(409);
  expect(error.code, label).toBe(code);
}

async function expectValidation(
  attempt: () => Promise<unknown>,
  code: string,
  field: string,
  label: string
): Promise<void> {
  let thrown: unknown;
  try {
    await attempt();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, label).toBeInstanceOf(ValidationError);
  const error = thrown as ValidationError;
  expect(error.category, label).toBe("validation");
  expect(error.httpStatus, label).toBe(400);
  expect(error.code, label).toBe(code);
  expect(error.field, label).toBe(field);
}

// ---------------------------------------------------------------------------
// Delivery input generators
// ---------------------------------------------------------------------------

/** Whole gallon counts above zero: tanker-realistic, plus the boundary at 1. */
const validBolGallons = fc.oneof(
  { arbitrary: fc.integer({ min: 1, max: 12_000 }), weight: 5 },
  { arbitrary: fc.constantFrom(1, 2, 500, 7_500), weight: 2 },
  { arbitrary: fc.integer({ min: 1, max: 2_000_000 }), weight: 1 }
);

/** Whitespace a driver's typed ticket number can arrive wrapped in. */
const padding = fc.constantFrom("", " ", "  ", "\t", "\n ");

const ticketCore = fc.oneof(
  { arbitrary: fc.integer({ min: 1, max: 9_999_999 }).map(String), weight: 4 },
  {
    arbitrary: fc
      .string({ minLength: 1, maxLength: 24 })
      .filter((value) => value.trim() !== ""),
    weight: 3,
  },
  {
    arbitrary: fc.constantFrom(
      "88213",
      "BOL-0001",
      "a",
      "A".repeat(MAX_TICKET_NUMBER_LENGTH)
    ),
    weight: 2,
  }
);

interface TicketSpec {
  /** What the dispatcher sends. */
  raw: string;
  /** What the service should store (Requirement 11.5 trims). */
  stored: string;
}

const validTicketNumber: fc.Arbitrary<TicketSpec> = fc
  .record({ core: ticketCore, left: padding, right: padding })
  .map(({ core, left, right }) => {
    const raw = `${left}${core}${right}`;
    return { raw, stored: raw.trim() };
  });

interface PhotoSpec {
  /** `undefined` means the field is omitted entirely. */
  input: string | null | undefined;
  /** What Requirement 11.6 should leave on the row. */
  stored: string | null;
}

const ticketPhotoSpec: fc.Arbitrary<PhotoSpec> = fc.oneof(
  { arbitrary: fc.constant<PhotoSpec>({ input: undefined, stored: null }), weight: 2 },
  { arbitrary: fc.constant<PhotoSpec>({ input: null, stored: null }), weight: 1 },
  {
    arbitrary: fc
      .constantFrom("", " ", "   \t")
      .map((input) => ({ input, stored: null }) as PhotoSpec),
    weight: 1,
  },
  {
    arbitrary: fc
      .record({
        key: fc
          .string({ minLength: 1, maxLength: 80 })
          .filter((value) => value.trim() !== ""),
        pad: padding,
      })
      .map(({ key, pad }) => {
        const input = `${pad}${key}${pad}`;
        return { input, stored: input.trim() } as PhotoSpec;
      }),
    weight: 4,
  },
  {
    arbitrary: fc
      .constantFrom("tickets/2025/03/88213.jpg", "bol/arizona/88214.png")
      .map((input) => ({ input, stored: input }) as PhotoSpec),
    weight: 2,
  }
);

/** A delivery payload, with the field omitted when no photo was offered. */
function deliveryInput(
  gallons: number,
  ticket: TicketSpec,
  photo?: PhotoSpec
): RecordDeliveryInput {
  return photo === undefined || photo.input === undefined
    ? { bolGallons: gallons, ticketNumber: ticket.raw }
    : {
        bolGallons: gallons,
        ticketNumber: ticket.raw,
        ticketPhotoKey: photo.input,
      };
}

// ---------------------------------------------------------------------------
// Property 23 (task 9.4) — Requirements 10.1, 10.2, 10.3, 10.4, 10.5
// ---------------------------------------------------------------------------

/**
 * One request against the status machine: either the dispatcher taps a status
 * directly, or they file the BOL (which is the only way to Delivered, and is
 * allowed straight from Accepted per Requirement 10.4). Targets are drawn from
 * all three statuses, so a step is as likely to be backward or a repeat as it
 * is to be the next one forward.
 */
type Step = { kind: "advance"; to: OrderStatus } | { kind: "deliver" };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc
      .constantFrom(...ORDER_STATUSES)
      .map((to) => ({ kind: "advance", to }) as Step),
    weight: 5,
  },
  { arbitrary: fc.constant<Step>({ kind: "deliver" }), weight: 2 }
);

describe("Property 23: Order status advances forward-only", () => {
  // Feature: load-energy, Property 23: Order status advances forward-only
  // **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5**
  it("moves an Order's status only forward along Accepted -> En_Route -> Delivered under any sequence of status-change requests, rejects every backward or repeated request, and always persists the status produced by the last valid forward transition", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          steps: fc.array(step, { minLength: 1, maxLength: 8 }),
          createdAt: instant,
          gallons: validBolGallons,
          ticket: validTicketNumber,
        }),
        async ({ steps, createdAt, gallons, ticket }) => {
          const h = await makeHarness(1, createdAt);
          const order = await wonOrder(h, createdAt);
          const dispatcher = h.suppliers[0].ctx;

          // Requirement 10.1: acceptance starts the machine at Accepted.
          let expected: OrderStatus = "accepted";
          let hasDelivery = false;
          /** Every status the Order actually came to hold, in order. */
          const reached: OrderStatus[] = ["accepted"];

          for (const [index, s] of steps.entries()) {
            const label =
              `step ${index} ${
                s.kind === "advance" ? `advance->${s.to}` : "deliver"
              } from ${expected}` +
              (hasDelivery ? " (BOL on file)" : "");

            if (s.kind === "advance") {
              if (orderStatusRank(s.to) < orderStatusRank(expected)) {
                // Requirement 10.5: backward is refused.
                await expectConflict(
                  () => h.orders.advanceStatus(dispatcher, order.id, s.to),
                  "ORDER_STATUS_BACKWARD",
                  label
                );
              } else if (s.to === expected) {
                // A repeat advances nothing, so it is not reported as a move.
                await expectConflict(
                  () => h.orders.advanceStatus(dispatcher, order.id, s.to),
                  "ORDER_STATUS_UNCHANGED",
                  label
                );
              } else if (s.to === "delivered" && !hasDelivery) {
                /**
                 * Forward, but Delivered is the marketplace's claim that fuel
                 * landed: it is reachable only with a BOL behind it
                 * (Requirement 10.3 via 11.1).
                 */
                await expectConflict(
                  () => h.orders.advanceStatus(dispatcher, order.id, s.to),
                  "DELIVERY_REQUIRED",
                  label
                );
              } else {
                // Requirement 10.2 / 10.4: a strictly forward move succeeds.
                const updated = await h.orders.advanceStatus(
                  dispatcher,
                  order.id,
                  s.to
                );
                expect(updated.status, label).toBe(s.to);
                expected = s.to;
                reached.push(s.to);
              }
            } else if (hasDelivery) {
              // Requirement 11.3 — covered in full by Property 24; here it is
              // only the reason the status does not move again.
              await expectConflict(
                () =>
                  h.orders.recordDelivery(
                    dispatcher,
                    order.id,
                    deliveryInput(gallons, ticket),
                    createdAt
                  ),
                "DELIVERY_EXISTS",
                label
              );
            } else {
              /**
               * Requirement 10.4: the BOL may be filed from Accepted as well as
               * from En_Route, and filing it is what carries the Order to
               * Delivered (Requirements 10.3, 11.1).
               */
              const delivery = await h.orders.recordDelivery(
                dispatcher,
                order.id,
                deliveryInput(gallons, ticket),
                createdAt
              );
              expect(delivery.orderId, label).toBe(order.id);
              hasDelivery = true;
              expected = "delivered";
              reached.push("delivered");
            }

            /**
             * After every request, accepted or refused, the stored status is the
             * one the last valid forward transition left behind — a refusal is
             * inert, not a partial write. Checked through the repository and
             * through the Buyer's read alike (Requirement 10.6).
             */
            expect((await h.repo.getOrder(order.id))?.status, label).toBe(
              expected
            );
            expect(
              (await h.orders.readOrder(h.buyer, order.id)).status,
              label
            ).toBe(expected);
            // Requirement 10.1: never anything but the three statuses.
            expect(ORDER_STATUSES, label).toContain(expected);
            // A BOL on file and a status short of Delivered cannot coexist.
            expect(
              (await h.repo.getDeliveryByOrder(order.id)) !== null,
              label
            ).toBe(hasDelivery);
            if (hasDelivery) expect(expected, label).toBe("delivered");
          }

          /**
           * The whole walk, not just each step: the statuses the Order actually
           * held form a strictly increasing run through the sequence, so it
           * never revisited one and never skipped backward.
           */
          const ranks = reached.map(orderStatusRank);
          for (const [index, rank] of ranks.entries()) {
            if (index === 0) continue;
            expect(
              rank,
              `reached ${reached.join(" -> ")}`
            ).toBeGreaterThan(ranks[index - 1]);
          }

          /**
           * Requirement 10.4's direct hop, exercised on an identical won load so
           * it is covered even when the generated sequence never filed a BOL
           * from Accepted: no en-route tap, straight to Delivered.
           */
          const control = await makeHarness(1, createdAt);
          const direct = await wonOrder(control, createdAt);
          expect(direct.status).toBe("accepted");
          await control.orders.recordDelivery(
            control.suppliers[0].ctx,
            direct.id,
            deliveryInput(gallons, ticket),
            createdAt
          );
          expect((await control.repo.getOrder(direct.id))?.status).toBe(
            "delivered"
          );
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 24 (task 9.5) — Requirements 11.1, 11.2, 11.3, 11.6
// ---------------------------------------------------------------------------

describe("Property 24: Delivery recording sets Delivered, stores details, and is unique per order", () => {
  // Feature: load-energy, Property 24: Delivery recording sets Delivered, stores details, and is unique per order
  // **Validates: Requirements 11.1, 11.2, 11.3, 11.6**
  it("creates exactly one Delivery linked to the Order for any valid BOL input, sets the Order to Delivered, stores the gallons, ticket number and any supplied ticket photo, and rejects a second Delivery on the same Order without amending the first", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          createdAt: instant,
          startEnRoute: fc.boolean(),
          gallons: validBolGallons,
          ticket: validTicketNumber,
          photo: ticketPhotoSpec,
          deliverOffsetMs: fc.integer({ min: 0, max: 72 * HOUR }),
          second: fc.record({
            gallons: validBolGallons,
            ticket: validTicketNumber,
            photo: ticketPhotoSpec,
          }),
        }),
        async (c) => {
          const h = await makeHarness(1, c.createdAt);
          const order = await wonOrder(h, c.createdAt);
          const dispatcher = h.suppliers[0].ctx;

          // Either lead-in is a won Order with no Delivery yet
          // (Requirement 10.4).
          if (c.startEnRoute) {
            await h.orders.advanceStatus(dispatcher, order.id, "en_route");
          }
          const startStatus: OrderStatus = c.startEnRoute
            ? "en_route"
            : "accepted";
          expect((await h.repo.getOrder(order.id))?.status).toBe(startStatus);
          expect(await h.repo.getDeliveryByOrder(order.id)).toBeNull();

          const deliveredAt = new Date(c.createdAt.getTime() + c.deliverOffsetMs);
          const label = `from ${startStatus}, ${c.gallons} gal, ticket ${JSON.stringify(
            c.ticket.raw
          )}, photo ${JSON.stringify(c.photo.input)}`;

          const delivery = await h.orders.recordDelivery(
            dispatcher,
            order.id,
            deliveryInput(c.gallons, c.ticket, c.photo),
            deliveredAt
          );

          // Requirements 11.1, 11.6: the row carries the gallons, the trimmed
          // ticket number, and the photo key when one was offered.
          expect(delivery, label).toMatchObject({
            orderId: order.id,
            bolGallons: c.gallons,
            ticketNumber: c.ticket.stored,
            ticketPhotoKey: c.photo.stored,
          });
          expect(delivery.deliveredAt.getTime(), label).toBe(
            deliveredAt.getTime()
          );
          // Stamped at the supplied instant, not at some wall clock of its own.
          expect(await h.repo.getDelivery(delivery.id), label).toMatchObject({
            id: delivery.id,
            orderId: order.id,
          });

          // Requirement 11.2: one Delivery, reachable from the Order.
          expect(
            (await h.repo.getDeliveryByOrder(order.id))?.id,
            label
          ).toBe(delivery.id);

          // Requirement 11.1: the Order is Delivered.
          expect((await h.repo.getOrder(order.id))?.status, label).toBe(
            "delivered"
          );

          // The same thing as either party reads it (Requirement 10.6).
          for (const [who, ctx] of [
            ["buyer", h.buyer],
            ["supplier", dispatcher],
          ] as const) {
            const view = await h.orders.readOrder(ctx, order.id);
            expect(view, `${label} / ${who} read`).toMatchObject({
              orderId: order.id,
              status: "delivered",
            });
            expect(view.delivery, `${label} / ${who} read`).toMatchObject({
              deliveryId: delivery.id,
              bolGallons: c.gallons,
              ticketNumber: c.ticket.stored,
              ticketPhotoKey: c.photo.stored,
            });
          }

          /**
           * Requirement 11.3: a second BOL on the same Order is refused —
           * whatever it carries, and from the Delivered status the first one
           * produced.
           */
          await expectConflict(
            () =>
              h.orders.recordDelivery(
                dispatcher,
                order.id,
                deliveryInput(c.second.gallons, c.second.ticket, c.second.photo),
                deliveredAt
              ),
            "DELIVERY_EXISTS",
            label
          );

          /**
           * Requirement 11.2 again, as the outcome that matters: the refusal
           * neither replaced nor amended the Delivery on file, so the gallons
           * commission invoicing bills from are still the first BOL's.
           */
          expect(
            await h.repo.getDeliveryByOrder(order.id),
            label
          ).toMatchObject({
            id: delivery.id,
            bolGallons: c.gallons,
            ticketNumber: c.ticket.stored,
            ticketPhotoKey: c.photo.stored,
          });
          expect((await h.repo.getOrder(order.id))?.status, label).toBe(
            "delivered"
          );
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 25 (task 9.6) — Requirements 11.4, 11.5
// ---------------------------------------------------------------------------

/** BOL gallon counts at or below zero (Requirement 11.4). */
const invalidBolGallons = fc.oneof(
  { arbitrary: fc.integer({ min: -100_000, max: 0 }), weight: 5 },
  { arbitrary: fc.constantFrom(0, -0, -1, -0.5, -1_000_000), weight: 3 },
  {
    arbitrary: fc.double({
      min: -10_000,
      max: 0,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    weight: 2,
  },
  { arbitrary: fc.constant(Number.NEGATIVE_INFINITY), weight: 1 }
);

/** A ticket number that is not there (Requirement 11.5). */
const missingTicketNumber = fc.oneof(
  {
    arbitrary: fc.constantFrom("", " ", "   ", "\t", "\n", " \t\n "),
    weight: 5,
  },
  {
    arbitrary: fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), {
      minLength: 1,
      maxLength: 8,
    }),
    weight: 3,
  },
  { arbitrary: fc.constantFrom(undefined, null), weight: 2 }
);

/** Which field the dispatcher got wrong — one, the other, or both. */
const badDeliveryCase = fc.oneof(
  fc.record({
    bad: fc.constant("gallons" as const),
    gallons: invalidBolGallons,
    ticket: validTicketNumber,
  }),
  fc.record({
    bad: fc.constant("ticket" as const),
    gallons: validBolGallons,
    ticket: missingTicketNumber,
  }),
  fc.record({
    bad: fc.constant("both" as const),
    gallons: invalidBolGallons,
    ticket: missingTicketNumber,
  })
);

describe("Property 25: Delivery input validation", () => {
  // Feature: load-energy, Property 25: Delivery input validation
  // **Validates: Requirements 11.4, 11.5**
  it("rejects any Delivery whose BOL gallons are at or below zero or whose ticket number is missing with a validation error naming the offending field, records nothing, and leaves the Order's status untouched", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          c: badDeliveryCase,
          createdAt: instant,
          startEnRoute: fc.boolean(),
          alreadyDelivered: fc.boolean(),
          repair: fc.record({
            gallons: validBolGallons,
            ticket: validTicketNumber,
            photo: ticketPhotoSpec,
          }),
        }),
        async ({ c, createdAt, startEnRoute, alreadyDelivered, repair }) => {
          const h = await makeHarness(1, createdAt);
          const order = await wonOrder(h, createdAt);
          const dispatcher = h.suppliers[0].ctx;

          if (startEnRoute) {
            await h.orders.advanceStatus(dispatcher, order.id, "en_route");
          }

          /**
           * Input is checked before the one-per-Order state check, so a bad
           * gallon count on an Order that already has its BOL is still answered
           * as the validation error the dispatcher can act on.
           */
          let onFile = null as Awaited<
            ReturnType<typeof h.repo.getDeliveryByOrder>
          >;
          if (alreadyDelivered) {
            onFile = await h.orders.recordDelivery(
              dispatcher,
              order.id,
              deliveryInput(repair.gallons, repair.ticket, repair.photo),
              createdAt
            );
          }

          const statusBefore = (await h.repo.getOrder(order.id))
            ?.status as OrderStatus;
          h.sms.calls.length = 0;

          const label = `${c.bad} bad (gallons ${JSON.stringify(
            c.gallons
          )}, ticket ${JSON.stringify(c.ticket)}), from ${statusBefore}`;

          /**
           * Gallons are validated first, so a payload that is wrong in both
           * places reports the gallons — the cause the caller hits first, not a
           * merged complaint.
           */
          const [code, field] =
            c.bad === "ticket"
              ? ["TICKET_NUMBER_REQUIRED", "ticketNumber"]
              : ["GALLONS_INVALID", "bolGallons"];

          await expectValidation(
            () =>
              h.orders.recordDelivery(
                dispatcher,
                order.id,
                {
                  bolGallons: c.gallons as number,
                  ticketNumber: c.ticket as unknown as string,
                },
                createdAt
              ),
            code,
            field,
            label
          );

          // Nothing was written: no new Delivery, and the status is exactly
          // what it was before the refused tap.
          const after = await h.repo.getDeliveryByOrder(order.id);
          expect(after?.id ?? null, label).toBe(onFile?.id ?? null);
          if (onFile) {
            // An existing BOL is left byte-for-byte alone.
            expect(after, label).toMatchObject({
              id: onFile.id,
              bolGallons: onFile.bolGallons,
              ticketNumber: onFile.ticketNumber,
              ticketPhotoKey: onFile.ticketPhotoKey,
            });
          }
          expect((await h.repo.getOrder(order.id))?.status, label).toBe(
            statusBefore
          );
          expect(
            (await h.orders.readOrder(h.buyer, order.id)).status,
            label
          ).toBe(statusBefore);
          // Nobody was told fuel landed.
          expect(h.sms.calls, label).toHaveLength(0);

          /**
           * The Order survives the refusal: a corrected payload is accepted
           * immediately when no BOL is on file, and still refused as a
           * duplicate when one is. So the rejection was about the input alone.
           */
          if (onFile) {
            await expectConflict(
              () =>
                h.orders.recordDelivery(
                  dispatcher,
                  order.id,
                  deliveryInput(repair.gallons, repair.ticket, repair.photo),
                  createdAt
                ),
              "DELIVERY_EXISTS",
              label
            );
          } else {
            const fixed = await h.orders.recordDelivery(
              dispatcher,
              order.id,
              deliveryInput(repair.gallons, repair.ticket, repair.photo),
              createdAt
            );
            expect(fixed, label).toMatchObject({
              orderId: order.id,
              bolGallons: repair.gallons,
              ticketNumber: repair.ticket.stored,
              ticketPhotoKey: repair.photo.stored,
            });
            expect((await h.repo.getOrder(order.id))?.status, label).toBe(
              "delivered"
            );
          }
        }
      )
    );
  });
});
