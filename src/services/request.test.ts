import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/repository/in-memory";
import type {
  AuthContext,
  Geofence,
  Offer,
  Request,
  RequestStatus,
} from "@/domain/types";
import { AdminService } from "./admin";
import { CompanyUserService } from "./company-user";
import { BcryptPasswordHasher } from "./password";
import {
  RequestService,
  deliveryWindowEndsAt,
  hasWindowEnded,
  requireGallons,
  type CreateRequestInput,
} from "./request";

const NOW = new Date("2025-03-01T09:00:00Z"); // 02:00 Phoenix time, Mar 1

// Phoenix SW Valley-ish pilot box.
const SW_VALLEY: Geofence = {
  minLat: 33.2,
  maxLat: 33.6,
  minLng: -112.6,
  maxLng: -112.1,
};

const INSIDE = { lat: 33.4, lng: -112.35 };

const VALID_INPUT: CreateRequestInput = {
  gallons: 500,
  productType: "ulsd",
  deliveryMethod: "wet_hose",
  deliveryWindow: "today",
  ...INSIDE,
};

interface Harness {
  repo: InMemoryRepository;
  admin: AdminService;
  service: RequestService;
  adminCtx: AuthContext;
  buyer: AuthContext;
  otherBuyer: AuthContext;
  supplier: AuthContext;
  supplierCompanyId: string;
}

async function makeHarness(configureFence = true): Promise<Harness> {
  const repo = new InMemoryRepository();
  const companies = new CompanyUserService({
    repo,
    hasher: new BcryptPasswordHasher(4),
  });
  const admin = new AdminService({ repo });
  const service = new RequestService({ repo, admin });

  const operatorCompany = await companies.createCompany(
    { name: "Load Energy", kind: "buyer" },
    NOW
  );
  const buyerCompany = await companies.createCompany(
    { name: "SW Valley Concrete", kind: "buyer" },
    NOW
  );
  const rivalCompany = await companies.createCompany(
    { name: "Goodyear Grading", kind: "buyer" },
    NOW
  );
  const supplierCompany = await companies.createCompany(
    { name: "Buckeye Diesel", kind: "supplier" },
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
  const rivalUser = await companies.createUser(
    {
      companyId: rivalCompany.id,
      role: "buyer",
      phone: "+16025550122",
      password: "rival-pw",
    },
    NOW
  );
  const supplierUser = await companies.createUser(
    {
      companyId: supplierCompany.id,
      role: "supplier",
      phone: "+16025550123",
      password: "supplier-pw",
    },
    NOW
  );

  const adminCtx: AuthContext = {
    userId: adminUser.id,
    companyId: adminUser.companyId,
    role: "admin",
  };

  if (configureFence) {
    await admin.setGeofence(adminCtx, SW_VALLEY, NOW);
  }

  return {
    repo,
    admin,
    service,
    adminCtx,
    buyer: {
      userId: buyerUser.id,
      companyId: buyerUser.companyId,
      role: "buyer",
    },
    otherBuyer: {
      userId: rivalUser.id,
      companyId: rivalUser.companyId,
      role: "buyer",
    },
    supplier: {
      userId: supplierUser.id,
      companyId: supplierUser.companyId,
      role: "supplier",
    },
    supplierCompanyId: supplierCompany.id,
  };
}

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

// ---------------------------------------------------------------------------
// windowEndsAt derivation
// ---------------------------------------------------------------------------

describe("deliveryWindowEndsAt", () => {
  it("ends a Today window at the last millisecond of the pilot-local day", () => {
    // 02:00 Phoenix on Mar 1 -> Mar 1 23:59:59.999 Phoenix == Mar 2 06:59:59.999Z
    expect(deliveryWindowEndsAt("today", NOW)).toEqual(
      new Date("2025-03-02T06:59:59.999Z")
    );
  });

  it("uses the pilot-local day, not the UTC day", () => {
    // 03:00Z on Mar 2 is still 20:00 Phoenix on Mar 1.
    expect(
      deliveryWindowEndsAt("today", new Date("2025-03-02T03:00:00Z"))
    ).toEqual(new Date("2025-03-02T06:59:59.999Z"));
    // 16:30 Phoenix on Mar 1 lands on the same day end.
    expect(
      deliveryWindowEndsAt("today", new Date("2025-03-01T23:30:00Z"))
    ).toEqual(new Date("2025-03-02T06:59:59.999Z"));
  });

  it("ends a Tomorrow_AM window at noon pilot time the next day", () => {
    // Mar 2 12:00 Phoenix == Mar 2 19:00Z
    expect(deliveryWindowEndsAt("tomorrow_am", NOW)).toEqual(
      new Date("2025-03-02T19:00:00Z")
    );
  });

  it("never ends before the creation instant", () => {
    const instants = [
      NOW,
      new Date("2025-03-02T06:59:59.999Z"), // the very end of a pilot day
      new Date("2025-03-02T07:00:00.000Z"), // the very start of the next one
    ];
    for (const instant of instants) {
      expect(
        deliveryWindowEndsAt("today", instant).getTime()
      ).toBeGreaterThanOrEqual(instant.getTime());
      expect(
        deliveryWindowEndsAt("tomorrow_am", instant).getTime()
      ).toBeGreaterThan(instant.getTime());
    }
  });
});

// ---------------------------------------------------------------------------
// Request creation
// ---------------------------------------------------------------------------

describe("RequestService.createRequest", () => {
  it("creates an Open Request linked to the Buyer and Company (Req 3.1, 3.8)", async () => {
    const request = await h.service.createRequest(h.buyer, VALID_INPUT, NOW);

    expect(request.status).toBe("open");
    expect(request.buyerCompanyId).toBe(h.buyer.companyId);
    expect(request.createdByUserId).toBe(h.buyer.userId);
    expect(request.gallons).toBe(500);
    expect(request.productType).toBe("ulsd");
    expect(request.deliveryMethod).toBe("wet_hose");
    expect(request.deliveryWindow).toBe("today");
    expect({ lat: request.pinLat, lng: request.pinLng }).toEqual(INSIDE);
    expect(request.notes).toBeNull();
    expect(request.windowEndsAt).toEqual(deliveryWindowEndsAt("today", NOW));
    expect(request.createdAt).toEqual(NOW);

    expect(await h.repo.getRequest(request.id)).toEqual(request);
  });

  it("accepts every valid enum combination (Req 3.2, 3.3, 3.4)", async () => {
    for (const productType of ["ulsd", "dyed"] as const) {
      for (const deliveryMethod of ["wet_hose", "yard_tank"] as const) {
        for (const deliveryWindow of ["today", "tomorrow_am"] as const) {
          const request = await h.service.createRequest(
            h.buyer,
            { ...VALID_INPUT, productType, deliveryMethod, deliveryWindow },
            NOW
          );
          expect({
            productType: request.productType,
            deliveryMethod: request.deliveryMethod,
            deliveryWindow: request.deliveryWindow,
          }).toEqual({ productType, deliveryMethod, deliveryWindow });
          expect(request.windowEndsAt).toEqual(
            deliveryWindowEndsAt(deliveryWindow, NOW)
          );
        }
      }
    }
  });

  it("stores notes when provided (Req 3.7)", async () => {
    const request = await h.service.createRequest(
      h.buyer,
      { ...VALID_INPUT, notes: "  Gate code 4417, ask for Manny  " },
      NOW
    );
    expect(request.notes).toBe("Gate code 4417, ask for Manny");
  });

  it("rejects gallons at or below zero (Req 3.5)", async () => {
    for (const gallons of [0, -1, -500]) {
      await expect(
        h.service.createRequest(h.buyer, { ...VALID_INPUT, gallons }, NOW)
      ).rejects.toMatchObject({
        category: "validation",
        code: "GALLONS_INVALID",
        field: "gallons",
      });
    }
  });

  it("rejects non-integer and non-finite gallons", async () => {
    for (const gallons of [12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        h.service.createRequest(h.buyer, { ...VALID_INPUT, gallons }, NOW)
      ).rejects.toMatchObject({ category: "validation", field: "gallons" });
    }
  });

  it("rejects unknown enum values (Req 3.2, 3.3, 3.4)", async () => {
    await expect(
      h.service.createRequest(
        h.buyer,
        { ...VALID_INPUT, productType: "gasoline" as never },
        NOW
      )
    ).rejects.toMatchObject({
      category: "validation",
      code: "PRODUCT_TYPE_INVALID",
      field: "productType",
    });

    await expect(
      h.service.createRequest(
        h.buyer,
        { ...VALID_INPUT, deliveryMethod: "cardlock" as never },
        NOW
      )
    ).rejects.toMatchObject({
      category: "validation",
      code: "DELIVERY_METHOD_INVALID",
      field: "deliveryMethod",
    });

    await expect(
      h.service.createRequest(
        h.buyer,
        { ...VALID_INPUT, deliveryWindow: "next_week" as never },
        NOW
      )
    ).rejects.toMatchObject({
      category: "validation",
      code: "DELIVERY_WINDOW_INVALID",
      field: "deliveryWindow",
    });
  });

  it("rejects a pin outside the Pilot_Geofence with a geofence error (Req 3.6)", async () => {
    await expect(
      h.service.createRequest(
        h.buyer,
        { ...VALID_INPUT, lat: 34.9, lng: -112.35 },
        NOW
      )
    ).rejects.toMatchObject({
      category: "geofence",
      code: "OUTSIDE_GEOFENCE",
      httpStatus: 422,
    });
  });

  it("accepts a pin exactly on the geofence boundary (Req 3.6 inclusive)", async () => {
    const request = await h.service.createRequest(
      h.buyer,
      { ...VALID_INPUT, lat: SW_VALLEY.minLat, lng: SW_VALLEY.maxLng },
      NOW
    );
    expect(request.status).toBe("open");
  });

  it("applies a fence an Admin has just updated (Req 16.7)", async () => {
    const shrunk: Geofence = {
      minLat: 33.0,
      maxLat: 33.1,
      minLng: -112.6,
      maxLng: -112.5,
    };
    await h.admin.setGeofence(h.adminCtx, shrunk, NOW);

    await expect(
      h.service.createRequest(h.buyer, VALID_INPUT, NOW)
    ).rejects.toMatchObject({ code: "OUTSIDE_GEOFENCE" });

    const request = await h.service.createRequest(
      h.buyer,
      { ...VALID_INPUT, lat: 33.05, lng: -112.55 },
      NOW
    );
    expect(request.status).toBe("open");
  });

  it("rejects an out-of-range coordinate as validation, not geofence (Req 2.4 vs 3.6)", async () => {
    await expect(
      h.service.createRequest(h.buyer, { ...VALID_INPUT, lat: 120 }, NOW)
    ).rejects.toMatchObject({
      category: "validation",
      code: "LATITUDE_OUT_OF_RANGE",
      field: "lat",
    });
  });

  it("fails closed when no Admin has configured a Pilot_Geofence", async () => {
    const bare = await makeHarness(false);
    await expect(
      bare.service.createRequest(bare.buyer, VALID_INPUT, NOW)
    ).rejects.toMatchObject({
      category: "geofence",
      code: "GEOFENCE_NOT_CONFIGURED",
      httpStatus: 422,
    });
    expect(await bare.repo.listRequestsByBuyerCompany(bare.buyer.companyId)).toEqual(
      []
    );
  });

  it("denies a Supplier creating a Request (Req 1.9)", async () => {
    await expect(
      h.service.createRequest(h.supplier, VALID_INPUT, NOW)
    ).rejects.toMatchObject({ category: "authorization" });
  });
});

describe("requireGallons", () => {
  it("accepts the smallest positive whole gallon count", () => {
    expect(requireGallons(1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Buyer work list
// ---------------------------------------------------------------------------

describe("RequestService.getWorkList", () => {
  it("returns the Company's Open Requests and Orders (Req 3.9)", async () => {
    const open = await h.service.createRequest(h.buyer, VALID_INPUT, NOW);
    const toCancel = await h.service.createRequest(h.buyer, VALID_INPUT, NOW);
    await h.repo.updateRequest(toCancel.id, { status: "cancelled" });

    const order = await h.repo.createOrder({
      requestId: null,
      offerId: null,
      buyerCompanyId: h.buyer.companyId,
      supplierCompanyId: h.supplierCompanyId,
      status: "accepted",
      isConcierge: false,
      createdAt: NOW,
    });

    const list = await h.service.getWorkList(h.buyer, undefined, NOW);
    expect(list.requests).toEqual([open]);
    expect(list.orders).toEqual([order]);
  });

  it("excludes another Company's Requests and Orders (Req 3.9 tenant isolation)", async () => {
    await h.service.createRequest(h.otherBuyer, VALID_INPUT, NOW);
    await h.repo.createOrder({
      requestId: null,
      offerId: null,
      buyerCompanyId: h.otherBuyer.companyId,
      supplierCompanyId: h.supplierCompanyId,
      status: "accepted",
      isConcierge: false,
      createdAt: NOW,
    });

    const list = await h.service.getWorkList(h.buyer, undefined, NOW);
    expect(list).toEqual({ requests: [], orders: [] });
  });

  it("denies reading another Company's work list", async () => {
    await expect(
      h.service.getWorkList(h.buyer, h.otherBuyer.companyId)
    ).rejects.toMatchObject({
      category: "authorization",
      code: "COMPANY_SCOPE_FORBIDDEN",
    });
  });
});

// ---------------------------------------------------------------------------
// Cancel and expire (Requirements 9.1-9.5)
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 3_600_000;

/** An active quote on `requestId`, written straight to the repository. */
async function seedOffer(
  requestId: string,
  overrides: Partial<Omit<Offer, "id">> = {}
): Promise<Offer> {
  return h.repo.createOffer({
    requestId,
    supplierCompanyId: h.supplierCompanyId,
    createdByUserId: h.supplier.userId,
    landedPricePerGal: 3.89,
    holdHours: 4,
    etaMinutes: null,
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 4 * MS_PER_HOUR),
    voided: false,
    status: "active",
    ...overrides,
  });
}

/** An Open Request on the buyer's Company, created at NOW. */
async function seedOpenRequest(
  overrides: Partial<CreateRequestInput> = {}
): Promise<Request> {
  return h.service.createRequest(h.buyer, { ...VALID_INPUT, ...overrides }, NOW);
}

describe("hasWindowEnded", () => {
  it("is false before the window end and true at or after it (Req 9.3)", () => {
    const windowEndsAt = new Date("2025-03-01T12:00:00Z");
    expect(hasWindowEnded({ windowEndsAt }, NOW)).toBe(false);
    // The boundary matches matching's isWindowStillOpen exactly: a window that
    // ends at `now` is over, so the load is expirable at that instant.
    expect(hasWindowEnded({ windowEndsAt }, windowEndsAt)).toBe(true);
    expect(
      hasWindowEnded({ windowEndsAt }, new Date("2025-03-01T12:00:00.001Z"))
    ).toBe(true);
  });

  it("fails closed on a malformed window end", () => {
    expect(hasWindowEnded({ windowEndsAt: new Date(Number.NaN) }, NOW)).toBe(
      false
    );
    expect(
      hasWindowEnded({ windowEndsAt: undefined as unknown as Date }, NOW)
    ).toBe(false);
  });
});

describe("RequestService.cancelRequest", () => {
  it("sets Cancelled and voids every active Offer (Req 9.1)", async () => {
    const request = await seedOpenRequest();
    const first = await seedOffer(request.id);
    const second = await seedOffer(request.id, { landedPricePerGal: 3.71 });

    const cancelled = await h.service.cancelRequest(h.buyer, request.id, NOW);

    expect(cancelled.status).toBe("cancelled");
    expect((await h.repo.getRequest(request.id))?.status).toBe("cancelled");
    for (const offer of [first, second]) {
      expect(await h.repo.getOffer(offer.id)).toMatchObject({
        status: "voided",
        voided: true,
      });
    }
  });

  it("leaves offers that are already dead alone", async () => {
    const request = await seedOpenRequest();
    const voided = await seedOffer(request.id, {
      status: "voided",
      voided: true,
    });
    const won = await seedOffer(request.id, { status: "accepted" });

    await h.service.cancelRequest(h.buyer, request.id, NOW);

    expect(await h.repo.getOffer(voided.id)).toMatchObject({
      status: "voided",
      voided: true,
    });
    // An accepted quote is history, not something cancellation rewrites.
    expect(await h.repo.getOffer(won.id)).toMatchObject({
      status: "accepted",
      voided: false,
    });
  });

  it("cancels a load that carries no offers at all", async () => {
    const request = await seedOpenRequest();
    await expect(
      h.service.cancelRequest(h.buyer, request.id, NOW)
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it.each<RequestStatus>(["accepted", "cancelled", "expired"])(
    "rejects cancelling a %s load (Req 9.2)",
    async (status) => {
      const request = await seedOpenRequest();
      await h.repo.updateRequest(request.id, { status });

      await expect(
        h.service.cancelRequest(h.buyer, request.id, NOW)
      ).rejects.toMatchObject({
        category: "conflict",
        code: "REQUEST_NOT_OPEN",
        httpStatus: 409,
      });
      expect((await h.repo.getRequest(request.id))?.status).toBe(status);
    }
  );

  it("rejects a second cancellation and leaves the first one standing (Req 9.2)", async () => {
    const request = await seedOpenRequest();
    await h.service.cancelRequest(h.buyer, request.id, NOW);

    await expect(
      h.service.cancelRequest(h.buyer, request.id, NOW)
    ).rejects.toMatchObject({ code: "REQUEST_NOT_OPEN" });
    expect((await h.repo.getRequest(request.id))?.status).toBe("cancelled");
  });

  it("denies a Buyer outside the owning Company (Req 9.5)", async () => {
    const request = await seedOpenRequest();
    const offer = await seedOffer(request.id);

    await expect(
      h.service.cancelRequest(h.otherBuyer, request.id, NOW)
    ).rejects.toMatchObject({
      category: "authorization",
      code: "COMPANY_SCOPE_FORBIDDEN",
      httpStatus: 403,
    });
    expect((await h.repo.getRequest(request.id))?.status).toBe("open");
    expect(await h.repo.getOffer(offer.id)).toMatchObject({ status: "active" });
  });

  it("denies a Supplier cancelling a load (Req 9.5, 1.9)", async () => {
    const request = await seedOpenRequest();
    await expect(
      h.service.cancelRequest(h.supplier, request.id, NOW)
    ).rejects.toMatchObject({ category: "authorization" });
  });

  it("reports an unknown load id as an authorization denial, not a 404", async () => {
    await expect(
      h.service.cancelRequest(h.buyer, "req-does-not-exist", NOW)
    ).rejects.toMatchObject({
      category: "authorization",
      code: "COMPANY_SCOPE_UNRESOLVED",
    });
  });

  it("drops the cancelled load off the work list (Req 9.1, 3.9)", async () => {
    const request = await seedOpenRequest();
    await h.service.cancelRequest(h.buyer, request.id, NOW);

    const list = await h.service.getWorkList(h.buyer, undefined, NOW);
    expect(list.requests).toEqual([]);
  });
});

describe("RequestService.expireRequest", () => {
  /** An instant just past a Today window created at NOW. */
  const PAST_WINDOW = new Date(
    deliveryWindowEndsAt("today", NOW).getTime() + 1
  );

  it("sets Expired and voids the remaining active Offers (Req 9.3)", async () => {
    const request = await seedOpenRequest();
    const live = await seedOffer(request.id);
    const alreadyVoided = await seedOffer(request.id, {
      status: "voided",
      voided: true,
    });

    const expired = await h.service.expireRequest(request.id, PAST_WINDOW);

    expect(expired.status).toBe("expired");
    expect((await h.repo.getRequest(request.id))?.status).toBe("expired");
    expect(await h.repo.getOffer(live.id)).toMatchObject({
      status: "voided",
      voided: true,
    });
    expect(await h.repo.getOffer(alreadyVoided.id)).toMatchObject({
      status: "voided",
    });
  });

  it("expires exactly at the window end, not a millisecond earlier (Req 9.3)", async () => {
    const request = await seedOpenRequest();
    const endsAt = request.windowEndsAt;

    const beforeEnd = await h.service.expireRequest(
      request.id,
      new Date(endsAt.getTime() - 1)
    );
    expect(beforeEnd.status).toBe("open");

    const atEnd = await h.service.expireRequest(request.id, endsAt);
    expect(atEnd.status).toBe("expired");
  });

  it("leaves a live load and its quotes untouched", async () => {
    const request = await seedOpenRequest();
    const offer = await seedOffer(request.id);

    const unchanged = await h.service.expireRequest(request.id, NOW);

    expect(unchanged.status).toBe("open");
    expect(await h.repo.getOffer(offer.id)).toMatchObject({ status: "active" });
  });

  it.each<RequestStatus>(["accepted", "cancelled", "expired"])(
    "never overwrites a %s load past its window (Req 9.3)",
    async (status) => {
      const request = await seedOpenRequest();
      await h.repo.updateRequest(request.id, { status });

      const result = await h.service.expireRequest(request.id, PAST_WINDOW);

      expect(result.status).toBe(status);
    }
  );

  it("is idempotent", async () => {
    const request = await seedOpenRequest();
    await h.service.expireRequest(request.id, PAST_WINDOW);
    await expect(
      h.service.expireRequest(request.id, PAST_WINDOW)
    ).resolves.toMatchObject({ status: "expired" });
  });

  it("rejects an unknown load id", async () => {
    await expect(
      h.service.expireRequest("req-does-not-exist", PAST_WINDOW)
    ).rejects.toMatchObject({
      category: "validation",
      code: "REQUEST_NOT_FOUND",
      field: "requestId",
    });
  });

  it("expires lazily on the work-list read and drops the load (Req 9.3, 9.4)", async () => {
    const request = await seedOpenRequest();
    const offer = await seedOffer(request.id);

    const list = await h.service.getWorkList(h.buyer, undefined, PAST_WINDOW);

    expect(list.requests).toEqual([]);
    expect((await h.repo.getRequest(request.id))?.status).toBe("expired");
    expect(await h.repo.getOffer(offer.id)).toMatchObject({
      status: "voided",
      voided: true,
    });
  });

  it("expires lazily on a single-load read (Req 9.3)", async () => {
    const request = await seedOpenRequest();

    const read = await h.service.getRequest(h.buyer, request.id, PAST_WINDOW);

    expect(read.status).toBe("expired");
    expect((await h.repo.getRequest(request.id))?.status).toBe("expired");
  });

  it("returns a live load unchanged on read", async () => {
    const request = await seedOpenRequest();
    await expect(
      h.service.getRequest(h.buyer, request.id, NOW)
    ).resolves.toEqual(request);
  });

  it("denies reading another Company's load", async () => {
    const request = await seedOpenRequest();
    await expect(
      h.service.getRequest(h.otherBuyer, request.id, NOW)
    ).rejects.toMatchObject({
      category: "authorization",
      code: "COMPANY_SCOPE_FORBIDDEN",
    });
  });
});
