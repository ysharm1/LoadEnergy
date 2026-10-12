/**
 * Route handler unit tests (task 13.1) and the ticket-photo upload (task 13.2).
 *
 * Requirements exercised: 1.1, 1.2, 2.1, 2.3, 3.1, 3.5, 3.6, 3.8, 6.1, 7.4,
 * 8.1, 9.1, 9.5, 10.2, 10.5, 10.6, 11.1, 11.6, 12.6, 12.8, 16.2, 16.4, 16.5,
 * 16.6, 16.7, 17.1.
 *
 * Real collaborators throughout: the real composition root over an in-memory
 * repository and session store, real bcrypt at a low cost, real `Request` and
 * `Response` objects, real multipart parsing. The only stand-ins are the
 * transports at the edge (an SMS sink, a ticket-photo store), which is where
 * the process boundary actually is — nothing about the handlers, the services,
 * or the error mapping is mocked.
 *
 * The session cookie is obtained by calling the login handler and is replayed
 * on every subsequent request, so each test authenticates the way a client
 * does.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createServices, type Services } from "@/composition/root";
import type { Company, User } from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import { InMemorySessionStore } from "@/session/store";
import { BcryptPasswordHasher } from "@/services/password";
import type { SmsSender } from "@/services/notifications";
import type {
  TicketPhotoStorage,
  TicketPhotoUpload,
} from "@/services/ticket-photo";
import { SESSION_COOKIE_NAME, readSessionToken } from "../session-cookie";
import { loginHandler, logoutHandler } from "./auth";
import { createSiteHandler, listSitesHandler } from "./sites";
import {
  cancelRequestHandler,
  createRequestHandler,
  listOffersForRequestHandler,
  listRequestsHandler,
} from "./requests";
import { acceptOfferHandler, createOfferHandler } from "./offers";
import {
  advanceOrderStatusHandler,
  readOrderHandler,
  recordDeliveryHandler,
} from "./orders";
import {
  approveSupplierHandler,
  commissionDueHandler,
  createCompanyHandler,
  createConciergeOrderHandler,
  createUserHandler,
  listCompaniesHandler,
  markInvoicePaidHandler,
  setGeofenceHandler,
  setOperatingLocationHandler,
  setServiceRadiusHandler,
} from "./admin";

const PASSWORD = "correct horse battery staple";

// A Phoenix SW Valley box, and a pin inside it.
const FENCE = { minLat: 33.2, maxLat: 33.6, minLng: -112.6, maxLng: -112.1 };
const PIN_INSIDE = { lat: 33.4, lng: -112.3 };
const PIN_OUTSIDE = { lat: 40.7, lng: -74.0 };

class SmsSink implements SmsSender {
  readonly sent: { to: string; body: string }[] = [];
  async send(to: string, body: string): Promise<void> {
    this.sent.push({ to, body });
  }
}

class TicketPhotoSink implements TicketPhotoStorage {
  readonly stored: TicketPhotoUpload[] = [];
  async put(upload: TicketPhotoUpload): Promise<string> {
    this.stored.push(upload);
    return upload.key;
  }
}

class FailingTicketPhotoStorage implements TicketPhotoStorage {
  async put(): Promise<string> {
    throw new Error("S3 is unreachable");
  }
}

interface Harness {
  services: Services;
  repo: InMemoryRepository;
  photos: TicketPhotoSink;
  buyerCompany: Company;
  supplierCompany: Company;
  otherBuyerCompany: Company;
  buyer: User;
  supplier: User;
  admin: User;
  otherBuyer: User;
}

// Cost 4 keeps bcrypt real but fast enough for a unit suite.
const hasher = new BcryptPasswordHasher(4);

async function makeHarness(
  ticketPhotos: TicketPhotoStorage = new TicketPhotoSink()
): Promise<Harness> {
  const repo = new InMemoryRepository();
  const services = createServices({
    repo,
    sessions: new InMemorySessionStore(),
    hasher,
    sms: new SmsSink(),
    ticketPhotos,
  });

  const operatorCompany = await services.users.createCompany({
    name: "Load Energy",
    kind: "buyer",
  });
  const buyerCompany = await services.users.createCompany({
    name: "SW Valley Concrete",
    kind: "buyer",
  });
  const otherBuyerCompany = await services.users.createCompany({
    name: "Rival Paving",
    kind: "buyer",
  });
  const supplierCompany = await services.users.createCompany({
    name: "Buckeye Diesel",
    kind: "supplier",
  });

  const mk = (companyId: string, role: User["role"], phone: string) =>
    services.users.createUser({ companyId, role, phone, password: PASSWORD });

  const admin = await mk(operatorCompany.id, "admin", "+16025550100");
  const buyer = await mk(buyerCompany.id, "buyer", "+16025550101");
  const supplier = await mk(supplierCompany.id, "supplier", "+16025550102");
  const otherBuyer = await mk(otherBuyerCompany.id, "buyer", "+16025550103");

  return {
    services,
    repo,
    photos: ticketPhotos as TicketPhotoSink,
    buyerCompany,
    supplierCompany,
    otherBuyerCompany,
    buyer,
    supplier,
    admin,
    otherBuyer,
  };
}

// ---------------------------------------------------------------------------
// Request/response helpers
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

/** Logs a user in through the real handler and returns the cookie to replay. */
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

/** Admin-configures the pilot so requests and matching can work. */
async function configurePilot(h: Harness, adminCookie: string): Promise<void> {
  expect(
    (await setGeofenceHandler(h.services, post("/api/admin/geofence", FENCE, adminCookie)))
      .status
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
        post("/api/admin/x/operating-location", PIN_INSIDE, adminCookie),
        h.supplierCompany.id
      )
    ).status
  ).toBe(200);
  expect(
    (
      await setServiceRadiusHandler(
        h.services,
        post("/api/admin/x/service-radius", { serviceRadiusMiles: 75 }, adminCookie),
        h.supplierCompany.id
      )
    ).status
  ).toBe(200);
  // Availability is the supplier's own switch and has no route in this task.
  await h.repo.updateCompany(h.supplierCompany.id, { supplierStatus: "open" });
}

const VALID_REQUEST = {
  gallons: 2500,
  productType: "ulsd",
  deliveryMethod: "wet_hose",
  deliveryWindow: "today",
  ...PIN_INSIDE,
  notes: "Gate code 4417",
};

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

// ---------------------------------------------------------------------------
// Auth (Requirements 1.1, 1.2)
// ---------------------------------------------------------------------------

describe("auth routes", () => {
  it("issues an HTTP-only session cookie and never returns the password hash", async () => {
    const response = await loginHandler(
      h.services,
      post("/api/auth/login", {
        identifier: h.buyer.phone,
        password: PASSWORD,
      })
    );

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const body = await bodyOf(response);
    expect(body.role).toBe("buyer");
    expect(body.user.id).toBe(h.buyer.id);
    expect(body.company.id).toBe(h.buyerCompany.id);
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("rejects invalid credentials with 401 and a uniform code", async () => {
    const response = await loginHandler(
      h.services,
      post("/api/auth/login", {
        identifier: h.buyer.phone,
        password: "wrong",
      })
    );

    expect(response.status).toBe(401);
    expect((await bodyOf(response)).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("clears the cookie on logout", async () => {
    const cookie = await signIn(h, h.buyer.phone);
    const response = await logoutHandler(
      h.services,
      post("/api/auth/logout", {}, cookie)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");

    // The session is gone, so the next protected call is unauthenticated.
    const after = await listSitesHandler(h.services, get("/api/sites", cookie));
    expect(after.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Session enforcement
// ---------------------------------------------------------------------------

describe("session enforcement", () => {
  it("rejects a protected route with no session cookie as 401", async () => {
    const response = await listSitesHandler(h.services, get("/api/sites"));
    expect(response.status).toBe(401);
    expect((await bodyOf(response)).error.code).toBe("SESSION_INVALID");
  });

  it("rejects a forged session token as 401", async () => {
    const response = await listSitesHandler(
      h.services,
      get("/api/sites", `${SESSION_COOKIE_NAME}=not-a-real-token`)
    );
    expect(response.status).toBe(401);
  });

  it("takes the owning company from the session, never from the body", async () => {
    const cookie = await signIn(h, h.buyer.phone);
    const adminCookie = await signIn(h, h.admin.phone);
    await configurePilot(h, adminCookie);

    const response = await createRequestHandler(
      h.services,
      post(
        "/api/requests",
        {
          ...VALID_REQUEST,
          // A client trying to post a load onto another tenant.
          buyerCompanyId: h.otherBuyerCompany.id,
          createdByUserId: h.otherBuyer.id,
        },
        cookie
      )
    );

    expect(response.status).toBe(201);
    const created = (await bodyOf(response)).request;
    expect(created.buyerCompanyId).toBe(h.buyerCompany.id);
    expect(created.createdByUserId).toBe(h.buyer.id);
  });
});

// ---------------------------------------------------------------------------
// Sites (Requirements 2.1, 2.3)
// ---------------------------------------------------------------------------

describe("site routes", () => {
  it("creates a site on the caller's company and lists it back", async () => {
    const cookie = await signIn(h, h.buyer.phone);

    const created = await createSiteHandler(
      h.services,
      post("/api/sites", { name: "Yard 7", ...PIN_INSIDE }, cookie)
    );
    expect(created.status).toBe(201);

    const listed = await listSitesHandler(h.services, get("/api/sites", cookie));
    expect(listed.status).toBe(200);
    const { sites } = await bodyOf(listed);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      name: "Yard 7",
      companyId: h.buyerCompany.id,
    });
  });

  it("maps an out-of-range coordinate to 400 with the offending field", async () => {
    const cookie = await signIn(h, h.buyer.phone);

    const response = await createSiteHandler(
      h.services,
      post("/api/sites", { name: "Bad pin", lat: 91, lng: 0 }, cookie)
    );

    expect(response.status).toBe(400);
    const { error } = await bodyOf(response);
    expect(error.field).toBe("lat");
    expect(error.code).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Requests (Requirements 3.1, 3.5, 3.6, 9.1, 9.5)
// ---------------------------------------------------------------------------

describe("request routes", () => {
  let cookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    cookie = await signIn(h, h.buyer.phone);
    adminCookie = await signIn(h, h.admin.phone);
    await configurePilot(h, adminCookie);
  });

  it("creates an Open request and returns it on the work list", async () => {
    const created = await createRequestHandler(
      h.services,
      post("/api/requests", VALID_REQUEST, cookie)
    );
    expect(created.status).toBe(201);
    expect((await bodyOf(created)).request.status).toBe("open");

    const list = await listRequestsHandler(
      h.services,
      get("/api/requests", cookie)
    );
    const workList = await bodyOf(list);
    expect(workList.requests).toHaveLength(1);
    expect(workList.orders).toHaveLength(0);
  });

  it("maps a pin outside the pilot geofence to 422 and echoes the box", async () => {
    const response = await createRequestHandler(
      h.services,
      post("/api/requests", { ...VALID_REQUEST, ...PIN_OUTSIDE }, cookie)
    );

    expect(response.status).toBe(422);
    const { error } = await bodyOf(response);
    expect(error.code).toBe("OUTSIDE_GEOFENCE");
    expect(error.details.fence).toMatchObject(FENCE);
  });

  it("maps non-positive gallons to 400 on the gallons field", async () => {
    const response = await createRequestHandler(
      h.services,
      post("/api/requests", { ...VALID_REQUEST, gallons: 0 }, cookie)
    );

    expect(response.status).toBe(400);
    const { error } = await bodyOf(response);
    expect(error.code).toBe("GALLONS_INVALID");
    expect(error.field).toBe("gallons");
  });

  it("cancels an Open request for its owner", async () => {
    const created = await createRequestHandler(
      h.services,
      post("/api/requests", VALID_REQUEST, cookie)
    );
    const { request: load } = await bodyOf(created);

    const cancelled = await cancelRequestHandler(
      h.services,
      post(`/api/requests/${load.id}/cancel`, {}, cookie),
      load.id
    );
    expect(cancelled.status).toBe(200);
    expect((await bodyOf(cancelled)).request.status).toBe("cancelled");

    // Requirement 9.2 — a second cancel is a conflict, not a success.
    const again = await cancelRequestHandler(
      h.services,
      post(`/api/requests/${load.id}/cancel`, {}, cookie),
      load.id
    );
    expect(again.status).toBe(409);
    expect((await bodyOf(again)).error.code).toBe("REQUEST_NOT_OPEN");
  });

  it("denies cancellation by a company that does not own the load (403)", async () => {
    const created = await createRequestHandler(
      h.services,
      post("/api/requests", VALID_REQUEST, cookie)
    );
    const { request: load } = await bodyOf(created);

    const intruder = await signIn(h, h.otherBuyer.phone);
    const response = await cancelRequestHandler(
      h.services,
      post(`/api/requests/${load.id}/cancel`, {}, intruder),
      load.id
    );

    expect(response.status).toBe(403);
    // Still Open: the denial changed nothing.
    expect((await h.repo.getRequest(load.id))?.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// The full app path (Requirements 6.1, 7.4, 8.1, 10.2, 11.1, 12.6, 12.8)
// ---------------------------------------------------------------------------

describe("offer, order, and delivery routes", () => {
  let buyerCookie: string;
  let supplierCookie: string;
  let adminCookie: string;
  let loadId: string;

  beforeEach(async () => {
    buyerCookie = await signIn(h, h.buyer.phone);
    supplierCookie = await signIn(h, h.supplier.phone);
    adminCookie = await signIn(h, h.admin.phone);
    await configurePilot(h, adminCookie);

    const created = await createRequestHandler(
      h.services,
      post("/api/requests", VALID_REQUEST, buyerCookie)
    );
    loadId = (await bodyOf(created)).request.id;
  });

  async function quote(holdHours = 4): Promise<string> {
    const response = await createOfferHandler(
      h.services,
      post(
        "/api/offers",
        {
          requestId: loadId,
          landedPricePerGal: 3.42,
          holdHours,
          etaMinutes: 90,
        },
        supplierCookie
      )
    );
    expect(response.status).toBe(201);
    return (await bodyOf(response)).offer.id;
  }

  it("submits a quote and shows it to the buyer with an activeness indicator", async () => {
    const offerId = await quote();

    const listed = await listOffersForRequestHandler(
      h.services,
      get(`/api/requests/${loadId}/offers`, buyerCookie),
      loadId
    );
    expect(listed.status).toBe(200);

    const { offers } = await bodyOf(listed);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      offerId,
      supplierName: "Buckeye Diesel",
      landedPricePerGal: 3.42,
      etaMinutes: 90,
      activeness: "active",
      isActive: true,
    });
    expect(offers[0].expiresAt).toBeTruthy();
  });

  it("maps a hold outside 1-8 hours to 400 on holdHours", async () => {
    const response = await createOfferHandler(
      h.services,
      post(
        "/api/offers",
        { requestId: loadId, landedPricePerGal: 3.4, holdHours: 9 },
        supplierCookie
      )
    );

    expect(response.status).toBe(400);
    const { error } = await bodyOf(response);
    expect(error.code).toBe("HOLD_HOURS_INVALID");
    expect(error.field).toBe("holdHours");
  });

  it("runs accept -> en route -> delivery -> invoice -> mark paid", async () => {
    const offerId = await quote();

    // Accept (Requirement 8.1).
    const accepted = await acceptOfferHandler(
      h.services,
      post(`/api/offers/${offerId}/accept`, {}, buyerCookie),
      offerId
    );
    expect(accepted.status).toBe(201);
    const { order } = await bodyOf(accepted);
    expect(order).toMatchObject({
      status: "accepted",
      requestId: loadId,
      offerId,
      supplierCompanyId: h.supplierCompany.id,
    });

    // En route (Requirement 10.2).
    const enRoute = await advanceOrderStatusHandler(
      h.services,
      post(`/api/orders/${order.id}/status`, { status: "en_route" }, supplierCookie),
      order.id
    );
    expect(enRoute.status).toBe(200);
    expect((await bodyOf(enRoute)).order.status).toBe("en_route");

    // Requirement 10.5 — backward is a conflict.
    const backward = await advanceOrderStatusHandler(
      h.services,
      post(`/api/orders/${order.id}/status`, { status: "accepted" }, supplierCookie),
      order.id
    );
    expect(backward.status).toBe(409);
    expect((await bodyOf(backward)).error.code).toBe("ORDER_STATUS_BACKWARD");

    // Delivery with a photo (Requirements 11.1, 11.6).
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
    const deliveryBody = await bodyOf(delivered);
    expect(deliveryBody.delivery).toMatchObject({
      bolGallons: 2480,
      ticketNumber: "BOL-99321",
    });
    expect(deliveryBody.ticketPhotoStored).toBe(true);
    expect(deliveryBody.delivery.ticketPhotoKey).toMatch(
      new RegExp(`^tickets/${order.id}/[0-9a-f-]+\\.jpg$`)
    );
    expect(h.photos.stored).toHaveLength(1);
    expect(h.photos.stored[0].contentType).toBe("image/jpeg");

    // Requirement 10.6 — the buyer reads the current status.
    const read = await readOrderHandler(
      h.services,
      get(`/api/orders/${order.id}`, buyerCookie),
      order.id
    );
    expect(read.status).toBe(200);
    const readBody = await bodyOf(read);
    expect(readBody.order.status).toBe("delivered");
    expect(readBody.order.delivery.bolGallons).toBe(2480);

    // Requirement 12.8 — the invoice is on the commission-due report.
    const due = await commissionDueHandler(
      h.services,
      get("/api/admin/commission-due", adminCookie)
    );
    expect(due.status).toBe(200);
    const dueBody = await bodyOf(due);
    expect(dueBody.rows).toHaveLength(1);
    expect(dueBody.rows[0]).toMatchObject({
      supplierCompanyId: h.supplierCompany.id,
      // First win, so the commission is waived at $0 but still invoiced Unpaid.
      amountDue: 0,
      unpaidInvoiceCount: 1,
    });

    // Requirement 12.6 — mark paid.
    const invoice = await h.repo.getCommissionInvoiceByOrder(order.id);
    expect(invoice).not.toBeNull();
    const paid = await markInvoicePaidHandler(
      h.services,
      post(`/api/admin/invoices/${invoice!.id}/mark-paid`, {}, adminCookie),
      invoice!.id
    );
    expect(paid.status).toBe(200);
    const paidBody = await bodyOf(paid);
    expect(paidBody.invoice.paymentStatus).toBe("paid");
    expect(paidBody.invoice.paidByAdminId).toBe(h.admin.id);
  });

  it("maps an expired hold on accept to 409 OFFER_EXPIRED", async () => {
    const offerId = await quote(1);
    // Age the hold past its expiry rather than waiting an hour.
    await h.repo.updateOffer(offerId, { expiresAt: new Date(Date.now() - 1000) });

    const response = await acceptOfferHandler(
      h.services,
      post(`/api/offers/${offerId}/accept`, {}, buyerCookie),
      offerId
    );

    expect(response.status).toBe(409);
    expect((await bodyOf(response)).error.code).toBe("OFFER_EXPIRED");
  });

  it("denies a delivery recorded by a company that did not win (403)", async () => {
    const offerId = await quote();
    const accepted = await acceptOfferHandler(
      h.services,
      post(`/api/offers/${offerId}/accept`, {}, buyerCookie),
      offerId
    );
    const { order } = await bodyOf(accepted);

    const response = await recordDeliveryHandler(
      h.services,
      post(
        `/api/orders/${order.id}/delivery`,
        { bolGallons: 10, ticketNumber: "FAKE" },
        buyerCookie
      ),
      order.id
    );

    expect(response.status).toBe(403);
    expect(await h.repo.getDeliveryByOrder(order.id)).toBeNull();
  });

  it("maps a missing ticket number to 400 on ticketNumber", async () => {
    const offerId = await quote();
    const accepted = await acceptOfferHandler(
      h.services,
      post(`/api/offers/${offerId}/accept`, {}, buyerCookie),
      offerId
    );
    const { order } = await bodyOf(accepted);

    const response = await recordDeliveryHandler(
      h.services,
      post(
        `/api/orders/${order.id}/delivery`,
        { bolGallons: 100, ticketNumber: "  " },
        supplierCookie
      ),
      order.id
    );

    expect(response.status).toBe(400);
    const { error } = await bodyOf(response);
    expect(error.code).toBe("TICKET_NUMBER_REQUIRED");
    expect(error.field).toBe("ticketNumber");
  });
});

// ---------------------------------------------------------------------------
// Ticket-photo upload is non-fatal (task 13.2, Requirement 11.6)
// ---------------------------------------------------------------------------

describe("ticket photo upload", () => {
  it("records gallons and ticket number with a null photo key when the upload fails", async () => {
    h = await makeHarness(new FailingTicketPhotoStorage());
    const buyerCookie = await signIn(h, h.buyer.phone);
    const supplierCookie = await signIn(h, h.supplier.phone);
    const adminCookie = await signIn(h, h.admin.phone);
    await configurePilot(h, adminCookie);

    const created = await createRequestHandler(
      h.services,
      post("/api/requests", VALID_REQUEST, buyerCookie)
    );
    const loadId = (await bodyOf(created)).request.id;

    const quoted = await createOfferHandler(
      h.services,
      post(
        "/api/offers",
        { requestId: loadId, landedPricePerGal: 3.5, holdHours: 2 },
        supplierCookie
      )
    );
    const offerId = (await bodyOf(quoted)).offer.id;

    const accepted = await acceptOfferHandler(
      h.services,
      post(`/api/offers/${offerId}/accept`, {}, buyerCookie),
      offerId
    );
    const { order } = await bodyOf(accepted);

    const form = new FormData();
    form.set("bolGallons", "1900");
    form.set("ticketNumber", "BOL-50012");
    form.set(
      "photo",
      new Blob([new Uint8Array([9, 9, 9])], { type: "image/png" }),
      "ticket.png"
    );

    const response = await recordDeliveryHandler(
      h.services,
      new Request(url(`/api/orders/${order.id}/delivery`), {
        method: "POST",
        headers: { Cookie: supplierCookie },
        body: form,
      }),
      order.id
    );

    // The delivery still records — the photo is corroboration, not the record.
    expect(response.status).toBe(201);
    const body = await bodyOf(response);
    expect(body.delivery).toMatchObject({
      bolGallons: 1900,
      ticketNumber: "BOL-50012",
      ticketPhotoKey: null,
    });
    expect(body.ticketPhotoStored).toBe(false);

    const stored = await h.repo.getDeliveryByOrder(order.id);
    expect(stored?.bolGallons).toBe(1900);
    expect(stored?.ticketPhotoKey).toBeNull();
    expect((await h.repo.getOrder(order.id))?.status).toBe("delivered");
  });
});

// ---------------------------------------------------------------------------
// Admin routes (Requirements 16.2, 16.4-16.7, 17.1, 12.7)
// ---------------------------------------------------------------------------

describe("admin routes", () => {
  it("approves a supplier and persists the operating location, radius, and fence", async () => {
    const adminCookie = await signIn(h, h.admin.phone);
    await configurePilot(h, adminCookie);

    const company = await h.repo.getCompany(h.supplierCompany.id);
    expect(company).toMatchObject({
      supplierApprovalStatus: "approved",
      operatingLat: PIN_INSIDE.lat,
      operatingLng: PIN_INSIDE.lng,
      serviceRadiusMiles: 75,
    });
    expect(await h.repo.getPilotGeofence()).toMatchObject(FENCE);
  });

  it("maps a non-positive service radius to 400", async () => {
    const adminCookie = await signIn(h, h.admin.phone);

    const response = await setServiceRadiusHandler(
      h.services,
      post("/api/admin/x/service-radius", { serviceRadiusMiles: 0 }, adminCookie),
      h.supplierCompany.id
    );

    expect(response.status).toBe(400);
    const { error } = await bodyOf(response);
    expect(error.code).toBe("SERVICE_RADIUS_INVALID");
    expect(error.field).toBe("serviceRadiusMiles");
  });

  it("denies every admin route to a non-admin caller (403)", async () => {
    const buyerCookie = await signIn(h, h.buyer.phone);

    const denied = await Promise.all([
      approveSupplierHandler(
        h.services,
        post("/api/admin/x/approve", {}, buyerCookie),
        h.supplierCompany.id
      ),
      setGeofenceHandler(
        h.services,
        post("/api/admin/geofence", FENCE, buyerCookie)
      ),
      commissionDueHandler(
        h.services,
        get("/api/admin/commission-due", buyerCookie)
      ),
      createConciergeOrderHandler(
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
      ),
    ]);

    for (const response of denied) expect(response.status).toBe(403);
  });

  it("onboards a company and a user, and the new user can sign in", async () => {
    const adminCookie = await signIn(h, h.admin.phone);

    // Requirement 16.1 — a new supplier company starts Pending and closed.
    const createdCompany = await createCompanyHandler(
      h.services,
      post(
        "/api/admin/companies",
        { name: "Estrella Fuel", kind: "supplier" },
        adminCookie
      )
    );
    expect(createdCompany.status).toBe(201);
    const { company } = await bodyOf(createdCompany);
    expect(company).toMatchObject({
      name: "Estrella Fuel",
      kind: "supplier",
      supplierApprovalStatus: "pending",
      supplierStatus: "closed",
    });

    // It shows up on the roster the rest of the Admin surface reads.
    const roster = await listCompaniesHandler(
      h.services,
      get("/api/admin/companies", adminCookie)
    );
    const { suppliers } = await bodyOf(roster);
    expect(suppliers.map((c: any) => c.id)).toContain(company.id);

    // Requirements 1.3, 1.4, 1.7 — one company, one role, optional email.
    const createdUser = await createUserHandler(
      h.services,
      post(
        "/api/admin/users",
        {
          companyId: company.id,
          role: "supplier",
          phone: "+1 (602) 555-0144",
          email: " Dispatch@Estrella.COM ",
          password: PASSWORD,
        },
        adminCookie
      )
    );
    expect(createdUser.status).toBe(201);
    const { user } = await bodyOf(createdUser);
    expect(user).toMatchObject({
      companyId: company.id,
      role: "supplier",
      phone: "+16025550144",
      email: "dispatch@estrella.com",
    });
    // The hash never leaves the server.
    expect(JSON.stringify(user)).not.toContain("passwordHash");
    expect((await h.repo.getUser(user.id))?.passwordHash).not.toBe(PASSWORD);

    // The whole point of onboarding: the new seat can actually sign in.
    const signedIn = await loginHandler(
      h.services,
      post("/api/auth/login", { identifier: "+16025550144", password: PASSWORD })
    );
    expect(signedIn.status).toBe(200);
    expect((await bodyOf(signedIn)).role).toBe("supplier");
  });

  it("denies onboarding to a non-admin caller and writes nothing (403)", async () => {
    const buyerCookie = await signIn(h, h.buyer.phone);
    const supplierCookie = await signIn(h, h.supplier.phone);
    const companiesBefore = (await h.repo.listCompanies()).length;

    for (const cookie of [buyerCookie, supplierCookie]) {
      const company = await createCompanyHandler(
        h.services,
        post("/api/admin/companies", { name: "Sneaky Fuel", kind: "supplier" }, cookie)
      );
      expect(company.status).toBe(403);

      const user = await createUserHandler(
        h.services,
        post(
          "/api/admin/users",
          {
            companyId: h.buyerCompany.id,
            role: "admin",
            phone: "+16025550155",
            password: PASSWORD,
          },
          cookie
        )
      );
      expect(user.status).toBe(403);
    }

    // No self-promotion to admin, and no new company.
    expect((await h.repo.listCompanies()).length).toBe(companiesBefore);
    const seats = await h.repo.listUsersByCompany(h.buyerCompany.id);
    expect(seats.map((seat) => seat.role)).toEqual(["buyer"]);
  });

  it("rejects onboarding with no session cookie as 401", async () => {
    const company = await createCompanyHandler(
      h.services,
      post("/api/admin/companies", { name: "Nobody Fuel", kind: "buyer" })
    );
    expect(company.status).toBe(401);

    const user = await createUserHandler(
      h.services,
      post("/api/admin/users", {
        companyId: h.buyerCompany.id,
        role: "buyer",
        phone: "+16025550166",
        password: PASSWORD,
      })
    );
    expect(user.status).toBe(401);
  });

  it("maps onboarding validation failures to 400 on the offending field", async () => {
    const adminCookie = await signIn(h, h.admin.phone);

    const blankName = await createCompanyHandler(
      h.services,
      post("/api/admin/companies", { name: "   ", kind: "buyer" }, adminCookie)
    );
    expect(blankName.status).toBe(400);
    expect((await bodyOf(blankName)).error).toMatchObject({
      code: "COMPANY_NAME_REQUIRED",
      field: "name",
    });

    const badKind = await createCompanyHandler(
      h.services,
      post("/api/admin/companies", { name: "Hauler Co", kind: "hauler" }, adminCookie)
    );
    expect(badKind.status).toBe(400);
    expect((await bodyOf(badKind)).error.field).toBe("kind");

    // Requirement 1.6 — a missing phone number is a validation error.
    const noPhone = await createUserHandler(
      h.services,
      post(
        "/api/admin/users",
        { companyId: h.buyerCompany.id, role: "buyer", password: PASSWORD },
        adminCookie
      )
    );
    expect(noPhone.status).toBe(400);
    expect((await bodyOf(noPhone)).error).toMatchObject({
      code: "PHONE_REQUIRED",
      field: "phone",
    });

    // Requirement 1.3 — a User must belong to an existing Company.
    const noCompany = await createUserHandler(
      h.services,
      post(
        "/api/admin/users",
        {
          companyId: "co-does-not-exist",
          role: "buyer",
          phone: "+16025550177",
          password: PASSWORD,
        },
        adminCookie
      )
    );
    expect(noCompany.status).toBe(400);
    expect((await bodyOf(noCompany)).error.field).toBe("companyId");
  });

  it("creates a concierge order as a Delivered order with its invoice", async () => {
    const adminCookie = await signIn(h, h.admin.phone);

    const response = await createConciergeOrderHandler(
      h.services,
      post(
        "/api/admin/concierge-orders",
        {
          buyerCompanyId: h.buyerCompany.id,
          supplierCompanyId: h.supplierCompany.id,
          bolGallons: 3100,
          ticketNumber: "PHONE-DEAL-1",
        },
        adminCookie
      )
    );

    expect(response.status).toBe(201);
    const { order } = await bodyOf(response);
    expect(order).toMatchObject({
      status: "delivered",
      isConcierge: true,
      buyerCompanyId: h.buyerCompany.id,
      supplierCompanyId: h.supplierCompany.id,
    });

    const delivery = await h.repo.getDeliveryByOrder(order.id);
    expect(delivery).toMatchObject({
      bolGallons: 3100,
      ticketNumber: "PHONE-DEAL-1",
    });
    expect(await h.repo.getCommissionInvoiceByOrder(order.id)).not.toBeNull();
  });
});
