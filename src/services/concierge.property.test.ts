/**
 * Property-based test for Admin concierge order entry (task 12.7).
 *
 * The subject is real throughout: the real `OrderService.createConciergeOrder`
 * over the real `CommissionService`, the real `AuditService`, and the real
 * `InMemoryRepository` (which enforces the unique `Delivery.orderId` constraint
 * the Prisma schema declares). Nothing under test is mocked.
 *
 * The generators vary everything the requirement leaves open: which Buyer
 * Company, which winning Supplier Company, the BOL gallon count, and the four
 * shapes an optional ticket number arrives in — supplied, absent, null, and
 * whitespace-only — since Requirement 17.2 only promises storage *where* a
 * ticket is provided.
 */

// Feature: load-energy, Property 39: Concierge order lands as a delivered order
// **Validates: Requirements 17.1, 17.2**

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ValidationError } from "@/domain/errors";
import type { AuthContext, Company } from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import { AuditService } from "./audit";
import { CommissionService } from "./commission";
import { MAX_TICKET_NUMBER_LENGTH, OrderService } from "./order";

const NOW = new Date("2025-03-03T16:00:00Z");
const BUCKEYE = { lat: 33.3703, lng: -112.5838 };

// ---------------------------------------------------------------------------
// Harness — several Buyer Companies, several Supplier Companies, one Admin
// ---------------------------------------------------------------------------

interface Seat {
  company: Company;
  ctx: AuthContext;
}

interface Harness {
  repo: InMemoryRepository;
  orders: OrderService;
  commission: CommissionService;
  audit: AuditService;
  admin: AuthContext;
  buyers: Seat[];
  suppliers: Seat[];
}

async function makeHarness(
  buyerCount: number,
  supplierCount: number
): Promise<Harness> {
  const repo = new InMemoryRepository();
  const audit = new AuditService({ repo });
  const commission = new CommissionService({ repo, audit });
  const orders = new OrderService({ repo, commission, audit });

  const buyers: Seat[] = [];
  for (let index = 0; index < buyerCount; index += 1) {
    const company = await repo.createCompany({
      name: `Buyer ${index} Concrete`,
      kind: "buyer",
      supplierApprovalStatus: null,
      supplierStatus: null,
      operatingLat: null,
      operatingLng: null,
      serviceRadiusMiles: null,
      createdAt: NOW,
    });
    const user = await repo.createUser({
      companyId: company.id,
      role: "buyer",
      phone: `+1602555${String(1000 + index).padStart(4, "0")}`,
      email: null,
      passwordHash: "hash",
      createdAt: NOW,
    });
    buyers.push({
      company,
      ctx: { userId: user.id, companyId: company.id, role: "buyer" },
    });
  }

  const suppliers: Seat[] = [];
  for (let index = 0; index < supplierCount; index += 1) {
    const company = await repo.createCompany({
      name: `Supplier ${index} Diesel`,
      kind: "supplier",
      // Onboarding state is deliberately mixed: the concierge path is for
      // pilot deals with companies an Admin may not have finished approving.
      supplierApprovalStatus: index % 2 === 0 ? "approved" : "pending",
      supplierStatus: index % 2 === 0 ? "open" : "closed",
      operatingLat: BUCKEYE.lat,
      operatingLng: BUCKEYE.lng,
      serviceRadiusMiles: 25,
      createdAt: NOW,
    });
    const user = await repo.createUser({
      companyId: company.id,
      role: "supplier",
      phone: `+1602555${String(2000 + index).padStart(4, "0")}`,
      email: null,
      passwordHash: "hash",
      createdAt: NOW,
    });
    suppliers.push({
      company,
      ctx: { userId: user.id, companyId: company.id, role: "supplier" },
    });
  }

  const adminUser = await repo.createUser({
    companyId: buyers[0].company.id,
    role: "admin",
    phone: "+16025550100",
    email: null,
    passwordHash: "hash",
    createdAt: NOW,
  });

  return {
    repo,
    orders,
    commission,
    audit,
    admin: {
      userId: adminUser.id,
      companyId: buyers[0].company.id,
      role: "admin",
    },
    buyers,
    suppliers,
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** The four shapes an optional concierge ticket number arrives in. */
interface TicketCase {
  raw?: string | null;
  /** What Requirement 17.2 says should end up on the Delivery. */
  expected: string | null;
}

const ticketCase: fc.Arbitrary<TicketCase> = fc.oneof(
  // Supplied: stored, trimmed.
  fc
    .string({ minLength: 1, maxLength: 40 })
    .map((raw) => ({ raw, expected: raw.trim() }))
    .filter(
      (c) =>
        c.expected !== "" && c.expected.length <= MAX_TICKET_NUMBER_LENGTH
    ),
  // Absent, null, and whitespace-only: no ticket on file.
  fc.constant<TicketCase>({ raw: undefined, expected: null }),
  fc.constant<TicketCase>({ raw: null, expected: null }),
  fc
    .constantFrom(" ", "   ", "\t", "\n \t ")
    .map((raw) => ({ raw, expected: null }))
);

const seatCount = fc.integer({ min: 1, max: 3 });
const positiveGallons = fc.integer({ min: 1, max: 50_000 });
/** Requirement 17.1's boundary and below it. */
const nonPositiveGallons = fc.integer({ min: -50_000, max: 0 });

// ---------------------------------------------------------------------------
// Property 39
// ---------------------------------------------------------------------------

describe("Property 39: Concierge order lands as a delivered order", () => {
  it("creates exactly one Delivered concierge order with its delivery, visible to both parties (Req 17.1, 17.2)", async () => {
    await fc.assert(
      fc.asyncProperty(
        seatCount,
        seatCount,
        fc.nat(),
        fc.nat(),
        positiveGallons,
        ticketCase,
        async (
          buyerCount,
          supplierCount,
          buyerPick,
          supplierPick,
          bolGallons,
          ticket
        ) => {
          const h = await makeHarness(buyerCount, supplierCount);
          const buyer = h.buyers[buyerPick % buyerCount];
          const supplier = h.suppliers[supplierPick % supplierCount];

          const order = await h.orders.createConciergeOrder(
            h.admin,
            {
              buyerCompanyId: buyer.company.id,
              supplierCompanyId: supplier.company.id,
              bolGallons,
              ticketNumber: ticket.raw,
            },
            NOW
          );

          // Requirement 17.1 — Delivered, concierge-flagged, with no RFQ or
          // quote behind it.
          expect(order.status).toBe("delivered");
          expect(order.isConcierge).toBe(true);
          expect(order.requestId).toBeNull();
          expect(order.offerId).toBeNull();
          expect(order.buyerCompanyId).toBe(buyer.company.id);
          expect(order.supplierCompanyId).toBe(supplier.company.id);
          expect(order.createdAt).toEqual(NOW);

          // Exactly one Order, on exactly the two companies named.
          for (const seat of [...h.buyers, ...h.suppliers]) {
            const asBuyer = await h.repo.listOrdersByBuyerCompany(
              seat.company.id
            );
            const asSupplier = await h.repo.listOrdersBySupplierCompany(
              seat.company.id
            );
            const expectedAsBuyer = seat.company.id === buyer.company.id ? 1 : 0;
            const expectedAsSupplier =
              seat.company.id === supplier.company.id ? 1 : 0;
            expect(asBuyer).toHaveLength(expectedAsBuyer);
            expect(asSupplier).toHaveLength(expectedAsSupplier);
            if (expectedAsBuyer === 1) expect(asBuyer[0].id).toBe(order.id);
            if (expectedAsSupplier === 1) {
              expect(asSupplier[0].id).toBe(order.id);
            }
          }

          // Requirements 17.1, 17.2 — one linked Delivery carrying the gallons
          // and the ticket number where one was provided.
          const delivery = await h.repo.getDeliveryByOrder(order.id);
          expect(delivery).not.toBeNull();
          expect(delivery!.orderId).toBe(order.id);
          expect(delivery!.bolGallons).toBe(bolGallons);
          expect(delivery!.ticketNumber).toBe(ticket.expected);
          expect(delivery!.deliveredAt).toEqual(NOW);

          // Visible to both parties, with the same status and BOL detail.
          for (const ctx of [buyer.ctx, supplier.ctx]) {
            const view = await h.orders.readOrder(ctx, order.id);
            expect(view.orderId).toBe(order.id);
            expect(view.status).toBe("delivered");
            expect(view.isConcierge).toBe(true);
            expect(view.delivery).not.toBeNull();
            expect(view.delivery!.bolGallons).toBe(bolGallons);
            expect(view.delivery!.ticketNumber).toBe(ticket.expected);
          }
        }
      )
    );
  });

  it("rejects BOL gallons at or below zero and writes nothing (Req 17.1)", async () => {
    await fc.assert(
      fc.asyncProperty(
        seatCount,
        seatCount,
        fc.nat(),
        fc.nat(),
        nonPositiveGallons,
        ticketCase,
        async (
          buyerCount,
          supplierCount,
          buyerPick,
          supplierPick,
          bolGallons,
          ticket
        ) => {
          const h = await makeHarness(buyerCount, supplierCount);
          const buyer = h.buyers[buyerPick % buyerCount];
          const supplier = h.suppliers[supplierPick % supplierCount];

          await expect(
            h.orders.createConciergeOrder(
              h.admin,
              {
                buyerCompanyId: buyer.company.id,
                supplierCompanyId: supplier.company.id,
                bolGallons,
                ticketNumber: ticket.raw,
              },
              NOW
            )
          ).rejects.toMatchObject({
            name: ValidationError.name,
            code: "GALLONS_INVALID",
            field: "bolGallons",
          });

          // Nothing written: no Order on either side, no invoice, no audit row.
          for (const seat of [...h.buyers, ...h.suppliers]) {
            await expect(
              h.repo.listOrdersByBuyerCompany(seat.company.id)
            ).resolves.toHaveLength(0);
            await expect(
              h.repo.listOrdersBySupplierCompany(seat.company.id)
            ).resolves.toHaveLength(0);
          }
          await expect(h.repo.listCommissionInvoices()).resolves.toHaveLength(0);
          await expect(h.audit.count()).resolves.toBe(0);
        }
      )
    );
  });
});
