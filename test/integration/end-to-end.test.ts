/**
 * End-to-end integration tests (task 13.3).
 *
 * Requirements exercised: 3.1, 4.1, 6.1, 8.1, 9.1, 9.3, 10.2, 11.1, 12.1,
 * 12.6, 17.1 — plus the audit rows (14.1-14.6) and the notification recipients
 * (13.1-13.4) those paths are required to produce.
 *
 * These drive the real route handlers over the real service graph from
 * `createServices`, backed by the real `InMemoryRepository` and the real
 * in-process session store. Every call carries a session cookie obtained from
 * the login handler, so each step authenticates the way a client does. The only
 * stand-ins are the transports at the process edge (an SMS sink and a
 * ticket-photo sink), which is where the real boundary is — no handler, no
 * service, and no repository is mocked.
 *
 * Three surfaces have services but no HTTP route yet (task 13.1 did not name
 * them): the supplier RFQ inbox, the Supplier_Status toggle, and the won-order
 * list. Those are called on the service graph directly, with an `AuthContext`
 * resolved from the same session cookie the handlers use, so the authorization
 * path is still the real one.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createServices, type Services } from "@/composition/root";
import type { AuthContext, Company, User } from "@/domain/types";
import { requireAuth } from "@/http/auth-context";
import { SESSION_COOKIE_NAME, readSessionToken } from "@/http/session-cookie";
import { loginHandler } from "@/http/handlers/auth";
import {
  cancelRequestHandler,
  createRequestHandler,
  listOffersForRequestHandler,
  listRequestsHandler,
  readRequestHandler,
} from "@/http/handlers/requests";
import { acceptOfferHandler, createOfferHandler } from "@/http/handlers/offers";
import {
  advanceOrderStatusHandler,
  readOrderHandler,
  recordDeliveryHandler,
} from "@/http/handlers/orders";
import {
  approveSupplierHandler,
  commissionDueHandler,
  createConciergeOrderHandler,
  markInvoicePaidHandler,
  setGeofenceHandler,
  setOperatingLocationHandler,
  setServiceRadiusHandler,
} from "@/http/handlers/admin";
import { InMemoryRepository } from "@/repository/in-memory";
import { InMemorySessionStore } from "@/session/store";
import type { SmsSender } from "@/services/notifications";
import { BcryptPasswordHasher } from "@/services/password";
import type {
  TicketPhotoStorage,
  TicketPhotoUpload,
} from "@/services/ticket-photo";

const PASSWORD = "correct horse battery staple";

/** A Phoenix SW Valley box, a pin inside it, and a pin far outside. */
const FENCE = { minLat: 33.2, maxLat: 33.6, minLng: -112.6, maxLng: -112.1 };
const PIN_INSIDE = { lat: 33.4, lng: -112.3 };
const PIN_OUTSIDE = { lat: 40.7, lng: -74.0 };

const BUYER_PHONE = "+16025550101";
const SUPPLIER_PHONE = "+16025550102";
const ADMIN_PHONE = "+16025550100";

class SmsSink implements SmsSender {
  readonly sent: { to: string; body: string }[] = [];
  async send(to: string, body: string): Promise<void> {
    this.sent.push({ to, body });
  }
  /** Recipients paged since `mark`, which is how each step is asserted. */
  since(mark: number): string[] {
    return this.sent.slice(mark).map((m) => m.to);
  }
}

class TicketPhotoSink implements TicketPhotoStorage {
  readonly stored: TicketPhotoUpload[] = [];
  async put(upload: TicketPhotoUpload): Promise<string> {
    this.stored.push(upload);
    return upload.key;
  }
}

interface Harness {
  services: Services;
  repo: InMemoryRepository;
  sms: SmsSink;
  photos: TicketPhotoSink;
  buyerCompany: Company;
  supplierCompany: Company;
  buyer: User;
  supplier: User;
  admin: User;
}

// Cost 4 keeps bcrypt real but fast enough for an integration suite.
const hasher = new BcryptPasswordHasher(4);

async function makeHarness(): Promise<Harness> {
  const repo = new InMemoryRepository();
  const sms = new SmsSink();
  const photos = new TicketPhotoSink();
  const services = createServices({
    repo,
    sessions: new InMemorySessionStore(),
    hasher,
    sms,
    ticketPhotos: photos,
  });

  const operatorCompany = await services.users.createCompany({
    name: "Load Energy",
    kind: "buyer",
  });
  const buyerCompany = await services.users.createCompany({
    name: "SW Valley Concrete",
    kind: "buyer",
  });
  const supplierCompany = await services.users.createCompany({
    name: "Buckeye Diesel",
    kind: "supplier",
  });

  const mk = (companyId: string, role: User["role"], phone: string) =>
    services.users.createUser({ companyId, role, phone, password: PASSWORD });

  const admin = await mk(operatorCompany.id, "admin", ADMIN_PHONE);
  const buyer = await mk(buyerCompany.id, "buyer", BUYER_PHONE);
  const supplier = await mk(supplierCompany.id, "supplier", SUPPLIER_PHONE);

  return {
    services,
    repo,
    sms,
    photos,
    buyerCompany,
    supplierCompany,
    buyer,
    supplier,
    admin,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const url = (path: string) => `http://localhost${path}`;

function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(url(path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}

function get(path: string, cookie?: string): Request {
  return new Request(url(path), {
    method: "GET",
    headers: cookie ? { Cookie: cookie } : {},
  });
}

async function bodyOf(response: Response): Promise<any> {
  return response.json();
}

/** Logs in through the real handler and returns the cookie to replay. */
async function signIn(h: Harness, phone: string): Promise<string> {
  const response = await loginHandler(
    h.services,
    post("/api/auth/login", { identifier: phone, password: PASSWORD })
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const token = readSessionToken(setCookie.split(";")[0]);
  expect(token).not.toBeNull();
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/**
 * Resolves the `AuthContext` behind a session cookie through the same path the
 * handlers use. Needed only for the three surfaces that have no route yet.
 */
function ctxFor(h: Harness, cookie: string): Promise<AuthContext> {
  return requireAuth(get("/api/internal", cookie), h.services.auth);
}

/**
 * Admin-configures the pilot the way an operator would before go-live:
 * the geofence, then the supplier's approval, operating pin, and radius
 * (Requirements 16.2, 16.4, 16.5, 16.7). The availability toggle is the
 * supplier's own switch and has no route yet, so it goes through the service
 * with the dispatcher's own session (Requirement 5.2).
 */
async function configurePilot(h: Harness): Promise<void> {
  const adminCookie = await signIn(h, h.admin.phone);

  expect(
    (
      await setGeofenceHandler(
        h.services,
        post("/api/admin/geofence", FENCE, adminCookie)
      )
    ).status
  ).toBe(200);
  expect(
    (
      await approveSupplierHandler(
        h.services,
        post("/api/admin/suppliers/x/approve", {}, adminCookie),
        h.supplierCompany.id
      )
    ).status
  ).toBe(200);
  expect(
    (
      await setOperatingLocationHandler(
        h.services,
        post("/api/admin/suppliers/x/operating-location", PIN_INSIDE, adminCookie),
        h.supplierCompany.id
      )
    ).status
  ).toBe(200);
  expect(
    (
      await setServiceRadiusHandler(
        h.services,
        post(
          "/api/admin/suppliers/x/service-radius",
          { serviceRadiusMiles: 75 },
          adminCookie
        ),
        h.supplierCompany.id
      )
    ).status
  ).toBe(200);

  const supplierCookie = await signIn(h, h.supplier.phone);
  const supplierCtx = await ctxFor(h, supplierCookie);
  const opened = await h.services.suppliers.setStatus(supplierCtx, "open");
  expect(opened.supplierStatus).toBe("open");
}

const VALID_REQUEST = {
  gallons: 2500,
  productType: "ulsd",
  deliveryMethod: "wet_hose",
  deliveryWindow: "today",
  ...PIN_INSIDE,
  notes: "Gate code 4417",
};

/** The audit actions on the log, oldest first. */
async function auditActions(h: Harness): Promise<string[]> {
  return (await h.services.audit.list()).map((entry) => entry.action);
}

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

// ---------------------------------------------------------------------------
// 1. The happy path
// ---------------------------------------------------------------------------

describe("the happy path end to end", () => {
  it("runs request -> match -> offer -> accept -> en route -> delivered -> invoice -> paid", async () => {
    await configurePilot(h);

    const buyerCookie = await signIn(h, h.buyer.phone);
    const supplierCookie = await signIn(h, h.supplier.phone);
    const adminCookie = await signIn(h, h.admin.phone);
    const supplierCtx = await ctxFor(h, supplierCookie);

    // --- Post the load (Requirement 3.1) -----------------------------------
    let mark = h.sms.sent.length;
    const created = await createRequestHandler(
      h.services,
      post("/api/requests", VALID_REQUEST, buyerCookie)
    );
    expect(created.status).toBe(201);
    const load = (await bodyOf(created)).request;
    expect(load).toMatchObject({
      status: "open",
      gallons: 2500,
      buyerCompanyId: h.buyerCompany.id,
      createdByUserId: h.buyer.id,
      notes: "Gate code 4417",
    });

    // Requirement 13.1 — the matched supplier's dispatcher is paged.
    expect(h.sms.since(mark)).toEqual([SUPPLIER_PHONE]);

    // --- Matching (Requirement 4.1) ----------------------------------------
    // No route for the RFQ inbox yet, so this goes through the service.
    const inbox = await h.services.matching.listRfqInbox(supplierCtx);
    expect(inbox.map((r) => r.id)).toEqual([load.id]);

    // --- Quote (Requirement 6.1) -------------------------------------------
    mark = h.sms.sent.length;
    const quoted = await createOfferHandler(
      h.services,
      post(
        "/api/offers",
        {
          requestId: load.id,
          landedPricePerGal: 3.42,
          holdHours: 4,
          etaMinutes: 90,
        },
        supplierCookie
      )
    );
    expect(quoted.status).toBe(201);
    const offer = (await bodyOf(quoted)).offer;
    expect(offer.supplierCompanyId).toBe(h.supplierCompany.id);

    // Requirement 13.2 — the owning buyer is paged about the quote.
    expect(h.sms.since(mark)).toEqual([BUYER_PHONE]);

    // The buyer sees the quote with its activeness indicator (Req 6.6, 7.4).
    const offerList = await listOffersForRequestHandler(
      h.services,
      get(`/api/requests/${load.id}/offers`, buyerCookie),
      load.id
    );
    expect(offerList.status).toBe(200);
    expect((await bodyOf(offerList)).offers).toMatchObject([
      {
        offerId: offer.id,
        supplierName: "Buckeye Diesel",
        landedPricePerGal: 3.42,
        etaMinutes: 90,
        isActive: true,
      },
    ]);

    // --- Accept (Requirement 8.1) ------------------------------------------
    mark = h.sms.sent.length;
    const accepted = await acceptOfferHandler(
      h.services,
      post(`/api/offers/${offer.id}/accept`, {}, buyerCookie),
      offer.id
    );
    expect(accepted.status).toBe(201);
    const order = (await bodyOf(accepted)).order;
    expect(order).toMatchObject({
      status: "accepted",
      requestId: load.id,
      offerId: offer.id,
      buyerCompanyId: h.buyerCompany.id,
      supplierCompanyId: h.supplierCompany.id,
      isConcierge: false,
    });

    // Requirement 13.3 — the winning dispatcher is paged.
    expect(h.sms.since(mark)).toEqual([SUPPLIER_PHONE]);

    // Requirement 8.2 — the load is no longer Open.
    const readBack = await readRequestHandler(
      h.services,
      get(`/api/requests/${load.id}`, buyerCookie),
      load.id
    );
    expect((await bodyOf(readBack)).request.status).toBe("accepted");

    // Requirement 8.7 — the winner sees it as a won order (service, no route).
    const won = await h.services.orders.listWonOrders(supplierCtx);
    expect(won.map((o) => o.id)).toEqual([order.id]);

    // --- En route (Requirement 10.2) ---------------------------------------
    const enRoute = await advanceOrderStatusHandler(
      h.services,
      post(
        `/api/orders/${order.id}/status`,
        { status: "en_route" },
        supplierCookie
      ),
      order.id
    );
    expect(enRoute.status).toBe(200);
    expect((await bodyOf(enRoute)).order.status).toBe("en_route");

    // --- Record the BOL (Requirement 11.1) ---------------------------------
    mark = h.sms.sent.length;
    const form = new FormData();
    form.set("bolGallons", "2480");
    form.set("ticketNumber", "BOL-99321");
    form.set(
      "photo",
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" }),
      "ticket.jpg"
    );
    const delivered = await recordDeliveryHandler(
      h.services,
      new Request(url(`/api/orders/${order.id}/delivery`), {
        method: "POST",
        headers: { Cookie: supplierCookie },
        body: form,
      }),
      order.id
    );
    expect(delivered.status).toBe(201);
    expect((await bodyOf(delivered)).delivery).toMatchObject({
      bolGallons: 2480,
      ticketNumber: "BOL-99321",
    });
    expect(h.photos.stored).toHaveLength(1);

    // Requirement 13.4 — the buyer is paged that fuel landed.
    expect(h.sms.since(mark)).toEqual([BUYER_PHONE]);

    // Requirement 10.6 — the buyer reads the current status and the BOL.
    const orderRead = await readOrderHandler(
      h.services,
      get(`/api/orders/${order.id}`, buyerCookie),
      order.id
    );
    expect(orderRead.status).toBe(200);
    expect((await bodyOf(orderRead)).order).toMatchObject({
      status: "delivered",
      delivery: { bolGallons: 2480, ticketNumber: "BOL-99321" },
    });

    // --- Invoice (Requirement 12.1) ----------------------------------------
    const invoice = await h.repo.getCommissionInvoiceByOrder(order.id);
    expect(invoice).toMatchObject({
      supplierCompanyId: h.supplierCompany.id,
      bolGallons: 2480,
      // First win, so the commission is waived at $0 but still invoiced Unpaid.
      amount: 0,
      waived: true,
      paymentStatus: "unpaid",
    });

    const due = await commissionDueHandler(
      h.services,
      get("/api/admin/commission-due", adminCookie)
    );
    expect(due.status).toBe(200);
    expect((await bodyOf(due)).rows).toMatchObject([
      {
        supplierCompanyId: h.supplierCompany.id,
        supplierCompanyName: "Buckeye Diesel",
        unpaidInvoiceCount: 1,
        amountDue: 0,
      },
    ]);

    // --- Mark paid (Requirement 12.6) --------------------------------------
    const paid = await markInvoicePaidHandler(
      h.services,
      post(`/api/admin/invoices/${invoice!.id}/mark-paid`, {}, adminCookie),
      invoice!.id
    );
    expect(paid.status).toBe(200);
    expect((await bodyOf(paid)).invoice).toMatchObject({
      paymentStatus: "paid",
      paidByAdminId: h.admin.id,
    });

    // Nothing outstanding once it is paid (Requirement 12.8).
    const dueAfter = await commissionDueHandler(
      h.services,
      get("/api/admin/commission-due", adminCookie)
    );
    expect((await bodyOf(dueAfter)).rows).toEqual([]);

    // --- The audit trail (Requirements 14.1, 14.2, 14.4, 14.6) -------------
    expect(await auditActions(h)).toEqual([
      "OFFER_SUBMITTED",
      "OFFER_ACCEPTED",
      "STATUS_CHANGED",
      "STATUS_CHANGED",
      "INVOICE_PAID",
    ]);

    const entries = await h.services.audit.list();
    expect(entries[0]).toMatchObject({
      actorUserId: h.supplier.id,
      subjectId: offer.id,
    });
    expect(entries[1]).toMatchObject({
      actorUserId: h.buyer.id,
      subjectId: order.id,
    });
    expect(entries[2].payload).toMatchObject({
      priorStatus: "accepted",
      newStatus: "en_route",
    });
    expect(entries[3].payload).toMatchObject({
      priorStatus: "en_route",
      newStatus: "delivered",
    });
    expect(entries[4]).toMatchObject({
      actorUserId: h.admin.id,
      subjectId: invoice!.id,
      payload: { priorStatus: "unpaid", newStatus: "paid" },
    });
  });

  it("keeps an out-of-geofence pin out of the marketplace entirely", async () => {
    await configurePilot(h);
    const buyerCookie = await signIn(h, h.buyer.phone);
    const supplierCookie = await signIn(h, h.supplier.phone);

    const rejected = await createRequestHandler(
      h.services,
      post("/api/requests", { ...VALID_REQUEST, ...PIN_OUTSIDE }, buyerCookie)
    );

    expect(rejected.status).toBe(422);
    expect((await bodyOf(rejected)).error.code).toBe("OUTSIDE_GEOFENCE");

    // Nothing was posted, so nobody was paged and no inbox changed.
    expect(h.sms.sent).toHaveLength(0);
    const supplierCtx = await ctxFor(h, supplierCookie);
    expect(await h.services.matching.listRfqInbox(supplierCtx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The cancel path (Requirements 9.1, 9.4, 14.3)
// ---------------------------------------------------------------------------

describe("the cancel path end to end", () => {
  it("voids the live quotes and drops the load out of the supplier inbox", async () => {
    await configurePilot(h);
    const buyerCookie = await signIn(h, h.buyer.phone);
    const supplierCookie = await signIn(h, h.supplier.phone);
    const supplierCtx = await ctxFor(h, supplierCookie);

    const created = await createRequestHandler(
      h.services,
      post("/api/requests", VALID_REQUEST, buyerCookie)
    );
    const load = (await bodyOf(created)).request;

    const quoted = await createOfferHandler(
      h.services,
      post(
        "/api/offers",
        { requestId: load.id, landedPricePerGal: 3.55, holdHours: 6 },
        supplierCookie
      )
    );
    const offer = (await bodyOf(quoted)).offer;
    expect(offer.status).toBe("active");

    // The load is live in the dispatcher's inbox before the cancel.
    expect(
      (await h.services.matching.listRfqInbox(supplierCtx)).map((r) => r.id)
    ).toEqual([load.id]);

    // --- Cancel (Requirement 9.1) ------------------------------------------
    const cancelled = await cancelRequestHandler(
      h.services,
      post(`/api/requests/${load.id}/cancel`, {}, buyerCookie),
      load.id
    );
    expect(cancelled.status).toBe(200);
    expect((await bodyOf(cancelled)).request.status).toBe("cancelled");

    // The quote is voided and no longer acceptable.
    const offerList = await listOffersForRequestHandler(
      h.services,
      get(`/api/requests/${load.id}/offers`, buyerCookie),
      load.id
    );
    expect((await bodyOf(offerList)).offers).toMatchObject([
      { offerId: offer.id, status: "voided", isActive: false },
    ]);

    const voided = await h.repo.getOffer(offer.id);
    expect(voided).toMatchObject({ status: "voided", voided: true });

    // Requirement 9.4 — gone from the inbox.
    expect(await h.services.matching.listRfqInbox(supplierCtx)).toEqual([]);

    // And off the buyer's work list, with no order behind it.
    const workList = await listRequestsHandler(
      h.services,
      get("/api/requests", buyerCookie)
    );
    expect(await bodyOf(workList)).toMatchObject({ requests: [], orders: [] });

    // Accepting the voided quote is now a conflict, not a win.
    const lateAccept = await acceptOfferHandler(
      h.services,
      post(`/api/offers/${offer.id}/accept`, {}, buyerCookie),
      offer.id
    );
    expect(lateAccept.status).toBe(409);
    expect((await bodyOf(lateAccept)).error.code).toBe("REQUEST_NOT_OPEN");

    // Requirement 14.3 — who cancelled, and the statuses it moved between.
    expect(await auditActions(h)).toEqual([
      "OFFER_SUBMITTED",
      "REQUEST_CANCELLED",
    ]);
    const [, cancelEntry] = await h.services.audit.list();
    expect(cancelEntry).toMatchObject({
      actorUserId: h.buyer.id,
      subjectId: load.id,
      payload: { priorStatus: "open", newStatus: "cancelled" },
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The window-expiry path (Requirements 9.3, 9.4, 14.3)
// ---------------------------------------------------------------------------

describe("the window-expiry path end to end", () => {
  it("expires a past-window load on read and voids its remaining quotes", async () => {
    await configurePilot(h);
    const buyerCookie = await signIn(h, h.buyer.phone);
    const supplierCookie = await signIn(h, h.supplier.phone);
    const supplierCtx = await ctxFor(h, supplierCookie);

    const created = await createRequestHandler(
      h.services,
      post("/api/requests", VALID_REQUEST, buyerCookie)
    );
    const load = (await bodyOf(created)).request;

    const quoted = await createOfferHandler(
      h.services,
      post(
        "/api/offers",
        { requestId: load.id, landedPricePerGal: 3.61, holdHours: 8 },
        supplierCookie
      )
    );
    const offer = (await bodyOf(quoted)).offer;

    // Age the delivery window past its end rather than waiting for midnight.
    // Expiry is lazy, so the row is still Open until something reads it.
    await h.repo.updateRequest(load.id, {
      windowEndsAt: new Date(Date.now() - 60_000),
    });
    expect((await h.repo.getRequest(load.id))?.status).toBe("open");

    // --- The read is what records the expiry (Requirement 9.3) -------------
    const read = await readRequestHandler(
      h.services,
      get(`/api/requests/${load.id}`, buyerCookie),
      load.id
    );
    expect(read.status).toBe(200);
    expect((await bodyOf(read)).request.status).toBe("expired");

    // The quote that was still live is voided.
    const offerList = await listOffersForRequestHandler(
      h.services,
      get(`/api/requests/${load.id}/offers`, buyerCookie),
      load.id
    );
    expect((await bodyOf(offerList)).offers).toMatchObject([
      { offerId: offer.id, status: "voided", isActive: false },
    ]);

    // Requirement 9.4 — an expired load reaches no dispatcher.
    expect(await h.services.matching.listRfqInbox(supplierCtx)).toEqual([]);

    // And it is off the buyer's work list.
    const workList = await listRequestsHandler(
      h.services,
      get("/api/requests", buyerCookie)
    );
    expect((await bodyOf(workList)).requests).toEqual([]);

    // An expired load cannot be cancelled or won afterwards.
    const lateCancel = await cancelRequestHandler(
      h.services,
      post(`/api/requests/${load.id}/cancel`, {}, buyerCookie),
      load.id
    );
    expect(lateCancel.status).toBe(409);
    const lateAccept = await acceptOfferHandler(
      h.services,
      post(`/api/offers/${offer.id}/accept`, {}, buyerCookie),
      offer.id
    );
    expect(lateAccept.status).toBe(409);

    // Requirement 14.3 — expiry is system-driven, so the row has no actor.
    expect(await auditActions(h)).toEqual([
      "OFFER_SUBMITTED",
      "REQUEST_EXPIRED",
    ]);
    const [, expiryEntry] = await h.services.audit.list();
    expect(expiryEntry).toMatchObject({
      actorUserId: null,
      subjectId: load.id,
      payload: { priorStatus: "open", newStatus: "expired" },
    });
  });
});

// ---------------------------------------------------------------------------
// 4. The admin concierge path (Requirements 17.1-17.4, 12.1-12.4)
// ---------------------------------------------------------------------------

describe("the admin concierge path end to end", () => {
  it("lands an off-app deal as a Delivered order under the same waived-win rules", async () => {
    const adminCookie = await signIn(h, h.admin.phone);

    const enter = (bolGallons: number, ticketNumber: string) =>
      createConciergeOrderHandler(
        h.services,
        post(
          "/api/admin/concierge-orders",
          {
            buyerCompanyId: h.buyerCompany.id,
            supplierCompanyId: h.supplierCompany.id,
            bolGallons,
            ticketNumber,
          },
          adminCookie
        )
      );

    // --- The first deal (Requirements 17.1, 17.2) --------------------------
    const first = await enter(3100, "PHONE-DEAL-1");
    expect(first.status).toBe(201);
    const firstOrder = (await bodyOf(first)).order;
    expect(firstOrder).toMatchObject({
      status: "delivered",
      isConcierge: true,
      requestId: null,
      offerId: null,
      buyerCompanyId: h.buyerCompany.id,
      supplierCompanyId: h.supplierCompany.id,
    });

    expect(await h.repo.getDeliveryByOrder(firstOrder.id)).toMatchObject({
      bolGallons: 3100,
      ticketNumber: "PHONE-DEAL-1",
    });

    // Requirements 12.1, 12.3, 12.4, 17.3 — win one is waived but invoiced.
    expect(
      await h.repo.getCommissionInvoiceByOrder(firstOrder.id)
    ).toMatchObject({
      supplierCompanyId: h.supplierCompany.id,
      bolGallons: 3100,
      amount: 0,
      waived: true,
      paymentStatus: "unpaid",
    });

    // --- Wins two and three, to show the waiver boundary holds -------------
    const secondOrder = (await bodyOf(await enter(1000, "PHONE-DEAL-2"))).order;
    const thirdOrder = (await bodyOf(await enter(5000, "PHONE-DEAL-3"))).order;

    expect(
      await h.repo.getCommissionInvoiceByOrder(secondOrder.id)
    ).toMatchObject({ amount: 0, waived: true });
    // Requirement 12.2 — the third win bills 5000 x $0.02.
    expect(
      await h.repo.getCommissionInvoiceByOrder(thirdOrder.id)
    ).toMatchObject({ amount: 100, waived: false, paymentStatus: "unpaid" });

    // Requirement 12.8 — three unpaid invoices, $100 of it collectable.
    const due = await commissionDueHandler(
      h.services,
      get("/api/admin/commission-due", adminCookie)
    );
    expect(await bodyOf(due)).toMatchObject({
      rows: [
        {
          supplierCompanyId: h.supplierCompany.id,
          unpaidInvoiceCount: 3,
          amountDue: 100,
        },
      ],
      totalDue: 100,
    });

    // --- Mark the billed one paid (Requirement 12.6) -----------------------
    const invoice = await h.repo.getCommissionInvoiceByOrder(thirdOrder.id);
    const paid = await markInvoicePaidHandler(
      h.services,
      post(`/api/admin/invoices/${invoice!.id}/mark-paid`, {}, adminCookie),
      invoice!.id
    );
    expect(paid.status).toBe(200);
    expect((await bodyOf(paid)).invoice).toMatchObject({
      paymentStatus: "paid",
      paidByAdminId: h.admin.id,
    });

    // --- The audit trail (Requirements 14.5, 14.6, 17.4) -------------------
    expect(await auditActions(h)).toEqual([
      "CONCIERGE_CREATED",
      "CONCIERGE_CREATED",
      "CONCIERGE_CREATED",
      "INVOICE_PAID",
    ]);
    const entries = await h.services.audit.list();
    expect(entries[0]).toMatchObject({
      actorUserId: h.admin.id,
      subjectId: firstOrder.id,
      payload: {
        status: "delivered",
        bolGallons: 3100,
        ticketNumber: "PHONE-DEAL-1",
        invoiceAmount: 0,
        invoiceWaived: true,
      },
    });
    expect(entries[3]).toMatchObject({
      actorUserId: h.admin.id,
      subjectId: invoice!.id,
      payload: { priorStatus: "unpaid", newStatus: "paid" },
    });
  });

  it("denies a concierge entry to a non-admin caller", async () => {
    const buyerCookie = await signIn(h, h.buyer.phone);

    const response = await createConciergeOrderHandler(
      h.services,
      post(
        "/api/admin/concierge-orders",
        {
          buyerCompanyId: h.buyerCompany.id,
          supplierCompanyId: h.supplierCompany.id,
          bolGallons: 1000,
        },
        buyerCookie
      )
    );

    // Requirement 17.5 — and nothing was written.
    expect(response.status).toBe(403);
    expect(await h.repo.listCommissionInvoices()).toEqual([]);
    expect(await h.services.audit.count()).toBe(0);
  });
});
