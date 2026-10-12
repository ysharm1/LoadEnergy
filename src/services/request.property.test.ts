/**
 * Property-based tests for the Request service.
 *
 * Feature: load-energy — Property 5 (task 4.6), Property 6 (task 4.7),
 * Property 7 (task 4.8).
 *
 * Runs the real `RequestService` over the real `AdminService` (which supplies
 * the configured Pilot_Geofence) and the real `InMemoryRepository`, with the
 * real `CompanyUserService` + `BcryptPasswordHasher` (low cost factor: genuine
 * hashing, cheap enough for 100+ iterations) building the Company and Buyer.
 * The geofence predicate under test is the real `isInsideGeofence`. No mocks
 * and no fakes: these properties exercise the same code the route handlers
 * will call.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { InMemoryRepository } from "@/repository/in-memory";
import { ConflictError, GeofenceError, ValidationError } from "@/domain/errors";
import {
  DELIVERY_METHODS,
  DELIVERY_WINDOWS,
  MAX_HOLD_HOURS,
  MAX_LAT,
  MAX_LNG,
  MIN_HOLD_HOURS,
  MIN_LAT,
  MIN_LNG,
  PRODUCT_TYPES,
  type AuthContext,
  type Company,
  type Geofence,
  type LatLng,
  type Offer,
  type OfferStatus,
  type Request as RequestRecord,
} from "@/domain/types";
import { AdminService } from "./admin";
import { CompanyUserService } from "./company-user";
import { isInsideGeofence } from "./geofence";
import { OfferService, isActive } from "./offer";
import { OrderService } from "./order";
import { BcryptPasswordHasher } from "./password";
import { RequestService, deliveryWindowEndsAt, hasWindowEnded } from "./request";

const NOW = new Date("2025-03-01T09:00:00Z"); // 02:00 Phoenix time, Mar 1
const LATER = new Date("2025-03-01T10:00:00Z");

const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

const token = (maxLength: number) =>
  fc.stringOf(fc.constantFrom(...LOWER_ALNUM.split("")), {
    minLength: 1,
    maxLength,
  });

// ---------------------------------------------------------------------------
// Coordinate and geofence generators
// ---------------------------------------------------------------------------

const latitude = fc.oneof(
  {
    arbitrary: fc.double({ min: MIN_LAT, max: MAX_LAT, noNaN: true }),
    weight: 4,
  },
  {
    arbitrary: fc.constantFrom(MIN_LAT, MAX_LAT, 0, 33.2, 33.6, 33.4484),
    weight: 1,
  }
);

const longitude = fc.oneof(
  {
    arbitrary: fc.double({ min: MIN_LNG, max: MAX_LNG, noNaN: true }),
    weight: 4,
  },
  {
    arbitrary: fc.constantFrom(MIN_LNG, MAX_LNG, 0, -112.6, -112.1, -112.074),
    weight: 1,
  }
);

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

/** A valid box: corners sorted so `min <= max` on both axes. */
const boundingBox: fc.Arbitrary<Geofence> = fc.oneof(
  {
    arbitrary: fc
      .tuple(latitude, latitude, longitude, longitude)
      .map(([latA, latB, lngA, lngB]) => ({
        minLat: Math.min(latA, latB),
        maxLat: Math.max(latA, latB),
        minLng: Math.min(lngA, lngB),
        maxLng: Math.max(lngA, lngB),
      })),
    weight: 4,
  },
  {
    // Degenerate single-pin box: `min === max` is allowed and the inclusive
    // bounds admit exactly that pin.
    arbitrary: fc.tuple(latitude, longitude).map(([lat, lng]) => ({
      minLat: lat,
      maxLat: lat,
      minLng: lng,
      maxLng: lng,
    })),
    weight: 1,
  },
  {
    arbitrary: fc.constant<Geofence>({
      minLat: 33.2,
      maxLat: 33.6,
      minLng: -112.6,
      maxLng: -112.1,
    }),
    weight: 1,
  }
);

/** A point on one axis inside [min, max], including the bounds themselves. */
const insideAxis = (min: number, max: number) =>
  fc.oneof(
    {
      arbitrary: fc
        .double({ min: 0, max: 1, noNaN: true })
        .map((t) => clamp(min + t * (max - min), min, max)),
      weight: 3,
    },
    { arbitrary: fc.constantFrom(min, max), weight: 2 }
  );

/** A pin strictly inside the box, edges and corners included. */
const insidePinFor = (fence: Geofence): fc.Arbitrary<LatLng> =>
  fc.record({
    lat: insideAxis(fence.minLat, fence.maxLat),
    lng: insideAxis(fence.minLng, fence.maxLng),
  });

/**
 * A pin pushed past one bound of the box, clamped to the valid coordinate
 * range. Clamping can land it back inside a box that spans the whole range, so
 * the properties always recompute membership with the real predicate rather
 * than assuming which side a generated pin fell on.
 */
const pushedOutPinFor = (fence: Geofence): fc.Arbitrary<LatLng> =>
  fc
    .tuple(
      fc.constantFrom("lat-above", "lat-below", "lng-above", "lng-below"),
      fc.double({ min: 0.0001, max: 60, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true })
    )
    .map(([direction, delta, tLat, tLng]) => {
      const baseLat = clamp(
        fence.minLat + tLat * (fence.maxLat - fence.minLat),
        fence.minLat,
        fence.maxLat
      );
      const baseLng = clamp(
        fence.minLng + tLng * (fence.maxLng - fence.minLng),
        fence.minLng,
        fence.maxLng
      );

      switch (direction) {
        case "lat-above":
          return { lat: Math.min(MAX_LAT, fence.maxLat + delta), lng: baseLng };
        case "lat-below":
          return { lat: Math.max(MIN_LAT, fence.minLat - delta), lng: baseLng };
        case "lng-above":
          return { lat: baseLat, lng: Math.min(MAX_LNG, fence.maxLng + delta) };
        default:
          return { lat: baseLat, lng: Math.max(MIN_LNG, fence.minLng - delta) };
      }
    });

/** The four corners of the box: the inclusive-bound edge cases. */
const cornerPinFor = (fence: Geofence): fc.Arbitrary<LatLng> =>
  fc.constantFrom(
    { lat: fence.minLat, lng: fence.minLng },
    { lat: fence.minLat, lng: fence.maxLng },
    { lat: fence.maxLat, lng: fence.minLng },
    { lat: fence.maxLat, lng: fence.maxLng }
  );

// ---------------------------------------------------------------------------
// Request input generators
// ---------------------------------------------------------------------------

/** gallons > 0 and whole, from the smallest load to a full tanker. */
const positiveGallons = fc.oneof(
  { arbitrary: fc.integer({ min: 1, max: 12000 }), weight: 4 },
  { arbitrary: fc.constantFrom(1, 2, 100, 500, 7500, 1_000_000), weight: 1 }
);

const productType = fc.constantFrom(...PRODUCT_TYPES);
const deliveryMethod = fc.constantFrom(...DELIVERY_METHODS);
const deliveryWindow = fc.constantFrom(...DELIVERY_WINDOWS);

/**
 * Notes are optional (Requirement 3.7): absent (`undefined`), explicitly null,
 * or text. Blank and padded text are included because the service trims and
 * stores blank as null, so `expectedNotes` mirrors that documented rule.
 */
const optionalNotes = fc.oneof(
  { arbitrary: fc.constant(undefined), weight: 2 },
  { arbitrary: fc.constant(null), weight: 1 },
  {
    arbitrary: fc.string({ minLength: 1, maxLength: 120 }),
    weight: 3,
  },
  {
    arbitrary: fc
      .tuple(token(10), token(10))
      .map(([a, b]) => `  gate code ${a}, ask for ${b}  `),
    weight: 2,
  },
  { arbitrary: fc.constantFrom("", "   ", "\n\t "), weight: 1 }
);

function expectedNotes(notes: string | null | undefined): string | null {
  if (notes === undefined || notes === null) return null;
  const trimmed = notes.trim();
  return trimmed === "" ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Harness — one Buyer Company, one Buyer, and an Admin who owns the fence
// ---------------------------------------------------------------------------

interface Harness {
  admin: AdminService;
  service: RequestService;
  adminCtx: AuthContext;
  buyer: AuthContext;
  buyerCompany: Company;
}

async function makeHarness(names: {
  operator: string;
  buyer: string;
}): Promise<Harness> {
  const repo = new InMemoryRepository();
  const companies = new CompanyUserService({
    repo,
    hasher: new BcryptPasswordHasher(4),
  });
  const admin = new AdminService({ repo });
  const service = new RequestService({ repo, admin });

  const operatorCompany = await companies.createCompany(
    { name: `${names.operator}-operator`, kind: "buyer" },
    NOW
  );
  const buyerCompany = await companies.createCompany(
    { name: `${names.buyer}-buyer`, kind: "buyer" },
    NOW
  );

  const adminUser = await companies.createUser(
    {
      companyId: operatorCompany.id,
      role: "admin",
      phone: "+16025550100",
      password: "operator-pw",
    },
    NOW
  );
  const buyerUser = await companies.createUser(
    {
      companyId: buyerCompany.id,
      role: "buyer",
      phone: "+16025550121",
      password: "buyer-pw",
    },
    NOW
  );

  return {
    admin,
    service,
    adminCtx: {
      userId: adminUser.id,
      companyId: adminUser.companyId,
      role: "admin",
    },
    buyer: {
      userId: buyerUser.id,
      companyId: buyerUser.companyId,
      role: "buyer",
    },
    buyerCompany,
  };
}

// ---------------------------------------------------------------------------
// Property 5 (task 4.6)
// ---------------------------------------------------------------------------

interface ValidRequestCase {
  fence: Geofence;
  pin: LatLng;
  gallons: number;
  productType: (typeof PRODUCT_TYPES)[number];
  deliveryMethod: (typeof DELIVERY_METHODS)[number];
  deliveryWindow: (typeof DELIVERY_WINDOWS)[number];
  notes: string | null | undefined;
}

const validRequestCase: fc.Arbitrary<ValidRequestCase> = boundingBox.chain(
  (fence) =>
    fc.record({
      fence: fc.constant(fence),
      // Inside the configured box, corners included, so creation is expected
      // to succeed for every generated case.
      pin: fc.oneof(
        { arbitrary: insidePinFor(fence), weight: 3 },
        { arbitrary: cornerPinFor(fence), weight: 1 }
      ),
      gallons: positiveGallons,
      productType,
      deliveryMethod,
      deliveryWindow,
      notes: optionalNotes,
    })
);

describe("Property 5: Request round trip with valid enums", () => {
  // Feature: load-energy, Property 5: Request round trip with valid enums
  // **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.7, 3.8**
  it("creates an Open Request carrying the submitted gallons, enums, pin, and notes, linked to the creating Buyer and Company", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          operatorName: token(10),
          buyerName: token(10),
          c: validRequestCase,
        }),
        async ({ operatorName, buyerName, c }) => {
          const h = await makeHarness({
            operator: operatorName,
            buyer: buyerName,
          });
          await h.admin.setGeofence(h.adminCtx, c.fence, NOW);

          const created = await h.service.createRequest(
            h.buyer,
            {
              gallons: c.gallons,
              productType: c.productType,
              deliveryMethod: c.deliveryMethod,
              deliveryWindow: c.deliveryWindow,
              lat: c.pin.lat,
              lng: c.pin.lng,
              notes: c.notes,
            },
            NOW
          );

          // Requirement 3.1: initial status is Open.
          expect(created.status).toBe("open");

          // Requirements 3.2, 3.3, 3.4, 3.7: every submitted field round-trips,
          // notes included when supplied.
          expect(created.gallons).toBe(c.gallons);
          expect(created.productType).toBe(c.productType);
          expect(created.deliveryMethod).toBe(c.deliveryMethod);
          expect(created.deliveryWindow).toBe(c.deliveryWindow);
          expect(created.pinLat).toBe(c.pin.lat);
          expect(created.pinLng).toBe(c.pin.lng);
          expect(created.notes).toBe(expectedNotes(c.notes));

          // Requirement 3.8: linked to the creating Buyer and that Buyer's
          // Company, both taken from the session.
          expect(created.createdByUserId).toBe(h.buyer.userId);
          expect(created.buyerCompanyId).toBe(h.buyerCompany.id);

          // Requirement 3.1: the window end is derived from the window and is
          // never already past at creation.
          expect(created.windowEndsAt.getTime()).toBe(
            deliveryWindowEndsAt(c.deliveryWindow, NOW).getTime()
          );
          expect(created.windowEndsAt.getTime()).toBeGreaterThanOrEqual(
            NOW.getTime()
          );

          // The same values survive a read back through the work list
          // (Requirement 3.9's Open-request half).
          const work = await h.service.getWorkList(h.buyer, undefined, NOW);
          const readBack = work.requests.find((r) => r.id === created.id);
          expect(readBack, "created Request missing from the work list").toBeDefined();
          expect(readBack).toMatchObject({
            status: "open",
            gallons: c.gallons,
            productType: c.productType,
            deliveryMethod: c.deliveryMethod,
            deliveryWindow: c.deliveryWindow,
            pinLat: c.pin.lat,
            pinLng: c.pin.lng,
            notes: expectedNotes(c.notes),
            createdByUserId: h.buyer.userId,
            buyerCompanyId: h.buyerCompany.id,
          });
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6 (task 4.7)
// ---------------------------------------------------------------------------

/**
 * Gallon values that are not greater than zero — exact zero, negative zero,
 * negatives of every magnitude, and -Infinity — plus the other shapes the
 * service refuses for the same reason a non-positive count is refused: NaN,
 * +Infinity, and fractional values, none of which can be a valid whole-gallon
 * load. The filter guarantees no draw is a valid positive integer.
 */
const invalidGallons = fc
  .oneof(
    { arbitrary: fc.constantFrom(0, -0), weight: 3 },
    {
      arbitrary: fc.constantFrom(
        -1,
        -0.5,
        -500,
        -1e-9,
        -Number.MIN_VALUE,
        -Number.MAX_VALUE,
        Number.NEGATIVE_INFINITY
      ),
      weight: 3,
    },
    { arbitrary: fc.integer({ min: -100000, max: 0 }), weight: 2 },
    {
      arbitrary: fc.double({ min: -50000, max: -1e-9, noNaN: true }),
      weight: 2,
    },
    // Non-integer and non-finite counts: rejected with the same contract.
    {
      arbitrary: fc.constantFrom(
        0.5,
        1.5,
        499.9,
        Number.NaN,
        Number.POSITIVE_INFINITY
      ),
      weight: 2,
    }
  )
  .filter((gallons) => !(Number.isInteger(gallons) && gallons > 0));

describe("Property 6: Non-positive gallons rejected", () => {
  // Feature: load-energy, Property 6: Non-positive gallons rejected
  // **Validates: Requirements 3.5**
  it("rejects a Request whose gallons are not a positive whole number with a validation error on gallons and persists nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          operatorName: token(10),
          buyerName: token(10),
          gallons: invalidGallons,
          c: validRequestCase,
        }),
        async ({ operatorName, buyerName, gallons, c }) => {
          const h = await makeHarness({
            operator: operatorName,
            buyer: buyerName,
          });
          // Everything else about the Request is valid, including a fence and a
          // pin inside it, so gallons is the only reason to reject.
          await h.admin.setGeofence(h.adminCtx, c.fence, NOW);

          let thrown: unknown;
          try {
            await h.service.createRequest(
              h.buyer,
              {
                gallons: gallons as number,
                productType: c.productType,
                deliveryMethod: c.deliveryMethod,
                deliveryWindow: c.deliveryWindow,
                lat: c.pin.lat,
                lng: c.pin.lng,
                notes: c.notes,
              },
              NOW
            );
          } catch (error) {
            thrown = error;
          }

          // Requirement 3.5: a validation error (400 at the API boundary) on
          // the gallons field.
          expect(thrown, `gallons: ${String(gallons)}`).toBeInstanceOf(
            ValidationError
          );
          const error = thrown as ValidationError;
          expect(error.category).toBe("validation");
          expect(error.httpStatus).toBe(400);
          expect(error.code).toBe("GALLONS_INVALID");
          expect(error.field).toBe("gallons");

          // Rejection means nothing was written.
          const work = await h.service.getWorkList(h.buyer, undefined, NOW);
          expect(work.requests).toHaveLength(0);
          expect(work.orders).toHaveLength(0);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7 (task 4.8)
// ---------------------------------------------------------------------------

/** A degenerate box on the pin itself: inclusive bounds admit exactly it. */
function fenceIncluding(pin: LatLng): Geofence {
  return {
    minLat: pin.lat,
    maxLat: pin.lat,
    minLng: pin.lng,
    maxLng: pin.lng,
  };
}

/** A box on a latitude the pin cannot occupy, so the pin is excluded. */
function fenceExcluding(pin: LatLng): Geofence {
  const lat = pin.lat === MIN_LAT ? MAX_LAT : MIN_LAT;
  return { minLat: lat, maxLat: lat, minLng: MIN_LNG, maxLng: MAX_LNG };
}

interface FencePinCase {
  fence: Geofence;
  pin: LatLng;
}

/**
 * A box plus a pin drawn from inside it, on one of its corners, or pushed past
 * one of its bounds — so both branches of the equivalence get exercised.
 */
const fencePinCase: fc.Arbitrary<FencePinCase> = boundingBox.chain((fence) =>
  fc.record({
    fence: fc.constant(fence),
    pin: fc.oneof(
      { arbitrary: insidePinFor(fence), weight: 2 },
      { arbitrary: cornerPinFor(fence), weight: 1 },
      { arbitrary: pushedOutPinFor(fence), weight: 3 },
      { arbitrary: fc.record({ lat: latitude, lng: longitude }), weight: 2 }
    ),
  })
);

describe("Property 7: Geofence membership governs Request acceptance", () => {
  // Feature: load-energy, Property 7: Geofence membership governs Request acceptance
  // **Validates: Requirements 3.6, 16.7**
  it("accepts a Request exactly when its pin lies inside the currently configured fence, including after an Admin updates the fence", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          operatorName: token(10),
          buyerName: token(10),
          c: fencePinCase,
          gallons: positiveGallons,
          productType,
          deliveryMethod,
          deliveryWindow,
        }),
        async (args) => {
          const { c } = args;
          const h = await makeHarness({
            operator: args.operatorName,
            buyer: args.buyerName,
          });

          const input = {
            gallons: args.gallons,
            productType: args.productType,
            deliveryMethod: args.deliveryMethod,
            deliveryWindow: args.deliveryWindow,
            lat: c.pin.lat,
            lng: c.pin.lng,
          };
          const label = `pin ${c.pin.lat},${c.pin.lng} vs box ${c.fence.minLat}..${c.fence.maxLat} / ${c.fence.minLng}..${c.fence.maxLng}`;

          /**
           * Attempts creation and reports whether the Request was accepted.
           * A geofence rejection is the expected failure mode; anything else
           * propagates and fails the property.
           */
          const attempt = async (
            fence: Geofence
          ): Promise<{ accepted: boolean; error?: GeofenceError }> => {
            try {
              const request = await h.service.createRequest(h.buyer, input, NOW);
              expect(request.status).toBe("open");
              expect(request.pinLat).toBe(c.pin.lat);
              expect(request.pinLng).toBe(c.pin.lng);
              return { accepted: true };
            } catch (error) {
              expect(error, label).toBeInstanceOf(GeofenceError);
              const geofenceError = error as GeofenceError;
              // Requirement 3.6: a geofence error, 422, code OUTSIDE_GEOFENCE,
              // echoing the configured box for client messaging.
              expect(geofenceError.category).toBe("geofence");
              expect(geofenceError.httpStatus).toBe(422);
              expect(geofenceError.code).toBe("OUTSIDE_GEOFENCE");
              expect(geofenceError.details?.fence).toEqual({
                minLat: fence.minLat,
                maxLat: fence.maxLat,
                minLng: fence.minLng,
                maxLng: fence.maxLng,
              });
              return { accepted: false, error: geofenceError };
            }
          };

          // With no fence configured at all, the pilot fails closed: a distinct
          // geofence-category code says an operator must set the box.
          let unconfigured: unknown;
          try {
            await h.service.createRequest(h.buyer, input, NOW);
          } catch (error) {
            unconfigured = error;
          }
          expect(unconfigured).toBeInstanceOf(GeofenceError);
          expect((unconfigured as GeofenceError).code).toBe(
            "GEOFENCE_NOT_CONFIGURED"
          );
          expect((unconfigured as GeofenceError).httpStatus).toBe(422);
          expect(
            await h.service.getWorkList(h.buyer, undefined, NOW)
          ).toMatchObject({
            requests: [],
          });

          // Requirement 3.6: with the fence configured, acceptance agrees
          // exactly with inclusive bounding-box membership.
          await h.admin.setGeofence(h.adminCtx, c.fence, NOW);
          const insideFirst = isInsideGeofence(c.pin, c.fence);
          const first = await attempt(c.fence);
          expect(first.accepted, label).toBe(insideFirst);

          // Requirement 16.7: an Admin updating the fence governs subsequent
          // Requests. The second box is built to flip membership for this same
          // pin, so the outcome must flip too.
          const updated = insideFirst
            ? fenceExcluding(c.pin)
            : fenceIncluding(c.pin);
          const insideSecond = isInsideGeofence(c.pin, updated);
          expect(insideSecond, `flip construction failed for ${label}`).toBe(
            !insideFirst
          );

          await h.admin.setGeofence(h.adminCtx, updated, LATER);
          const second = await attempt(updated);
          expect(second.accepted, `after fence update: ${label}`).toBe(
            insideSecond
          );
          expect(second.accepted).toBe(!first.accepted);

          // Exactly the accepted attempts were persisted.
          const work = await h.service.getWorkList(h.buyer, undefined, LATER);
          expect(work.requests).toHaveLength(
            (first.accepted ? 1 : 0) + (second.accepted ? 1 : 0)
          );
        }
      )
    );
  });
});
// ===========================================================================
// Leaving Open: cancellation and window-end expiry
//
// Feature: load-energy — Property 20 (task 8.3), Property 21 (task 8.4),
// Property 22 (task 8.5).
//
// These three properties need quotes on the load, so the harness widens: the
// real `RequestService`, the real `OfferService`, and the real `OrderService`
// all over one real `InMemoryRepository`, with the real `AdminService` owning
// the Pilot_Geofence and each Supplier Company's Operating_Location and
// Service_Radius. Nothing about the subject is stubbed — a quote is created by
// a supplier actually submitting it, a load becomes Accepted by a buyer
// actually accepting an offer, and voiding is whatever the shared
// `voidActiveOffersOnRequest` helper really does.
//
// Companies and users are written straight through the repository here rather
// than through `CompanyUserService`: identity creation is covered by its own
// properties, and skipping the password hashing keeps these harnesses cheap
// enough to build fresh for every iteration.
// ===========================================================================

const MS_PER_HOUR = 3_600_000;

/** The pilot box, a supplier origin inside it, and a load pin ~13 mi away. */
const PILOT_BOX: Geofence = {
  minLat: 33.2,
  maxLat: 33.6,
  minLng: -112.6,
  maxLng: -112.1,
};
const BUCKEYE = { lat: 33.3703, lng: -112.5838 };
const GOODYEAR = { lat: 33.4353, lng: -112.3576 };
const SERVICE_RADIUS_MILES = 50;

interface SupplierSeat {
  company: Company;
  ctx: AuthContext;
}

interface LoadHarness {
  repo: InMemoryRepository;
  requests: RequestService;
  offers: OfferService;
  orders: OrderService;
  buyer: AuthContext;
  suppliers: SupplierSeat[];
}

/**
 * One Buyer Company plus `supplierCount` Approved, Open Supplier Companies,
 * each configured by the real Admin service around the load's pin so their
 * quotes pass the real eligibility gate.
 */
async function makeLoadHarness(supplierCount: number): Promise<LoadHarness> {
  const repo = new InMemoryRepository();
  const admin = new AdminService({ repo });
  const requests = new RequestService({ repo, admin });
  const offers = new OfferService({ repo });
  const orders = new OrderService({ repo });

  const blankCompany = {
    supplierApprovalStatus: null,
    supplierStatus: null,
    operatingLat: null,
    operatingLng: null,
    serviceRadiusMiles: null,
    createdAt: NOW,
  } as const;

  const operatorCompany = await repo.createCompany({
    name: "Load Energy",
    kind: "buyer",
    ...blankCompany,
  });
  const buyerCompany = await repo.createCompany({
    name: "SW Valley Concrete",
    kind: "buyer",
    ...blankCompany,
  });

  const adminUser = await repo.createUser({
    companyId: operatorCompany.id,
    role: "admin",
    phone: "+16025550100",
    email: null,
    passwordHash: "hash",
    createdAt: NOW,
  });
  const buyerUser = await repo.createUser({
    companyId: buyerCompany.id,
    role: "buyer",
    phone: "+16025550121",
    email: null,
    passwordHash: "hash",
    createdAt: NOW,
  });

  const adminCtx: AuthContext = {
    userId: adminUser.id,
    companyId: operatorCompany.id,
    role: "admin",
  };
  await admin.setGeofence(adminCtx, PILOT_BOX, NOW);

  const suppliers: SupplierSeat[] = [];
  for (let index = 0; index < supplierCount; index += 1) {
    const created = await repo.createCompany({
      name: `Supplier ${index} Diesel`,
      kind: "supplier",
      supplierApprovalStatus: "pending",
      supplierStatus: "open",
      operatingLat: null,
      operatingLng: null,
      serviceRadiusMiles: null,
      createdAt: NOW,
    });
    // Real Admin configuration: approval, origin, radius.
    await admin.approveSupplier(adminCtx, created.id);
    await admin.setOperatingLocation(adminCtx, created.id, BUCKEYE);
    const company = await admin.setServiceRadius(
      adminCtx,
      created.id,
      SERVICE_RADIUS_MILES
    );

    const user = await repo.createUser({
      companyId: company.id,
      role: "supplier",
      phone: `+1602555${String(2000 + index).padStart(4, "0")}`,
      email: null,
      passwordHash: "hash",
      createdAt: NOW,
    });
    suppliers.push({
      company,
      ctx: { userId: user.id, companyId: company.id, role: "supplier" },
    });
  }

  return {
    repo,
    requests,
    offers,
    orders,
    buyer: { userId: buyerUser.id, companyId: buyerCompany.id, role: "buyer" },
    suppliers,
  };
}

/** An Open Request on the pin every harness supplier can serve. */
async function createLoad(
  h: LoadHarness,
  window: (typeof DELIVERY_WINDOWS)[number],
  gallons = 500,
  createdAt: Date = NOW
): Promise<RequestRecord> {
  return h.requests.createRequest(
    h.buyer,
    {
      gallons,
      productType: "ulsd",
      deliveryMethod: "wet_hose",
      deliveryWindow: window,
      lat: GOODYEAR.lat,
      lng: GOODYEAR.lng,
    },
    createdAt
  );
}

/** A stored lifecycle state a quote can already be sitting in. */
interface DeadState {
  status: OfferStatus;
  voided: boolean;
}

interface QuoteSpec {
  price: number;
  holdHours: number;
  /** Null means the quote is left as submitted: stored `active`, unvoided. */
  dead: DeadState | null;
}

/**
 * Submits one quote per supplier seat through the real `OfferService`, then
 * moves the ones marked dead into their stored state the way a sibling win or a
 * lapse would have. Returns the records as stored.
 */
async function seedQuotes(
  h: LoadHarness,
  requestId: string,
  specs: readonly QuoteSpec[],
  createdAt: Date = NOW
): Promise<Offer[]> {
  const created: Offer[] = [];
  for (const [index, spec] of specs.entries()) {
    const fresh = await h.offers.createOffer(
      h.suppliers[index].ctx,
      {
        requestId,
        landedPricePerGal: spec.price,
        holdHours: spec.holdHours,
      },
      createdAt
    );
    created.push(
      spec.dead === null
        ? fresh
        : await h.repo.updateOffer(fresh.id, spec.dead)
    );
  }
  return created;
}

/** The stored lifecycle of every quote on a load, keyed by offer id. */
async function offerStates(
  h: LoadHarness,
  requestId: string
): Promise<Map<string, DeadState>> {
  const offers = await h.repo.listOffersByRequest(requestId);
  return new Map(
    offers.map((offer) => [offer.id, { status: offer.status, voided: offer.voided }])
  );
}

// ---------------------------------------------------------------------------
// Shared quote generators
// ---------------------------------------------------------------------------

/** $2.0000-$6.0000/gal at the Decimal(10,4) scale, so nothing is reshaped. */
const quotePrice = fc
  .integer({ min: 20_000, max: 60_000 })
  .map((tenThousandths) => tenThousandths / 10_000);

/** The full inclusive 1..8 hour hold range, both boundaries included. */
const quoteHold = fc.integer({ min: MIN_HOLD_HOURS, max: MAX_HOLD_HOURS });

/**
 * The states a quote can already be dead in when the load leaves Open. Voiding
 * must leave every one of them exactly as it found them — a quote that lost an
 * earlier race, one that was itself accepted, and one already marked expired.
 */
const deadState: fc.Arbitrary<DeadState> = fc.constantFrom<DeadState>(
  { status: "voided", voided: true },
  { status: "accepted", voided: false },
  { status: "expired", voided: false }
);

const quoteSpec: fc.Arbitrary<QuoteSpec> = fc.record({
  price: quotePrice,
  holdHours: quoteHold,
  dead: fc.oneof(
    { arbitrary: fc.constant(null), weight: 3 },
    { arbitrary: deadState, weight: 2 }
  ),
});

// ---------------------------------------------------------------------------
// Property 20 (task 8.3) — Requirement 9.1
// ---------------------------------------------------------------------------

/**
 * Between one and four quotes on the load, the first of them always left live,
 * so every case really is "an Open Request with active Offers" as the property
 * states. The rest are free to be already dead.
 */
const cancelQuotes: fc.Arbitrary<QuoteSpec[]> = fc
  .array(quoteSpec, { minLength: 1, maxLength: 4 })
  .map((specs) => [{ ...specs[0], dead: null }, ...specs.slice(1)]);

describe("Property 20: Cancelling an Open request voids its offers", () => {
  // Feature: load-energy, Property 20: Cancelling an Open request voids its offers
  // **Validates: Requirements 9.1**
  it("sets the Request_Status to Cancelled and voids every active Offer on the load, leaving already-dead quotes untouched", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          quotes: cancelQuotes,
          window: deliveryWindow,
          gallons: positiveGallons,
          // Cancel anywhere from the instant the quotes land to well past the
          // longest hold, so quotes that have lapsed by the clock but are still
          // stored `active` are covered too.
          cancelAfterHours: fc.integer({ min: 0, max: 9 }),
        }),
        async ({ quotes, window, gallons, cancelAfterHours }) => {
          const h = await makeLoadHarness(quotes.length);
          const load = await createLoad(h, window, gallons);
          const seeded = await seedQuotes(h, load.id, quotes);
          const cancelAt = new Date(NOW.getTime() + cancelAfterHours * MS_PER_HOUR);
          const label = `${quotes.length} quotes, ${window}, cancel +${cancelAfterHours}h`;

          const cancelled = await h.requests.cancelRequest(
            h.buyer,
            load.id,
            cancelAt
          );

          // Requirement 9.1: the load is Cancelled, in the returned record and
          // in the store.
          expect(cancelled.status, label).toBe("cancelled");
          expect(cancelled.id, label).toBe(load.id);
          expect((await h.repo.getRequest(load.id))?.status, label).toBe(
            "cancelled"
          );

          const after = await offerStates(h, load.id);
          expect(after.size, label).toBe(seeded.length);

          for (const [index, offer] of seeded.entries()) {
            const spec = quotes[index];
            const state = after.get(offer.id);
            const perOffer = `${label} / quote ${index} (${
              spec.dead === null ? "live" : spec.dead.status
            })`;
            expect(state, perOffer).toBeDefined();

            if (spec.dead === null) {
              // Requirement 9.1: every active quote is voided.
              expect(state, perOffer).toEqual({
                status: "voided",
                voided: true,
              });
            } else {
              // An already-dead quote keeps the record of why it died.
              expect(state, perOffer).toEqual(spec.dead);
            }
          }

          // Nothing on the load is acceptable any more, by the real predicate
          // and through the Buyer's own view of their quotes.
          for (const stored of await h.repo.listOffersByRequest(load.id)) {
            expect(isActive(stored, cancelAt), label).toBe(false);
          }
          const views = await h.offers.listOffersForRequest(
            h.buyer,
            load.id,
            cancelAt
          );
          expect(views, label).toHaveLength(seeded.length);
          expect(
            views.filter((view) => view.isActive),
            label
          ).toEqual([]);

          // A cancelled load is not live work any more (Requirement 3.9).
          const work = await h.requests.getWorkList(h.buyer, undefined, cancelAt);
          expect(
            work.requests.some((r) => r.id === load.id),
            label
          ).toBe(false);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 21 (task 8.4) — Requirement 9.2
// ---------------------------------------------------------------------------

/**
 * The three ways a Request can already have left Open, each reached through the
 * real path that puts it there rather than by writing the status directly.
 */
type DeadLoadPath = "accepted" | "cancelled" | "expired";

describe("Property 21: Cancellation requires an Open request", () => {
  // Feature: load-energy, Property 21: Cancellation requires an Open request
  // **Validates: Requirements 9.2**
  it("rejects cancelling a Request whose status is not Open with a conflict error and changes nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          path: fc.constantFrom<DeadLoadPath>("accepted", "cancelled", "expired"),
          window: deliveryWindow,
          gallons: positiveGallons,
          price: quotePrice,
          holdHours: quoteHold,
          // How long after the load left Open the cancellation is attempted.
          attemptAfterMs: fc.constantFrom(0, 1, 60_000, MS_PER_HOUR),
        }),
        async ({ path, window, gallons, price, holdHours, attemptAfterMs }) => {
          const h = await makeLoadHarness(1);
          const load = await createLoad(h, window, gallons);
          const [quote] = await seedQuotes(h, load.id, [
            { price, holdHours, dead: null },
          ]);

          // Drive the load out of Open the way it actually happens.
          let leftOpenAt = NOW;
          switch (path) {
            case "accepted":
              await h.orders.acceptOffer(h.buyer, quote.id, NOW);
              break;
            case "cancelled":
              await h.requests.cancelRequest(h.buyer, load.id, NOW);
              break;
            default:
              // Requirement 9.3's evaluator: at the window end it is expirable.
              leftOpenAt = load.windowEndsAt;
              await h.requests.expireIfWindowEnded(load, leftOpenAt);
          }

          const attemptAt = new Date(leftOpenAt.getTime() + attemptAfterMs);
          const label = `${path}, ${window}, attempt +${attemptAfterMs}ms`;

          const before = await offerStates(h, load.id);
          expect((await h.repo.getRequest(load.id))?.status, label).toBe(path);

          let thrown: unknown;
          try {
            await h.requests.cancelRequest(h.buyer, load.id, attemptAt);
          } catch (error) {
            thrown = error;
          }

          // Requirement 9.2: rejected as a state conflict (409 at the API
          // boundary), whichever way the load left Open.
          expect(thrown, label).toBeInstanceOf(ConflictError);
          const error = thrown as ConflictError;
          expect(error.category, label).toBe("conflict");
          expect(error.httpStatus, label).toBe(409);
          expect(error.code, label).toBe("REQUEST_NOT_OPEN");

          // A rejected cancellation is inert: the earlier terminal status
          // stands and no quote moved.
          expect((await h.repo.getRequest(load.id))?.status, label).toBe(path);
          expect(await offerStates(h, load.id), label).toEqual(before);

          /**
           * The control: a second load on the same Company, still Open, is
           * cancellable at the very same instant. That pins the rejection above
           * on the Request_Status alone — not the caller, the clock, or the
           * load id.
           */
          const stillOpen = await createLoad(h, window, gallons);
          const controlCancelled = await h.requests.cancelRequest(
            h.buyer,
            stillOpen.id,
            attemptAt
          );
          expect(controlCancelled.status, `${label} / control`).toBe("cancelled");
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 22 (task 8.5) — Requirement 9.3
// ---------------------------------------------------------------------------

/**
 * Offsets around `windowEndsAt`, in milliseconds. The boundary itself is the
 * interesting one: a window that ends exactly at `now` has ended, so 0 must
 * expire while -1 must not.
 */
const windowEndOffsetMs = fc.constantFrom(
  -MS_PER_HOUR,
  -1,
  0,
  1,
  MS_PER_HOUR,
  5 * MS_PER_HOUR
);

describe("Property 22: Expiry after window end voids remaining offers", () => {
  // Feature: load-energy, Property 22: Expiry after window end voids remaining offers
  // **Validates: Requirements 9.3**
  it("sets an Open Request past its window end to Expired and voids every remaining active Offer, and leaves a Request whose window has not ended alone", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          quotes: fc.array(quoteSpec, { minLength: 1, maxLength: 4 }),
          window: deliveryWindow,
          gallons: positiveGallons,
          offsetMs: windowEndOffsetMs,
        }),
        async ({ quotes, window, gallons, offsetMs }) => {
          const h = await makeLoadHarness(quotes.length);
          const load = await createLoad(h, window, gallons);
          const seeded = await seedQuotes(h, load.id, quotes);

          const evaluatedAt = new Date(load.windowEndsAt.getTime() + offsetMs);
          // Stated independently of the service: the window has ended once the
          // clock reaches its end, boundary included.
          const ended = evaluatedAt.getTime() >= load.windowEndsAt.getTime();
          const label = `${quotes.length} quotes, ${window}, ${
            offsetMs >= 0 ? "+" : ""
          }${offsetMs}ms (${ended ? "ended" : "live"})`;

          expect(hasWindowEnded(load, evaluatedAt), label).toBe(ended);

          const before = await offerStates(h, load.id);
          const evaluated = await h.requests.expireIfWindowEnded(
            load,
            evaluatedAt
          );

          if (!ended) {
            // Still inside the window: no status change and no write at all.
            expect(evaluated.status, label).toBe("open");
            expect((await h.repo.getRequest(load.id))?.status, label).toBe("open");
            expect(await offerStates(h, load.id), label).toEqual(before);

            const work = await h.requests.getWorkList(
              h.buyer,
              undefined,
              evaluatedAt
            );
            expect(
              work.requests.some((r) => r.id === load.id),
              label
            ).toBe(true);
            return;
          }

          // Requirement 9.3: the load is Expired, in the returned record, in
          // the store, and on the Buyer's own read path.
          expect(evaluated.status, label).toBe("expired");
          expect(evaluated.id, label).toBe(load.id);
          expect((await h.repo.getRequest(load.id))?.status, label).toBe(
            "expired"
          );
          expect(
            (await h.requests.getRequest(h.buyer, load.id, evaluatedAt)).status,
            label
          ).toBe("expired");

          const after = await offerStates(h, load.id);
          expect(after.size, label).toBe(seeded.length);

          for (const [index, offer] of seeded.entries()) {
            const spec = quotes[index];
            const perOffer = `${label} / quote ${index} (${
              spec.dead === null ? "live" : spec.dead.status
            })`;

            if (spec.dead === null) {
              // Requirement 9.3: every remaining active quote is voided.
              expect(after.get(offer.id), perOffer).toEqual({
                status: "voided",
                voided: true,
              });
            } else {
              expect(after.get(offer.id), perOffer).toEqual(spec.dead);
            }
          }

          // Nothing on an expired load is acceptable any more.
          for (const stored of await h.repo.listOffersByRequest(load.id)) {
            expect(isActive(stored, evaluatedAt), label).toBe(false);
          }

          // Expiry is idempotent and drops the load off the work list.
          const again = await h.requests.expireIfWindowEnded(
            evaluated,
            evaluatedAt
          );
          expect(again.status, label).toBe("expired");
          expect(await offerStates(h, load.id), label).toEqual(after);

          const work = await h.requests.getWorkList(
            h.buyer,
            undefined,
            evaluatedAt
          );
          expect(
            work.requests.some((r) => r.id === load.id),
            label
          ).toBe(false);
        }
      )
    );
  });
});
