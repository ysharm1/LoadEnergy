/**
 * Property-based tests for the Offer service.
 *
 * Feature: load-energy — Property 11 (task 7.7), Property 12 (task 7.5),
 * Property 13 (task 7.6), Property 14 (task 7.8), Property 15 (task 7.9).
 *
 * Everything under test is real: the real `OfferService` over the real
 * `InMemoryRepository` (which enforces the same unique constraints as the Prisma
 * schema), the real matching predicate behind submission gating, the real
 * validators (`requireLandedPrice`, `requireHoldHours`), the real expiry
 * arithmetic (`computeExpiry`), the real activeness predicates (`isActive`,
 * `isExpired`), the real buyer projection (`toOfferView`), and a real
 * `NotificationDispatcher` over in-memory transports. Nothing about the subject
 * is mocked or faked.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ConflictError, ValidationError } from "@/domain/errors";
import {
  MAX_HOLD_HOURS,
  MIN_HOLD_HOURS,
  OFFER_STATUSES,
  type AuthContext,
  type Company,
  type Offer,
  type OfferStatus,
  type Request,
  type SupplierApprovalStatus,
  type SupplierStatus,
} from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import {
  NotificationDispatcher,
  type EmailSender,
  type SmsSender,
} from "./notifications";
import {
  MAX_ETA_MINUTES,
  MAX_LANDED_PRICE_PER_GAL,
  OfferService,
  computeExpiry,
  isActive,
  isExpired,
  roundLandedPrice,
  type OfferView,
} from "./offer";

const HOUR = 3_600_000;

/** Buckeye is the supplier origin; Goodyear is ~13 mi away, well inside 50. */
const BUCKEYE = { lat: 33.3703, lng: -112.5838 };
const GOODYEAR = { lat: 33.4353, lng: -112.3576 };
const SERVICE_RADIUS_MILES = 50;

const NOW = new Date("2025-03-01T09:00:00Z");

// ---------------------------------------------------------------------------
// In-memory transports — real dispatcher, no network
// ---------------------------------------------------------------------------

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
// Harness
// ---------------------------------------------------------------------------

interface SupplierSpec {
  approval: SupplierApprovalStatus;
  status: SupplierStatus;
}

interface SupplierSeat {
  company: Company;
  ctx: AuthContext;
}

interface Harness {
  repo: InMemoryRepository;
  offers: OfferService;
  sms: RecordingSmsSender;
  buyer: AuthContext;
  suppliers: SupplierSeat[];
  request: Request;
}

/** An eligible seller: Approved, Open, and configured around the load's pin. */
const ELIGIBLE: SupplierSpec = { approval: "approved", status: "open" };

async function makeHarness(
  specs: readonly SupplierSpec[] = [ELIGIBLE],
  requestCreatedAt: Date = NOW
): Promise<Harness> {
  const repo = new InMemoryRepository();
  const sms = new RecordingSmsSender();
  const notifier = new NotificationDispatcher({
    sms,
    email: new RecordingEmailSender(),
    clock: () => requestCreatedAt,
  });
  const offers = new OfferService({ repo, notifier });

  const buyerCo = await repo.createCompany({
    name: "SW Valley Concrete",
    kind: "buyer",
    supplierApprovalStatus: null,
    supplierStatus: null,
    operatingLat: null,
    operatingLng: null,
    serviceRadiusMiles: null,
    createdAt: requestCreatedAt,
  });
  const buyerUser = await repo.createUser({
    companyId: buyerCo.id,
    role: "buyer",
    phone: "+16025550101",
    email: "super@swvalley.example",
    passwordHash: "hash",
    createdAt: requestCreatedAt,
  });

  const suppliers: SupplierSeat[] = [];
  for (const [index, spec] of specs.entries()) {
    const company = await repo.createCompany({
      name: `Supplier ${index} Diesel`,
      kind: "supplier",
      supplierApprovalStatus: spec.approval,
      supplierStatus: spec.status,
      operatingLat: BUCKEYE.lat,
      operatingLng: BUCKEYE.lng,
      serviceRadiusMiles: SERVICE_RADIUS_MILES,
      createdAt: requestCreatedAt,
    });
    const user = await repo.createUser({
      companyId: company.id,
      role: "supplier",
      phone: `+1602555${String(2000 + index).padStart(4, "0")}`,
      email: null,
      passwordHash: "hash",
      createdAt: requestCreatedAt,
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
    windowEndsAt: new Date(requestCreatedAt.getTime() + 8 * HOUR),
    createdAt: requestCreatedAt,
  });

  return {
    repo,
    offers,
    sms,
    buyer: { userId: buyerUser.id, companyId: buyerCo.id, role: "buyer" },
    suppliers,
    request,
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A Landed_Price the column can actually hold: strictly positive, at most four
 * decimal places (`Decimal(10, 4)`), and inside the
 * `MAX_LANDED_PRICE_PER_GAL` ceiling. Drawn as whole ten-thousandths so no draw
 * is silently reshaped by rounding, with the realistic diesel band weighted
 * heaviest and both ends of the column's range pinned as edge cases.
 */
const validPrice = fc.oneof(
  {
    // $2.0000 - $6.0000/gal: the prices a Phoenix dispatcher actually quotes.
    arbitrary: fc
      .integer({ min: 20_000, max: 60_000 })
      .map((tenThousandths) => tenThousandths / 10_000),
    weight: 5,
  },
  {
    arbitrary: fc
      .integer({ min: 1, max: 9_999_999_999 })
      .map((tenThousandths) => tenThousandths / 10_000),
    weight: 2,
  },
  {
    // The extremes: the smallest storable price and the ceiling itself.
    arbitrary: fc.constantFrom(
      0.0001,
      0.01,
      1,
      3.4567,
      MAX_LANDED_PRICE_PER_GAL
    ),
    weight: 2,
  }
);

/** The full inclusive hold range, with both boundaries weighted in. */
const validHoldHours = fc.oneof(
  {
    arbitrary: fc.integer({ min: MIN_HOLD_HOURS, max: MAX_HOLD_HOURS }),
    weight: 4,
  },
  { arbitrary: fc.constantFrom(MIN_HOLD_HOURS, MAX_HOLD_HOURS), weight: 2 }
);

/**
 * The optional ETA (Requirement 6.3): absent as `undefined`, absent as an
 * explicit `null`, or a positive whole number of minutes up to the day-long cap.
 */
const optionalEta = fc.oneof(
  { arbitrary: fc.constant(undefined), weight: 2 },
  { arbitrary: fc.constant(null), weight: 1 },
  { arbitrary: fc.integer({ min: 1, max: MAX_ETA_MINUTES }), weight: 4 },
  { arbitrary: fc.constantFrom(1, 45, 90, MAX_ETA_MINUTES), weight: 2 }
);

/** Varied creation instants, so expiry arithmetic is never anchored to one t. */
const instant = fc.date({
  min: new Date("2025-01-01T00:00:00.000Z"),
  max: new Date("2026-12-31T23:59:59.000Z"),
  noInvalidDate: true,
});

const expectedEta = (eta: number | null | undefined): number | null =>
  eta === undefined || eta === null ? null : eta;

// ---------------------------------------------------------------------------
// Property 12 (task 7.5) — Requirements 6.1, 6.2, 6.3
// ---------------------------------------------------------------------------

describe("Property 12: Offer round trip and expiry computation", () => {
  // Feature: load-energy, Property 12: Offer round trip and expiry computation
  // **Validates: Requirements 6.1, 6.2, 6.3**
  it("stores the submitted price and ETA, links the Request and the Supplier Company, and sets expiresAt to the creation instant plus holdHours", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          price: validPrice,
          holdHours: validHoldHours,
          etaMinutes: optionalEta,
          createdAt: instant,
        }),
        async ({ price, holdHours, etaMinutes, createdAt }) => {
          const h = await makeHarness([ELIGIBLE], createdAt);
          const seat = h.suppliers[0];

          const offer = await h.offers.createOffer(
            seat.ctx,
            {
              requestId: h.request.id,
              landedPricePerGal: price,
              holdHours,
              etaMinutes,
            },
            createdAt
          );

          const label = `price ${price}, hold ${holdHours}, eta ${String(
            etaMinutes
          )}, t ${createdAt.toISOString()}`;

          // Requirement 6.1: the same price comes back, at the scale the
          // Decimal(10,4) column stores.
          expect(offer.landedPricePerGal, label).toBe(roundLandedPrice(price));
          // Every generated price is already at the stored scale.
          expect(offer.landedPricePerGal, label).toBe(price);

          // Requirement 6.3: a supplied ETA is stored; an absent one is null.
          expect(offer.etaMinutes, label).toBe(expectedEta(etaMinutes));

          // Requirement 6.1: linked to the Request and to the Supplier's
          // Company, both taken from the session / input rather than invented.
          expect(offer.requestId, label).toBe(h.request.id);
          expect(offer.supplierCompanyId, label).toBe(seat.company.id);
          expect(offer.createdByUserId, label).toBe(seat.ctx.userId);
          expect(offer.holdHours, label).toBe(holdHours);
          expect(offer.status, label).toBe("active");
          expect(offer.voided, label).toBe(false);

          // Requirement 6.2: Offer_Expiry is exactly creation time + Hold_Hours.
          expect(offer.createdAt.getTime(), label).toBe(createdAt.getTime());
          expect(offer.expiresAt.getTime(), label).toBe(
            createdAt.getTime() + holdHours * HOUR
          );
          expect(offer.expiresAt.getTime(), label).toBe(
            computeExpiry(createdAt, holdHours).getTime()
          );

          // The same values survive the round trip through the store...
          const stored = await h.repo.getOffer(offer.id);
          expect(stored, label).not.toBeNull();
          expect(stored, label).toMatchObject({
            requestId: h.request.id,
            supplierCompanyId: seat.company.id,
            landedPricePerGal: roundLandedPrice(price),
            holdHours,
            etaMinutes: expectedEta(etaMinutes),
            status: "active",
            voided: false,
          });
          expect((stored as Offer).expiresAt.getTime(), label).toBe(
            offer.expiresAt.getTime()
          );

          // ...and through the Buyer's own view of their load.
          const views = await h.offers.listOffersForRequest(
            h.buyer,
            h.request.id,
            createdAt
          );
          expect(views, label).toHaveLength(1);
          expect(views[0], label).toMatchObject({
            offerId: offer.id,
            requestId: h.request.id,
            supplierCompanyId: seat.company.id,
            supplierName: seat.company.name,
            landedPricePerGal: roundLandedPrice(price),
            etaMinutes: expectedEta(etaMinutes),
            holdHours,
          });
          expect(views[0].expiresAt.getTime(), label).toBe(
            offer.expiresAt.getTime()
          );
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13 (task 7.6) — Requirements 6.4, 6.5
// ---------------------------------------------------------------------------

/**
 * Prices that are not a usable Landed_Price: zero (both signs), negatives of
 * every magnitude, and the non-finite values that would otherwise slip through
 * every downstream comparison. The filter guarantees no draw is valid.
 */
const invalidPrice = fc
  .oneof(
    { arbitrary: fc.constantFrom(0, -0), weight: 3 },
    {
      arbitrary: fc.constantFrom(
        -0.0001,
        -1,
        -3.45,
        -999_999.9999,
        -Number.MIN_VALUE,
        -Number.MAX_VALUE,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.NaN
      ),
      weight: 4,
    },
    { arbitrary: fc.integer({ min: -100_000, max: 0 }), weight: 2 },
    {
      arbitrary: fc.double({ min: -50_000, max: -1e-9, noNaN: true }),
      weight: 2,
    }
  )
  .filter((price) => !(Number.isFinite(price) && price > 0));

/**
 * Holds outside the inclusive range [1, 8], plus the fractional and non-finite
 * shapes an integer hold column cannot hold. 0 and 9 — the two values that sit
 * one step outside each boundary — are pinned explicitly.
 */
const invalidHoldHours = fc
  .oneof(
    { arbitrary: fc.constantFrom(0, -0, MAX_HOLD_HOURS + 1), weight: 4 },
    {
      arbitrary: fc.constantFrom(
        -1,
        -8,
        9,
        24,
        1.5,
        2.5,
        7.9,
        8.0001,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY
      ),
      weight: 4,
    },
    { arbitrary: fc.integer({ min: -100, max: 0 }), weight: 2 },
    { arbitrary: fc.integer({ min: 9, max: 100 }), weight: 2 },
    {
      arbitrary: fc
        .double({ min: MIN_HOLD_HOURS, max: MAX_HOLD_HOURS, noNaN: true })
        .filter((hours) => !Number.isInteger(hours)),
      weight: 3,
    }
  )
  .filter(
    (hours) =>
      !(
        Number.isInteger(hours) &&
        hours >= MIN_HOLD_HOURS &&
        hours <= MAX_HOLD_HOURS
      )
  );

/** One bad field at a time, so the reported field is unambiguous. */
type InvalidOfferCase =
  | { field: "landedPricePerGal"; price: number; holdHours: number }
  | { field: "holdHours"; price: number; holdHours: number };

const invalidOfferCase: fc.Arbitrary<InvalidOfferCase> = fc.oneof(
  fc.record({
    field: fc.constant("landedPricePerGal" as const),
    price: invalidPrice,
    holdHours: validHoldHours,
  }),
  fc.record({
    field: fc.constant("holdHours" as const),
    price: validPrice,
    holdHours: invalidHoldHours,
  })
);

const EXPECTED_CODE = {
  landedPricePerGal: "LANDED_PRICE_INVALID",
  holdHours: "HOLD_HOURS_INVALID",
} as const;

describe("Property 13: Offer input validation including hold bound", () => {
  // Feature: load-energy, Property 13: Offer input validation including hold bound
  // **Validates: Requirements 6.4, 6.5**
  it("rejects a non-positive price or a hold outside [1, 8] with a validation error on that field and persists nothing, while a positive price with a hold inside [1, 8] is accepted", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          bad: invalidOfferCase,
          etaMinutes: optionalEta,
          goodPrice: validPrice,
          goodHold: validHoldHours,
          createdAt: instant,
        }),
        async ({ bad, etaMinutes, goodPrice, goodHold, createdAt }) => {
          const h = await makeHarness([ELIGIBLE], createdAt);
          const seat = h.suppliers[0];
          const label = `${bad.field}: price ${String(bad.price)}, hold ${String(
            bad.holdHours
          )}`;

          let thrown: unknown;
          try {
            await h.offers.createOffer(
              seat.ctx,
              {
                requestId: h.request.id,
                landedPricePerGal: bad.price,
                holdHours: bad.holdHours,
                etaMinutes,
              },
              createdAt
            );
          } catch (error) {
            thrown = error;
          }

          // Requirements 6.4, 6.5: a validation error (400 at the API
          // boundary) naming the offending field.
          expect(thrown, label).toBeInstanceOf(ValidationError);
          const error = thrown as ValidationError;
          expect(error.category, label).toBe("validation");
          expect(error.httpStatus, label).toBe(400);
          expect(error.code, label).toBe(EXPECTED_CODE[bad.field]);
          expect(error.field, label).toBe(bad.field);

          // A rejected quote is not a quote: nothing reached the store, and the
          // Buyer sees no offer on their load.
          expect(await h.repo.listOffersByRequest(h.request.id), label).toEqual(
            []
          );
          expect(
            await h.offers.listOffersForRequest(h.buyer, h.request.id, createdAt),
            label
          ).toEqual([]);

          // The other half of the property: a positive price with a hold inside
          // the inclusive range is accepted on the very same load.
          const accepted = await h.offers.createOffer(
            seat.ctx,
            {
              requestId: h.request.id,
              landedPricePerGal: goodPrice,
              holdHours: goodHold,
              etaMinutes,
            },
            createdAt
          );
          expect(accepted.landedPricePerGal, label).toBe(
            roundLandedPrice(goodPrice)
          );
          expect(accepted.holdHours, label).toBe(goodHold);
          expect(
            await h.repo.listOffersByRequest(h.request.id),
            label
          ).toHaveLength(1);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11 (task 7.7) — Requirements 5.4, 5.5
// ---------------------------------------------------------------------------

/**
 * A seller that must not be able to quote: Pending approval, Closed
 * availability, or both. Every other condition on the submission — the load is
 * Open, the pin is inside the configured radius, the price and hold are valid —
 * is satisfied, so gating is the only reason left to reject.
 */
const gatedSupplier: fc.Arbitrary<SupplierSpec> = fc
  .record({
    approval: fc.constantFrom<SupplierApprovalStatus>("pending", "approved"),
    status: fc.constantFrom<SupplierStatus>("open", "limited", "closed"),
  })
  .filter((spec) => spec.approval === "pending" || spec.status === "closed");

/**
 * The complement of `gatedSupplier`: Approved, and Open or Limited. Used as the
 * control seat on the same load, so a rejection above can only be the gate —
 * not the price, the hold, the radius, or the load's own status.
 */
const ungatedSupplier: fc.Arbitrary<SupplierSpec> = fc.record({
  approval: fc.constant<SupplierApprovalStatus>("approved"),
  status: fc.constantFrom<SupplierStatus>("open", "limited"),
});

describe("Property 11: Offer submission is gated by supplier status and approval", () => {
  // Feature: load-energy, Property 11: Offer submission is gated by supplier status and approval
  // **Validates: Requirements 5.4, 5.5**
  it("rejects a submission from a Closed or Pending Supplier Company and persists no offer", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          spec: gatedSupplier,
          control: ungatedSupplier,
          price: validPrice,
          holdHours: validHoldHours,
          etaMinutes: optionalEta,
          createdAt: instant,
        }),
        async ({ spec, control, price, holdHours, etaMinutes, createdAt }) => {
          const h = await makeHarness([spec, control], createdAt);
          const seat = h.suppliers[0];
          const controlSeat = h.suppliers[1];
          const label = `approval ${spec.approval}, status ${spec.status}`;

          let thrown: unknown;
          try {
            await h.offers.createOffer(
              seat.ctx,
              {
                requestId: h.request.id,
                landedPricePerGal: price,
                holdHours,
                etaMinutes,
              },
              createdAt
            );
          } catch (error) {
            thrown = error;
          }

          // Requirements 5.4, 5.5: rejected as a state conflict (409 at the API
          // boundary). Approval is reported before availability, so a Pending
          // company that is also Closed hears about the approval first.
          expect(thrown, label).toBeInstanceOf(ConflictError);
          const error = thrown as ConflictError;
          expect(error.category, label).toBe("conflict");
          expect(error.httpStatus, label).toBe(409);
          expect(error.code, label).toBe(
            spec.approval !== "approved" ? "SUPPLIER_PENDING" : "SUPPLIER_CLOSED"
          );

          // Nothing was written and nothing was paged.
          expect(await h.repo.listOffersByRequest(h.request.id), label).toEqual(
            []
          );
          expect(
            await h.repo.listOffersBySupplierCompany(seat.company.id),
            label
          ).toEqual([]);
          expect(h.sms.calls, label).toEqual([]);

          // The load itself is untouched and still quotable by someone else.
          expect(await h.repo.getRequest(h.request.id), label).toMatchObject({
            status: "open",
          });

          /**
           * The control: the identical submission from an Approved,
           * Open-or-Limited seat on the same load is accepted. That pins the
           * rejection above on the gate alone — the price, the hold, the ETA,
           * the radius, and the Request_Status were all fine.
           */
          const controlLabel = `${label} / control ${control.status}`;
          const accepted = await h.offers.createOffer(
            controlSeat.ctx,
            {
              requestId: h.request.id,
              landedPricePerGal: price,
              holdHours,
              etaMinutes,
            },
            createdAt
          );
          expect(accepted.supplierCompanyId, controlLabel).toBe(
            controlSeat.company.id
          );
          const onLoad = await h.repo.listOffersByRequest(h.request.id);
          expect(onLoad, controlLabel).toHaveLength(1);
          expect(onLoad[0].supplierCompanyId, controlLabel).toBe(
            controlSeat.company.id
          );
          expect(
            await h.repo.listOffersBySupplierCompany(seat.company.id),
            controlLabel
          ).toEqual([]);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14 (task 7.8) — Requirements 6.6, 7.4
// ---------------------------------------------------------------------------

/** A stored lifecycle state a quote can be sitting in when the Buyer looks. */
interface Lifecycle {
  status: OfferStatus;
  voided: boolean;
}

const LIVE_LIFECYCLE: Lifecycle = { status: "active", voided: false };

/**
 * The Buyer's list returns every quote on the load, not only the live ones, so
 * the view under test has to carry the right indicator for a quote that was
 * voided when a sibling won, one that was itself accepted, and one already
 * marked expired — mid-hold or not.
 */
const lifecycle: fc.Arbitrary<Lifecycle> = fc.oneof(
  { arbitrary: fc.constant(LIVE_LIFECYCLE), weight: 5 },
  {
    arbitrary: fc.constant<Lifecycle>({ status: "voided", voided: true }),
    weight: 2,
  },
  {
    arbitrary: fc.constant<Lifecycle>({ status: "accepted", voided: false }),
    weight: 2,
  },
  {
    arbitrary: fc.constant<Lifecycle>({ status: "expired", voided: false }),
    weight: 1,
  }
);

interface QuoteSpec {
  price: number;
  holdHours: number;
  etaMinutes: number | null | undefined;
  lifecycle: Lifecycle;
}

const quoteSpec: fc.Arbitrary<QuoteSpec> = fc.record({
  price: validPrice,
  holdHours: validHoldHours,
  etaMinutes: optionalEta,
  lifecycle,
});

/** A quote is still acceptable only from `active` and unvoided. */
const isLive = (spec: Lifecycle): boolean =>
  spec.status === "active" && !spec.voided;

/**
 * Several quotes on one load plus an evaluation time. The strategies pin the
 * interesting clocks: before every hold lapses, exactly on the shortest hold's
 * expiry (the inclusive boundary, which splits the list), after the longest hold
 * has lapsed, and a freely drawn instant across the whole span.
 */
const offerListCase = fc
  .record({
    quotes: fc.array(quoteSpec, { minLength: 1, maxLength: 5 }),
    strategy: fc.constantFrom(
      "all-active",
      "shortest-boundary",
      "all-expired",
      "spread"
    ),
    spread: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ quotes, strategy, spread }) => {
    const holds = quotes.map((q) => q.holdHours);
    const shortest = Math.min(...holds);
    const longest = Math.max(...holds);
    const offsetMs =
      strategy === "all-active"
        ? 0
        : strategy === "shortest-boundary"
          ? shortest * HOUR
          : strategy === "all-expired"
            ? longest * HOUR
            : Math.round(spread * (longest + 1) * HOUR);
    return { quotes, strategy, offsetMs };
  });

describe("Property 14: Offer view contains required fields and activeness indicator", () => {
  // Feature: load-energy, Property 14: Offer view contains required fields and activeness indicator
  // **Validates: Requirements 6.6, 7.4**
  it("returns the Supplier name, landed price, ETA, and expiry for every quote on the load, each carrying an active/expired indicator that agrees with the activeness predicate at the evaluation time", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ c: offerListCase, createdAt: instant }),
        async ({ c, createdAt }) => {
          const h = await makeHarness(
            c.quotes.map(() => ELIGIBLE),
            createdAt
          );

          const created: Offer[] = [];
          for (const [index, quote] of c.quotes.entries()) {
            const fresh = await h.offers.createOffer(
              h.suppliers[index].ctx,
              {
                requestId: h.request.id,
                landedPricePerGal: quote.price,
                holdHours: quote.holdHours,
                etaMinutes: quote.etaMinutes,
              },
              createdAt
            );
            // Moved into its stored lifecycle state the way a sibling win or a
            // lapse would move it; the expiry and every other field stand.
            created.push(
              isLive(quote.lifecycle)
                ? fresh
                : await h.repo.updateOffer(fresh.id, quote.lifecycle)
            );
          }

          const evaluatedAt = new Date(createdAt.getTime() + c.offsetMs);
          const views = await h.offers.listOffersForRequest(
            h.buyer,
            h.request.id,
            evaluatedAt
          );
          const label = `${c.quotes.length} quotes, ${c.strategy}, +${c.offsetMs}ms`;

          // Every quote on the load is present — expired ones are marked, not
          // dropped, so a Buyer can see that the cheap one lapsed.
          expect(views, label).toHaveLength(created.length);

          for (const [index, offer] of created.entries()) {
            const view = views.find((v) => v.offerId === offer.id);
            const seat = h.suppliers[index];
            const quote = c.quotes[index];
            const perOffer = `${label} / offer ${index}`;

            expect(view, perOffer).toBeDefined();
            const found = view as NonNullable<typeof view>;

            // Requirement 6.6: name, price, ETA, and expiry all present.
            expect(found.supplierName, perOffer).toBe(seat.company.name);
            expect(found.supplierName, perOffer).not.toBe("");
            expect(found.supplierCompanyId, perOffer).toBe(seat.company.id);
            expect(found.landedPricePerGal, perOffer).toBe(
              roundLandedPrice(quote.price)
            );
            expect(found.etaMinutes, perOffer).toBe(
              expectedEta(quote.etaMinutes)
            );
            expect(found.holdHours, perOffer).toBe(quote.holdHours);
            expect(found.expiresAt.getTime(), perOffer).toBe(
              computeExpiry(createdAt, quote.holdHours).getTime()
            );

            // The stored lifecycle is surfaced as-is alongside the indicator.
            expect(found.status, perOffer).toBe(quote.lifecycle.status);

            /**
             * Requirement 7.4: the indicator is exactly "can the Buyer tap
             * Accept on this right now" — the clock still short of the expiry
             * AND the quote still live — restated independently of the service
             * so agreement is not circular.
             */
            const expectedActive =
              isLive(quote.lifecycle) &&
              evaluatedAt.getTime() < found.expiresAt.getTime();
            expect(found.isActive, perOffer).toBe(expectedActive);
            expect(found.activeness, perOffer).toBe(
              expectedActive ? "active" : "expired"
            );
            expect(found.isActive, perOffer).toBe(
              isActive(offer, evaluatedAt)
            );
          }

          const liveQuotes = c.quotes.filter((q) => isLive(q.lifecycle));
          const holds = c.quotes.map((q) => q.holdHours);
          const shortest = Math.min(...holds);

          if (c.strategy === "all-active") {
            // No hold has lapsed yet, so activeness is decided by lifecycle
            // alone: every live quote is active, every dead one is not.
            expect(
              views.filter((v) => v.isActive).length,
              label
            ).toBe(liveQuotes.length);
          }
          if (c.strategy === "all-expired") {
            expect(views.some((v) => v.isActive), label).toBe(false);
          }
          if (c.strategy === "shortest-boundary") {
            /**
             * The boundary strategy is a real split, and that split is the
             * whole reason the indicator is worth returning: at this instant
             * the shortest hold has lapsed exactly, while a live longer hold
             * has not.
             */
            for (const [index, offer] of created.entries()) {
              const quote = c.quotes[index];
              const view = views.find(
                (v) => v.offerId === offer.id
              ) as OfferView;
              if (quote.holdHours === shortest) {
                expect(view.isActive, `${label} / at boundary`).toBe(false);
              } else if (isLive(quote.lifecycle)) {
                expect(view.isActive, `${label} / past boundary`).toBe(true);
              }
            }
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 15 (task 7.9) — Requirements 7.1, 7.2
// ---------------------------------------------------------------------------

/**
 * Evaluation instants relative to a hold that expires at `expiresAt`: the last
 * millisecond of the hold, the expiry instant itself (Requirement 7.2's "reaches
 * or passes"), the first millisecond past it, and freely drawn times on both
 * sides.
 */
const evaluationOffsetMs = fc.oneof(
  { arbitrary: fc.constantFrom(-1, 0, 1), weight: 4 },
  { arbitrary: fc.integer({ min: -8 * HOUR, max: 8 * HOUR }), weight: 3 },
  {
    arbitrary: fc.constantFrom(
      -HOUR,
      -1000,
      -2,
      2,
      1000,
      HOUR,
      24 * HOUR,
      -24 * HOUR
    ),
    weight: 2,
  }
);

describe("Property 15: Offer activeness boundary", () => {
  // Feature: load-energy, Property 15: Offer activeness boundary
  // **Validates: Requirements 7.1, 7.2**
  it("treats a stored Offer as active exactly while now is strictly before expiresAt and its status is active and unvoided, and as expired once now reaches expiresAt", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          price: validPrice,
          holdHours: validHoldHours,
          etaMinutes: optionalEta,
          createdAt: instant,
          status: fc.constantFrom<OfferStatus>(...OFFER_STATUSES),
          voided: fc.boolean(),
          offsetMs: evaluationOffsetMs,
        }),
        async ({
          price,
          holdHours,
          etaMinutes,
          createdAt,
          status,
          voided,
          offsetMs,
        }) => {
          const h = await makeHarness([ELIGIBLE], createdAt);

          // A real Offer written by the real service, then moved into the
          // lifecycle state under test the way a sibling win or a lapse would.
          const fresh = await h.offers.createOffer(
            h.suppliers[0].ctx,
            {
              requestId: h.request.id,
              landedPricePerGal: price,
              holdHours,
              etaMinutes,
            },
            createdAt
          );
          const offer = await h.repo.updateOffer(fresh.id, { status, voided });

          const expiresAt = offer.expiresAt;
          expect(expiresAt.getTime()).toBe(
            computeExpiry(createdAt, holdHours).getTime()
          );

          const now = new Date(expiresAt.getTime() + offsetMs);
          const label = `status ${status}, voided ${voided}, now ${
            offsetMs >= 0 ? "+" : ""
          }${offsetMs}ms of expiry`;

          const beforeExpiry = now.getTime() < expiresAt.getTime();
          const liveStatus = status === "active" && !voided;

          // Requirements 7.1, 7.2: active iff the clock is strictly short of
          // the expiry AND the quote is still live. A voided or already-accepted
          // quote is not acceptable even mid-hold.
          expect(isActive(offer, now), label).toBe(beforeExpiry && liveStatus);

          // Expiry itself depends only on the clock, whatever the status.
          expect(isExpired(offer, now), label).toBe(!beforeExpiry);

          // The boundary, stated directly: the last millisecond of the hold is
          // still live, the expiry instant is not.
          const lastMs = new Date(expiresAt.getTime() - 1);
          expect(isActive(offer, lastMs), label).toBe(liveStatus);
          expect(isExpired(offer, lastMs), label).toBe(false);
          expect(isActive(offer, expiresAt), label).toBe(false);
          expect(isExpired(offer, expiresAt), label).toBe(true);
          expect(
            isExpired(offer, new Date(expiresAt.getTime() + 1)),
            label
          ).toBe(true);

          // The Buyer's indicator never disagrees with the predicate.
          const [view] = await h.offers.listOffersForRequest(
            h.buyer,
            h.request.id,
            now
          );
          expect(view.isActive, label).toBe(isActive(offer, now));
          expect(view.activeness, label).toBe(
            beforeExpiry && liveStatus ? "active" : "expired"
          );
        }
      )
    );
  });
});
