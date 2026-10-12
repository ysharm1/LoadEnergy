/**
 * The `Repository` behavioural contract, as a reusable suite.
 *
 * There are two adapters behind the persistence port — the in-memory one the
 * service and property tests run against, and the Prisma one production runs
 * against — and the only thing that stops them drifting is running the same
 * assertions over both. `describeRepositoryContract` is that suite; it is
 * invoked once from `in-memory.test.ts` and once from `prisma.test.ts`.
 *
 * Two consequences shape how it is written:
 *
 *  - **Fixtures are referentially valid.** Postgres enforces the foreign keys
 *    the in-memory maps ignore, so every Request has a real buyer company and
 *    author, every Order has a real Request and Offer, and every
 *    `paidByAdminId` is a real admin. The suite seeds those parents rather
 *    than pointing at invented ids.
 *  - **Order is only asserted where the port guarantees it.** List methods
 *    return creation order; where the service layer sorts for itself, the
 *    suite compares sets.
 *
 * Adapter-specific behaviour (the in-memory id generator, the Prisma error
 * translation table) is tested in the respective test files, not here.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "@/domain/errors";
import type {
  NewCommissionInvoice,
  NewCompany,
  NewDelivery,
  NewOffer,
  NewOrder,
  NewRequest,
  NewSite,
  NewUser,
  Role,
} from "@/domain/types";
import type { Repository } from "./repository";

export const AT = new Date("2025-01-01T00:00:00Z");
export const LATER = new Date("2025-01-01T01:00:00Z");
export const LATEST = new Date("2025-01-01T02:00:00Z");

// ---------------------------------------------------------------------------
// Input builders
// ---------------------------------------------------------------------------

export function buyerCompany(name: string): NewCompany {
  return {
    name,
    kind: "buyer",
    supplierApprovalStatus: null,
    supplierStatus: null,
    operatingLat: null,
    operatingLng: null,
    serviceRadiusMiles: null,
    createdAt: AT,
  };
}

export function supplierCompany(name: string): NewCompany {
  return {
    ...buyerCompany(name),
    kind: "supplier",
    supplierApprovalStatus: "approved",
    supplierStatus: "open",
    operatingLat: 33.4,
    operatingLng: -112.3,
    serviceRadiusMiles: 25,
  };
}

export function user(
  companyId: string,
  phone: string,
  email: string | null = null,
  role: Role = "buyer"
): NewUser {
  return {
    companyId,
    role,
    phone,
    email,
    passwordHash: "hash",
    createdAt: AT,
  };
}

function site(companyId: string, name: string): NewSite {
  return { companyId, name, lat: 33.45, lng: -112.07, createdAt: AT };
}

function request(
  buyerCompanyId: string,
  createdByUserId: string,
  overrides: Partial<NewRequest> = {}
): NewRequest {
  return {
    buyerCompanyId,
    createdByUserId,
    gallons: 500,
    productType: "ulsd",
    deliveryMethod: "wet_hose",
    deliveryWindow: "today",
    pinLat: 33.45,
    pinLng: -112.07,
    notes: null,
    status: "open",
    windowEndsAt: LATER,
    createdAt: AT,
    ...overrides,
  };
}

function offer(
  requestId: string,
  supplierCompanyId: string,
  createdByUserId: string,
  overrides: Partial<NewOffer> = {}
): NewOffer {
  return {
    requestId,
    supplierCompanyId,
    createdByUserId,
    landedPricePerGal: 3.4567,
    holdHours: 4,
    etaMinutes: 90,
    createdAt: AT,
    expiresAt: LATER,
    voided: false,
    status: "active",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Seeded world: the parent rows the foreign keys require
// ---------------------------------------------------------------------------

interface World {
  buyerCompanyId: string;
  supplierCompanyId: string;
  buyerUserId: string;
  supplierUserId: string;
  adminUserId: string;
}

async function seedWorld(repo: Repository): Promise<World> {
  const buyerCo = await repo.createCompany(buyerCompany("Acme Job Sites"));
  const supplierCo = await repo.createCompany(supplierCompany("Valley Diesel"));
  const opsCo = await repo.createCompany(buyerCompany("Load Energy Ops"));

  const buyerUser = await repo.createUser(
    user(buyerCo.id, "+16025550100", "super@acme.test")
  );
  const supplierUser = await repo.createUser(
    user(supplierCo.id, "+16025550200", null, "supplier")
  );
  const adminUser = await repo.createUser(
    user(opsCo.id, "+16025550300", "admin@loadenergy.test", "admin")
  );

  return {
    buyerCompanyId: buyerCo.id,
    supplierCompanyId: supplierCo.id,
    buyerUserId: buyerUser.id,
    supplierUserId: supplierUser.id,
    adminUserId: adminUser.id,
  };
}

/** A Request with one live Offer on it — the precondition for an Order. */
async function seedQuotedRequest(repo: Repository, world: World) {
  const req = await repo.createRequest(
    request(world.buyerCompanyId, world.buyerUserId)
  );
  const quote = await repo.createOffer(
    offer(req.id, world.supplierCompanyId, world.supplierUserId)
  );
  return { request: req, offer: quote };
}

function appOrder(
  world: World,
  requestId: string,
  offerId: string,
  overrides: Partial<NewOrder> = {}
): NewOrder {
  return {
    requestId,
    offerId,
    buyerCompanyId: world.buyerCompanyId,
    supplierCompanyId: world.supplierCompanyId,
    status: "accepted",
    isConcierge: false,
    createdAt: AT,
    ...overrides,
  };
}

function conciergeOrder(world: World): NewOrder {
  return {
    requestId: null,
    offerId: null,
    buyerCompanyId: world.buyerCompanyId,
    supplierCompanyId: world.supplierCompanyId,
    status: "delivered",
    isConcierge: true,
    createdAt: AT,
  };
}

async function conflictFrom(promise: Promise<unknown>): Promise<ConflictError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictError);
    return error as ConflictError;
  }
  throw new Error("expected the operation to reject with a ConflictError");
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface RepositoryContractHooks {
  /** Suite name, e.g. `"InMemoryRepository"`. */
  label: string;
  /** Skips the whole suite (no database configured) without failing it. */
  skip?: boolean;
  /** Returns a repository over empty storage. Called before each test. */
  create: () => Repository | Promise<Repository>;
  /** Drops all stored state. Called before each test, ahead of `create`. */
  reset?: () => Promise<void>;
  /** Releases resources once the suite is done. */
  teardown?: () => Promise<void>;
}

export function describeRepositoryContract(
  hooks: RepositoryContractHooks
): void {
  const suite = hooks.skip ? describe.skip : describe;

  suite(`${hooks.label} (Repository contract)`, () => {
    let repo: Repository;

    beforeEach(async () => {
      await hooks.reset?.();
      repo = await hooks.create();
    });

    afterAll(async () => {
      await hooks.teardown?.();
    });

    // --- Company -----------------------------------------------------------

    it("assigns an id and round-trips a created record", async () => {
      const created = await repo.createCompany(buyerCompany("Acme Job Sites"));

      expect(created.id).toBeTruthy();
      expect(await repo.getCompany(created.id)).toEqual(created);
    });

    it("does not expose internal state through returned references", async () => {
      const created = await repo.createCompany(buyerCompany("Mutable Co"));
      created.name = "Tampered";

      const fetched = await repo.getCompany(created.id);
      expect(fetched?.name).toBe("Mutable Co");
    });

    it("returns null rather than throwing for an unknown id", async () => {
      expect(await repo.getCompany("missing")).toBeNull();
      expect(await repo.getUser("missing")).toBeNull();
      expect(await repo.getUserByPhone("+10000000000")).toBeNull();
      expect(await repo.getUserByEmail("nobody@example.test")).toBeNull();
      expect(await repo.getSite("missing")).toBeNull();
      expect(await repo.getRequest("missing")).toBeNull();
      expect(await repo.getOffer("missing")).toBeNull();
      expect(await repo.getOrder("missing")).toBeNull();
      expect(await repo.getOrderByRequest("missing")).toBeNull();
      expect(await repo.getOrderByOffer("missing")).toBeNull();
      expect(await repo.getDelivery("missing")).toBeNull();
      expect(await repo.getDeliveryByOrder("missing")).toBeNull();
      expect(await repo.getCommissionInvoice("missing")).toBeNull();
      expect(await repo.getCommissionInvoiceByOrder("missing")).toBeNull();
      expect(await repo.getPilotGeofence()).toBeNull();
    });

    it("persists a supplier company's Admin-set operating pin and radius", async () => {
      const created = await repo.createCompany(supplierCompany("Valley Diesel"));

      const fetched = await repo.getCompany(created.id);
      expect(fetched?.operatingLat).toBe(33.4);
      expect(fetched?.operatingLng).toBe(-112.3);
      expect(fetched?.serviceRadiusMiles).toBe(25);
      expect(await repo.listSupplierCompanies()).toHaveLength(1);
    });

    it("lists supplier companies without the buyers", async () => {
      await repo.createCompany(buyerCompany("Acme Job Sites"));
      const supplier = await repo.createCompany(supplierCompany("Buckeye"));

      expect((await repo.listSupplierCompanies()).map((c) => c.id)).toEqual([
        supplier.id,
      ]);
      expect(await repo.listCompanies()).toHaveLength(2);
    });

    it("patches a company and reports a missing one as a conflict", async () => {
      const supplier = await repo.createCompany(supplierCompany("Goodyear"));

      const updated = await repo.updateCompany(supplier.id, {
        supplierStatus: "closed",
        serviceRadiusMiles: 40,
      });
      expect(updated.id).toBe(supplier.id);
      expect(updated.supplierStatus).toBe("closed");
      expect(updated.serviceRadiusMiles).toBe(40);
      expect(updated.name).toBe("Goodyear");

      const conflict = await conflictFrom(
        repo.updateCompany("missing", { supplierStatus: "open" })
      );
      expect(conflict.code).toBe("COMPANY_NOT_FOUND");
    });

    // --- User --------------------------------------------------------------

    it("treats phone as unique and email as optional", async () => {
      const company = await repo.createCompany(buyerCompany("Acme Job Sites"));
      await repo.createUser(
        user(company.id, "+16025550100", "super@acme.test")
      );

      // A second user may omit email entirely.
      const noEmail = await repo.createUser(user(company.id, "+16025550101"));
      expect(noEmail.email).toBeNull();

      const phoneTaken = await conflictFrom(
        repo.createUser(user(company.id, "+16025550100"))
      );
      expect(phoneTaken.code).toBe("USER_PHONE_TAKEN");

      const emailTaken = await conflictFrom(
        repo.createUser(user(company.id, "+16025550102", "super@acme.test"))
      );
      expect(emailTaken.code).toBe("USER_EMAIL_TAKEN");

      expect((await repo.getUserByPhone("+16025550101"))?.email).toBeNull();
      expect((await repo.getUserByEmail("super@acme.test"))?.phone).toBe(
        "+16025550100"
      );
    });

    it("lists a company's users and nobody else's", async () => {
      const world = await seedWorld(repo);

      const buyerSeats = await repo.listUsersByCompany(world.buyerCompanyId);
      expect(buyerSeats.map((u) => u.id)).toEqual([world.buyerUserId]);
      expect(await repo.listUsersByCompany("missing")).toEqual([]);
    });

    // --- Site --------------------------------------------------------------

    it("stores sites against their company", async () => {
      const world = await seedWorld(repo);
      const yard = await repo.createSite(site(world.buyerCompanyId, "Yard 1"));

      expect(await repo.getSite(yard.id)).toEqual(yard);
      expect(
        (await repo.listSitesByCompany(world.buyerCompanyId)).map((s) => s.name)
      ).toEqual(["Yard 1"]);
      expect(await repo.listSitesByCompany(world.supplierCompanyId)).toEqual([]);
    });

    // --- Request -----------------------------------------------------------

    it("round-trips a request and indexes it by company and status", async () => {
      const world = await seedWorld(repo);
      const open = await repo.createRequest(
        request(world.buyerCompanyId, world.buyerUserId, {
          notes: "Gate code 1234",
        })
      );

      expect(await repo.getRequest(open.id)).toEqual(open);
      expect(open.notes).toBe("Gate code 1234");
      expect(open.windowEndsAt).toEqual(LATER);
      expect(
        (await repo.listRequestsByBuyerCompany(world.buyerCompanyId)).map(
          (r) => r.id
        )
      ).toEqual([open.id]);
      expect((await repo.listRequestsByStatus("open")).map((r) => r.id)).toEqual(
        [open.id]
      );
      expect(await repo.listRequestsByStatus("expired")).toEqual([]);
    });

    it("patches a request's status and reports a missing one as a conflict", async () => {
      const world = await seedWorld(repo);
      const open = await repo.createRequest(
        request(world.buyerCompanyId, world.buyerUserId)
      );

      const cancelled = await repo.updateRequest(open.id, {
        status: "cancelled",
      });
      expect(cancelled.id).toBe(open.id);
      expect(cancelled.status).toBe("cancelled");
      expect(await repo.listRequestsByStatus("open")).toEqual([]);

      const conflict = await conflictFrom(
        repo.updateRequest("missing", { status: "expired" })
      );
      expect(conflict.code).toBe("REQUEST_NOT_FOUND");
    });

    // --- Offer -------------------------------------------------------------

    it("round-trips an offer's landed price as a plain number", async () => {
      const world = await seedWorld(repo);
      const { offer: quote } = await seedQuotedRequest(repo, world);

      expect(typeof quote.landedPricePerGal).toBe("number");
      expect(quote.landedPricePerGal).toBe(3.4567);

      const fetched = await repo.getOffer(quote.id);
      expect(fetched?.landedPricePerGal).toBe(3.4567);
      expect(fetched?.etaMinutes).toBe(90);
      expect(fetched?.expiresAt).toEqual(LATER);
    });

    it("indexes offers by request and by supplier company", async () => {
      const world = await seedWorld(repo);
      const { request: req, offer: quote } = await seedQuotedRequest(
        repo,
        world
      );

      expect((await repo.listOffersByRequest(req.id)).map((o) => o.id)).toEqual([
        quote.id,
      ]);
      expect(
        (
          await repo.listOffersBySupplierCompany(world.supplierCompanyId)
        ).map((o) => o.id)
      ).toEqual([quote.id]);
      expect(await repo.listOffersByRequest("missing")).toEqual([]);
    });

    it("patches an offer and reports a missing one as a conflict", async () => {
      const world = await seedWorld(repo);
      const { offer: quote } = await seedQuotedRequest(repo, world);

      const voided = await repo.updateOffer(quote.id, {
        voided: true,
        status: "voided",
      });
      expect(voided.id).toBe(quote.id);
      expect(voided.voided).toBe(true);
      expect(voided.status).toBe("voided");
      expect(voided.landedPricePerGal).toBe(3.4567);

      const conflict = await conflictFrom(
        repo.updateOffer("missing", { status: "expired" })
      );
      expect(conflict.code).toBe("OFFER_NOT_FOUND");
    });

    // --- Order -------------------------------------------------------------

    it("rejects a duplicate order for the same request", async () => {
      const world = await seedWorld(repo);
      const { request: req, offer: first } = await seedQuotedRequest(
        repo,
        world
      );
      const second = await repo.createOffer(
        offer(req.id, world.supplierCompanyId, world.supplierUserId)
      );

      await repo.createOrder(appOrder(world, req.id, first.id));
      const conflict = await conflictFrom(
        repo.createOrder(appOrder(world, req.id, second.id))
      );
      expect(conflict.code).toBe("ORDER_REQUEST_TAKEN");
    });

    it("rejects a duplicate order for the same offer", async () => {
      const world = await seedWorld(repo);
      const { request: first, offer: quote } = await seedQuotedRequest(
        repo,
        world
      );
      const other = await repo.createRequest(
        request(world.buyerCompanyId, world.buyerUserId)
      );

      await repo.createOrder(appOrder(world, first.id, quote.id));
      const conflict = await conflictFrom(
        repo.createOrder(appOrder(world, other.id, quote.id))
      );
      expect(conflict.code).toBe("ORDER_OFFER_TAKEN");
    });

    it("allows multiple concierge orders with no request or offer", async () => {
      const world = await seedWorld(repo);
      await repo.createOrder(conciergeOrder(world));
      await repo.createOrder(conciergeOrder(world));

      expect(
        await repo.listOrdersBySupplierCompany(world.supplierCompanyId)
      ).toHaveLength(2);
      expect(
        await repo.countDeliveredOrdersBySupplier(world.supplierCompanyId)
      ).toBe(2);
    });

    it("looks an order up by its request and by its winning offer", async () => {
      const world = await seedWorld(repo);
      const { request: req, offer: quote } = await seedQuotedRequest(
        repo,
        world
      );
      const order = await repo.createOrder(appOrder(world, req.id, quote.id));

      expect((await repo.getOrderByRequest(req.id))?.id).toBe(order.id);
      expect((await repo.getOrderByOffer(quote.id))?.id).toBe(order.id);
      expect(
        (await repo.listOrdersByBuyerCompany(world.buyerCompanyId)).map(
          (o) => o.id
        )
      ).toEqual([order.id]);
    });

    it("advances an order's status and reports a missing one as a conflict", async () => {
      const world = await seedWorld(repo);
      const { request: req, offer: quote } = await seedQuotedRequest(
        repo,
        world
      );
      const order = await repo.createOrder(appOrder(world, req.id, quote.id));

      const enRoute = await repo.updateOrder(order.id, { status: "en_route" });
      expect(enRoute.status).toBe("en_route");
      expect(
        await repo.countDeliveredOrdersBySupplier(world.supplierCompanyId)
      ).toBe(0);

      const delivered = await repo.updateOrder(order.id, {
        status: "delivered",
      });
      expect(delivered.status).toBe("delivered");
      expect(
        await repo.countDeliveredOrdersBySupplier(world.supplierCompanyId)
      ).toBe(1);

      const conflict = await conflictFrom(
        repo.updateOrder("missing", { status: "delivered" })
      );
      expect(conflict.code).toBe("ORDER_NOT_FOUND");
    });

    // --- Delivery ----------------------------------------------------------

    it("enforces the unique Delivery.orderId constraint", async () => {
      const world = await seedWorld(repo);
      const { request: req, offer: quote } = await seedQuotedRequest(
        repo,
        world
      );
      const order = await repo.createOrder(appOrder(world, req.id, quote.id));

      const input: NewDelivery = {
        orderId: order.id,
        bolGallons: 400,
        ticketNumber: "T-1",
        ticketPhotoKey: null,
        deliveredAt: AT,
      };
      const delivery = await repo.createDelivery(input);
      const conflict = await conflictFrom(repo.createDelivery(input));
      expect(conflict.code).toBe("DELIVERY_EXISTS");

      expect(await repo.getDelivery(delivery.id)).toEqual(delivery);
      expect(await repo.getDeliveryByOrder(order.id)).toEqual(delivery);
      expect(delivery.ticketPhotoKey).toBeNull();
    });

    // --- CommissionInvoice -------------------------------------------------

    it("enforces the unique CommissionInvoice.orderId constraint", async () => {
      const world = await seedWorld(repo);
      const { request: req, offer: quote } = await seedQuotedRequest(
        repo,
        world
      );
      const order = await repo.createOrder(appOrder(world, req.id, quote.id));

      const invoiceInput: NewCommissionInvoice = {
        orderId: order.id,
        supplierCompanyId: world.supplierCompanyId,
        bolGallons: 500,
        amount: 10,
        waived: false,
        paymentStatus: "unpaid",
        paidByAdminId: null,
        paidAt: null,
        createdAt: AT,
      };

      const invoice = await repo.createCommissionInvoice(invoiceInput);
      const conflict = await conflictFrom(
        repo.createCommissionInvoice(invoiceInput)
      );
      expect(conflict.code).toBe("INVOICE_EXISTS");

      const paid = await repo.updateCommissionInvoice(invoice.id, {
        paymentStatus: "paid",
        paidByAdminId: world.adminUserId,
        paidAt: AT,
      });
      expect(paid.paymentStatus).toBe("paid");
      expect(paid.paidByAdminId).toBe(world.adminUserId);
      expect(paid.paidAt).toEqual(AT);
    });

    it("keeps invoice amounts as plain numbers and indexes them by supplier", async () => {
      const world = await seedWorld(repo);
      const { request: req, offer: quote } = await seedQuotedRequest(
        repo,
        world
      );
      const order = await repo.createOrder(appOrder(world, req.id, quote.id));

      const invoice = await repo.createCommissionInvoice({
        orderId: order.id,
        supplierCompanyId: world.supplierCompanyId,
        bolGallons: 512,
        amount: 10.24,
        waived: false,
        paymentStatus: "unpaid",
        paidByAdminId: null,
        paidAt: null,
        createdAt: AT,
      });

      expect(typeof invoice.amount).toBe("number");
      expect(invoice.amount).toBe(10.24);
      expect((await repo.getCommissionInvoice(invoice.id))?.amount).toBe(10.24);
      expect((await repo.getCommissionInvoiceByOrder(order.id))?.id).toBe(
        invoice.id
      );
      expect((await repo.listCommissionInvoices()).map((i) => i.id)).toEqual([
        invoice.id,
      ]);
      expect(
        (
          await repo.listCommissionInvoicesBySupplier(world.supplierCompanyId)
        ).map((i) => i.id)
      ).toEqual([invoice.id]);
      expect(
        await repo.listCommissionInvoicesBySupplier(world.buyerCompanyId)
      ).toEqual([]);

      const conflict = await conflictFrom(
        repo.updateCommissionInvoice("missing", { paymentStatus: "paid" })
      );
      expect(conflict.code).toBe("INVOICE_NOT_FOUND");
    });

    it("records a waived invoice as a zero amount", async () => {
      const world = await seedWorld(repo);
      const { request: req, offer: quote } = await seedQuotedRequest(
        repo,
        world
      );
      const order = await repo.createOrder(appOrder(world, req.id, quote.id));

      const waived = await repo.createCommissionInvoice({
        orderId: order.id,
        supplierCompanyId: world.supplierCompanyId,
        bolGallons: 500,
        amount: 0,
        waived: true,
        paymentStatus: "unpaid",
        paidByAdminId: null,
        paidAt: null,
        createdAt: AT,
      });

      expect(waived.waived).toBe(true);
      expect(waived.amount).toBe(0);
      expect((await repo.getCommissionInvoice(waived.id))?.amount).toBe(0);
    });

    // --- AuditEntry --------------------------------------------------------

    it("keeps the audit log append-only and monotonic", async () => {
      const world = await seedWorld(repo);
      await repo.appendAuditEntry({
        actorUserId: world.buyerUserId,
        action: "OFFER_SUBMITTED",
        subjectId: "request-1",
        payload: null,
        createdAt: AT,
      });
      // System-driven expiry has no acting user.
      await repo.appendAuditEntry({
        actorUserId: null,
        action: "REQUEST_EXPIRED",
        subjectId: "request-1",
        payload: { from: "open", to: "expired" },
        createdAt: LATER,
      });

      const entries = await repo.listAuditEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].action).toBe("OFFER_SUBMITTED");
      expect(entries[0].payload).toBeNull();
      expect(entries[1].actorUserId).toBeNull();
      expect(entries[1].payload).toEqual({ from: "open", to: "expired" });
      expect(await repo.countAuditEntries()).toBe(2);
      expect(await repo.listAuditEntriesBySubject("request-1")).toHaveLength(2);
      expect(await repo.listAuditEntriesBySubject("request-2")).toEqual([]);

      // The repository exposes no update or delete path for audit entries.
      expect("updateAuditEntry" in repo).toBe(false);
      expect("deleteAuditEntry" in repo).toBe(false);
    });

    // --- Ordering ----------------------------------------------------------

    it("returns list results in creation order", async () => {
      const world = await seedWorld(repo);
      const first = await repo.createRequest(
        request(world.buyerCompanyId, world.buyerUserId, { createdAt: AT })
      );
      const second = await repo.createRequest(
        request(world.buyerCompanyId, world.buyerUserId, { createdAt: LATER })
      );
      const third = await repo.createRequest(
        request(world.buyerCompanyId, world.buyerUserId, { createdAt: LATEST })
      );

      expect(
        (await repo.listRequestsByBuyerCompany(world.buyerCompanyId)).map(
          (r) => r.id
        )
      ).toEqual([first.id, second.id, third.id]);
      expect((await repo.listRequestsByStatus("open")).map((r) => r.id)).toEqual(
        [first.id, second.id, third.id]
      );
    });

    // --- PilotGeofence -----------------------------------------------------

    it("upserts the single pilot geofence", async () => {
      const world = await seedWorld(repo);
      expect(await repo.getPilotGeofence()).toBeNull();

      const first = await repo.setPilotGeofence({
        minLat: 33.2,
        maxLat: 33.6,
        minLng: -112.6,
        maxLng: -112.1,
        setByAdminId: world.adminUserId,
        updatedAt: AT,
      });
      const second = await repo.setPilotGeofence({
        minLat: 33.0,
        maxLat: 33.9,
        minLng: -112.9,
        maxLng: -111.9,
        setByAdminId: world.adminUserId,
        updatedAt: LATER,
      });

      expect(second.id).toBe(first.id);
      expect(second.minLat).toBe(33.0);
      expect(second.maxLng).toBe(-111.9);
      // The caller owns the timestamp, so the `@updatedAt` column stores what
      // was passed rather than wall-clock now.
      expect(second.updatedAt).toEqual(LATER);
      expect(await repo.getPilotGeofence()).toEqual(second);
    });
  });
}
