/**
 * Offer acceptance, order creation, the won-order list, and the ACCEPTED
 * notification (tasks 7.3, 7.4).
 *
 * Requirements: 7.3, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 13.3.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { AuthContext, Request, RequestStatus } from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import {
  NotificationDispatcher,
  type EmailSender,
  type SmsSender,
} from "./notifications";
import { OfferService } from "./offer";
import { OrderService } from "./order";

const NOW = new Date("2025-03-01T09:00:00Z");
const HOUR = 3_600_000;

const BUCKEYE = { lat: 33.3703, lng: -112.5838 };
const GOODYEAR = { lat: 33.4353, lng: -112.3576 };

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
  orders: OrderService;
  sms: RecordingSmsSender;
  buyer: AuthContext;
  supplierA: AuthContext;
  supplierB: AuthContext;
  request: Request;
  makeRequest(status?: RequestStatus): Promise<Request>;
}

async function makeHarness(sms: SmsSender = new RecordingSmsSender()): Promise<Harness> {
  const repo = new InMemoryRepository();
  const notifier = new NotificationDispatcher({
    sms,
    email: new RecordingEmailSender(),
    clock: () => NOW,
  });
  const offers = new OfferService({ repo, notifier });
  const orders = new OrderService({ repo, notifier });

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

  async function supplierCompany(name: string) {
    return repo.createCompany({
      name,
      kind: "supplier",
      supplierApprovalStatus: "approved",
      supplierStatus: "open",
      operatingLat: BUCKEYE.lat,
      operatingLng: BUCKEYE.lng,
      serviceRadiusMiles: 25,
      createdAt: NOW,
    });
  }

  const supplierCoA = await supplierCompany("Buckeye Diesel");
  const supplierCoB = await supplierCompany("Tolleson Fuel");

  async function user(
    companyId: string,
    role: "buyer" | "supplier" | "admin",
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

  const buyerUser = await user(buyerCo.id, "buyer", "+16025550101");
  const supplierUserA = await user(supplierCoA.id, "supplier", "+16025550201");
  // A second dispatcher on the winner, plus an office seat that must not be paged.
  await user(supplierCoA.id, "supplier", "+16025550202");
  await user(supplierCoA.id, "admin", "+16025550203");
  const supplierUserB = await user(supplierCoB.id, "supplier", "+16025550301");

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
    orders,
    sms: sms as RecordingSmsSender,
    buyer: { userId: buyerUser.id, companyId: buyerCo.id, role: "buyer" },
    supplierA: {
      userId: supplierUserA.id,
      companyId: supplierCoA.id,
      role: "supplier",
    },
    supplierB: {
      userId: supplierUserB.id,
      companyId: supplierCoB.id,
      role: "supplier",
    },
    request: await makeRequest(),
    makeRequest,
  };
}

describe("OrderService.acceptOffer", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("creates an Accepted order linking request, offer, and winner (Req 8.1)", async () => {
    const offer = await h.offers.createOffer(
      h.supplierA,
      { requestId: h.request.id, landedPricePerGal: 3.4, holdHours: 4 },
      NOW
    );

    const order = await h.orders.acceptOffer(h.buyer, offer.id, NOW);

    expect(order).toMatchObject({
      requestId: h.request.id,
      offerId: offer.id,
      buyerCompanyId: h.buyer.companyId,
      supplierCompanyId: h.supplierA.companyId,
      status: "accepted",
      isConcierge: false,
    });
  });

  it("sets the request to Accepted and voids every other active offer (Reqs 8.2, 8.3)", async () => {
    const winner = await h.offers.createOffer(
      h.supplierA,
      { requestId: h.request.id, landedPricePerGal: 3.4, holdHours: 4 },
      NOW
    );
    const loser = await h.offers.createOffer(
      h.supplierB,
      { requestId: h.request.id, landedPricePerGal: 3.6, holdHours: 4 },
      NOW
    );

    await h.orders.acceptOffer(h.buyer, winner.id, NOW);

    await expect(h.repo.getRequest(h.request.id)).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(h.repo.getOffer(winner.id)).resolves.toMatchObject({
      status: "accepted",
      voided: false,
    });
    await expect(h.repo.getOffer(loser.id)).resolves.toMatchObject({
      status: "voided",
      voided: true,
    });
  });

  it("exposes the order to the winning supplier as a won order (Reqs 8.7, 8.5)", async () => {
    const offer = await h.offers.createOffer(
      h.supplierA,
      { requestId: h.request.id, landedPricePerGal: 3.4, holdHours: 4 },
      NOW
    );
    const order = await h.orders.acceptOffer(h.buyer, offer.id, NOW);

    await expect(h.orders.listWonOrders(h.supplierA)).resolves.toEqual([order]);
    // The losing supplier's book is untouched.
    await expect(h.orders.listWonOrders(h.supplierB)).resolves.toEqual([]);
  });

  it("rejects an expired hold with an expiry error (Req 7.3)", async () => {
    const offer = await h.offers.createOffer(
      h.supplierA,
      { requestId: h.request.id, landedPricePerGal: 3.4, holdHours: 1 },
      NOW
    );

    // Exactly at the expiry instant: the hold is over (Req 7.2).
    await expect(
      h.orders.acceptOffer(h.buyer, offer.id, new Date(NOW.getTime() + HOUR))
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "OFFER_EXPIRED",
    });
    await expect(h.repo.getRequest(h.request.id)).resolves.toMatchObject({
      status: "open",
    });
  });

  it.each<RequestStatus>(["accepted", "cancelled", "expired"])(
    "rejects acceptance when the request is %s (Req 8.4)",
    async (status) => {
      const request = await h.makeRequest();
      const offer = await h.offers.createOffer(
        h.supplierA,
        { requestId: request.id, landedPricePerGal: 3.4, holdHours: 4 },
        NOW
      );
      await h.repo.updateRequest(request.id, { status });

      await expect(
        h.orders.acceptOffer(h.buyer, offer.id, NOW)
      ).rejects.toMatchObject({
        name: "ConflictError",
        code: "REQUEST_NOT_OPEN",
      });
    }
  );

  it("rejects a second accept on the same request (Req 8.3)", async () => {
    const first = await h.offers.createOffer(
      h.supplierA,
      { requestId: h.request.id, landedPricePerGal: 3.4, holdHours: 4 },
      NOW
    );
    const second = await h.offers.createOffer(
      h.supplierB,
      { requestId: h.request.id, landedPricePerGal: 3.6, holdHours: 4 },
      NOW
    );

    await h.orders.acceptOffer(h.buyer, first.id, NOW);

    // The losing quote and a repeat of the winning one both bounce.
    await expect(
      h.orders.acceptOffer(h.buyer, second.id, NOW)
    ).rejects.toMatchObject({ code: "REQUEST_NOT_OPEN" });
    await expect(
      h.orders.acceptOffer(h.buyer, first.id, NOW)
    ).rejects.toMatchObject({ code: "REQUEST_NOT_OPEN" });

    const orders = await h.repo.listOrdersByBuyerCompany(h.buyer.companyId);
    expect(orders).toHaveLength(1);
  });

  it("rejects an offer owned by a Closed supplier company (Req 8.6)", async () => {
    const offer = await h.offers.createOffer(
      h.supplierA,
      { requestId: h.request.id, landedPricePerGal: 3.4, holdHours: 4 },
      NOW
    );
    // The dispatcher closes up after quoting.
    await h.repo.updateCompany(h.supplierA.companyId, {
      supplierStatus: "closed",
    });

    await expect(
      h.orders.acceptOffer(h.buyer, offer.id, NOW)
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "SUPPLIER_CLOSED",
    });
    await expect(h.repo.getRequest(h.request.id)).resolves.toMatchObject({
      status: "open",
    });
  });

  it("denies a buyer from another company, a supplier, and an unknown offer alike (Req 8.5)", async () => {
    const offer = await h.offers.createOffer(
      h.supplierA,
      { requestId: h.request.id, landedPricePerGal: 3.4, holdHours: 4 },
      NOW
    );
    const other: AuthContext = {
      userId: "u-other",
      companyId: "co-other",
      role: "buyer",
    };

    await expect(
      h.orders.acceptOffer(other, offer.id, NOW)
    ).rejects.toMatchObject({ name: "AuthorizationError" });
    await expect(
      h.orders.acceptOffer(h.supplierA, offer.id, NOW)
    ).rejects.toMatchObject({ name: "AuthorizationError" });
    await expect(
      h.orders.acceptOffer(h.buyer, "no-such-offer", NOW)
    ).rejects.toMatchObject({ name: "AuthorizationError" });

    await expect(h.repo.getRequest(h.request.id)).resolves.toMatchObject({
      status: "open",
    });
  });

  it("rolls the claim back when the order write is refused", async () => {
    const offer = await h.offers.createOffer(
      h.supplierA,
      { requestId: h.request.id, landedPricePerGal: 3.4, holdHours: 4 },
      NOW
    );
    // The unique Order.requestId backstop: something already owns this load.
    await h.repo.createOrder({
      requestId: h.request.id,
      offerId: null,
      buyerCompanyId: h.buyer.companyId,
      supplierCompanyId: h.supplierB.companyId,
      status: "accepted",
      isConcierge: false,
      createdAt: NOW,
    });

    await expect(
      h.orders.acceptOffer(h.buyer, offer.id, NOW)
    ).rejects.toMatchObject({ code: "ORDER_REQUEST_TAKEN" });

    // Compensated: the load is quotable again and the quote is still live.
    await expect(h.repo.getRequest(h.request.id)).resolves.toMatchObject({
      status: "open",
    });
    await expect(h.repo.getOffer(offer.id)).resolves.toMatchObject({
      status: "active",
      voided: false,
    });
  });
});

describe("OrderService.listWonOrders", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("denies a supplier asking for another company's book", async () => {
    await expect(
      h.orders.listWonOrders(h.supplierA, h.supplierB.companyId)
    ).rejects.toMatchObject({ name: "AuthorizationError" });
  });

  it("denies a buyer", async () => {
    await expect(h.orders.listWonOrders(h.buyer)).rejects.toMatchObject({
      name: "AuthorizationError",
    });
  });
});

describe("Acceptance fires ACCEPTED to the winning supplier", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("texts the winner's dispatchers only (Req 13.3)", async () => {
    const winner = await h.offers.createOffer(
      h.supplierA,
      { requestId: h.request.id, landedPricePerGal: 3.4, holdHours: 4 },
      NOW
    );
    await h.offers.createOffer(
      h.supplierB,
      { requestId: h.request.id, landedPricePerGal: 3.6, holdHours: 4 },
      NOW
    );
    h.sms.calls.length = 0; // Drop the NEW_OFFER traffic.

    await h.orders.acceptOffer(h.buyer, winner.id, NOW);

    expect(h.sms.calls.map((c) => c.to).sort()).toEqual([
      "+16025550201",
      "+16025550202",
    ]);
    expect(h.sms.calls[0].body).toContain("accepted");
    expect(h.sms.calls[0].body).toContain("500 gal ULSD");
    expect(h.sms.calls[0].body).toContain("$3.40/gal");
  });

  it("notifies nobody on a rejected acceptance", async () => {
    const offer = await h.offers.createOffer(
      h.supplierA,
      { requestId: h.request.id, landedPricePerGal: 3.4, holdHours: 1 },
      NOW
    );
    h.sms.calls.length = 0;

    await expect(
      h.orders.acceptOffer(h.buyer, offer.id, new Date(NOW.getTime() + HOUR))
    ).rejects.toMatchObject({ code: "OFFER_EXPIRED" });
    expect(h.sms.calls).toHaveLength(0);
  });

  it("still creates the order when the SMS transport is down", async () => {
    const broken = await makeHarness(new BrokenSmsSender());
    const offer = await broken.offers.createOffer(
      broken.supplierA,
      { requestId: broken.request.id, landedPricePerGal: 3.4, holdHours: 4 },
      NOW
    );

    const order = await broken.orders.acceptOffer(broken.buyer, offer.id, NOW);

    expect(order.status).toBe("accepted");
    await expect(broken.repo.getOrder(order.id)).resolves.toMatchObject({
      id: order.id,
      status: "accepted",
    });
  });
});

// ---------------------------------------------------------------------------
// Order lifecycle, delivery, and the DELIVERED notification (tasks 9.1-9.3)
//
// Requirements: 10.1, 10.2, 10.4, 10.5, 11.1, 11.3, 11.4, 11.5, 11.6, 11.7,
// 13.4. The buyer order-status read (Req 10.6) is covered by task 9.8.
// ---------------------------------------------------------------------------

/** An Accepted order on a fresh load, won by supplier A. */
async function wonOrder(h: Harness) {
  const request = await h.makeRequest();
  const offer = await h.offers.createOffer(
    h.supplierA,
    { requestId: request.id, landedPricePerGal: 3.4, holdHours: 4 },
    NOW
  );
  const order = await h.orders.acceptOffer(h.buyer, offer.id, NOW);
  // Drop the NEW_OFFER / ACCEPTED traffic (the broken-transport harness records
  // nothing, so there may be no call list at all).
  if (Array.isArray(h.sms.calls)) h.sms.calls.length = 0;
  return order;
}

describe("OrderService.advanceStatus", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("marks a won order En_Route (Reqs 10.2, 10.4)", async () => {
    const order = await wonOrder(h);

    const updated = await h.orders.advanceStatus(
      h.supplierA,
      order.id,
      "en_route"
    );

    expect(updated.status).toBe("en_route");
    await expect(h.repo.getOrder(order.id)).resolves.toMatchObject({
      status: "en_route",
    });
  });

  it("rejects a backward move (Req 10.5)", async () => {
    const order = await wonOrder(h);
    await h.orders.advanceStatus(h.supplierA, order.id, "en_route");

    await expect(
      h.orders.advanceStatus(h.supplierA, order.id, "accepted")
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "ORDER_STATUS_BACKWARD",
    });
    // The persisted status is still the last valid forward transition.
    await expect(h.repo.getOrder(order.id)).resolves.toMatchObject({
      status: "en_route",
    });
  });

  it("rejects moving back from Delivered (Req 10.5)", async () => {
    const order = await wonOrder(h);
    await h.orders.recordDelivery(
      h.supplierA,
      order.id,
      { bolGallons: 498, ticketNumber: "88213" },
      NOW
    );

    for (const status of ["accepted", "en_route"] as const) {
      await expect(
        h.orders.advanceStatus(h.supplierA, order.id, status)
      ).rejects.toMatchObject({ code: "ORDER_STATUS_BACKWARD" });
    }
    await expect(h.repo.getOrder(order.id)).resolves.toMatchObject({
      status: "delivered",
    });
  });

  it("rejects repeating the status the order already holds", async () => {
    const order = await wonOrder(h);

    await expect(
      h.orders.advanceStatus(h.supplierA, order.id, "accepted")
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "ORDER_STATUS_UNCHANGED",
    });
  });

  it("rejects a status outside Accepted / En_Route / Delivered (Req 10.1)", async () => {
    const order = await wonOrder(h);

    await expect(
      h.orders.advanceStatus(
        h.supplierA,
        order.id,
        "shipped" as unknown as "en_route"
      )
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "ORDER_STATUS_INVALID",
      field: "status",
    });
  });

  it("refuses Delivered until a BOL is on file", async () => {
    const order = await wonOrder(h);

    await expect(
      h.orders.advanceStatus(h.supplierA, order.id, "delivered")
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "DELIVERY_REQUIRED",
    });
    await expect(h.repo.getOrder(order.id)).resolves.toMatchObject({
      status: "accepted",
    });
  });

  it("denies another supplier company, the buyer, and an unknown order alike", async () => {
    const order = await wonOrder(h);

    for (const [ctx, id] of [
      [h.supplierB, order.id],
      [h.buyer, order.id],
      [h.supplierA, "no-such-order"],
    ] as const) {
      await expect(
        h.orders.advanceStatus(ctx, id, "en_route")
      ).rejects.toMatchObject({ name: "AuthorizationError" });
    }
    await expect(h.repo.getOrder(order.id)).resolves.toMatchObject({
      status: "accepted",
    });
  });
});

describe("OrderService.recordDelivery", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("creates the delivery from Accepted and sets Delivered (Reqs 11.1, 10.4)", async () => {
    const order = await wonOrder(h);
    const at = new Date(NOW.getTime() + 2 * HOUR);

    const delivery = await h.orders.recordDelivery(
      h.supplierA,
      order.id,
      { bolGallons: 498, ticketNumber: " 88213 " },
      at
    );

    expect(delivery).toMatchObject({
      orderId: order.id,
      bolGallons: 498,
      ticketNumber: "88213",
      ticketPhotoKey: null,
      deliveredAt: at,
    });
    await expect(h.repo.getOrder(order.id)).resolves.toMatchObject({
      status: "delivered",
    });
    await expect(h.repo.getDeliveryByOrder(order.id)).resolves.toMatchObject({
      id: delivery.id,
    });
  });

  it("records from En_Route too, and stores a ticket photo (Req 11.6)", async () => {
    const order = await wonOrder(h);
    await h.orders.advanceStatus(h.supplierA, order.id, "en_route");

    const delivery = await h.orders.recordDelivery(
      h.supplierA,
      order.id,
      {
        bolGallons: 500,
        ticketNumber: "88214",
        ticketPhotoKey: "tickets/2025/03/88214.jpg",
      },
      NOW
    );

    expect(delivery.ticketPhotoKey).toBe("tickets/2025/03/88214.jpg");
    await expect(h.repo.getOrder(order.id)).resolves.toMatchObject({
      status: "delivered",
    });
  });

  it("treats a blank ticket photo key as no photo (Req 11.6)", async () => {
    const order = await wonOrder(h);

    const delivery = await h.orders.recordDelivery(
      h.supplierA,
      order.id,
      { bolGallons: 500, ticketNumber: "88215", ticketPhotoKey: "   " },
      NOW
    );

    expect(delivery.ticketPhotoKey).toBeNull();
  });

  it("rejects a second delivery on the same order (Reqs 11.2, 11.3)", async () => {
    const order = await wonOrder(h);
    const first = await h.orders.recordDelivery(
      h.supplierA,
      order.id,
      { bolGallons: 498, ticketNumber: "88213" },
      NOW
    );

    await expect(
      h.orders.recordDelivery(
        h.supplierA,
        order.id,
        { bolGallons: 10, ticketNumber: "88299" },
        NOW
      )
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "DELIVERY_EXISTS",
    });
    // The first delivery stands, unamended.
    await expect(h.repo.getDeliveryByOrder(order.id)).resolves.toMatchObject({
      id: first.id,
      bolGallons: 498,
      ticketNumber: "88213",
    });
  });

  it.each([0, -1, -250.5, 12.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects BOL gallons of %p with a validation error (Req 11.4)",
    async (bolGallons) => {
      const order = await wonOrder(h);

      await expect(
        h.orders.recordDelivery(
          h.supplierA,
          order.id,
          { bolGallons, ticketNumber: "88213" },
          NOW
        )
      ).rejects.toMatchObject({
        name: "ValidationError",
        field: "bolGallons",
      });
      await expect(h.repo.getDeliveryByOrder(order.id)).resolves.toBeNull();
      await expect(h.repo.getOrder(order.id)).resolves.toMatchObject({
        status: "accepted",
      });
    }
  );

  it.each(["", "   ", undefined, null])(
    "rejects a missing ticket number (%p) with a validation error (Req 11.5)",
    async (ticketNumber) => {
      const order = await wonOrder(h);

      await expect(
        h.orders.recordDelivery(
          h.supplierA,
          order.id,
          {
            bolGallons: 498,
            ticketNumber: ticketNumber as unknown as string,
          },
          NOW
        )
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "TICKET_NUMBER_REQUIRED",
        field: "ticketNumber",
      });
      await expect(h.repo.getDeliveryByOrder(order.id)).resolves.toBeNull();
    }
  );

  it("denies anyone but the winning supplier company (Req 11.7)", async () => {
    const order = await wonOrder(h);

    for (const [ctx, id] of [
      [h.supplierB, order.id],
      [h.buyer, order.id],
      [h.supplierA, "no-such-order"],
    ] as const) {
      await expect(
        h.orders.recordDelivery(
          ctx,
          id,
          { bolGallons: 498, ticketNumber: "88213" },
          NOW
        )
      ).rejects.toMatchObject({ name: "AuthorizationError" });
    }
    await expect(h.repo.getDeliveryByOrder(order.id)).resolves.toBeNull();
    await expect(h.repo.getOrder(order.id)).resolves.toMatchObject({
      status: "accepted",
    });
  });
});

describe("Delivery fires DELIVERED to the owning buyer", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("texts the buyer's users with the landed gallons and ticket (Req 13.4)", async () => {
    const order = await wonOrder(h);

    await h.orders.recordDelivery(
      h.supplierA,
      order.id,
      { bolGallons: 498, ticketNumber: "88213" },
      NOW
    );

    expect(h.sms.calls.map((c) => c.to)).toEqual(["+16025550101"]);
    expect(h.sms.calls[0].body).toContain("delivered");
    expect(h.sms.calls[0].body).toContain("498 gal on the BOL");
    expect(h.sms.calls[0].body).toContain("ticket 88213");
    expect(h.sms.calls[0].body).toContain("500 gal ULSD");
  });

  it("notifies nobody on a rejected delivery", async () => {
    const order = await wonOrder(h);

    await expect(
      h.orders.recordDelivery(
        h.supplierA,
        order.id,
        { bolGallons: 0, ticketNumber: "88213" },
        NOW
      )
    ).rejects.toMatchObject({ name: "ValidationError" });
    await expect(
      h.orders.advanceStatus(h.supplierA, order.id, "delivered")
    ).rejects.toMatchObject({ code: "DELIVERY_REQUIRED" });

    expect(h.sms.calls).toHaveLength(0);
  });

  it("still records the delivery when the SMS transport is down", async () => {
    const broken = await makeHarness(new BrokenSmsSender());
    const order = await wonOrder(broken);

    const delivery = await broken.orders.recordDelivery(
      broken.supplierA,
      order.id,
      { bolGallons: 498, ticketNumber: "88213" },
      NOW
    );

    await expect(
      broken.repo.getDeliveryByOrder(order.id)
    ).resolves.toMatchObject({ id: delivery.id });
    await expect(broken.repo.getOrder(order.id)).resolves.toMatchObject({
      status: "delivered",
    });
  });
});

// ---------------------------------------------------------------------------
// The buyer order-status read (task 9.8) — Requirement 10.6
// ---------------------------------------------------------------------------

describe("OrderService.readOrder (buyer view)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("returns the status produced by the last valid transition (Req 10.6)", async () => {
    const order = await wonOrder(h);

    // Right after acceptance: Accepted, with no BOL behind it yet.
    const atAcceptance = await h.orders.readOrder(h.buyer, order.id);
    expect(atAcceptance).toMatchObject({
      orderId: order.id,
      requestId: order.requestId,
      offerId: order.offerId,
      buyerCompanyId: h.buyer.companyId,
      supplierCompanyId: h.supplierA.companyId,
      status: "accepted",
      delivery: null,
    });

    // The dispatcher rolls: the buyer's read follows.
    await h.orders.advanceStatus(h.supplierA, order.id, "en_route");
    await expect(h.orders.readOrder(h.buyer, order.id)).resolves.toMatchObject({
      status: "en_route",
      delivery: null,
    });

    // A refused backward change leaves the read on the last valid status.
    await expect(
      h.orders.advanceStatus(h.supplierA, order.id, "accepted")
    ).rejects.toMatchObject({ code: "ORDER_STATUS_BACKWARD" });
    await expect(h.orders.readOrder(h.buyer, order.id)).resolves.toMatchObject({
      status: "en_route",
    });

    // The BOL lands, so the buyer sees Delivered and the delivery detail.
    const delivery = await h.orders.recordDelivery(
      h.supplierA,
      order.id,
      { bolGallons: 498, ticketNumber: "88213" },
      NOW
    );
    const delivered = await h.orders.readOrder(h.buyer, order.id);
    expect(delivered.status).toBe("delivered");
    expect(delivered.delivery).toMatchObject({
      deliveryId: delivery.id,
      bolGallons: 498,
      ticketNumber: "88213",
      ticketPhotoKey: null,
    });
  });

  it("denies a buyer outside the owning company", async () => {
    const order = await wonOrder(h);
    const other: AuthContext = {
      userId: "u-other",
      companyId: "co-other",
      role: "buyer",
    };

    await expect(h.orders.readOrder(other, order.id)).rejects.toMatchObject({
      name: "AuthorizationError",
    });
  });
});
