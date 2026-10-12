/**
 * Property-based test for the RFQ matching predicate.
 *
 * Feature: load-energy — Property 9 (task 5.6).
 *
 * Two halves, both against real code:
 *   1. the pure predicate `matchSuppliers` over generated Supplier Companies
 *      spanning every combination of approval status, availability, configured /
 *      unconfigured Operating_Location, and configured / null / invalid
 *      Service_Radius, against Requests in all four Request_Status values;
 *   2. the persisted path — real `MatchingService.listRfqInbox` over the real
 *      `InMemoryRepository`, with Companies created by the real
 *      `CompanyUserService` + `BcryptPasswordHasher` — which must agree with the
 *      predicate and must never surface an Accepted, Cancelled, or Expired
 *      Request.
 *
 * The expected set is computed in this file from the RAW conditions
 * (Requirement 4.1's conjunction) plus an independently written great-circle
 * formula — the atan2 form, not the implementation's asin form — so the test
 * never asks the code under test whether it agrees with itself.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { InMemoryRepository } from "@/repository/in-memory";
import {
  MAX_LAT,
  MAX_LNG,
  MIN_LAT,
  MIN_LNG,
  REQUEST_STATUSES,
  SUPPLIER_APPROVAL_STATUSES,
  SUPPLIER_STATUSES,
  type AuthContext,
  type Company,
  type LatLng,
  type Request,
  type RequestStatus,
  type SupplierApprovalStatus,
  type SupplierStatus,
} from "@/domain/types";
import { CompanyUserService } from "./company-user";
import { BcryptPasswordHasher } from "./password";
import { EARTH_RADIUS_MILES } from "./geo";
import {
  MatchingService,
  matchSuppliers,
  type MatchableRequest,
  type MatchableSupplier,
} from "./matching";

const NOW = new Date("2025-03-01T09:00:00Z");
/** Every generated Request's window ends well after `NOW`. */
const WINDOW_ENDS_AT = new Date("2025-03-02T06:59:59.999Z");

// ---------------------------------------------------------------------------
// An independent great-circle distance, used only to compute the expected set
// ---------------------------------------------------------------------------

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * The atan2 form of the haversine formula. Deliberately a different expression
 * from `services/geo.ts` (which uses `asin` over absolute deltas) so that the
 * expected membership is not derived from the implementation under test. The
 * two agree to well within the 5% margin the generators keep between a
 * Service_Radius and the distance it is compared against.
 */
function distanceMiles(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) *
      Math.cos(toRadians(b.lat)) *
      Math.sin(dLng / 2) ** 2;
  const clamped = Math.min(Math.max(h, 0), 1);
  return (
    2 *
    EARTH_RADIUS_MILES *
    Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped))
  );
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const latitude = fc.oneof(
  {
    arbitrary: fc.double({ min: MIN_LAT, max: MAX_LAT, noNaN: true }),
    weight: 3,
  },
  {
    arbitrary: fc.constantFrom(MIN_LAT, MAX_LAT, 0, 33.3703, 33.4484, 33.4353),
    weight: 2,
  }
);

const longitude = fc.oneof(
  {
    arbitrary: fc.double({ min: MIN_LNG, max: MAX_LNG, noNaN: true }),
    weight: 3,
  },
  {
    arbitrary: fc.constantFrom(
      MIN_LNG,
      MAX_LNG,
      0,
      -112.5838,
      -112.074,
      -112.3576
    ),
    weight: 2,
  }
);

const coordinate: fc.Arbitrary<LatLng> = fc.record({
  lat: latitude,
  lng: longitude,
});

/** Whether (and how completely) an Admin has set the Operating_Location. */
type LocationKind = "configured" | "unset" | "lat-only" | "lng-only";

/**
 * How the Admin-set Service_Radius relates to the supplier's distance from the
 * Request pin: comfortably inside, comfortably outside, never configured, or
 * configured with a value that is not a usable radius.
 */
type RadiusKind = "inside" | "outside" | "unset" | "invalid";

interface SupplierSpec {
  approval: SupplierApprovalStatus;
  status: SupplierStatus;
  locationKind: LocationKind;
  location: LatLng;
  radiusKind: RadiusKind;
  /** > 1: radius = distance × factor, so the pin is inside with margin. */
  insideFactor: number;
  /** < 1: radius = distance × factor, so the pin is outside with margin. */
  outsideFactor: number;
  invalidRadius: number;
}

const supplierSpec: fc.Arbitrary<SupplierSpec> = fc.record({
  approval: fc.constantFrom(...SUPPLIER_APPROVAL_STATUSES),
  status: fc.constantFrom(...SUPPLIER_STATUSES),
  locationKind: fc.oneof(
    { arbitrary: fc.constant<LocationKind>("configured"), weight: 5 },
    { arbitrary: fc.constant<LocationKind>("unset"), weight: 2 },
    { arbitrary: fc.constant<LocationKind>("lat-only"), weight: 1 },
    { arbitrary: fc.constant<LocationKind>("lng-only"), weight: 1 }
  ),
  location: coordinate,
  radiusKind: fc.oneof(
    { arbitrary: fc.constant<RadiusKind>("inside"), weight: 4 },
    { arbitrary: fc.constant<RadiusKind>("outside"), weight: 4 },
    { arbitrary: fc.constant<RadiusKind>("unset"), weight: 1 },
    { arbitrary: fc.constant<RadiusKind>("invalid"), weight: 1 }
  ),
  insideFactor: fc.double({ min: 1.05, max: 5, noNaN: true }),
  outsideFactor: fc.double({ min: 0.05, max: 0.95, noNaN: true }),
  invalidRadius: fc.constantFrom(
    0,
    -0,
    -1,
    -25,
    -1e-9,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ),
});

/** Where an extra Request's pin sits relative to the base pin. */
type PinKind = "base" | "jitter" | "far";

interface RequestSpec {
  status: RequestStatus;
  pinKind: PinKind;
  jitterLat: number;
  jitterLng: number;
  farPin: LatLng;
}

const requestSpecFor = (
  status: RequestStatus,
  pinKind: fc.Arbitrary<PinKind>
): fc.Arbitrary<RequestSpec> =>
  fc.record({
    status: fc.constant(status),
    pinKind,
    jitterLat: fc.double({ min: -3, max: 3, noNaN: true }),
    jitterLng: fc.double({ min: -3, max: 3, noNaN: true }),
    farPin: coordinate,
  });

const anyPinKind = fc.constantFrom<PinKind>("base", "jitter", "far");

interface MatchingCase {
  pin: LatLng;
  suppliers: SupplierSpec[];
  /** Buyer-kind companies dropped into the candidate list as decoys. */
  buyerDecoys: number;
  /** One Request per Request_Status on the base pin, plus extras off it. */
  statusRequests: RequestSpec[];
  extraRequests: RequestSpec[];
}

/**
 * A supplier that must match: Approved, available, with an Admin-configured
 * Operating_Location and a radius comfortably covering the base pin. Prepended
 * to every generated case so each run asserts the positive direction of the
 * predicate as well as the exclusions.
 */
const eligibleSupplierSpec: fc.Arbitrary<SupplierSpec> = fc.record({
  approval: fc.constant<SupplierApprovalStatus>("approved"),
  status: fc.constantFrom<SupplierStatus>("open", "limited"),
  locationKind: fc.constant<LocationKind>("configured"),
  location: coordinate,
  radiusKind: fc.constant<RadiusKind>("inside"),
  insideFactor: fc.double({ min: 1.05, max: 5, noNaN: true }),
  outsideFactor: fc.double({ min: 0.05, max: 0.95, noNaN: true }),
  invalidRadius: fc.constant(0),
});

const matchingCase: fc.Arbitrary<MatchingCase> = fc.record({
  pin: coordinate,
  suppliers: fc
    .tuple(
      eligibleSupplierSpec,
      fc.array(supplierSpec, { minLength: 0, maxLength: 3 })
    )
    .map(([anchor, rest]) => [anchor, ...rest]),
  buyerDecoys: fc.integer({ min: 0, max: 2 }),
  // Every run covers all four Request_Status values at the base pin, so the
  // inside/outside intent of each supplier's radius lands exactly.
  statusRequests: fc.tuple(
    ...REQUEST_STATUSES.map((status) =>
      requestSpecFor(status, fc.constant<PinKind>("base"))
    )
  ).map((specs) => [...specs]),
  extraRequests: fc.array(
    fc.constantFrom(...REQUEST_STATUSES).chain((status) =>
      requestSpecFor(status, anyPinKind)
    ),
    { minLength: 0, maxLength: 3 }
  ),
});

// ---------------------------------------------------------------------------
// Resolving a generated case into companies, requests, and the expected set
// ---------------------------------------------------------------------------

interface ResolvedSupplier {
  id: string;
  spec: SupplierSpec;
  operatingLat: number | null;
  operatingLng: number | null;
  serviceRadiusMiles: number | null;
}

function resolveSupplier(
  spec: SupplierSpec,
  index: number,
  pin: LatLng
): ResolvedSupplier {
  const hasLat =
    spec.locationKind === "configured" || spec.locationKind === "lat-only";
  const hasLng =
    spec.locationKind === "configured" || spec.locationKind === "lng-only";

  // Distance from the base pin, used only to size the radius so that "inside"
  // and "outside" are unambiguous by a wide margin.
  const distance = distanceMiles(pin, spec.location);

  let serviceRadiusMiles: number | null;
  switch (spec.radiusKind) {
    case "inside":
      serviceRadiusMiles = distance === 0 ? 25 : distance * spec.insideFactor;
      break;
    case "outside":
      serviceRadiusMiles = distance * spec.outsideFactor;
      break;
    case "unset":
      serviceRadiusMiles = null;
      break;
    default:
      serviceRadiusMiles = spec.invalidRadius;
  }

  return {
    id: `sup-${index}`,
    spec,
    operatingLat: hasLat ? spec.location.lat : null,
    operatingLng: hasLng ? spec.location.lng : null,
    serviceRadiusMiles,
  };
}

function resolvePin(spec: RequestSpec, pin: LatLng): LatLng {
  switch (spec.pinKind) {
    case "base":
      return pin;
    case "jitter":
      return {
        lat: clamp(pin.lat + spec.jitterLat, MIN_LAT, MAX_LAT),
        lng: clamp(pin.lng + spec.jitterLng, MIN_LNG, MAX_LNG),
      };
    default:
      return spec.farPin;
  }
}

/**
 * Requirement 4.1's conjunction, written out from the raw conditions rather
 * than by consulting the implementation: Approved AND Open|Limited AND the pin
 * within the configured Service_Radius of the configured Operating_Location AND
 * the Request Open. A buyer-kind company never matches.
 */
function expectedEligible(
  requestStatus: RequestStatus,
  requestPin: LatLng,
  supplier: ResolvedSupplier
): boolean {
  if (requestStatus !== "open") return false;
  if (supplier.spec.approval !== "approved") return false;
  if (supplier.spec.status !== "open" && supplier.spec.status !== "limited") {
    return false;
  }

  const { operatingLat, operatingLng, serviceRadiusMiles } = supplier;
  if (operatingLat === null || operatingLng === null) return false;
  if (serviceRadiusMiles === null) return false;
  if (!Number.isFinite(serviceRadiusMiles) || serviceRadiusMiles <= 0) {
    return false;
  }

  return (
    distanceMiles(requestPin, { lat: operatingLat, lng: operatingLng }) <=
    serviceRadiusMiles
  );
}

/**
 * Guards against a float knife-edge: if any (Request pin, supplier) distance
 * sits within a hair of that supplier's radius, the independent formula and the
 * implementation could legitimately land on opposite sides of an inclusive
 * bound. Those draws are discarded rather than asserted on — every kept draw
 * has a decisive answer.
 */
function isDecisive(
  pins: readonly LatLng[],
  suppliers: readonly ResolvedSupplier[]
): boolean {
  for (const supplier of suppliers) {
    const { operatingLat, operatingLng, serviceRadiusMiles } = supplier;
    if (operatingLat === null || operatingLng === null) continue;
    if (
      serviceRadiusMiles === null ||
      !Number.isFinite(serviceRadiusMiles) ||
      serviceRadiusMiles <= 0
    ) {
      continue;
    }
    for (const pin of pins) {
      const distance = distanceMiles(pin, {
        lat: operatingLat,
        lng: operatingLng,
      });
      const margin = Math.abs(distance - serviceRadiusMiles);
      if (margin <= 1e-6 * Math.max(1, serviceRadiusMiles)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Persisted harness — real repository, real company/user creation
// ---------------------------------------------------------------------------

const phoneFor = (index: number) =>
  `+1602555${String(index + 1).padStart(4, "0")}`;

interface Harness {
  service: MatchingService;
  /** One supplier AuthContext per generated supplier, in generated order. */
  supplierCtxs: AuthContext[];
  companies: Company[];
  requests: Request[];
}

async function makeHarness(
  suppliers: readonly ResolvedSupplier[],
  requestPlan: readonly { status: RequestStatus; pin: LatLng }[],
  seed: number
): Promise<Harness> {
  const repo = new InMemoryRepository();
  const companyUsers = new CompanyUserService({
    repo,
    hasher: new BcryptPasswordHasher(4),
  });
  const service = new MatchingService({ repo });

  const buyerCompany = await companyUsers.createCompany(
    { name: `buyer-${seed}`, kind: "buyer" },
    NOW
  );
  const buyerUser = await companyUsers.createUser(
    {
      companyId: buyerCompany.id,
      role: "buyer",
      phone: phoneFor(0),
      password: "pw-buyer",
    },
    NOW
  );

  const companies: Company[] = [];
  const supplierCtxs: AuthContext[] = [];

  for (const [index, supplier] of suppliers.entries()) {
    // Created Pending + Closed by the real service (Requirement 16.1), then
    // configured exactly as the generated case dictates.
    const created = await companyUsers.createCompany(
      { name: `supplier-${seed}-${index}`, kind: "supplier" },
      NOW
    );
    const configured = await repo.updateCompany(created.id, {
      supplierApprovalStatus: supplier.spec.approval,
      supplierStatus: supplier.spec.status,
      operatingLat: supplier.operatingLat,
      operatingLng: supplier.operatingLng,
      serviceRadiusMiles: supplier.serviceRadiusMiles,
    });
    companies.push(configured);

    const user = await companyUsers.createUser(
      {
        companyId: created.id,
        role: "supplier",
        phone: phoneFor(index + 1),
        password: `pw-sup-${index}`,
      },
      NOW
    );
    supplierCtxs.push({
      userId: user.id,
      companyId: created.id,
      role: "supplier",
    });
  }

  const requests: Request[] = [];
  for (const [index, plan] of requestPlan.entries()) {
    requests.push(
      await repo.createRequest({
        buyerCompanyId: buyerCompany.id,
        createdByUserId: buyerUser.id,
        gallons: 500,
        productType: "ulsd",
        deliveryMethod: "wet_hose",
        deliveryWindow: "today",
        pinLat: plan.pin.lat,
        pinLng: plan.pin.lng,
        notes: null,
        status: plan.status,
        windowEndsAt: WINDOW_ENDS_AT,
        createdAt: new Date(NOW.getTime() + index * 1000),
      })
    );
  }

  return { service, supplierCtxs, companies, requests };
}

const sorted = (ids: readonly string[]) => [...ids].sort();

// ---------------------------------------------------------------------------
// Property 9 (task 5.6)
// ---------------------------------------------------------------------------

describe("Property 9: Supplier matching predicate", () => {
  // Feature: load-energy, Property 9: Supplier matching predicate
  // **Validates: Requirements 4.1, 4.3, 4.4, 4.5, 4.6, 4.7, 5.3, 9.4, 16.3**
  it("matches exactly the Approved, Open|Limited, in-radius suppliers on Open requests, and the RFQ inbox agrees", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ seed: fc.nat(), matching: matchingCase }),
        async ({ seed, matching }) => {
          const suppliers = matching.suppliers.map((spec, index) =>
            resolveSupplier(spec, index, matching.pin)
          );

          const requestPlan = [
            ...matching.statusRequests,
            ...matching.extraRequests,
          ].map((spec) => ({
            status: spec.status,
            pin: resolvePin(spec, matching.pin),
          }));

          fc.pre(
            isDecisive(
              requestPlan.map((plan) => plan.pin),
              suppliers
            )
          );

          // --- 1. The pure predicate -------------------------------------
          // Candidate list: the generated supplier companies plus buyer-kind
          // decoys, which must never match (Requirement 4.1).
          const candidates: (MatchableSupplier & { id: string })[] = [
            ...suppliers.map((supplier) => ({
              id: supplier.id,
              kind: "supplier" as const,
              supplierApprovalStatus: supplier.spec.approval,
              supplierStatus: supplier.spec.status,
              operatingLat: supplier.operatingLat,
              operatingLng: supplier.operatingLng,
              serviceRadiusMiles: supplier.serviceRadiusMiles,
            })),
            ...Array.from({ length: matching.buyerDecoys }, (_, index) => ({
              id: `buy-${index}`,
              kind: "buyer" as const,
              supplierApprovalStatus: null,
              supplierStatus: null,
              operatingLat: matching.pin.lat,
              operatingLng: matching.pin.lng,
              serviceRadiusMiles: 5000,
            })),
          ];

          for (const plan of requestPlan) {
            const request: MatchableRequest = {
              pinLat: plan.pin.lat,
              pinLng: plan.pin.lng,
              status: plan.status,
            };

            const expected = suppliers
              .filter((supplier) =>
                expectedEligible(plan.status, plan.pin, supplier)
              )
              .map((supplier) => supplier.id);

            expect(
              matchSuppliers(request, candidates).map((c) => c.id),
              `status=${plan.status} pin=${plan.pin.lat},${plan.pin.lng}`
            ).toEqual(expected);

            // Requirements 4.5, 9.4, plus the Accepted case: a non-Open
            // Request matches nobody at all.
            if (plan.status !== "open") {
              expect(matchSuppliers(request, candidates)).toEqual([]);
            }
          }

          // The positive direction, asserted in every run: the anchor supplier
          // (Approved, available, configured, in radius) matches the Open
          // Request on the base pin (Requirements 4.1, 5.3).
          expect(
            matchSuppliers(
              {
                pinLat: matching.pin.lat,
                pinLng: matching.pin.lng,
                status: "open",
              },
              candidates
            ).map((candidate) => candidate.id)
          ).toContain("sup-0");

          // --- 2. The persisted path and the RFQ inbox -------------------
          const h = await makeHarness(suppliers, requestPlan, seed);

          const nonOpenIds = h.requests
            .filter((request) => request.status !== "open")
            .map((request) => request.id);

          for (const [index, supplier] of suppliers.entries()) {
            const ctx = h.supplierCtxs[index];

            const expectedIds = h.requests
              .filter((request, requestIndex) =>
                expectedEligible(
                  request.status,
                  requestPlan[requestIndex].pin,
                  supplier
                )
              )
              .map((request) => request.id);

            // Requirements 4.3, 4.4, 4.6, 4.7, 5.3, 16.3: the inbox is exactly
            // the matched set — nothing extra, nothing missing.
            const inbox = await h.service.listRfqInbox(ctx, undefined, NOW);
            expect(
              sorted(inbox.map((request) => request.id)),
              `supplier ${supplier.id}: approval=${supplier.spec.approval} status=${supplier.spec.status} radius=${String(supplier.serviceRadiusMiles)}`
            ).toEqual(sorted(expectedIds));

            // Requirements 4.5, 9.4: Cancelled, Expired, and Accepted Requests
            // never appear in any supplier's inbox.
            for (const id of nonOpenIds) {
              expect(inbox.map((request) => request.id)).not.toContain(id);
            }

            // The other direction of the same relation: the suppliers notified
            // for a Request are the suppliers whose inbox shows it.
            for (const [requestIndex, request] of h.requests.entries()) {
              const matched = await h.service.listMatchedSuppliers(request);
              const matchedIds = matched.map((company) => company.id);
              const shouldSee = expectedEligible(
                request.status,
                requestPlan[requestIndex].pin,
                supplier
              );
              expect(matchedIds.includes(ctx.companyId)).toBe(shouldSee);
            }
          }
        }
      )
    );
  });
});
