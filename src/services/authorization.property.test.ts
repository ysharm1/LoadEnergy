/**
 * Property-based test for the authorization matrix.
 *
 * Feature: load-energy, Property 36: Role-based authorization is enforced
 * **Validates: Requirements 1.9, 8.5, 9.5, 11.7, 12.7, 16.8, 17.5**
 *
 * The matrix is restated here from the requirements rather than imported from
 * `ACTION_POLICIES`: `allow` on each row lists exactly the callers the spec
 * permits, so the test would still fail if the policy table itself drifted.
 *
 * The subject is real end to end — the real Site/Request/Offer/Order/Admin/
 * Supplier/Matching/Commission services over the real `InMemoryRepository`.
 * Nothing under test is mocked, so a denial has to be produced by the guard on
 * the service entry point, not by a stub standing in for it.
 *
 * Each iteration picks one caller (a role plus a company relationship to the
 * fixture) and walks the whole matrix against a freshly seeded marketplace, so
 * every guarded action is exercised from that seat. A permitted call must
 * complete; a denied call must raise `AuthorizationError` (403) and leave the
 * repository byte-for-byte unchanged.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { AuthorizationError } from "@/domain/errors";
import type {
  AuthContext,
  DeliveryMethod,
  DeliveryWindow,
  Geofence,
  LatLng,
  Offer,
  Order,
  ProductType,
  Request,
  SupplierStatus,
} from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import { AdminService } from "./admin";
import {
  AUTHORIZED_ACTIONS,
  AUTHZ_CODES,
  type AuthorizedAction,
} from "./authorization";
import { CommissionService } from "./commission";
import { CompanyUserService } from "./company-user";
import { MatchingService } from "./matching";
import type { PasswordHasher } from "./password";
import { OfferService } from "./offer";
import { OrderService } from "./order";
import { RequestService } from "./request";
import { SiteService } from "./site";
import { SupplierService } from "./supplier";

const NOW = new Date("2025-03-01T09:00:00Z");

/** The pilot box every generated pin sits inside. */
const FENCE: Geofence = {
  minLat: 33,
  maxLat: 33.9,
  minLng: -112.9,
  maxLng: -111.6,
};

const BUCKEYE: LatLng = { lat: 33.3703, lng: -112.5838 };
/** Generous enough that every in-fence pin is in radius for both suppliers. */
const SEEDED_RADIUS_MILES = 250;

/**
 * Outside the block the fixture's seats are drawn from, so the User the
 * `user.create` row onboards never collides with a seeded phone number.
 */
const ONBOARDED_PHONE = "+16025559001";
const ONBOARDED_PASSWORD = "onboarding-password";

/**
 * A stand-in for the hashing port, which is the one place a real adapter would
 * dominate the run: bcrypt's cost factor is deliberate, and `user.create` is
 * invoked once per iteration. Nothing under test depends on the hash's
 * strength — only on plaintext never reaching the repository, which this still
 * shows.
 */
class FakePasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `fake-hash:${password}`;
  }
  async verify(password: string, hash: string): Promise<boolean> {
    return hash === `fake-hash:${password}`;
  }
  async decoyHash(): Promise<string> {
    return "fake-hash:decoy";
  }
}

// ---------------------------------------------------------------------------
// Callers: role x company relationship to the fixture
// ---------------------------------------------------------------------------

const CALLER_KEYS = [
  /** Buyer on the Company that owns the Request, the Offers, and the Order. */
  "buyerOwner",
  /** Buyer on a different Buyer Company. */
  "buyerOther",
  /** Supplier on the winning Supplier Company. */
  "supplierWinner",
  /** Supplier on a different Supplier Company. */
  "supplierOther",
  /** Admin, who belongs to neither trading company. */
  "admin",
] as const;

type CallerKey = (typeof CALLER_KEYS)[number];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  repo: InMemoryRepository;
  sites: SiteService;
  requests: RequestService;
  offers: OfferService;
  orders: OrderService;
  admin: AdminService;
  suppliers: SupplierService;
  matching: MatchingService;
  commission: CommissionService;
  companies: CompanyUserService;
  ids: {
    buyerCompany: string;
    otherBuyerCompany: string;
    winningSupplier: string;
    otherSupplier: string;
    pendingSupplier: string;
  };
  ctx: Record<CallerKey, AuthContext>;
  /** Open, un-quoted: the target for `offer.create`. */
  quotableRequest: Request;
  /** Open with one live quote: the target for cancel / offer list / accept. */
  openRequest: Request;
  activeOffer: Offer;
  /** Accepted: the target for advance / read / delivery. */
  order: Order;
  /** Unpaid: the target for `invoice.markPaid`. */
  invoiceId: string;
}

interface Scenario {
  caller: CallerKey;
  gallons: number;
  price: number;
  holdHours: number;
  pin: LatLng;
  productType: ProductType;
  deliveryMethod: DeliveryMethod;
  deliveryWindow: DeliveryWindow;
  radiusMiles: number;
  bolGallons: number;
  ticketNumber: string;
  supplierStatus: SupplierStatus;
  siteName: string;
  fence: Geofence;
}

async function makeHarness(scenario: Scenario): Promise<Harness> {
  const repo = new InMemoryRepository();
  const admin = new AdminService({ repo });
  const commission = new CommissionService({ repo });
  const sites = new SiteService({ repo });
  const requests = new RequestService({ repo, admin });
  const offers = new OfferService({ repo });
  const orders = new OrderService({ repo, commission });
  const suppliers = new SupplierService({ repo });
  const matching = new MatchingService({ repo });
  const companies = new CompanyUserService({
    repo,
    hasher: new FakePasswordHasher(),
  });

  let phoneSeq = 0;
  const nextPhone = (): string =>
    `+1602555${String(1000 + (phoneSeq += 1)).padStart(4, "0")}`;

  const buyerCompany = async (name: string) =>
    repo.createCompany({
      name,
      kind: "buyer",
      supplierApprovalStatus: null,
      supplierStatus: null,
      operatingLat: null,
      operatingLng: null,
      serviceRadiusMiles: null,
      createdAt: NOW,
    });

  const supplierCompany = async (
    name: string,
    approval: "pending" | "approved"
  ) =>
    repo.createCompany({
      name,
      kind: "supplier",
      supplierApprovalStatus: approval,
      supplierStatus: "open",
      operatingLat: BUCKEYE.lat,
      operatingLng: BUCKEYE.lng,
      serviceRadiusMiles: SEEDED_RADIUS_MILES,
      createdAt: NOW,
    });

  const owningBuyer = await buyerCompany("SW Valley Concrete");
  const otherBuyer = await buyerCompany("North Phoenix Paving");
  const winningSupplier = await supplierCompany("Buckeye Diesel", "approved");
  const otherSupplier = await supplierCompany("Estrella Fuel", "approved");
  const pendingSupplier = await supplierCompany("Gila Bend Fuel", "pending");
  const adminCompany = await buyerCompany("Load Energy Ops");

  const seat = async (
    companyId: string,
    role: AuthContext["role"]
  ): Promise<AuthContext> => {
    const user = await repo.createUser({
      companyId,
      role,
      phone: nextPhone(),
      email: null,
      passwordHash: "hash",
      createdAt: NOW,
    });
    return { userId: user.id, companyId, role };
  };

  const ctx: Record<CallerKey, AuthContext> = {
    buyerOwner: await seat(owningBuyer.id, "buyer"),
    buyerOther: await seat(otherBuyer.id, "buyer"),
    supplierWinner: await seat(winningSupplier.id, "supplier"),
    supplierOther: await seat(otherSupplier.id, "supplier"),
    admin: await seat(adminCompany.id, "admin"),
  };

  // The fence has to exist before any Request can be posted.
  await admin.setGeofence(ctx.admin, FENCE, NOW);

  const postRequest = async (): Promise<Request> =>
    requests.createRequest(
      ctx.buyerOwner,
      {
        gallons: scenario.gallons,
        productType: scenario.productType,
        deliveryMethod: scenario.deliveryMethod,
        deliveryWindow: scenario.deliveryWindow,
        lat: scenario.pin.lat,
        lng: scenario.pin.lng,
      },
      NOW
    );

  const quotableRequest = await postRequest();
  const openRequest = await postRequest();
  const wonRequest = await postRequest();

  const quote = async (requestId: string): Promise<Offer> =>
    offers.createOffer(
      ctx.supplierWinner,
      {
        requestId,
        landedPricePerGal: scenario.price,
        holdHours: scenario.holdHours,
      },
      NOW
    );

  const activeOffer = await quote(openRequest.id);
  const winningOffer = await quote(wonRequest.id);

  // Accepted, so `order.advance` and `delivery.record` have somewhere to go.
  const order = await orders.acceptOffer(ctx.buyerOwner, winningOffer.id, NOW);

  // A concierge entry is the shortest real path to an Unpaid invoice.
  const billedOrder = await orders.createConciergeOrder(
    ctx.admin,
    {
      buyerCompanyId: owningBuyer.id,
      supplierCompanyId: winningSupplier.id,
      bolGallons: scenario.bolGallons,
      ticketNumber: scenario.ticketNumber,
    },
    NOW
  );
  const invoice = await commission.getInvoiceByOrder(billedOrder.id);
  if (!invoice) throw new Error("fixture: concierge order produced no invoice");

  return {
    repo,
    sites,
    requests,
    offers,
    orders,
    admin,
    suppliers,
    matching,
    commission,
    companies,
    ids: {
      buyerCompany: owningBuyer.id,
      otherBuyerCompany: otherBuyer.id,
      winningSupplier: winningSupplier.id,
      otherSupplier: otherSupplier.id,
      pendingSupplier: pendingSupplier.id,
    },
    ctx,
    quotableRequest,
    openRequest,
    activeOffer,
    order,
    invoiceId: invoice.id,
  };
}

// ---------------------------------------------------------------------------
// The matrix, restated from the requirements
// ---------------------------------------------------------------------------

interface GuardedAction {
  action: AuthorizedAction;
  /** Exactly the callers the spec permits; every other caller is denied. */
  allow: readonly CallerKey[];
  /** Requirement ids this row carries, for traceability. */
  requirements: string;
  invoke(h: Harness, ctx: AuthContext, s: Scenario): Promise<unknown>;
}

const GUARDED_ACTIONS: readonly GuardedAction[] = [
  // --- Buyer surface (Requirement 1.9) ----------------------------------
  {
    action: "site.create",
    allow: ["buyerOwner", "buyerOther"],
    requirements: "1.9",
    invoke: (h, ctx, s) =>
      h.sites.createSite(
        ctx,
        { name: s.siteName, lat: s.pin.lat, lng: s.pin.lng },
        NOW
      ),
  },
  {
    action: "site.list",
    allow: ["buyerOwner"],
    requirements: "1.9",
    invoke: (h, ctx) => h.sites.listSites(ctx, h.ids.buyerCompany),
  },
  {
    action: "request.create",
    allow: ["buyerOwner", "buyerOther"],
    requirements: "1.9",
    invoke: (h, ctx, s) =>
      h.requests.createRequest(
        ctx,
        {
          gallons: s.gallons,
          productType: s.productType,
          deliveryMethod: s.deliveryMethod,
          deliveryWindow: s.deliveryWindow,
          lat: s.pin.lat,
          lng: s.pin.lng,
        },
        NOW
      ),
  },
  {
    action: "request.list",
    allow: ["buyerOwner"],
    requirements: "1.9",
    invoke: (h, ctx) => h.requests.getWorkList(ctx, h.ids.buyerCompany, NOW),
  },
  {
    action: "request.cancel",
    allow: ["buyerOwner"],
    requirements: "1.9, 9.5",
    invoke: (h, ctx) => h.requests.cancelRequest(ctx, h.openRequest.id, NOW),
  },
  {
    action: "offer.list",
    allow: ["buyerOwner"],
    requirements: "1.9",
    invoke: (h, ctx) =>
      h.offers.listOffersForRequest(ctx, h.openRequest.id, NOW),
  },
  {
    action: "offer.accept",
    allow: ["buyerOwner"],
    requirements: "1.9, 8.5",
    invoke: (h, ctx) => h.orders.acceptOffer(ctx, h.activeOffer.id, NOW),
  },

  // --- Supplier surface (Requirement 1.9) -------------------------------
  {
    action: "supplier.setStatus",
    allow: ["supplierWinner"],
    requirements: "1.9",
    invoke: (h, ctx, s) =>
      h.suppliers.setStatus(ctx, s.supplierStatus, h.ids.winningSupplier),
  },
  {
    action: "rfq.list",
    allow: ["supplierWinner"],
    requirements: "1.9",
    invoke: (h, ctx) =>
      h.matching.listRfqInbox(ctx, h.ids.winningSupplier, NOW),
  },
  {
    action: "offer.create",
    allow: ["supplierWinner", "supplierOther"],
    requirements: "1.9",
    invoke: (h, ctx, s) =>
      h.offers.createOffer(
        ctx,
        {
          requestId: h.quotableRequest.id,
          landedPricePerGal: s.price,
          holdHours: s.holdHours,
        },
        NOW
      ),
  },
  {
    action: "order.listWon",
    allow: ["supplierWinner"],
    requirements: "1.9",
    invoke: (h, ctx) => h.orders.listWonOrders(ctx, h.ids.winningSupplier),
  },
  {
    action: "order.advance",
    allow: ["supplierWinner"],
    requirements: "1.9, 11.7",
    invoke: (h, ctx) =>
      h.orders.advanceStatus(ctx, h.order.id, "en_route", NOW),
  },
  {
    action: "delivery.record",
    allow: ["supplierWinner"],
    requirements: "1.9, 11.7",
    invoke: (h, ctx, s) =>
      h.orders.recordDelivery(
        ctx,
        h.order.id,
        { bolGallons: s.bolGallons, ticketNumber: s.ticketNumber },
        NOW
      ),
  },

  // --- Shared: both parties to the Order, plus Admin --------------------
  {
    action: "order.read",
    allow: ["buyerOwner", "supplierWinner", "admin"],
    requirements: "1.9",
    invoke: (h, ctx) => h.orders.readOrder(ctx, h.order.id),
  },

  // --- Admin surface (Requirements 12.7, 16.8, 17.5) --------------------
  /**
   * Onboarding is Admin-only, and the guarded entry point is the only one the
   * HTTP surface can reach — see the two-doors note in
   * `services/company-user.ts`. The unguarded `createCompany`/`createUser`
   * take no `AuthContext` and so cannot be driven from a seat at all.
   */
  {
    action: "company.create",
    allow: ["admin"],
    requirements: "1.9, 16.1",
    invoke: (h, ctx, s) =>
      h.companies.createCompanyAsAdmin(
        ctx,
        { name: `${s.siteName} Fuel`, kind: "supplier" },
        NOW
      ),
  },
  {
    action: "user.create",
    allow: ["admin"],
    requirements: "1.3, 1.4, 1.9",
    invoke: (h, ctx) =>
      h.companies.createUserAsAdmin(
        ctx,
        {
          companyId: h.ids.otherBuyerCompany,
          role: "buyer",
          phone: ONBOARDED_PHONE,
          password: ONBOARDED_PASSWORD,
        },
        NOW
      ),
  },
  {
    action: "supplier.approve",
    allow: ["admin"],
    requirements: "1.9, 16.8",
    invoke: (h, ctx) => h.admin.approveSupplier(ctx, h.ids.pendingSupplier),
  },
  {
    action: "supplier.setOperatingLocation",
    allow: ["admin"],
    requirements: "1.9, 16.8",
    invoke: (h, ctx, s) =>
      h.admin.setOperatingLocation(ctx, h.ids.otherSupplier, s.pin),
  },
  {
    action: "supplier.setServiceRadius",
    allow: ["admin"],
    requirements: "1.9, 16.8",
    invoke: (h, ctx, s) =>
      h.admin.setServiceRadius(ctx, h.ids.otherSupplier, s.radiusMiles),
  },
  {
    action: "geofence.set",
    allow: ["admin"],
    requirements: "1.9, 16.8",
    invoke: (h, ctx, s) => h.admin.setGeofence(ctx, s.fence, NOW),
  },
  {
    action: "order.createConcierge",
    allow: ["admin"],
    requirements: "1.9, 17.5",
    invoke: (h, ctx, s) =>
      h.orders.createConciergeOrder(
        ctx,
        {
          buyerCompanyId: h.ids.buyerCompany,
          supplierCompanyId: h.ids.winningSupplier,
          bolGallons: s.bolGallons,
          ticketNumber: s.ticketNumber,
        },
        NOW
      ),
  },
  {
    action: "invoice.markPaid",
    allow: ["admin"],
    requirements: "1.9, 12.7",
    invoke: (h, ctx) => h.commission.markInvoicePaid(ctx, h.invoiceId, NOW),
  },
  {
    action: "commission.viewDue",
    allow: ["admin"],
    requirements: "1.9, 12.7",
    invoke: (h, ctx) => h.commission.commissionDue(ctx),
  },
];

// ---------------------------------------------------------------------------
// State snapshot — "no state written on a denial"
// ---------------------------------------------------------------------------

/**
 * Every row a guarded action could touch, read back through the repository's
 * own API and serialized. Compared before and after a denied call.
 */
async function snapshot(repo: InMemoryRepository): Promise<string> {
  const companies = await repo.listCompanies();
  const parts: unknown[] = [companies];
  const orderIds: string[] = [];

  for (const company of companies) {
    const orders = [
      ...(await repo.listOrdersByBuyerCompany(company.id)),
      ...(await repo.listOrdersBySupplierCompany(company.id)),
    ];
    for (const order of orders) orderIds.push(order.id);
    parts.push(
      await repo.listUsersByCompany(company.id),
      await repo.listSitesByCompany(company.id),
      await repo.listRequestsByBuyerCompany(company.id),
      await repo.listOffersBySupplierCompany(company.id),
      orders
    );
  }

  for (const orderId of [...new Set(orderIds)].sort()) {
    parts.push(await repo.getDeliveryByOrder(orderId));
  }

  parts.push(
    await repo.listCommissionInvoices(),
    await repo.listAuditEntries(),
    await repo.getPilotGeofence()
  );

  return JSON.stringify(parts);
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A pin strictly inside the pilot fence, at the stored coordinate scale. */
const pinInsideFence: fc.Arbitrary<LatLng> = fc.record({
  lat: fc
    .integer({ min: 0, max: 900 })
    .map((thousandths) => FENCE.minLat + thousandths / 1000),
  lng: fc
    .integer({ min: 0, max: 1300 })
    .map((thousandths) => FENCE.minLng + thousandths / 1000),
});

/** Any valid box an Admin could set (equal bounds allowed). */
const anyFence: fc.Arbitrary<Geofence> = fc
  .tuple(
    fc.integer({ min: -9_000, max: 9_000 }),
    fc.integer({ min: 0, max: 900 }),
    fc.integer({ min: -18_000, max: 18_000 }),
    fc.integer({ min: 0, max: 900 })
  )
  .map(([lat, latSpan, lng, lngSpan]) => ({
    minLat: lat / 100,
    maxLat: Math.min(90, (lat + latSpan) / 100),
    minLng: lng / 100,
    maxLng: Math.min(180, (lng + lngSpan) / 100),
  }));

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  caller: fc.constantFrom(...CALLER_KEYS),
  gallons: fc.integer({ min: 1, max: 20_000 }),
  price: fc
    .integer({ min: 20_000, max: 60_000 })
    .map((tenThousandths) => tenThousandths / 10_000),
  holdHours: fc.integer({ min: 1, max: 8 }),
  pin: pinInsideFence,
  productType: fc.constantFrom<ProductType>("ulsd", "dyed"),
  deliveryMethod: fc.constantFrom<DeliveryMethod>("wet_hose", "yard_tank"),
  deliveryWindow: fc.constantFrom<DeliveryWindow>("today", "tomorrow_am"),
  radiusMiles: fc.integer({ min: 1, max: 400 }),
  bolGallons: fc.integer({ min: 1, max: 20_000 }),
  ticketNumber: fc
    .integer({ min: 1, max: 999_999 })
    .map((n) => `BOL-${String(n).padStart(6, "0")}`),
  supplierStatus: fc.constantFrom<SupplierStatus>("open", "limited", "closed"),
  siteName: fc
    .integer({ min: 1, max: 9_999 })
    .map((n) => `Yard ${String(n).padStart(4, "0")}`),
  fence: anyFence,
});

// ---------------------------------------------------------------------------
// Property 36
// ---------------------------------------------------------------------------

describe("Property 36: Role-based authorization is enforced", () => {
  // Feature: load-energy, Property 36: Role-based authorization is enforced
  // **Validates: Requirements 1.9, 8.5, 9.5, 11.7, 12.7, 16.8, 17.5**
  it("permits a guarded action exactly when the matrix allows the caller's role and company, and otherwise denies it with a 403 and no write (Requirements 1.9, 8.5, 9.5, 11.7, 12.7, 16.8, 17.5)", async () => {
    // The matrix under test is the whole matrix: no guarded action escapes it.
    expect([...GUARDED_ACTIONS.map((row) => row.action)].sort()).toEqual(
      [...AUTHORIZED_ACTIONS].sort()
    );

    const denialCodes = new Set<string>(Object.values(AUTHZ_CODES));

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        for (const row of GUARDED_ACTIONS) {
          // A fresh marketplace per action: a permitted call is allowed to
          // write, and must not change what the next action sees.
          const h = await makeHarness(scenario);
          const ctx = h.ctx[scenario.caller];
          const permitted = row.allow.includes(scenario.caller);
          const before = permitted ? "" : await snapshot(h.repo);

          let denial: unknown;
          let failure: unknown;
          try {
            await row.invoke(h, ctx, scenario);
          } catch (error) {
            if (error instanceof AuthorizationError) denial = error;
            else failure = error;
          }

          const where = `${row.action} as ${scenario.caller} (Requirements ${row.requirements})`;

          if (permitted) {
            // The matrix admits this seat, so the guard must not stand in the
            // way — and nothing else may fail either, since the fixture is
            // built so the action is otherwise valid.
            expect(denial, `denied a permitted action: ${where}`).toBeUndefined();
            expect(failure, `permitted action failed: ${where}`).toBeUndefined();
            continue;
          }

          // Requirement 1.9 and friends: denied, with a 403 authorization error.
          expect(failure, `wrong error class for ${where}`).toBeUndefined();
          expect(denial, `expected a denial for ${where}`).toBeInstanceOf(
            AuthorizationError
          );
          const error = denial as AuthorizationError;
          expect(error.category, where).toBe("authorization");
          expect(error.httpStatus, where).toBe(403);
          expect(denialCodes.has(error.code), `${where}: ${error.code}`).toBe(
            true
          );

          // A denial decides nothing, so it writes nothing.
          expect(await snapshot(h.repo), `state changed on denial: ${where}`).toBe(
            before
          );
        }
      })
    );
  });
});
