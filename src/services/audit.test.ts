/**
 * The append-only audit log and its wiring into every audited action
 * (tasks 12.1, 12.2).
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 17.4.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { AuthContext, AuditEntry } from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import { AdminService } from "./admin";
import { AuditService } from "./audit";
import { CommissionService } from "./commission";
import { MatchingService } from "./matching";
import { OfferService } from "./offer";
import { OrderService } from "./order";
import { RequestService } from "./request";

/** 09:00 Phoenix time on a pilot weekday. */
const NOW = new Date("2025-03-03T16:00:00Z");
/** Comfortably past any `today` window derived from `NOW`. */
const AFTER_WINDOW = new Date("2025-03-05T16:00:00Z");

const BUCKEYE = { lat: 33.3703, lng: -112.5838 };

interface Harness {
  repo: InMemoryRepository;
  audit: AuditService;
  requests: RequestService;
  offers: OfferService;
  orders: OrderService;
  commission: CommissionService;
  admin: AuthContext;
  buyer: AuthContext;
  supplier: AuthContext;
  buyerCompanyId: string;
  supplierCompanyId: string;
}

async function makeHarness(): Promise<Harness> {
  const repo = new InMemoryRepository();
  const audit = new AuditService({ repo });
  const adminService = new AdminService({ repo });
  const matching = new MatchingService({ repo });
  const commission = new CommissionService({ repo, audit });
  const offers = new OfferService({ repo, audit });
  const orders = new OrderService({ repo, audit, commission });
  const requests = new RequestService({
    repo,
    admin: adminService,
    matching,
    audit,
  });

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
  const supplierCo = await repo.createCompany({
    name: "Buckeye Diesel",
    kind: "supplier",
    supplierApprovalStatus: "approved",
    supplierStatus: "open",
    operatingLat: BUCKEYE.lat,
    operatingLng: BUCKEYE.lng,
    serviceRadiusMiles: 25,
    createdAt: NOW,
  });

  async function user(
    companyId: string,
    role: AuthContext["role"],
    phone: string
  ) {
    return repo.createUser({
      companyId,
      role,
      phone,
      email: null,
      passwordHash: "hash",
      createdAt: NOW,
    });
  }

  const adminUser = await user(buyerCo.id, "admin", "+16025550100");
  const buyerUser = await user(buyerCo.id, "buyer", "+16025550101");
  const supplierUser = await user(supplierCo.id, "supplier", "+16025550201");

  const admin: AuthContext = {
    userId: adminUser.id,
    companyId: buyerCo.id,
    role: "admin",
  };

  await adminService.setGeofence(
    admin,
    { minLat: 32.9, maxLat: 33.8, minLng: -112.9, maxLng: -111.9 },
    NOW
  );

  return {
    repo,
    audit,
    requests,
    offers,
    orders,
    commission,
    admin,
    buyer: { userId: buyerUser.id, companyId: buyerCo.id, role: "buyer" },
    supplier: {
      userId: supplierUser.id,
      companyId: supplierCo.id,
      role: "supplier",
    },
    buyerCompanyId: buyerCo.id,
    supplierCompanyId: supplierCo.id,
  };
}

async function postRequest(h: Harness, now: Date = NOW) {
  return h.requests.createRequest(
    h.buyer,
    {
      gallons: 500,
      productType: "ulsd",
      deliveryMethod: "wet_hose",
      deliveryWindow: "today",
      lat: BUCKEYE.lat,
      lng: BUCKEYE.lng,
    },
    now
  );
}

async function postOffer(h: Harness, requestId: string, now: Date = NOW) {
  return h.offers.createOffer(
    h.supplier,
    { requestId, landedPricePerGal: 3.85, holdHours: 4 },
    now
  );
}

function entriesOf(entries: AuditEntry[], action: AuditEntry["action"]) {
  return entries.filter((entry) => entry.action === action);
}

describe("AuditService (task 12.1)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("appends an entry and reads it back with its actor, subject, and timestamp", async () => {
    const entry = await h.audit.append(
      {
        action: "OFFER_SUBMITTED",
        actorUserId: h.supplier.userId,
        subjectId: "offer-1",
        payload: { requestId: "request-1" },
      },
      NOW
    );

    expect(entry).toMatchObject({
      actorUserId: h.supplier.userId,
      action: "OFFER_SUBMITTED",
      subjectId: "offer-1",
      payload: { requestId: "request-1" },
      createdAt: NOW,
    });
    await expect(h.audit.list()).resolves.toHaveLength(1);
    await expect(h.audit.count()).resolves.toBe(1);
    await expect(h.audit.listBySubject("offer-1")).resolves.toHaveLength(1);
    await expect(h.audit.listBySubject("offer-2")).resolves.toHaveLength(0);
  });

  it("accepts a null acting user for system-driven actions (Req 14.3)", async () => {
    const entry = await h.audit.append(
      { action: "REQUEST_EXPIRED", subjectId: "request-1" },
      NOW
    );

    expect(entry.actorUserId).toBeNull();
  });

  it("exposes insert and read only — no update or delete path (Req 14.7)", () => {
    for (const forbidden of [
      "update",
      "updateEntry",
      "delete",
      "deleteEntry",
      "remove",
      "clear",
    ]) {
      expect(forbidden in h.audit).toBe(false);
    }
    for (const forbidden of [
      "updateAuditEntry",
      "deleteAuditEntry",
      "removeAuditEntry",
    ]) {
      expect(forbidden in h.repo).toBe(false);
    }
  });

  it("rejects an unknown action and a blank subject with validation errors", async () => {
    await expect(
      h.audit.append(
        { action: "NOT_AN_ACTION" as never, subjectId: "offer-1" },
        NOW
      )
    ).rejects.toMatchObject({ code: "AUDIT_ACTION_INVALID", field: "action" });

    await expect(
      h.audit.append({ action: "OFFER_SUBMITTED", subjectId: "  " }, NOW)
    ).rejects.toMatchObject({
      code: "AUDIT_SUBJECT_REQUIRED",
      field: "subjectId",
    });
  });

  it("preserves earlier entries as new ones are appended (Req 14.7)", async () => {
    const first = await h.audit.append(
      { action: "OFFER_SUBMITTED", actorUserId: "u-1", subjectId: "offer-1" },
      NOW
    );
    const before = await h.audit.list();

    await h.audit.append(
      { action: "REQUEST_EXPIRED", subjectId: "request-1" },
      AFTER_WINDOW
    );
    const after = await h.audit.list();

    expect(after).toHaveLength(before.length + 1);
    expect(after[0]).toEqual(first);
    await expect(h.audit.count()).resolves.toBe(2);
  });
});

describe("audit wiring (task 12.2)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("appends OFFER_SUBMITTED naming the actor, supplier company, and request (Req 14.1)", async () => {
    const request = await postRequest(h);
    const offer = await postOffer(h, request.id);

    const [entry] = entriesOf(await h.audit.list(), "OFFER_SUBMITTED");
    expect(entry).toMatchObject({
      actorUserId: h.supplier.userId,
      subjectId: offer.id,
      createdAt: NOW,
    });
    expect(entry.payload).toMatchObject({
      offerId: offer.id,
      requestId: request.id,
      supplierCompanyId: h.supplierCompanyId,
      buyerCompanyId: h.buyerCompanyId,
    });
  });

  it("appends OFFER_ACCEPTED naming the actor, offer, and order (Req 14.2)", async () => {
    const request = await postRequest(h);
    const offer = await postOffer(h, request.id);
    const order = await h.orders.acceptOffer(h.buyer, offer.id, NOW);

    const [entry] = entriesOf(await h.audit.list(), "OFFER_ACCEPTED");
    expect(entry).toMatchObject({
      actorUserId: h.buyer.userId,
      subjectId: order.id,
      createdAt: NOW,
    });
    expect(entry.payload).toMatchObject({
      orderId: order.id,
      offerId: offer.id,
      requestId: request.id,
      supplierCompanyId: h.supplierCompanyId,
    });
  });

  it("appends REQUEST_CANCELLED with the prior and new status (Req 14.3)", async () => {
    const request = await postRequest(h);
    await h.requests.cancelRequest(h.buyer, request.id, NOW);

    const [entry] = entriesOf(await h.audit.list(), "REQUEST_CANCELLED");
    expect(entry).toMatchObject({
      actorUserId: h.buyer.userId,
      subjectId: request.id,
    });
    expect(entry.payload).toMatchObject({
      requestId: request.id,
      priorStatus: "open",
      newStatus: "cancelled",
    });
  });

  it("appends REQUEST_EXPIRED with no acting user (Req 14.3)", async () => {
    const request = await postRequest(h);
    const expired = await h.requests.expireRequest(request.id, AFTER_WINDOW);
    expect(expired.status).toBe("expired");

    const [entry] = entriesOf(await h.audit.list(), "REQUEST_EXPIRED");
    expect(entry).toMatchObject({
      actorUserId: null,
      subjectId: request.id,
      createdAt: AFTER_WINDOW,
    });
    expect(entry.payload).toMatchObject({
      priorStatus: "open",
      newStatus: "expired",
    });
  });

  it("appends STATUS_CHANGED for an explicit advance and for delivery recording (Req 14.4)", async () => {
    const request = await postRequest(h);
    const offer = await postOffer(h, request.id);
    const order = await h.orders.acceptOffer(h.buyer, offer.id, NOW);

    await h.orders.advanceStatus(h.supplier, order.id, "en_route", NOW);
    await h.orders.recordDelivery(
      h.supplier,
      order.id,
      { bolGallons: 498, ticketNumber: "88213" },
      NOW
    );

    const changes = entriesOf(await h.audit.list(), "STATUS_CHANGED");
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      actorUserId: h.supplier.userId,
      subjectId: order.id,
    });
    expect(changes[0].payload).toMatchObject({
      priorStatus: "accepted",
      newStatus: "en_route",
    });
    expect(changes[1].payload).toMatchObject({
      priorStatus: "en_route",
      newStatus: "delivered",
      bolGallons: 498,
    });
  });

  it("appends nothing when a status change is rejected (Req 14.4)", async () => {
    const request = await postRequest(h);
    const offer = await postOffer(h, request.id);
    const order = await h.orders.acceptOffer(h.buyer, offer.id, NOW);
    await h.orders.advanceStatus(h.supplier, order.id, "en_route", NOW);

    const before = await h.audit.count();
    await expect(
      h.orders.advanceStatus(h.supplier, order.id, "accepted", NOW)
    ).rejects.toMatchObject({ code: "ORDER_STATUS_BACKWARD" });

    await expect(h.audit.count()).resolves.toBe(before);
  });

  it("appends INVOICE_PAID once, with the prior and new payment status (Req 14.6)", async () => {
    const request = await postRequest(h);
    const offer = await postOffer(h, request.id);
    const order = await h.orders.acceptOffer(h.buyer, offer.id, NOW);
    await h.orders.recordDelivery(
      h.supplier,
      order.id,
      { bolGallons: 498, ticketNumber: "88213" },
      NOW
    );

    const invoice = await h.commission.getInvoiceByOrder(order.id);
    await h.commission.markInvoicePaid(h.admin, invoice!.id, AFTER_WINDOW);
    // A second tap is a no-op, so it must not claim the payment twice.
    await h.commission.markInvoicePaid(h.admin, invoice!.id, AFTER_WINDOW);

    const paid = entriesOf(await h.audit.list(), "INVOICE_PAID");
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({
      actorUserId: h.admin.userId,
      subjectId: invoice!.id,
      createdAt: AFTER_WINDOW,
    });
    expect(paid[0].payload).toMatchObject({
      invoiceId: invoice!.id,
      orderId: order.id,
      supplierCompanyId: h.supplierCompanyId,
      priorStatus: "unpaid",
      newStatus: "paid",
    });
  });

  it("records the whole life of one load in order, subject by subject", async () => {
    const request = await postRequest(h);
    const offer = await postOffer(h, request.id);
    const order = await h.orders.acceptOffer(h.buyer, offer.id, NOW);
    await h.orders.recordDelivery(
      h.supplier,
      order.id,
      { bolGallons: 500, ticketNumber: "88214" },
      NOW
    );
    const invoice = await h.commission.getInvoiceByOrder(order.id);
    await h.commission.markInvoicePaid(h.admin, invoice!.id, AFTER_WINDOW);

    const actions = (await h.audit.list()).map((entry) => entry.action);
    expect(actions).toEqual([
      "OFFER_SUBMITTED",
      "OFFER_ACCEPTED",
      "STATUS_CHANGED",
      "INVOICE_PAID",
    ]);
    await expect(h.audit.listBySubject(order.id)).resolves.toHaveLength(2);
  });
});
