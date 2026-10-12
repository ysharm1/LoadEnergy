/**
 * NEW_RFQ wiring (task 5.4, Requirement 13.1): creating a Request notifies the
 * supplier users of every matched Supplier Company, and a broken transport
 * never fails the post.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/repository/in-memory";
import type { AuthContext, Geofence } from "@/domain/types";
import { AdminService } from "./admin";
import { CompanyUserService } from "./company-user";
import { MatchingService } from "./matching";
import {
  NotificationDispatcher,
  type EmailSender,
  type SmsSender,
} from "./notifications";
import { BcryptPasswordHasher } from "./password";
import { RequestService, type CreateRequestInput } from "./request";

const NOW = new Date("2025-03-01T09:00:00Z");

const SW_VALLEY: Geofence = {
  minLat: 33.2,
  maxLat: 33.6,
  minLng: -112.7,
  maxLng: -112.1,
};

const BUCKEYE = { lat: 33.3703, lng: -112.5838 };
const GOODYEAR = { lat: 33.4353, lng: -112.3576 };

const VALID_INPUT: CreateRequestInput = {
  gallons: 500,
  productType: "ulsd",
  deliveryMethod: "wet_hose",
  deliveryWindow: "today",
  ...GOODYEAR,
};

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
  requests: RequestService;
  sms: RecordingSmsSender;
  email: RecordingEmailSender;
  buyer: AuthContext;
  matchedCompanyId: string;
  closedCompanyId: string;
}

async function makeHarness(sms: SmsSender = new RecordingSmsSender()): Promise<Harness> {
  const repo = new InMemoryRepository();
  const companies = new CompanyUserService({
    repo,
    hasher: new BcryptPasswordHasher(4),
  });
  const admin = new AdminService({ repo });
  const matching = new MatchingService({ repo });
  const email = new RecordingEmailSender();
  const notifier = new NotificationDispatcher({ sms, email, clock: () => NOW });
  const requests = new RequestService({ repo, admin, matching, notifier });

  const operatorCo = await companies.createCompany(
    { name: "Load Energy", kind: "buyer" },
    NOW
  );
  const buyerCo = await companies.createCompany(
    { name: "SW Valley Concrete", kind: "buyer" },
    NOW
  );
  const matchedCo = await companies.createCompany(
    { name: "Buckeye Diesel", kind: "supplier" },
    NOW
  );
  const closedCo = await companies.createCompany(
    { name: "Tolleson Fuel", kind: "supplier" },
    NOW
  );

  const adminUser = await companies.createUser(
    {
      companyId: operatorCo.id,
      role: "admin",
      phone: "+16025550150",
      password: "admin-pw",
    },
    NOW
  );
  const buyerUser = await companies.createUser(
    {
      companyId: buyerCo.id,
      role: "buyer",
      phone: "+16025550151",
      password: "buyer-pw",
    },
    NOW
  );
  // Matched company: one dispatcher with email, one without, plus a non-supplier
  // seat that must not be paged.
  await companies.createUser(
    {
      companyId: matchedCo.id,
      role: "supplier",
      phone: "+16025550152",
      email: "dispatch@buckeye.example",
      password: "sup-pw",
    },
    NOW
  );
  await companies.createUser(
    {
      companyId: matchedCo.id,
      role: "supplier",
      phone: "+16025550153",
      password: "sup2-pw",
    },
    NOW
  );
  await companies.createUser(
    {
      companyId: matchedCo.id,
      role: "admin",
      phone: "+16025550154",
      password: "owner-pw",
    },
    NOW
  );
  // Closed company, otherwise identically configured.
  await companies.createUser(
    {
      companyId: closedCo.id,
      role: "supplier",
      phone: "+16025550155",
      password: "closed-pw",
    },
    NOW
  );

  const adminCtx: AuthContext = {
    userId: adminUser.id,
    companyId: operatorCo.id,
    role: "admin",
  };
  await admin.setGeofence(adminCtx, SW_VALLEY, NOW);
  await admin.approveSupplier(adminCtx, matchedCo.id);
  await admin.setOperatingLocation(adminCtx, matchedCo.id, BUCKEYE);
  await admin.setServiceRadius(adminCtx, matchedCo.id, 25);
  await admin.approveSupplier(adminCtx, closedCo.id);
  await admin.setOperatingLocation(adminCtx, closedCo.id, BUCKEYE);
  await admin.setServiceRadius(adminCtx, closedCo.id, 25);
  await repo.updateCompany(matchedCo.id, { supplierStatus: "open" });
  // closedCo stays `closed` from creation.

  return {
    repo,
    requests,
    sms: sms as RecordingSmsSender,
    email,
    buyer: { userId: buyerUser.id, companyId: buyerCo.id, role: "buyer" },
    matchedCompanyId: matchedCo.id,
    closedCompanyId: closedCo.id,
  };
}

describe("Request creation fires NEW_RFQ to matched suppliers", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("texts every supplier user of the matched company and no one else", async () => {
    await h.requests.createRequest(h.buyer, VALID_INPUT, NOW);

    expect(h.sms.calls.map((c) => c.to).sort()).toEqual([
      "+16025550152",
      "+16025550153",
    ]);
  });

  it("emails only the dispatcher with an address on file", async () => {
    await h.requests.createRequest(h.buyer, VALID_INPUT, NOW);
    expect(h.email.calls.map((c) => c.to)).toEqual(["dispatch@buckeye.example"]);
  });

  it("sends a body summarizing the load", async () => {
    await h.requests.createRequest(h.buyer, VALID_INPUT, NOW);
    expect(h.sms.calls[0].body).toContain("500 gal ULSD");
    expect(h.sms.calls[0].body).toContain("wet hose");
  });

  it("notifies nobody when no supplier matches", async () => {
    // Shrink the matched company's radius so the Goodyear pin falls outside it.
    await h.repo.updateCompany(h.matchedCompanyId, { serviceRadiusMiles: 1 });
    await h.requests.createRequest(h.buyer, VALID_INPUT, NOW);
    expect(h.sms.calls).toHaveLength(0);
    expect(h.email.calls).toHaveLength(0);
  });

  it("still creates the Request when the SMS transport is down", async () => {
    const broken = await makeHarness(new BrokenSmsSender());
    const request = await broken.requests.createRequest(broken.buyer, VALID_INPUT, NOW);

    expect(request.status).toBe("open");
    await expect(broken.repo.getRequest(request.id)).resolves.toMatchObject({
      id: request.id,
      status: "open",
    });
  });
});
