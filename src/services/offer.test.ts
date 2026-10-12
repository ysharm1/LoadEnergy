/**
 * Offer creation, validation, gating, activeness, the Buyer's offer list, and
 * the NEW_OFFER notification (tasks 7.1, 7.2, 7.4).
 *
 * Requirements: 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.4, 13.2.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/domain/errors";
import type { AuthContext, Offer, Request, RequestStatus } from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import {
  NotificationDispatcher,
  type EmailSender,
  type SmsSender,
} from "./notifications";
import {
  OfferService,
  computeExpiry,
  isActive,
  type CreateOfferInput,
} from "./offer";

const NOW = new Date("2025-03-01T09:00:00Z");
const HOUR = 3_600_000;

const BUCKEYE = { lat: 33.3703, lng: -112.5838 };
const GOODYEAR = { lat: 33.4353, lng: -112.3576 };
const FLAGSTAFF = { lat: 35.1983, lng: -111.6513 };

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

class BrokenSmsSender implements SmsSender {
  async send(): Promise<void> {
    throw new Error("twilio is down");
  }
}

interface Harness {
  repo: InMemoryRepository;
  offers: OfferService;
  sms: RecordingSmsSender;
  email: RecordingEmailSender;
  buyer: AuthContext;
  supplier: AuthContext;
  pendingSupplier: AuthContext;
  closedSupplier: AuthContext;
  farSupplier: AuthContext;
  request: Request;
  makeRequest(status?: RequestStatus): Promise<Request>;
}

async function makeHarness(sms: SmsSender = new RecordingSmsSender()): Promise<Harness> {
  const repo = new InMemoryRepository();
  const email = new RecordingEmailSender();
  const notifier = new NotificationDispatcher({ sms, email, clock: () => NOW });
  const offers = new OfferService({ repo, notifier });

  const buyerCo = await repo.createCompany({
    name: "SW Valley Concrete",
    kind: "buyer",
    supplierApprovalStatus: null,
    supplierStatus: null,
    operatingLat: null,
    operatingLng: null,
    serviceRadiusMiles: null,
    createdAt: NOW,
  });

  async function supplierCompany(
    name: string,
    approval: "approved" | "pending",
    status: "open" | "limited" | "closed",
    origin = BUCKEYE,
    radius = 25
  ) {
    return repo.createCompany({
      name,
      kind: "supplier",
      supplierApprovalStatus: approval,
      supplierStatus: status,
      operatingLat: origin.lat,
      operatingLng: origin.lng,
      serviceRadiusMiles: radius,
      createdAt: NOW,
    });
  }

  const supplierCo = await supplierCompany("Buckeye Diesel", "approved", "open");
  const pendingCo = await supplierCompany("Tolleson Fuel", "pending", "open");
  const closedCo = await supplierCompany("Avondale Oil", "approved", "closed");
  const farCo = await supplierCompany(
    "Flagstaff Fuel",
    "approved",
    "open",
    FLAGSTAFF,
    25
  );

  async function user(
    companyId: string,
    role: "buyer" | "supplier" | "admin",
    phone: string,
    emailAddress: string | null = null
  ) {
    return repo.createUser({
      companyId,
      role,
      phone,
      email: emailAddress,
      passwordHash: "hash",
      createdAt: NOW,
    });
  }

  const buyerUser = await user(
    buyerCo.id,
    "buyer",
    "+16025550101",
    "super@swvalley.example"
  );
  // A second superintendent without an email, and an office seat that is not a
  // buyer: both are here to pin down who gets paged.
  await user(buyerCo.id, "buyer", "+16025550102");
  await user(buyerCo.id, "admin", "+16025550103", "office@swvalley.example");

  const supplierUser = await user(supplierCo.id, "supplier", "+16025550201");
  const pendingUser = await user(pendingCo.id, "supplier", "+16025550202");
  const closedUser = await user(closedCo.id, "supplier", "+16025550203");
  const farUser = await user(farCo.id, "supplier", "+16025550204");

  async function makeRequest(status: RequestStatus = "open"): Promise<Request> {
    return repo.createRequest({
      buyerCompanyId: buyerCo.id,
      createdByUserId: buyerUser.id,
      gallons: 500,
      productType: "ulsd",
      deliveryMethod: "wet_hose",
      deliveryWindow: "today",
      pinLat: GOODYEAR.lat,
      pinLng: GOODYEAR.lng,
      notes: null,
      status,
      windowEndsAt: new Date(NOW.getTime() + 8 * HOUR),
      createdAt: NOW,
    });
  }

  return {
    repo,
    offers,
    sms: sms as RecordingSmsSender,
    email,
    buyer: { userId: buyerUser.id, companyId: buyerCo.id, role: "buyer" },
    supplier: {
      userId: supplierUser.id,
      companyId: supplierCo.id,
      role: "supplier",
    },
    pendingSupplier: {
      userId: pendingUser.id,
      companyId: pendingCo.id,
      role: "supplier",
    },
    closedSupplier: {
      userId: closedUser.id,
      companyId: closedCo.id,
      role: "supplier",
    },
    farSupplier: { userId: farUser.id, companyId: farCo.id, role: "supplier" },
    request: await makeRequest(),
    makeRequest,
  };
}

function quote(requestId: string, over: Partial<CreateOfferInput> = {}): CreateOfferInput {
  return { requestId, landedPricePerGal: 3.45, holdHours: 2, ...over };
}

// ---------------------------------------------------------------------------
// Task 7.1 — creation, validation, gating
// ---------------------------------------------------------------------------

describe("OfferService.createOffer", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("stores the quote linked to the request and the supplier company", async () => {
    const offer = await h.offers.createOffer(
      h.supplier,
      quote(h.request.id, { etaMinutes: 90 }),
      NOW
    );

    expect(offer).toMatchObject({
      requestId: h.request.id,
      supplierCompanyId: h.supplier.companyId,
      createdByUserId: h.supplier.userId,
      landedPricePerGal: 3.45,
      holdHours: 2,
      etaMinutes: 90,
      status: "active",
      voided: false,
    });
    await expect(h.repo.getOffer(offer.id)).resolves.toMatchObject({
      id: offer.id,
      landedPricePerGal: 3.45,
    });
  });

  it("sets Offer_Expiry to the creation time plus the hold (Req 6.2)", async () => {
    const offer = await h.offers.createOffer(
      h.supplier,
      quote(h.request.id, { holdHours: 6 }),
      NOW
    );

    expect(offer.createdAt.getTime()).toBe(NOW.getTime());
    expect(offer.expiresAt.getTime()).toBe(NOW.getTime() + 6 * HOUR);
    expect(offer.expiresAt).toEqual(computeExpiry(NOW, 6));
  });

  it("stores no ETA when none is quoted (Req 6.3)", async () => {
    const offer = await h.offers.createOffer(h.supplier, quote(h.request.id), NOW);
    expect(offer.etaMinutes).toBeNull();
  });

  it("rounds the price to the stored Decimal(10,4) scale", async () => {
    const offer = await h.offers.createOffer(
      h.supplier,
      quote(h.request.id, { landedPricePerGal: 3.456789 }),
      NOW
    );
    expect(offer.landedPricePerGal).toBe(3.4568);
  });

  it.each([0, -0.01, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a landed price of %p (Req 6.4)",
    async (price) => {
      await expect(
        h.offers.createOffer(
          h.supplier,
          quote(h.request.id, { landedPricePerGal: price as number }),
          NOW
        )
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "LANDED_PRICE_INVALID",
        field: "landedPricePerGal",
      });
    }
  );

  it.each([1, 2, 8])("accepts a %p hour hold (Req 6.5, inclusive)", async (holdHours) => {
    const request = await h.makeRequest();
    const offer = await h.offers.createOffer(
      h.supplier,
      quote(request.id, { holdHours }),
      NOW
    );
    expect(offer.holdHours).toBe(holdHours);
    expect(offer.expiresAt.getTime()).toBe(NOW.getTime() + holdHours * HOUR);
  });

  it.each([0, 9, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a hold of %p hours (Req 6.5)",
    async (holdHours) => {
      await expect(
        h.offers.createOffer(
          h.supplier,
          quote(h.request.id, { holdHours: holdHours as number }),
          NOW
        )
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "HOLD_HOURS_INVALID",
        field: "holdHours",
      });
    }
  );

  it.each([0, -30, 12.5])("rejects an ETA of %p minutes", async (etaMinutes) => {
    await expect(
      h.offers.createOffer(
        h.supplier,
        quote(h.request.id, { etaMinutes }),
        NOW
      )
    ).rejects.toMatchObject({ name: "ValidationError", code: "ETA_INVALID" });
  });

  it("rejects a Pending supplier company (Req 5.5)", async () => {
    await expect(
      h.offers.createOffer(h.pendingSupplier, quote(h.request.id), NOW)
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "SUPPLIER_PENDING",
    });
  });

  it("rejects a Closed supplier company (Req 5.4)", async () => {
    await expect(
      h.offers.createOffer(h.closedSupplier, quote(h.request.id), NOW)
    ).rejects.toMatchObject({ name: "ConflictError", code: "SUPPLIER_CLOSED" });
  });

  it("rejects a supplier whose radius does not cover the pin (Req 6.1)", async () => {
    await expect(
      h.offers.createOffer(h.farSupplier, quote(h.request.id), NOW)
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "SUPPLIER_NOT_ELIGIBLE",
    });
  });

  it.each<RequestStatus>(["accepted", "cancelled", "expired"])(
    "rejects a quote on a %s request (Req 6.1)",
    async (status) => {
      const request = await h.makeRequest(status);
      await expect(
        h.offers.createOffer(h.supplier, quote(request.id), NOW)
      ).rejects.toMatchObject({
        name: "ConflictError",
        code: "REQUEST_NOT_OPEN",
      });
    }
  );

  it("rejects an unknown request id", async () => {
    await expect(
      h.offers.createOffer(h.supplier, quote("no-such-request"), NOW)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("denies a Buyer attempting to quote", async () => {
    await expect(
      h.offers.createOffer(h.buyer, quote(h.request.id), NOW)
    ).rejects.toMatchObject({ name: "AuthorizationError" });
  });
});

// ---------------------------------------------------------------------------
// Task 7.2 — activeness and the buyer-facing list
// ---------------------------------------------------------------------------

describe("isActive", () => {
  const base: Pick<Offer, "expiresAt" | "status" | "voided"> = {
    expiresAt: new Date(NOW.getTime() + HOUR),
    status: "active",
    voided: false,
  };

  it("is active strictly before the expiry (Req 7.1)", () => {
    expect(isActive(base, NOW)).toBe(true);
    expect(isActive(base, new Date(base.expiresAt.getTime() - 1))).toBe(true);
  });

  it("is expired at the expiry instant and after (Req 7.2)", () => {
    expect(isActive(base, base.expiresAt)).toBe(false);
    expect(isActive(base, new Date(base.expiresAt.getTime() + 1))).toBe(false);
  });

  it("is not active once voided or no longer `active`", () => {
    expect(isActive({ ...base, voided: true }, NOW)).toBe(false);
    expect(isActive({ ...base, status: "voided" }, NOW)).toBe(false);
    expect(isActive({ ...base, status: "accepted" }, NOW)).toBe(false);
    expect(isActive({ ...base, status: "expired" }, NOW)).toBe(false);
  });
});

describe("OfferService.listOffersForRequest", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("projects supplier name, price, ETA, expiry, and the indicator (Reqs 6.6, 7.4)", async () => {
    await h.offers.createOffer(
      h.supplier,
      quote(h.request.id, { landedPricePerGal: 3.21, holdHours: 4, etaMinutes: 45 }),
      NOW
    );

    const [view] = await h.offers.listOffersForRequest(h.buyer, h.request.id, NOW);

    expect(view).toMatchObject({
      supplierName: "Buckeye Diesel",
      landedPricePerGal: 3.21,
      etaMinutes: 45,
      holdHours: 4,
      activeness: "active",
      isActive: true,
    });
    expect(view.expiresAt.getTime()).toBe(NOW.getTime() + 4 * HOUR);
  });

  it("marks a lapsed hold expired without dropping it from the list (Req 7.4)", async () => {
    await h.offers.createOffer(h.supplier, quote(h.request.id, { holdHours: 1 }), NOW);

    const later = new Date(NOW.getTime() + HOUR);
    const views = await h.offers.listOffersForRequest(h.buyer, h.request.id, later);

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ activeness: "expired", isActive: false });
  });

  it("returns an empty list for a request with no quotes", async () => {
    await expect(
      h.offers.listOffersForRequest(h.buyer, h.request.id, NOW)
    ).resolves.toEqual([]);
  });

  it("denies a buyer from another company and an unknown request alike", async () => {
    const other: AuthContext = {
      userId: "u-other",
      companyId: "co-other",
      role: "buyer",
    };
    await expect(
      h.offers.listOffersForRequest(other, h.request.id, NOW)
    ).rejects.toMatchObject({ name: "AuthorizationError" });
    await expect(
      h.offers.listOffersForRequest(h.buyer, "no-such-request", NOW)
    ).rejects.toMatchObject({ name: "AuthorizationError" });
  });

  it("denies a supplier reading the buyer's quote comparison", async () => {
    await expect(
      h.offers.listOffersForRequest(h.supplier, h.request.id, NOW)
    ).rejects.toMatchObject({ name: "AuthorizationError" });
  });
});

// ---------------------------------------------------------------------------
// Task 7.4 — NEW_OFFER notification (Requirement 13.2)
// ---------------------------------------------------------------------------

describe("Offer submission fires NEW_OFFER to the owning buyer", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("texts every buyer-role user of the owning company and no one else", async () => {
    await h.offers.createOffer(h.supplier, quote(h.request.id), NOW);

    expect(h.sms.calls.map((c) => c.to).sort()).toEqual([
      "+16025550101",
      "+16025550102",
    ]);
  });

  it("emails only the buyer with an address on file", async () => {
    await h.offers.createOffer(h.supplier, quote(h.request.id), NOW);
    expect(h.email.calls.map((c) => c.to)).toEqual(["super@swvalley.example"]);
  });

  it("summarizes the quote in the body", async () => {
    await h.offers.createOffer(
      h.supplier,
      quote(h.request.id, { landedPricePerGal: 3.45, holdHours: 3, etaMinutes: 60 }),
      NOW
    );

    const body = h.sms.calls[0].body;
    expect(body).toContain("$3.45/gal");
    expect(body).toContain("ETA 60 min");
    expect(body).toContain("3h hold");
  });

  it("notifies nobody on a rejected quote", async () => {
    await expect(
      h.offers.createOffer(h.closedSupplier, quote(h.request.id), NOW)
    ).rejects.toBeInstanceOf(ConflictError);
    expect(h.sms.calls).toHaveLength(0);
  });

  it("still records the offer when the SMS transport is down", async () => {
    const broken = await makeHarness(new BrokenSmsSender());
    const offer = await broken.offers.createOffer(
      broken.supplier,
      quote(broken.request.id),
      NOW
    );

    expect(offer.status).toBe("active");
    await expect(broken.repo.getOffer(offer.id)).resolves.toMatchObject({
      id: offer.id,
      status: "active",
    });
  });
});
