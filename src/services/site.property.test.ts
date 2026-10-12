/**
 * Property-based tests for the Site service.
 *
 * Feature: load-energy — Property 3 (task 4.4), Property 4 (task 4.5).
 *
 * Runs the real `SiteService` (and, for the work-list half of Property 3, the
 * real `RequestService` + `AdminService`) against the real
 * `InMemoryRepository`, with the real `CompanyUserService` +
 * `BcryptPasswordHasher` (low cost factor: genuine hashing, cheap enough for
 * 100+ iterations) building the Companies and Users. No mocks, no fakes.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { InMemoryRepository } from "@/repository/in-memory";
import { AuthorizationError, ValidationError } from "@/domain/errors";
import {
  MAX_LAT,
  MAX_LNG,
  MIN_LAT,
  MIN_LNG,
  type AuthContext,
  type Company,
  type Geofence,
} from "@/domain/types";
import { AdminService } from "./admin";
import { CompanyUserService } from "./company-user";
import { BcryptPasswordHasher } from "./password";
import { RequestService, type CreateRequestInput } from "./request";
import { SiteService } from "./site";

const NOW = new Date("2025-03-01T09:00:00Z");

/** Phoenix SW Valley-ish pilot box, so the work-list Requests are in-area. */
const SW_VALLEY: Geofence = {
  minLat: 33.2,
  maxLat: 33.6,
  minLng: -112.6,
  maxLng: -112.1,
};

const IN_AREA_PIN = { lat: 33.4, lng: -112.35 };

const IN_AREA_REQUEST: CreateRequestInput = {
  gallons: 500,
  productType: "ulsd",
  deliveryMethod: "wet_hose",
  deliveryWindow: "today",
  ...IN_AREA_PIN,
};

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

const token = (maxLength: number) =>
  fc.stringOf(fc.constantFrom(...LOWER_ALNUM.split("")), {
    minLength: 1,
    maxLength,
  });

/**
 * A valid Site name: any text that still has content after trimming, since
 * `createSite` trims before storing. Includes padded and multi-word names so
 * the round trip is checked against the normalized value, not just simple
 * tokens.
 */
const siteName = fc
  .oneof(
    { arbitrary: fc.string({ minLength: 1, maxLength: 40 }), weight: 3 },
    {
      arbitrary: fc
        .tuple(token(12), token(12))
        .map(([a, b]) => `  ${a} ${b}  `),
      weight: 1,
    },
    {
      arbitrary: fc.constantFrom(
        "Lot 14 — Estrella",
        "Yard tank A",
        "51st Ave & Baseline",
        "x"
      ),
      weight: 1,
    }
  )
  .filter((name) => name.trim() !== "");

/** Latitude in [-90, 90], weighted to also hit the inclusive extremes. */
const latitude = fc.oneof(
  {
    arbitrary: fc.double({ min: MIN_LAT, max: MAX_LAT, noNaN: true }),
    weight: 4,
  },
  {
    arbitrary: fc.constantFrom(MIN_LAT, MAX_LAT, 0, -0, 33.2, 33.6, 33.4484),
    weight: 1,
  }
);

/** Longitude in [-180, 180], weighted to also hit the inclusive extremes. */
const longitude = fc.oneof(
  {
    arbitrary: fc.double({ min: MIN_LNG, max: MAX_LNG, noNaN: true }),
    weight: 4,
  },
  {
    arbitrary: fc.constantFrom(
      MIN_LNG,
      MAX_LNG,
      0,
      -0,
      -112.6,
      -112.1,
      -112.074
    ),
    weight: 1,
  }
);

const validSiteInput = fc.record({
  name: siteName,
  lat: latitude,
  lng: longitude,
});

// ---------------------------------------------------------------------------
// Harness — two Buyer Companies so tenant isolation has something to leak
// ---------------------------------------------------------------------------

interface Harness {
  sites: SiteService;
  requests: RequestService;
  /** Buyer on company A: the caller under test. */
  buyer: AuthContext;
  /** Buyer on company B: the other tenant. */
  otherBuyer: AuthContext;
  buyerCompany: Company;
  otherBuyerCompany: Company;
}

async function makeHarness(names: {
  operator: string;
  buyer: string;
  otherBuyer: string;
}): Promise<Harness> {
  const repo = new InMemoryRepository();
  const companies = new CompanyUserService({
    repo,
    hasher: new BcryptPasswordHasher(4),
  });
  const admin = new AdminService({ repo });
  const sites = new SiteService({ repo });
  const requests = new RequestService({ repo, admin });

  const operatorCompany = await companies.createCompany(
    { name: `${names.operator}-operator`, kind: "buyer" },
    NOW
  );
  const buyerCompany = await companies.createCompany(
    { name: `${names.buyer}-a`, kind: "buyer" },
    NOW
  );
  const otherBuyerCompany = await companies.createCompany(
    { name: `${names.otherBuyer}-b`, kind: "buyer" },
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
  const otherBuyerUser = await companies.createUser(
    {
      companyId: otherBuyerCompany.id,
      role: "buyer",
      phone: "+16025550122",
      password: "other-buyer-pw",
    },
    NOW
  );

  const adminCtx: AuthContext = {
    userId: adminUser.id,
    companyId: adminUser.companyId,
    role: "admin",
  };
  // A configured fence so the Requests used for the work-list half of
  // Property 3 (Requirement 3.9) can be created at all.
  await admin.setGeofence(adminCtx, SW_VALLEY, NOW);

  return {
    sites,
    requests,
    buyer: {
      userId: buyerUser.id,
      companyId: buyerUser.companyId,
      role: "buyer",
    },
    otherBuyer: {
      userId: otherBuyerUser.id,
      companyId: otherBuyerUser.companyId,
      role: "buyer",
    },
    buyerCompany,
    otherBuyerCompany,
  };
}

// ---------------------------------------------------------------------------
// Property 3 (task 4.4)
// ---------------------------------------------------------------------------

describe("Property 3: Site round trip and tenant isolation", () => {
  // Feature: load-energy, Property 3: Site round trip and tenant isolation
  // **Validates: Requirements 2.1, 2.2, 2.3, 3.9**
  it("returns the created Site's name and coordinates on the owning company's list and never another company's Sites, Requests, or Orders", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          operatorName: token(10),
          buyerName: token(10),
          otherBuyerName: token(10),
          mine: fc.array(validSiteInput, { minLength: 1, maxLength: 4 }),
          theirs: fc.array(validSiteInput, { minLength: 1, maxLength: 3 }),
        }),
        async (c) => {
          const h = await makeHarness({
            operator: c.operatorName,
            buyer: c.buyerName,
            otherBuyer: c.otherBuyerName,
          });

          // Requirements 2.1, 2.2: each Site is created on the caller's own
          // Buyer Company with the submitted name and pin.
          const created = [];
          for (const input of c.mine) {
            const site = await h.sites.createSite(h.buyer, input, NOW);
            expect(site.companyId).toBe(h.buyerCompany.id);
            expect(site.name).toBe(input.name.trim());
            expect(site.lat).toBe(input.lat);
            expect(site.lng).toBe(input.lng);
            created.push(site);
          }

          // The other tenant's Sites, created through the same code path.
          const foreign = [];
          for (const input of c.theirs) {
            foreign.push(await h.sites.createSite(h.otherBuyer, input, NOW));
          }

          // Requirement 2.3: listing returns the caller's Sites, each with the
          // same name and coordinates that were submitted.
          const listed = await h.sites.listSites(h.buyer);
          for (const site of created) {
            const found = listed.find((s) => s.id === site.id);
            expect(found, `site ${site.id} missing from its own list`).toBeDefined();
            expect(found).toMatchObject({
              companyId: h.buyerCompany.id,
              name: site.name,
              lat: site.lat,
              lng: site.lng,
            });
          }

          // Requirement 2.3: and nothing belonging to the other Company.
          const foreignIds = new Set(foreign.map((s) => s.id));
          expect(listed.every((s) => s.companyId === h.buyerCompany.id)).toBe(true);
          expect(listed.some((s) => foreignIds.has(s.id))).toBe(false);
          expect(listed).toHaveLength(created.length);

          // Isolation is enforced, not merely filtered: asking for another
          // Company's list is denied rather than answered.
          await expect(
            h.sites.listSites(h.buyer, h.otherBuyerCompany.id)
          ).rejects.toBeInstanceOf(AuthorizationError);

          // Requirement 3.9: the same isolation holds for the work list. Both
          // tenants post a Request; each sees only its own.
          const myRequest = await h.requests.createRequest(
            h.buyer,
            IN_AREA_REQUEST,
            NOW
          );
          const theirRequest = await h.requests.createRequest(
            h.otherBuyer,
            IN_AREA_REQUEST,
            NOW
          );

          const work = await h.requests.getWorkList(h.buyer, undefined, NOW);
          expect(work.requests.map((r) => r.id)).toContain(myRequest.id);
          expect(work.requests.map((r) => r.id)).not.toContain(theirRequest.id);
          expect(
            work.requests.every((r) => r.buyerCompanyId === h.buyerCompany.id)
          ).toBe(true);
          expect(
            work.orders.every((o) => o.buyerCompanyId === h.buyerCompany.id)
          ).toBe(true);

          await expect(
            h.requests.getWorkList(h.buyer, h.otherBuyerCompany.id)
          ).rejects.toBeInstanceOf(AuthorizationError);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 (task 4.5)
// ---------------------------------------------------------------------------

/**
 * Latitudes that genuinely fall outside [-90, 90]: values just past each
 * bound, large magnitudes, and the non-finite values that fail the range test
 * too. The filter guarantees no draw can accidentally be in range.
 */
const outOfRangeLatitude = fc
  .oneof(
    {
      arbitrary: fc.constantFrom(
        90.0000001,
        -90.0000001,
        90.5,
        -90.5,
        91,
        -91,
        180,
        -180,
        1e9,
        -1e9,
        Number.MAX_VALUE,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NaN
      ),
      weight: 3,
    },
    {
      arbitrary: fc.double({ min: 90.0001, max: 1e6, noNaN: true }),
      weight: 2,
    },
    {
      arbitrary: fc.double({ min: -1e6, max: -90.0001, noNaN: true }),
      weight: 2,
    }
  )
  .filter((lat) => !(lat >= MIN_LAT && lat <= MAX_LAT));

/** Longitudes that genuinely fall outside [-180, 180]. */
const outOfRangeLongitude = fc
  .oneof(
    {
      arbitrary: fc.constantFrom(
        180.0000001,
        -180.0000001,
        180.5,
        -180.5,
        181,
        -181,
        360,
        -360,
        1e9,
        -1e9,
        Number.MAX_VALUE,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NaN
      ),
      weight: 3,
    },
    {
      arbitrary: fc.double({ min: 180.0001, max: 1e6, noNaN: true }),
      weight: 2,
    },
    {
      arbitrary: fc.double({ min: -1e6, max: -180.0001, noNaN: true }),
      weight: 2,
    }
  )
  .filter((lng) => !(lng >= MIN_LNG && lng <= MAX_LNG));

/**
 * A pin violating at least one bound: bad latitude, bad longitude, or both.
 * `expectedField` is the coordinate the service reports, which is latitude
 * first when both are bad since validation runs lat then lng.
 */
const outOfRangePin = fc.oneof(
  fc
    .record({ lat: outOfRangeLatitude, lng: longitude })
    .map((pin) => ({ ...pin, expectedField: "lat" as const })),
  fc
    .record({ lat: latitude, lng: outOfRangeLongitude })
    .map((pin) => ({ ...pin, expectedField: "lng" as const })),
  fc
    .record({ lat: outOfRangeLatitude, lng: outOfRangeLongitude })
    .map((pin) => ({ ...pin, expectedField: "lat" as const }))
);

describe("Property 4: Coordinate validation rejects out-of-range pins", () => {
  // Feature: load-energy, Property 4: Coordinate validation rejects out-of-range pins
  // **Validates: Requirements 2.4**
  it("rejects any Site whose latitude is outside [-90, 90] or longitude outside [-180, 180] with a validation error and persists nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          operatorName: token(10),
          buyerName: token(10),
          otherBuyerName: token(10),
          name: siteName,
          pin: outOfRangePin,
        }),
        async (c) => {
          const h = await makeHarness({
            operator: c.operatorName,
            buyer: c.buyerName,
            otherBuyer: c.otherBuyerName,
          });

          let thrown: unknown;
          try {
            await h.sites.createSite(
              h.buyer,
              { name: c.name, lat: c.pin.lat, lng: c.pin.lng },
              NOW
            );
          } catch (error) {
            thrown = error;
          }

          // Requirement 2.4: a validation error (400 at the API boundary)
          // naming the offending coordinate.
          const label = `lat: ${String(c.pin.lat)}, lng: ${String(c.pin.lng)}`;
          expect(thrown, label).toBeInstanceOf(ValidationError);
          const error = thrown as ValidationError;
          expect(error.category).toBe("validation");
          expect(error.httpStatus).toBe(400);
          expect(error.field).toBe(c.pin.expectedField);

          // Rejection means nothing was written.
          expect(await h.sites.listSites(h.buyer)).toHaveLength(0);
        }
      )
    );
  });
});
