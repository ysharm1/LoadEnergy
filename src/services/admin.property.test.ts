/**
 * Property-based tests for the Admin service.
 *
 * Feature: load-energy — Property 37 (task 3.4), Property 38 (task 3.5).
 *
 * Runs the real `AdminService` against the real `InMemoryRepository`, with the
 * real `CompanyUserService` + `BcryptPasswordHasher` (low cost factor: genuine
 * hashing, cheap enough for 100+ iterations) creating the Supplier Companies
 * and the Admin user. No mocks and no fakes: the properties exercise the same
 * code the route handlers will call.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { InMemoryRepository } from "@/repository/in-memory";
import { ValidationError } from "@/domain/errors";
import {
  MAX_LAT,
  MAX_LNG,
  MIN_LAT,
  MIN_LNG,
  type AuthContext,
  type Company,
  type Geofence,
  type LatLng,
} from "@/domain/types";
import { AdminService } from "./admin";
import { CompanyUserService } from "./company-user";
import { BcryptPasswordHasher } from "./password";

const NOW = new Date("2025-03-01T09:00:00Z");
const LATER = new Date("2025-03-02T09:00:00Z");

const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A short company-name token. */
const token = (maxLength: number) =>
  fc.stringOf(fc.constantFrom(...LOWER_ALNUM.split("")), {
    minLength: 1,
    maxLength,
  });

// ---------------------------------------------------------------------------
// Coordinate generators — in-range values including the inclusive extremes
// ---------------------------------------------------------------------------

/** Latitude in [-90, 90], weighted to also hit the extremes and 0. */
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

/** Longitude in [-180, 180], weighted to also hit the extremes and 0. */
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

const operatingLocation: fc.Arbitrary<LatLng> = fc.record({
  lat: latitude,
  lng: longitude,
});

/** A Service_Radius > 0: ordinary pilot radii plus the smallest positives. */
const positiveRadiusMiles = fc.oneof(
  {
    arbitrary: fc.double({ min: 0.001, max: 5000, noNaN: true }),
    weight: 4,
  },
  {
    arbitrary: fc.constantFrom(
      0.5,
      1,
      25,
      35,
      500,
      1e-9,
      Number.MIN_VALUE,
      Number.MAX_VALUE
    ),
    weight: 1,
  }
);

// ---------------------------------------------------------------------------
// Geofence generators — valid boxes (min <= max) plus pins deliberately inside
// and deliberately outside each box
// ---------------------------------------------------------------------------

/** The inclusive bounding-box membership test, local to this test file. */
function isInsideBox(pin: LatLng, fence: Geofence): boolean {
  return (
    pin.lat >= fence.minLat &&
    pin.lat <= fence.maxLat &&
    pin.lng >= fence.minLng &&
    pin.lng <= fence.maxLng
  );
}

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
    // Degenerate single-pin box: min == max is allowed, and the inclusive
    // bounds still admit exactly that pin.
    arbitrary: fc.tuple(latitude, longitude).map(([lat, lng]) => ({
      minLat: lat,
      maxLat: lat,
      minLng: lng,
      maxLng: lng,
    })),
    weight: 1,
  }
);

/** A point on one axis inside [min, max], including the inclusive bounds. */
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

const insidePinFor = (fence: Geofence): fc.Arbitrary<LatLng> =>
  fc.record({
    lat: insideAxis(fence.minLat, fence.maxLat),
    lng: insideAxis(fence.minLng, fence.maxLng),
  });

/**
 * A pin pushed past one bound of the box. A box spanning the full coordinate
 * range has no outside pin at all, so the generator yields null in that case
 * and the property skips the exclusion half of the check rather than asserting
 * something false.
 */
const outsidePinFor = (fence: Geofence): fc.Arbitrary<LatLng | null> =>
  fc
    .tuple(
      fc.constantFrom("lat-above", "lat-below", "lng-above", "lng-below"),
      fc.double({ min: 0.0001, max: 45, noNaN: true }),
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

      let pin: LatLng;
      switch (direction) {
        case "lat-above":
          pin = { lat: Math.min(MAX_LAT, fence.maxLat + delta), lng: baseLng };
          break;
        case "lat-below":
          pin = { lat: Math.max(MIN_LAT, fence.minLat - delta), lng: baseLng };
          break;
        case "lng-above":
          pin = { lat: baseLat, lng: Math.min(MAX_LNG, fence.maxLng + delta) };
          break;
        default:
          pin = { lat: baseLat, lng: Math.max(MIN_LNG, fence.minLng - delta) };
      }

      // Guard: only return a pin that genuinely falls outside the box.
      return isInsideBox(pin, fence) ? null : pin;
    });

interface FenceCase {
  fence: Geofence;
  insidePin: LatLng;
  outsidePin: LatLng | null;
}

const fenceCase: fc.Arbitrary<FenceCase> = boundingBox.chain((fence) =>
  fc.record({
    fence: fc.constant(fence),
    insidePin: insidePinFor(fence),
    outsidePin: outsidePinFor(fence),
  })
);

// ---------------------------------------------------------------------------
// Harness — one fresh store, Admin, and Supplier Companies per generated case
// ---------------------------------------------------------------------------

interface Harness {
  service: AdminService;
  admin: AuthContext;
  supplierCompany: Company;
  /** A second Supplier Company left unconfigured, to catch cross-company writes. */
  otherSupplierCompany: Company;
}

async function makeHarness(names: {
  operator: string;
  supplier: string;
  otherSupplier: string;
}): Promise<Harness> {
  const repo = new InMemoryRepository();
  const companies = new CompanyUserService({
    repo,
    hasher: new BcryptPasswordHasher(4),
  });
  const service = new AdminService({ repo });

  // The Admin is the marketplace operator, not a trading party, but a User
  // still belongs to exactly one Company (Requirement 1.3).
  const operatorCompany = await companies.createCompany(
    { name: `${names.operator}-operator`, kind: "buyer" },
    NOW
  );
  const supplierCompany = await companies.createCompany(
    { name: `${names.supplier}-a`, kind: "supplier" },
    NOW
  );
  const otherSupplierCompany = await companies.createCompany(
    { name: `${names.otherSupplier}-b`, kind: "supplier" },
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

  return {
    service,
    admin: {
      userId: adminUser.id,
      companyId: adminUser.companyId,
      role: "admin",
    },
    supplierCompany,
    otherSupplierCompany,
  };
}

// ---------------------------------------------------------------------------
// Property 37 (task 3.4)
// ---------------------------------------------------------------------------

describe("Property 37: Admin approval and configuration lifecycle", () => {
  // Feature: load-energy, Property 37: Admin approval and configuration lifecycle
  // **Validates: Requirements 16.1, 16.2, 16.4, 16.5, 16.7**
  it("starts a new supplier Pending, approves it, and reads back the configured location, radius, and geofence", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          operatorName: token(10),
          supplierName: token(10),
          otherSupplierName: token(10),
          location: operatingLocation,
          radiusMiles: positiveRadiusMiles,
          initialFence: boundingBox,
          fenceCase,
        }),
        async (c) => {
          const h = await makeHarness({
            operator: c.operatorName,
            supplier: c.supplierName,
            otherSupplier: c.otherSupplierName,
          });
          const { service, admin } = h;
          const supplierId = h.supplierCompany.id;

          // Requirement 16.1: a newly created Supplier Company is Pending, both
          // as returned at creation and as read back.
          expect(h.supplierCompany.supplierApprovalStatus).toBe("pending");
          const atCreation = await service.getSupplierCompany(supplierId);
          expect(atCreation?.supplierApprovalStatus).toBe("pending");
          expect(atCreation?.operatingLat).toBeNull();
          expect(atCreation?.operatingLng).toBeNull();
          expect(atCreation?.serviceRadiusMiles).toBeNull();

          // Requirement 16.2: after an Admin approves it, the status is Approved.
          const approved = await service.approveSupplier(admin, supplierId);
          expect(approved.supplierApprovalStatus).toBe("approved");
          expect(
            (await service.getSupplierCompany(supplierId))
              ?.supplierApprovalStatus
          ).toBe("approved");

          // Requirement 16.4: the Operating_Location the Admin set persists.
          const located = await service.setOperatingLocation(
            admin,
            supplierId,
            c.location
          );
          expect(located.operatingLat).toBe(c.location.lat);
          expect(located.operatingLng).toBe(c.location.lng);

          // Requirement 16.5: the Service_Radius (> 0) the Admin set persists.
          const radiused = await service.setServiceRadius(
            admin,
            supplierId,
            c.radiusMiles
          );
          expect(radiused.serviceRadiusMiles).toBe(c.radiusMiles);

          // All three configured values read back together, and approval
          // survived the later writes.
          const configured = await service.getSupplierCompany(supplierId);
          expect(configured?.supplierApprovalStatus).toBe("approved");
          expect(configured?.operatingLat).toBe(c.location.lat);
          expect(configured?.operatingLng).toBe(c.location.lng);
          expect(configured?.serviceRadiusMiles).toBe(c.radiusMiles);

          // Configuration is per-company: the second Supplier Company is
          // untouched by any of the writes above.
          const untouched = await service.getSupplierCompany(
            h.otherSupplierCompany.id
          );
          expect(untouched?.supplierApprovalStatus).toBe("pending");
          expect(untouched?.operatingLat).toBeNull();
          expect(untouched?.operatingLng).toBeNull();
          expect(untouched?.serviceRadiusMiles).toBeNull();

          // Requirement 16.7: the Pilot_Geofence an Admin sets persists, and a
          // later update replaces the single configured box.
          await service.setGeofence(admin, c.initialFence, NOW);
          const set = await service.setGeofence(
            admin,
            c.fenceCase.fence,
            LATER
          );
          expect(set).toMatchObject({
            ...c.fenceCase.fence,
            setByAdminId: admin.userId,
            updatedAt: LATER,
          });

          const readFence = await service.getGeofence();
          expect(readFence).not.toBeNull();
          expect(readFence).toMatchObject(c.fenceCase.fence);

          // The freshly updated fence is the box that governs membership: a pin
          // inside it is admitted and a pin outside it is not, judged against
          // the bounds actually read back from the service.
          expect(isInsideBox(c.fenceCase.insidePin, readFence!)).toBe(true);
          if (c.fenceCase.outsidePin !== null) {
            expect(isInsideBox(c.fenceCase.outsidePin, readFence!)).toBe(false);
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 38 (task 3.5)
// ---------------------------------------------------------------------------

/**
 * Service_Radius values that are not greater than zero: exact zero, negative
 * zero, negatives from the smallest representable to the largest magnitude,
 * -Infinity, and NaN (which also fails `> 0`, and would silently make every
 * distance comparison false if stored). The filter guarantees no draw can
 * accidentally be a valid positive radius.
 */
const nonPositiveRadius = fc
  .oneof(
    { arbitrary: fc.constantFrom(0, -0), weight: 2 },
    {
      arbitrary: fc.constantFrom(
        -1,
        -0.5,
        -25,
        -1e-9,
        -Number.MIN_VALUE,
        -Number.MAX_VALUE,
        Number.NEGATIVE_INFINITY,
        Number.NaN
      ),
      weight: 2,
    },
    {
      arbitrary: fc.double({ min: -5000, max: -1e-9, noNaN: true }),
      weight: 3,
    },
    {
      arbitrary: fc.integer({ min: -100000, max: 0 }),
      weight: 2,
    }
  )
  .filter((radius) => !(radius > 0));

describe("Property 38: Non-positive radius rejected", () => {
  // Feature: load-energy, Property 38: Non-positive radius rejected
  // **Validates: Requirements 16.6**
  it("rejects any Service_Radius <= 0 with a validation error and leaves the stored radius unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          operatorName: token(10),
          supplierName: token(10),
          otherSupplierName: token(10),
          // Either never configured (null) or already holding a valid radius,
          // so "rejected" can be checked to mean "not mutated" either way.
          baselineRadiusMiles: fc.option(positiveRadiusMiles, { nil: null }),
          radiusMiles: nonPositiveRadius,
        }),
        async (c) => {
          const h = await makeHarness({
            operator: c.operatorName,
            supplier: c.supplierName,
            otherSupplier: c.otherSupplierName,
          });
          const { service, admin } = h;
          const supplierId = h.supplierCompany.id;

          if (c.baselineRadiusMiles !== null) {
            await service.setServiceRadius(
              admin,
              supplierId,
              c.baselineRadiusMiles
            );
          }

          let thrown: unknown;
          try {
            await service.setServiceRadius(admin, supplierId, c.radiusMiles);
          } catch (error) {
            thrown = error;
          }

          // Requirement 16.6: rejected as a validation error (400 at the API
          // boundary) naming the offending field.
          expect(thrown, `radius: ${String(c.radiusMiles)}`).toBeInstanceOf(
            ValidationError
          );
          const error = thrown as ValidationError;
          expect(error.category).toBe("validation");
          expect(error.httpStatus).toBe(400);
          expect(error.field).toBe("serviceRadiusMiles");

          // Rejection means rejection: the stored radius is not mutated as a
          // side effect.
          const readBack = await service.getSupplierCompany(supplierId);
          expect(readBack?.serviceRadiusMiles ?? null).toBe(
            c.baselineRadiusMiles
          );
        }
      )
    );
  });
});
