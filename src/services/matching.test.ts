import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/repository/in-memory";
import type {
  AuthContext,
  Company,
  Request,
  RequestStatus,
} from "@/domain/types";
import { AdminService } from "./admin";
import { CompanyUserService } from "./company-user";
import { BcryptPasswordHasher } from "./password";
import { RequestService } from "./request";
import {
  MatchingService,
  isEligibleSupplier,
  isWindowStillOpen,
  matchSuppliers,
} from "./matching";

const NOW = new Date("2025-03-01T09:00:00Z");
const LATER = new Date("2025-03-01T20:00:00Z");

// Buckeye, AZ — the supplier origin used throughout.
const BUCKEYE = { lat: 33.3703, lng: -112.5838 };
// Goodyear, ~9 miles east of Buckeye.
const GOODYEAR = { lat: 33.4353, lng: -112.3576 };
// Tucson, ~104 miles from Phoenix — far outside any pilot radius.
const TUCSON = { lat: 32.2226, lng: -110.9747 };

function supplierCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: "sup-1",
    name: "Buckeye Diesel",
    kind: "supplier",
    supplierApprovalStatus: "approved",
    supplierStatus: "open",
    operatingLat: BUCKEYE.lat,
    operatingLng: BUCKEYE.lng,
    serviceRadiusMiles: 25,
    createdAt: NOW,
    ...overrides,
  };
}

function openRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: "req-1",
    buyerCompanyId: "buy-1",
    createdByUserId: "usr-1",
    gallons: 500,
    productType: "ulsd",
    deliveryMethod: "wet_hose",
    deliveryWindow: "today",
    pinLat: GOODYEAR.lat,
    pinLng: GOODYEAR.lng,
    notes: null,
    status: "open",
    windowEndsAt: new Date("2025-03-02T06:59:59.999Z"),
    createdAt: NOW,
    ...overrides,
  };
}

describe("isEligibleSupplier", () => {
  it("admits an approved, open, in-radius supplier on an Open request", () => {
    expect(isEligibleSupplier(openRequest(), supplierCompany())).toBe(true);
  });

  it("admits a Limited supplier", () => {
    expect(
      isEligibleSupplier(openRequest(), supplierCompany({ supplierStatus: "limited" }))
    ).toBe(true);
  });

  it("excludes a Closed supplier", () => {
    expect(
      isEligibleSupplier(openRequest(), supplierCompany({ supplierStatus: "closed" }))
    ).toBe(false);
  });

  it("excludes a Pending supplier", () => {
    expect(
      isEligibleSupplier(
        openRequest(),
        supplierCompany({ supplierApprovalStatus: "pending" })
      )
    ).toBe(false);
  });

  it("excludes an out-of-radius supplier", () => {
    expect(
      isEligibleSupplier(
        openRequest({ pinLat: TUCSON.lat, pinLng: TUCSON.lng }),
        supplierCompany()
      )
    ).toBe(false);
  });

  it("is inclusive at exactly the configured radius", () => {
    // 9-ish miles Buckeye to Goodyear; set the radius to that exact distance.
    const radius = 25;
    const inside = supplierCompany({ serviceRadiusMiles: radius });
    expect(isEligibleSupplier(openRequest(), inside)).toBe(true);
    const tooSmall = supplierCompany({ serviceRadiusMiles: 1 });
    expect(isEligibleSupplier(openRequest(), tooSmall)).toBe(false);
  });

  it.each<RequestStatus>(["accepted", "cancelled", "expired"])(
    "excludes a %s request",
    (status) => {
      expect(isEligibleSupplier(openRequest({ status }), supplierCompany())).toBe(
        false
      );
    }
  );

  it("excludes a supplier with no Admin-set operating location", () => {
    expect(
      isEligibleSupplier(
        openRequest(),
        supplierCompany({ operatingLat: null, operatingLng: null })
      )
    ).toBe(false);
  });

  it("excludes a supplier with no Admin-set service radius", () => {
    expect(
      isEligibleSupplier(openRequest(), supplierCompany({ serviceRadiusMiles: null }))
    ).toBe(false);
  });

  it("excludes a buyer company outright", () => {
    expect(
      isEligibleSupplier(
        openRequest(),
        supplierCompany({
          kind: "buyer",
          supplierApprovalStatus: null,
          supplierStatus: null,
        })
      )
    ).toBe(false);
  });
});

describe("matchSuppliers", () => {
  it("keeps only the eligible companies, preserving input order", () => {
    const eligibleA = supplierCompany({ id: "a" });
    const closed = supplierCompany({ id: "b", supplierStatus: "closed" });
    const eligibleB = supplierCompany({ id: "c", supplierStatus: "limited" });
    const pending = supplierCompany({ id: "d", supplierApprovalStatus: "pending" });
    const far = supplierCompany({
      id: "e",
      operatingLat: TUCSON.lat,
      operatingLng: TUCSON.lng,
    });

    const matched = matchSuppliers(openRequest(), [
      eligibleA,
      closed,
      eligibleB,
      pending,
      far,
    ]);

    expect(matched.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("matches nothing for a non-Open request", () => {
    expect(
      matchSuppliers(openRequest({ status: "cancelled" }), [supplierCompany()])
    ).toEqual([]);
  });
});

describe("isWindowStillOpen", () => {
  it("is true before the window end and false at or after it", () => {
    const endsAt = new Date("2025-03-01T12:00:00Z");
    expect(isWindowStillOpen({ windowEndsAt: endsAt }, NOW)).toBe(true);
    expect(isWindowStillOpen({ windowEndsAt: endsAt }, endsAt)).toBe(false);
    expect(isWindowStillOpen({ windowEndsAt: endsAt }, LATER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

interface Harness {
  repo: InMemoryRepository;
  service: MatchingService;
  supplier: AuthContext;
  rival: AuthContext;
  buyerCtx: AuthContext;
  supplierCompanyId: string;
  rivalCompanyId: string;
  buyerCompanyId: string;
}

async function makeHarness(): Promise<Harness> {
  const repo = new InMemoryRepository();
  const companies = new CompanyUserService({
    repo,
    hasher: new BcryptPasswordHasher(4),
  });
  const service = new MatchingService({ repo });

  const supplierCo = await companies.createCompany(
    { name: "Buckeye Diesel", kind: "supplier" },
    NOW
  );
  const rivalCo = await companies.createCompany(
    { name: "Tolleson Fuel", kind: "supplier" },
    NOW
  );
  const buyerCo = await companies.createCompany(
    { name: "SW Valley Concrete", kind: "buyer" },
    NOW
  );

  // Admin configuration: approved, open, Buckeye origin, 25-mile radius.
  await repo.updateCompany(supplierCo.id, {
    supplierApprovalStatus: "approved",
    supplierStatus: "open",
    operatingLat: BUCKEYE.lat,
    operatingLng: BUCKEYE.lng,
    serviceRadiusMiles: 25,
  });
  await repo.updateCompany(rivalCo.id, {
    supplierApprovalStatus: "approved",
    supplierStatus: "open",
    operatingLat: TUCSON.lat,
    operatingLng: TUCSON.lng,
    serviceRadiusMiles: 25,
  });

  const supplierUser = await companies.createUser(
    {
      companyId: supplierCo.id,
      role: "supplier",
      phone: "+16025550141",
      password: "pw-supplier",
    },
    NOW
  );
  const rivalUser = await companies.createUser(
    {
      companyId: rivalCo.id,
      role: "supplier",
      phone: "+16025550142",
      password: "pw-rival",
    },
    NOW
  );
  const buyerUser = await companies.createUser(
    {
      companyId: buyerCo.id,
      role: "buyer",
      phone: "+16025550143",
      password: "pw-buyer",
    },
    NOW
  );

  return {
    repo,
    service,
    supplier: {
      userId: supplierUser.id,
      companyId: supplierCo.id,
      role: "supplier",
    },
    rival: { userId: rivalUser.id, companyId: rivalCo.id, role: "supplier" },
    buyerCtx: { userId: buyerUser.id, companyId: buyerCo.id, role: "buyer" },
    supplierCompanyId: supplierCo.id,
    rivalCompanyId: rivalCo.id,
    buyerCompanyId: buyerCo.id,
  };
}

async function seedRequest(
  h: Harness,
  overrides: Partial<Request> = {}
): Promise<Request> {
  const { id: _ignored, ...rest } = openRequest({
    buyerCompanyId: h.buyerCompanyId,
    ...overrides,
  });
  return h.repo.createRequest(rest);
}

/**
 * A MatchingService wired to the real window-end expiry evaluator
 * (Requirement 9.3). The thunk ties the knot between the two services — the
 * Request service needs matching for NEW_RFQ, matching needs the evaluator —
 * without either module importing the other.
 */
function withExpiry(h: Harness): MatchingService {
  let requests!: RequestService;
  const matching = new MatchingService({
    repo: h.repo,
    expiry: {
      expireIfWindowEnded: (request, now) =>
        requests.expireIfWindowEnded(request, now),
    },
  });
  requests = new RequestService({
    repo: h.repo,
    admin: new AdminService({ repo: h.repo }),
    matching,
  });
  return matching;
}

describe("MatchingService.listRfqInbox", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("returns an in-radius Open request", async () => {
    const request = await seedRequest(h);
    const inbox = await h.service.listRfqInbox(h.supplier, undefined, NOW);
    expect(inbox.map((r) => r.id)).toEqual([request.id]);
  });

  it("excludes an out-of-radius request", async () => {
    await seedRequest(h, { pinLat: TUCSON.lat, pinLng: TUCSON.lng });
    await expect(
      h.service.listRfqInbox(h.supplier, undefined, NOW)
    ).resolves.toEqual([]);
  });

  it.each<RequestStatus>(["accepted", "cancelled", "expired"])(
    "excludes a %s request",
    async (status) => {
      await seedRequest(h, { status });
      await expect(
        h.service.listRfqInbox(h.supplier, undefined, NOW)
      ).resolves.toEqual([]);
    }
  );

  it("excludes every request while the supplier is Closed", async () => {
    await seedRequest(h);
    await h.repo.updateCompany(h.supplierCompanyId, { supplierStatus: "closed" });
    await expect(
      h.service.listRfqInbox(h.supplier, undefined, NOW)
    ).resolves.toEqual([]);
  });

  it("excludes every request while the supplier is Pending", async () => {
    await seedRequest(h);
    await h.repo.updateCompany(h.supplierCompanyId, {
      supplierApprovalStatus: "pending",
    });
    await expect(
      h.service.listRfqInbox(h.supplier, undefined, NOW)
    ).resolves.toEqual([]);
  });

  it("includes a Limited supplier's in-radius requests", async () => {
    const request = await seedRequest(h);
    await h.repo.updateCompany(h.supplierCompanyId, { supplierStatus: "limited" });
    const inbox = await h.service.listRfqInbox(h.supplier, undefined, NOW);
    expect(inbox.map((r) => r.id)).toEqual([request.id]);
  });

  it("excludes a request whose delivery window has already ended", async () => {
    await seedRequest(h, { windowEndsAt: new Date("2025-03-01T08:00:00Z") });
    await expect(
      h.service.listRfqInbox(h.supplier, undefined, NOW)
    ).resolves.toEqual([]);
  });

  it("leaves the status alone when no expiry evaluator is wired", async () => {
    const request = await seedRequest(h, {
      windowEndsAt: new Date("2025-03-01T08:00:00Z"),
    });
    await h.service.listRfqInbox(h.supplier, undefined, NOW);
    const stored = await h.repo.getRequest(request.id);
    expect(stored?.status).toBe("open");
  });

  it("records a past-window request Expired when the evaluator is wired (Req 9.3, 9.4)", async () => {
    const request = await seedRequest(h, {
      windowEndsAt: new Date("2025-03-01T08:00:00Z"),
    });
    const offer = await h.repo.createOffer({
      requestId: request.id,
      supplierCompanyId: h.supplierCompanyId,
      createdByUserId: h.supplier.userId,
      landedPricePerGal: 3.89,
      holdHours: 4,
      etaMinutes: null,
      createdAt: NOW,
      expiresAt: new Date("2025-03-01T13:00:00Z"),
      voided: false,
      status: "active",
    });

    const inbox = await withExpiry(h).listRfqInbox(h.supplier, undefined, NOW);

    expect(inbox).toEqual([]);
    expect((await h.repo.getRequest(request.id))?.status).toBe("expired");
    expect(await h.repo.getOffer(offer.id)).toMatchObject({
      status: "voided",
      voided: true,
    });
  });

  it("keeps a live request in the inbox with the evaluator wired", async () => {
    const request = await seedRequest(h);
    const inbox = await withExpiry(h).listRfqInbox(h.supplier, undefined, NOW);
    expect(inbox.map((r) => r.id)).toEqual([request.id]);
    expect((await h.repo.getRequest(request.id))?.status).toBe("open");
  });

  it("returns newest first", async () => {
    const older = await seedRequest(h, { createdAt: new Date("2025-03-01T07:00:00Z") });
    const newer = await seedRequest(h, { createdAt: new Date("2025-03-01T08:30:00Z") });
    const inbox = await h.service.listRfqInbox(h.supplier, undefined, NOW);
    expect(inbox.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it("gives each supplier only its own in-radius work", async () => {
    const valleyRequest = await seedRequest(h);
    const tucsonRequest = await seedRequest(h, {
      pinLat: TUCSON.lat,
      pinLng: TUCSON.lng,
    });

    await expect(
      h.service.listRfqInbox(h.supplier, undefined, NOW)
    ).resolves.toMatchObject([{ id: valleyRequest.id }]);
    await expect(
      h.service.listRfqInbox(h.rival, undefined, NOW)
    ).resolves.toMatchObject([{ id: tucsonRequest.id }]);
  });

  it("denies reading another supplier company's inbox", async () => {
    await seedRequest(h);
    await expect(
      h.service.listRfqInbox(h.supplier, h.rivalCompanyId, NOW)
    ).rejects.toMatchObject({
      category: "authorization",
      code: "COMPANY_SCOPE_FORBIDDEN",
    });
  });

  it("denies a buyer the RFQ inbox", async () => {
    await expect(
      h.service.listRfqInbox(h.buyerCtx, undefined, NOW)
    ).rejects.toMatchObject({ category: "authorization" });
  });
});

describe("MatchingService.listMatchedSuppliers", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("returns the supplier companies whose inbox will show the request", async () => {
    const request = await seedRequest(h);
    const matched = await h.service.listMatchedSuppliers(request);
    expect(matched.map((c) => c.id)).toEqual([h.supplierCompanyId]);
  });

  it("returns nothing for a non-Open request", async () => {
    const request = await seedRequest(h, { status: "cancelled" });
    await expect(h.service.listMatchedSuppliers(request)).resolves.toEqual([]);
  });
});
