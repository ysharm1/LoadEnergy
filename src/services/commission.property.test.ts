/**
 * Property-based tests for the commission ledger: what a Delivered load owes,
 * the invoice that records it, the Admin's mark-paid, and the commission-due
 * report.
 *
 * Feature: load-energy — Property 26 (task 10.4), Property 27 (task 10.5),
 * Property 28 (task 10.6), Property 29 (task 10.7), Property 30 (task 10.8).
 *
 * The subject is real throughout: the real `CommissionService` over the real
 * `OrderService` and `OfferService` over the real `InMemoryRepository` (which
 * enforces the unique `CommissionInvoice.orderId` and `Delivery.orderId`
 * constraints the Prisma schema declares). Every billed load is a genuinely
 * won one — quoted through `createOffer`, accepted through `acceptOffer`, and
 * delivered through `recordDelivery` — so the win count the waiver turns on is
 * the one the marketplace actually produced. Nothing under test is mocked.
 *
 * Expected money is computed independently of the service: a gallon costs two
 * cents, so the billed amount is `round(gallons x 2) / 100` worked out in
 * integer cents here rather than by reusing `roundToCents`.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  COMMISSION_RATE_PER_GAL,
  MAX_HOLD_HOURS,
  WAIVED_WIN_LIMIT,
  type AuthContext,
  type CommissionInvoice,
  type Company,
  type Delivery,
  type Order,
} from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import {
  CommissionService,
  commissionAmount,
  commissionTerms,
  isWaivedWin,
} from "./commission";
import { OfferService } from "./offer";
import { OrderService } from "./order";

const HOUR = 3_600_000;

const BUCKEYE = { lat: 33.3703, lng: -112.5838 };
const GOODYEAR = { lat: 33.4353, lng: -112.3576 };
const SERVICE_RADIUS_MILES = 50;

const NOW = new Date("2025-03-01T09:00:00Z");

// ---------------------------------------------------------------------------
// Independent money arithmetic
// ---------------------------------------------------------------------------

/**
 * The commission a billable load of `bolGallons` owes, in dollars, derived from
 * the rate rather than from the service's own helper: $0.02/gal is two cents a
 * gallon, so the amount is an exact number of cents.
 */
function expectedBilledAmount(bolGallons: number): number {
  return Math.round(bolGallons * COMMISSION_RATE_PER_GAL * 100) / 100;
}

/** Whole cents, for summing many amounts without float drift. */
function cents(amount: number): number {
  return Math.round(amount * 100);
}

// ---------------------------------------------------------------------------
// Harness — one Buyer Company, two Admins, and `supplierCount` eligible sellers
// ---------------------------------------------------------------------------

interface SupplierSeat {
  company: Company;
  ctx: AuthContext;
}

interface Harness {
  repo: InMemoryRepository;
  offers: OfferService;
  orders: OrderService;
  commission: CommissionService;
  buyer: AuthContext;
  /** Two Admin seats, so mark-paid can be repeated by a different Admin. */
  admins: AuthContext[];
  suppliers: SupplierSeat[];
  /** Monotonic BOL ticket numbers, so a load is identifiable in a failure. */
  nextTicket(): string;
}

async function makeHarness(
  supplierCount: number,
  createdAt: Date = NOW
): Promise<Harness> {
  const repo = new InMemoryRepository();
  const commission = new CommissionService({ repo });
  const offers = new OfferService({ repo });
  // Wired exactly as production wires it: a Delivered load bills itself.
  const orders = new OrderService({ repo, commission });

  const buyerCo = await repo.createCompany({
    name: "SW Valley Concrete",
    kind: "buyer",
    supplierApprovalStatus: null,
    supplierStatus: null,
    operatingLat: null,
    operatingLng: null,
    serviceRadiusMiles: null,
    createdAt,
  });

  async function seat(
    companyId: string,
    role: AuthContext["role"],
    phone: string
  ): Promise<AuthContext> {
    const user = await repo.createUser({
      companyId,
      role,
      phone,
      email: null,
      passwordHash: "hash",
      createdAt,
    });
    return { userId: user.id, companyId, role };
  }

  const buyer = await seat(buyerCo.id, "buyer", "+16025550101");
  const admins = [
    await seat(buyerCo.id, "admin", "+16025550100"),
    await seat(buyerCo.id, "admin", "+16025550109"),
  ];

  const suppliers: SupplierSeat[] = [];
  for (let index = 0; index < supplierCount; index += 1) {
    const company = await repo.createCompany({
      name: `Supplier ${index} Diesel`,
      kind: "supplier",
      supplierApprovalStatus: "approved",
      // Open and Limited both quote and both can win (Requirement 5.3).
      supplierStatus: index % 2 === 0 ? "open" : "limited",
      operatingLat: BUCKEYE.lat,
      operatingLng: BUCKEYE.lng,
      serviceRadiusMiles: SERVICE_RADIUS_MILES,
      createdAt,
    });
    suppliers.push({
      company,
      ctx: await seat(
        company.id,
        "supplier",
        `+1602555${String(2000 + index).padStart(4, "0")}`
      ),
    });
  }

  let ticket = 0;

  return {
    repo,
    offers,
    orders,
    commission,
    buyer,
    admins,
    suppliers,
    nextTicket: () => {
      ticket += 1;
      return `BOL-${String(ticket).padStart(5, "0")}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Load helpers — every Order is won through the real marketplace path
// ---------------------------------------------------------------------------

/** A won (Accepted) Order for supplier `index`, with no Delivery yet. */
async function wonOrder(
  h: Harness,
  index: number,
  at: Date = NOW
): Promise<Order> {
  const request = await h.repo.createRequest({
    buyerCompanyId: h.buyer.companyId,
    createdByUserId: h.buyer.userId,
    gallons: 500,
    productType: "ulsd",
    deliveryMethod: "wet_hose",
    deliveryWindow: "today",
    pinLat: GOODYEAR.lat,
    pinLng: GOODYEAR.lng,
    notes: null,
    status: "open",
    windowEndsAt: new Date(at.getTime() + 8 * HOUR),
    createdAt: at,
  });
  const offer = await h.offers.createOffer(
    h.suppliers[index].ctx,
    {
      requestId: request.id,
      landedPricePerGal: 3.4,
      holdHours: MAX_HOLD_HOURS,
      etaMinutes: null,
    },
    at
  );
  return h.orders.acceptOffer(h.buyer, offer.id, at);
}

interface DeliveredLoad {
  order: Order;
  delivery: Delivery;
}

/** A won Order carried all the way to Delivered with its BOL on file. */
async function deliverLoad(
  h: Harness,
  index: number,
  bolGallons: number,
  at: Date = NOW
): Promise<DeliveredLoad> {
  const order = await wonOrder(h, index, at);
  const delivery = await h.orders.recordDelivery(
    h.suppliers[index].ctx,
    order.id,
    { bolGallons, ticketNumber: h.nextTicket() },
    at
  );
  return { order, delivery };
}

/**
 * A concierge-shaped load: an Order landed straight at Delivered with its
 * Delivery and no originating Request or Offer, which is what task 12.3 will
 * create. No invoice yet — the caller drives the shared, origin-agnostic
 * generation entry point (Requirement 17.3).
 */
async function conciergeLoad(
  h: Harness,
  index: number,
  bolGallons: number,
  at: Date = NOW
): Promise<DeliveredLoad> {
  const order = await h.repo.createOrder({
    requestId: null,
    offerId: null,
    buyerCompanyId: h.buyer.companyId,
    supplierCompanyId: h.suppliers[index].company.id,
    status: "delivered",
    isConcierge: true,
    createdAt: at,
  });
  const delivery = await h.repo.createDelivery({
    orderId: order.id,
    bolGallons,
    ticketNumber: h.nextTicket(),
    ticketPhotoKey: null,
    deliveredAt: at,
  });
  return { order, delivery };
}

/** The invoice on a load, or null. */
async function invoiceFor(
  h: Harness,
  orderId: string
): Promise<CommissionInvoice | null> {
  return h.repo.getCommissionInvoiceByOrder(orderId);
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Whole gallon counts above zero: tanker-realistic, plus the boundary at 1. */
const validBolGallons = fc.oneof(
  { arbitrary: fc.integer({ min: 1, max: 12_000 }), weight: 5 },
  { arbitrary: fc.constantFrom(1, 2, 3, 50, 1_235, 7_500), weight: 3 },
  { arbitrary: fc.integer({ min: 1, max: 2_000_000 }), weight: 1 }
);

const instant = fc.date({
  min: new Date("2025-01-01T00:00:00.000Z"),
  max: new Date("2026-12-31T23:59:59.000Z"),
  noInvalidDate: true,
});

/**
 * One seller's run of deliveries. Length crosses the waiver boundary in both
 * directions: runs of 1 and 2 stop inside the allowance, 3 lands exactly on the
 * first billed win, and longer runs go past it.
 */
const gallonRun = fc.array(validBolGallons, { minLength: 1, maxLength: 5 });

/** Several sellers' runs, so the waiver is shown to be per Supplier Company. */
const gallonRuns = fc.array(gallonRun, { minLength: 1, maxLength: 3 });

// ---------------------------------------------------------------------------
// Property 26 (task 10.4) — Requirements 12.2, 12.3
// ---------------------------------------------------------------------------

describe("Property 26: Commission amount depends on prior wins and gallons", () => {
  // Feature: load-energy, Property 26: Commission amount depends on prior wins and gallons
  // **Validates: Requirements 12.2, 12.3**
  it("charges nothing and flags the invoice waived for a Supplier Company's first two completed wins, and BOL gallons x $0.02 with the flag clear from the third win on, for any gallon count and any number of prior wins — the boundary walked explicitly at the 1st, 2nd and 3rd win and counted per supplier company", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          runs: gallonRuns,
          priorWins: fc.oneof(
            { arbitrary: fc.constantFrom(0, 1, 2, 3), weight: 4 },
            { arbitrary: fc.integer({ min: 0, max: 200 }), weight: 2 }
          ),
          createdAt: instant,
        }),
        async ({ runs, priorWins, createdAt }) => {
          /**
           * The arithmetic on its own first (Requirements 12.2, 12.3). Total
           * and pure, so every generated gallon count is checked against an
           * independently derived amount at the generated win count and at each
           * of the boundary positions: n = 0 and n = 1 are the 1st and 2nd win
           * and are waived, n = 2 is the 3rd win and is billed, n = 3 stays
           * billed.
           */
          for (const run of runs) {
            for (const gallons of run) {
              const billed = expectedBilledAmount(gallons);
              const label = `${gallons} gal`;

              for (const n of [0, 1, 2, 3, priorWins]) {
                const waived = n < WAIVED_WIN_LIMIT;
                const at = `${label}, ${n} prior wins`;
                expect(isWaivedWin(n), at).toBe(waived);
                expect(commissionAmount(gallons, n), at).toBe(
                  waived ? 0 : billed
                );
                // The amount and the flag are produced together, so they can
                // never disagree about whether this win was waived.
                expect(commissionTerms(gallons, n), at).toEqual({
                  amount: waived ? 0 : billed,
                  waived,
                });
              }

              // A waived win is free whatever the load size; a billed one is
              // strictly proportional to the gallons on the ticket.
              expect(commissionAmount(gallons, 0), label).toBe(0);
              expect(commissionAmount(gallons, 2), label).toBeCloseTo(
                gallons * COMMISSION_RATE_PER_GAL,
                6
              );
            }
          }

          /**
           * The same rule as the marketplace produces it: each seller's run of
           * real won-and-delivered loads, billed in order. The win count is
           * whatever the ledger says, not a number handed to the service.
           */
          const h = await makeHarness(runs.length, createdAt);

          for (const [index, run] of runs.entries()) {
            const supplierCompanyId = h.suppliers[index].company.id;

            for (const [position, gallons] of run.entries()) {
              const at = new Date(createdAt.getTime() + position * 24 * HOUR);
              const { order } = await deliverLoad(h, index, gallons, at);

              const waived = position < WAIVED_WIN_LIMIT;
              const expectedAmount = waived ? 0 : expectedBilledAmount(gallons);
              const label = `supplier ${index}, win ${
                position + 1
              }, ${gallons} gal`;

              const invoice = await invoiceFor(h, order.id);
              expect(invoice, label).toMatchObject({
                supplierCompanyId,
                bolGallons: gallons,
                amount: expectedAmount,
                waived,
              });

              // Requirement 12.3: the waiver is an amount of zero, not a
              // missing invoice, and the flag says why it is zero.
              if (waived) {
                expect(invoice?.amount, label).toBe(0);
              } else {
                // Requirement 12.2: billed strictly on the BOL gallons.
                expect(invoice?.amount, label).toBeCloseTo(
                  gallons * COMMISSION_RATE_PER_GAL,
                  6
                );
              }

              /**
               * The win count the amount turned on is this company's own
               * completed wins: the ledger agrees with the position in the run,
               * regardless of how much the rest of the marketplace delivered.
               */
              expect(
                await h.repo.countDeliveredOrdersBySupplier(supplierCompanyId),
                label
              ).toBe(position + 1);
            }

            /**
             * The whole run as the seller's statement: exactly the first two
             * wins were free, every later one was billed on its own gallons,
             * and the total owed is the sum of the billed ones.
             */
            const statement = await h.repo.listCommissionInvoicesBySupplier(
              supplierCompanyId
            );
            expect(statement, `supplier ${index} statement`).toHaveLength(
              run.length
            );
            expect(
              statement.filter((i) => i.waived).length,
              `supplier ${index} statement`
            ).toBe(Math.min(run.length, WAIVED_WIN_LIMIT));
            const billedCents = run
              .slice(WAIVED_WIN_LIMIT)
              .reduce((sum, gallons) => sum + cents(expectedBilledAmount(gallons)), 0);
            expect(
              statement.reduce((sum, i) => sum + cents(i.amount), 0),
              `supplier ${index} statement`
            ).toBe(billedCents);
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 27 (task 10.5) — Requirements 12.1, 12.4, 17.3
// ---------------------------------------------------------------------------

/** Where the Delivered load came from — both land on the same entry point. */
type Origin = "app" | "concierge";

const origin: fc.Arbitrary<Origin> = fc.constantFrom("app", "concierge");

describe("Property 27: Delivered orders generate exactly one addressed, unpaid invoice", () => {
  // Feature: load-energy, Property 27: Delivered orders generate exactly one addressed, unpaid invoice
  // **Validates: Requirements 12.1, 12.4, 17.3**
  it("generates exactly one Commission_Invoice for any Order that reaches Delivered with recorded BOL gallons, app-originated or concierge, addressed to the winning Supplier Company and created Unpaid including waived $0 invoices, and stays at that one invoice however many times generation is invoked", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          origin,
          gallons: validBolGallons,
          // Earlier wins, so the load under test lands on either side of the
          // waiver boundary; a waived $0 invoice must still be created Unpaid.
          priorWins: fc.integer({ min: 0, max: 3 }),
          priorGallons: validBolGallons,
          regenerations: fc.integer({ min: 1, max: 3 }),
          createdAt: instant,
        }),
        async (c) => {
          const h = await makeHarness(1, c.createdAt);
          const supplierCompanyId = h.suppliers[0].company.id;

          for (let index = 0; index < c.priorWins; index += 1) {
            await deliverLoad(
              h,
              0,
              c.priorGallons,
              new Date(c.createdAt.getTime() + index * 24 * HOUR)
            );
          }

          const deliveredAt = new Date(
            c.createdAt.getTime() + c.priorWins * 24 * HOUR
          );
          const waived = c.priorWins < WAIVED_WIN_LIMIT;
          const expectedAmount = waived ? 0 : expectedBilledAmount(c.gallons);
          const label = `${c.origin} origin, ${c.gallons} gal, ${c.priorWins} prior wins`;

          const { order, delivery } =
            c.origin === "app"
              ? await deliverLoad(h, 0, c.gallons, deliveredAt)
              : await conciergeLoad(h, 0, c.gallons, deliveredAt);

          expect((await h.repo.getOrder(order.id))?.status, label).toBe(
            "delivered"
          );
          expect(order.isConcierge, label).toBe(c.origin === "concierge");

          /**
           * The app path bills itself as part of recording the Delivery; the
           * concierge path reaches the same entry point with nothing but an
           * order id (Requirement 17.3), which is what makes "the same
           * commission rules" one code path rather than two.
           */
          const generated = await h.commission.generateInvoiceForOrder(
            order.id,
            deliveredAt
          );
          expect(generated, label).not.toBeNull();

          // Requirement 12.1 — addressed to the winning Supplier Company and
          // billed on the gallons actually on the ticket.
          const invoice = generated as CommissionInvoice;
          expect(invoice, label).toMatchObject({
            orderId: order.id,
            supplierCompanyId,
            bolGallons: delivery.bolGallons,
            amount: expectedAmount,
            waived,
            // Requirement 12.4 — Unpaid on creation, waived $0 included.
            paymentStatus: "unpaid",
            paidByAdminId: null,
            paidAt: null,
          });
          if (waived) expect(invoice.amount, label).toBe(0);

          // Requirement 12.1 — exactly one, by every route to it.
          const forOrder = (await h.repo.listCommissionInvoices()).filter(
            (i) => i.orderId === order.id
          );
          expect(forOrder, label).toHaveLength(1);
          expect(forOrder[0].id, label).toBe(invoice.id);
          expect((await invoiceFor(h, order.id))?.id, label).toBe(invoice.id);
          expect(
            (await h.commission.getInvoiceByOrder(order.id))?.id,
            label
          ).toBe(invoice.id);

          /**
           * Replaying generation is a no-op, at any later instant: the stored
           * invoice comes back untouched and no second one appears. That is
           * what lets the delivery path treat a transient generation failure as
           * retryable, and what the concierge path relies on too.
           */
          for (let attempt = 1; attempt <= c.regenerations; attempt += 1) {
            const again = await h.commission.generateInvoiceForOrder(
              order.id,
              new Date(deliveredAt.getTime() + attempt * HOUR)
            );
            expect(again, `${label} / replay ${attempt}`).toEqual(invoice);
            expect(
              (await h.repo.listCommissionInvoices()).filter(
                (i) => i.orderId === order.id
              ),
              `${label} / replay ${attempt}`
            ).toHaveLength(1);
          }

          // One invoice per Delivered load in the whole ledger, prior wins
          // included — never two for one load, never one missing.
          const all = await h.repo.listCommissionInvoices();
          expect(all, label).toHaveLength(c.priorWins + 1);
          expect(new Set(all.map((i) => i.orderId)).size, label).toBe(
            all.length
          );
          for (const row of all) {
            expect(row.supplierCompanyId, label).toBe(supplierCompanyId);
            expect(row.paymentStatus, label).toBe("unpaid");
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 28 (task 10.6) — Requirement 12.5
// ---------------------------------------------------------------------------

/** How far a won load got short of Delivered. */
type Undelivered = "accepted" | "en_route";

const undelivered: fc.Arbitrary<Undelivered> = fc.constantFrom(
  "accepted",
  "en_route"
);

describe("Property 28: No invoice before delivery", () => {
  // Feature: load-energy, Property 28: No invoice before delivery
  // **Validates: Requirements 12.5**
  it("holds no Commission_Invoice for any Order that has not reached Delivered — generation is a no-op however often it is invoked and the load is absent from commission due — and bills it only once the BOL is on file", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          stages: fc.array(undelivered, { minLength: 1, maxLength: 4 }),
          attempts: fc.integer({ min: 1, max: 3 }),
          gallons: validBolGallons,
          createdAt: instant,
        }),
        async ({ stages, attempts, gallons, createdAt }) => {
          const h = await makeHarness(1, createdAt);
          const dispatcher = h.suppliers[0].ctx;
          const open: Order[] = [];

          for (const [index, stage] of stages.entries()) {
            const at = new Date(createdAt.getTime() + index * 24 * HOUR);
            const order = await wonOrder(h, 0, at);
            if (stage === "en_route") {
              await h.orders.advanceStatus(dispatcher, order.id, "en_route", at);
            }
            open.push(order);

            const label = `load ${index} at ${stage}`;
            expect((await h.repo.getOrder(order.id))?.status, label).toBe(stage);
            // No BOL on file is the real reason there is nothing to bill.
            expect(await h.repo.getDeliveryByOrder(order.id), label).toBeNull();

            /**
             * Requirement 12.5. Generation reports "nothing to bill" rather
             * than failing — callers sweep it over Orders that are mostly not
             * delivered — and it writes nothing, however many times it runs or
             * at whatever instant.
             */
            for (let attempt = 1; attempt <= attempts; attempt += 1) {
              expect(
                await h.commission.generateInvoiceForOrder(
                  order.id,
                  new Date(at.getTime() + attempt * HOUR)
                ),
                `${label} / attempt ${attempt}`
              ).toBeNull();
            }
            expect(await invoiceFor(h, order.id), label).toBeNull();
            expect(
              await h.commission.getInvoiceByOrder(order.id),
              label
            ).toBeNull();
          }

          // Nothing anywhere in the ledger, so nothing is owed and the report
          // an Admin reads is empty.
          expect(await h.repo.listCommissionInvoices()).toEqual([]);
          expect(await h.commission.commissionDue(h.admins[0])).toEqual({
            rows: [],
            totalDue: 0,
          });

          /**
           * Delivery is the whole gate: the same loads, billed the moment the
           * BOL lands and not before. So the absence above was about the status
           * and nothing else.
           */
          for (const [index, order] of open.entries()) {
            const at = new Date(createdAt.getTime() + index * 24 * HOUR);
            await h.orders.recordDelivery(
              dispatcher,
              order.id,
              { bolGallons: gallons, ticketNumber: h.nextTicket() },
              at
            );
            expect(await invoiceFor(h, order.id), `load ${index} billed`)
              .toMatchObject({
                orderId: order.id,
                supplierCompanyId: h.suppliers[0].company.id,
                bolGallons: gallons,
                paymentStatus: "unpaid",
              });
          }
          expect(await h.repo.listCommissionInvoices()).toHaveLength(
            open.length
          );
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 29 (task 10.7) — Requirement 12.6
// ---------------------------------------------------------------------------

describe("Property 29: Admin mark-paid records payment state and never reverts", () => {
  // Feature: load-energy, Property 29: Admin mark-paid records payment state and never reverts
  // **Validates: Requirements 12.6**
  it("sets an Unpaid invoice to Paid with the acting Admin's id and the timestamp — waived $0 invoices included — and leaves it Paid with that same Admin and instant however often, and by whichever Admin, the operation is repeated", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // Length decides whether the invoice under test is waived or billed.
          run: gallonRun,
          targetSeed: fc.nat(),
          adminSeed: fc.nat(),
          createdAt: instant,
          paidOffsetMs: fc.integer({ min: 0, max: 90 * 24 * HOUR }),
          repeats: fc.array(fc.integer({ min: -30 * 24 * HOUR, max: 30 * 24 * HOUR }), {
            minLength: 1,
            maxLength: 4,
          }),
        }),
        async (c) => {
          const h = await makeHarness(1, c.createdAt);

          for (const [position, gallons] of c.run.entries()) {
            await deliverLoad(
              h,
              0,
              gallons,
              new Date(c.createdAt.getTime() + position * 24 * HOUR)
            );
          }

          const ledger = await h.repo.listCommissionInvoices();
          const target = ledger[c.targetSeed % ledger.length];
          const payer = h.admins[c.adminSeed % h.admins.length];
          const paidAt = new Date(c.createdAt.getTime() + c.paidOffsetMs);
          const label = `invoice on ${target.bolGallons} gal (${
            target.waived ? "waived $0" : `$${target.amount}`
          }), paid by admin ${c.adminSeed % h.admins.length}`;

          expect(target.paymentStatus, label).toBe("unpaid");

          // Requirement 12.6 — Paid, with who did it and when.
          const paid = await h.commission.markInvoicePaid(
            payer,
            target.id,
            paidAt
          );
          expect(paid, label).toMatchObject({
            id: target.id,
            paymentStatus: "paid",
            paidByAdminId: payer.userId,
            // The amount is untouched: settling a bill does not rewrite it,
            // and a waived $0 invoice is settled like any other.
            amount: target.amount,
            waived: target.waived,
          });
          expect(paid.paidAt?.getTime(), label).toBe(paidAt.getTime());

          // Persisted, not just returned.
          const stored = await h.repo.getCommissionInvoice(target.id);
          expect(stored, label).toMatchObject({
            paymentStatus: "paid",
            paidByAdminId: payer.userId,
          });
          expect(stored?.paidAt?.getTime(), label).toBe(paidAt.getTime());

          /**
           * One-way. Repeated taps — by the same Admin or the other one, at
           * earlier and later instants alike — leave the invoice Paid with the
           * original Admin and the original timestamp, so Payment_Status never
           * moves back to Unpaid and the record of who settled it is not
           * overwritten by a double tap in the admin UI.
           */
          for (const [attempt, offset] of c.repeats.entries()) {
            const other = h.admins[(c.adminSeed + attempt + 1) % h.admins.length];
            const again = await h.commission.markInvoicePaid(
              other,
              target.id,
              new Date(paidAt.getTime() + offset)
            );
            const at = `${label} / repeat ${attempt} (${offset}ms)`;
            expect(again, at).toMatchObject({
              id: target.id,
              paymentStatus: "paid",
              paidByAdminId: payer.userId,
            });
            expect(again.paidAt?.getTime(), at).toBe(paidAt.getTime());
            expect(await h.repo.getCommissionInvoice(target.id), at)
              .toMatchObject({
                paymentStatus: "paid",
                paidByAdminId: payer.userId,
              });
          }

          // Settled, so it is off the collection list; every other invoice on
          // the ledger is untouched by this one's payment.
          const due = await h.commission.commissionDue(h.admins[0]);
          const stillOwed = (await h.repo.listCommissionInvoices()).filter(
            (i) => i.paymentStatus === "unpaid"
          );
          expect(stillOwed.map((i) => i.id), label).toEqual(
            ledger.filter((i) => i.id !== target.id).map((i) => i.id)
          );
          expect(
            due.rows.reduce((sum, row) => sum + cents(row.amountDue), 0),
            label
          ).toBe(stillOwed.reduce((sum, i) => sum + cents(i.amount), 0));
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 30 (task 10.8) — Requirement 12.8
// ---------------------------------------------------------------------------

describe("Property 30: Commission due aggregates unpaid invoices per supplier", () => {
  // Feature: load-energy, Property 30: Commission due aggregates unpaid invoices per supplier
  // **Validates: Requirements 12.8**
  it("returns, for every Supplier Company with anything outstanding, the sum of that company's Unpaid invoice amounts and the count behind it, excludes Paid invoices entirely, omits companies that owe nothing, and totals to the sum of its own rows", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // One run per seller; an empty run is a seller who never delivered.
          runs: fc.array(fc.array(validBolGallons, { minLength: 0, maxLength: 4 }), {
            minLength: 1,
            maxLength: 3,
          }),
          /** Which invoices an Admin has settled, by position in the ledger. */
          settled: fc.array(fc.boolean(), { minLength: 0, maxLength: 12 }),
          createdAt: instant,
        }),
        async ({ runs, settled, createdAt }) => {
          const h = await makeHarness(runs.length, createdAt);

          for (const [index, run] of runs.entries()) {
            for (const [position, gallons] of run.entries()) {
              await deliverLoad(
                h,
                index,
                gallons,
                new Date(createdAt.getTime() + position * 24 * HOUR)
              );
            }
          }

          const ledger = await h.repo.listCommissionInvoices();
          for (const [position, invoice] of ledger.entries()) {
            if (settled[position]) {
              await h.commission.markInvoicePaid(
                h.admins[position % h.admins.length],
                invoice.id,
                new Date(createdAt.getTime() + 30 * 24 * HOUR)
              );
            }
          }

          /**
           * What is owed, worked out independently of the service: unpaid rows
           * only, grouped by Supplier Company, summed in whole cents.
           */
          const expected = new Map<string, { cents: number; count: number }>();
          for (const invoice of await h.repo.listCommissionInvoices()) {
            if (invoice.paymentStatus !== "unpaid") continue;
            const running = expected.get(invoice.supplierCompanyId) ?? {
              cents: 0,
              count: 0,
            };
            expected.set(invoice.supplierCompanyId, {
              cents: running.cents + cents(invoice.amount),
              count: running.count + 1,
            });
          }

          const report = await h.commission.commissionDue(h.admins[0]);
          const label = `${runs.length} sellers, runs [${runs
            .map((r) => r.length)
            .join(",")}], ${settled.filter(Boolean).length} settled`;

          /**
           * Requirement 12.8: a row for each Supplier Company that owes
           * something and no others. A company whose every invoice is paid — or
           * which never delivered — is absent rather than present at zero, so
           * the key set is the collection list. A waived $0 invoice does keep
           * its company on the list: it is genuinely unpaid paperwork.
           */
          expect([...report.rows.map((r) => r.supplierCompanyId)].sort(), label).toEqual(
            [...expected.keys()].sort()
          );
          expect(report.rows, label).toHaveLength(expected.size);

          for (const row of report.rows) {
            const want = expected.get(row.supplierCompanyId) as {
              cents: number;
              count: number;
            };
            const at = `${label} / ${row.supplierCompanyId}`;
            // The grouped sum, to the cent, and the count of bills behind it.
            expect(cents(row.amountDue), at).toBe(want.cents);
            expect(row.unpaidInvoiceCount, at).toBe(want.count);
            expect(
              row.supplierCompanyName,
              at
            ).toBe(
              h.suppliers.find((s) => s.company.id === row.supplierCompanyId)
                ?.company.name ?? null
            );
          }

          // Paid invoices are excluded, not netted off somewhere else: the
          // report plus what has been settled is the whole ledger.
          const all = await h.repo.listCommissionInvoices();
          const settledCents = all
            .filter((i) => i.paymentStatus === "paid")
            .reduce((sum, i) => sum + cents(i.amount), 0);
          expect(
            report.rows.reduce((sum, row) => sum + cents(row.amountDue), 0) +
              settledCents,
            label
          ).toBe(all.reduce((sum, i) => sum + cents(i.amount), 0));

          // The total is the sum of the rows it is printed with.
          expect(cents(report.totalDue), label).toBe(
            report.rows.reduce((sum, row) => sum + cents(row.amountDue), 0)
          );
        }
      )
    );
  });
});
