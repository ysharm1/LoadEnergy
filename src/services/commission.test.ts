/**
 * Commission calculation, invoice generation on delivery, Admin mark-paid, and
 * the commission-due report (tasks 10.1, 10.2, 10.3).
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 17.3.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { AuthContext, Order } from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import {
  CommissionService,
  commissionAmount,
  commissionDueBySupplier,
  commissionTerms,
  isWaivedWin,
} from "./commission";
import { OrderService } from "./order";

const NOW = new Date("2025-03-01T09:00:00Z");
const LATER = new Date("2025-03-05T17:30:00Z");

const BUCKEYE = { lat: 33.3703, lng: -112.5838 };

interface Harness {
  repo: InMemoryRepository;
  commission: CommissionService;
  orders: OrderService;
  admin: AuthContext;
  buyer: AuthContext;
  supplierA: AuthContext;
  supplierB: AuthContext;
  buyerCompanyId: string;
  supplierCompanyAId: string;
  supplierCompanyBId: string;
  /** An Order on supplier A at `status`, with no Delivery yet. */
  makeOrder(status?: Order["status"], supplierCompanyId?: string): Promise<Order>;
}

async function makeHarness(): Promise<Harness> {
  const repo = new InMemoryRepository();
  const commission = new CommissionService({ repo });
  const orders = new OrderService({ repo, commission });

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
  const supplierUserA = await user(supplierCoA.id, "supplier", "+16025550201");
  const supplierUserB = await user(supplierCoB.id, "supplier", "+16025550301");

  async function makeOrder(
    status: Order["status"] = "accepted",
    supplierCompanyId: string = supplierCoA.id
  ): Promise<Order> {
    return repo.createOrder({
      requestId: null,
      offerId: null,
      buyerCompanyId: buyerCo.id,
      supplierCompanyId,
      status,
      isConcierge: false,
      createdAt: NOW,
    });
  }

  return {
    repo,
    commission,
    orders,
    admin: { userId: adminUser.id, companyId: buyerCo.id, role: "admin" },
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
    buyerCompanyId: buyerCo.id,
    supplierCompanyAId: supplierCoA.id,
    supplierCompanyBId: supplierCoB.id,
    makeOrder,
  };
}

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

/** Delivers a load through the real supplier path, returning the Order. */
async function deliver(
  ctx: AuthContext,
  bolGallons: number,
  ticketNumber: string,
  supplierCompanyId?: string
): Promise<Order> {
  const order = await h.makeOrder("accepted", supplierCompanyId);
  await h.orders.recordDelivery(ctx, order.id, { bolGallons, ticketNumber }, NOW);
  return order;
}

// ---------------------------------------------------------------------------
// Task 10.1 — commission calculation (Requirements 12.2, 12.3)
// ---------------------------------------------------------------------------

describe("commissionAmount (Requirements 12.2, 12.3)", () => {
  it("waives the first two completed wins", () => {
    expect(commissionAmount(1000, 0)).toBe(0);
    expect(commissionAmount(1000, 1)).toBe(0);
  });

  it("bills $0.02 per BOL gallon from the third win on", () => {
    expect(commissionAmount(1000, 2)).toBe(20);
    expect(commissionAmount(1000, 3)).toBe(20);
    expect(commissionAmount(7_500, 9)).toBe(150);
  });

  it("walks the waiver boundary at n = 1, 2, 3 completed wins", () => {
    const gallons = 500;
    expect(commissionAmount(gallons, 0)).toBe(0); // 1st win
    expect(commissionAmount(gallons, 1)).toBe(0); // 2nd win
    expect(commissionAmount(gallons, 2)).toBe(10); // 3rd win: billed
    expect(commissionAmount(gallons, 3)).toBe(10); // 4th win: billed
  });

  it("returns cent-exact money rather than float dust", () => {
    expect(commissionAmount(1_235, 2)).toBe(24.7);
    expect(commissionAmount(1, 2)).toBe(0.02);
    expect(commissionAmount(3, 2)).toBe(0.06);
  });

  it("pairs the amount with the waived flag so the two cannot disagree", () => {
    expect(commissionTerms(900, 1)).toEqual({ amount: 0, waived: true });
    expect(commissionTerms(900, 2)).toEqual({ amount: 18, waived: false });
    expect(isWaivedWin(0)).toBe(true);
    expect(isWaivedWin(1)).toBe(true);
    expect(isWaivedWin(2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 10.2 — invoice generation on delivery (Requirements 12.1, 12.4, 12.5, 17.3)
// ---------------------------------------------------------------------------

describe("invoice generation on delivery (Requirements 12.1, 12.4)", () => {
  it("produces exactly one Unpaid invoice addressed to the winning supplier", async () => {
    const order = await deliver(h.supplierA, 1_200, "BOL-1");

    const invoices = await h.repo.listCommissionInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      orderId: order.id,
      supplierCompanyId: h.supplierCompanyAId,
      bolGallons: 1_200,
      paymentStatus: "unpaid",
      paidByAdminId: null,
      paidAt: null,
      createdAt: NOW,
    });
  });

  it("creates the first two wins waived at $0 and still Unpaid", async () => {
    await deliver(h.supplierA, 1_000, "BOL-1");
    await deliver(h.supplierA, 2_000, "BOL-2");

    const invoices = await h.repo.listCommissionInvoicesBySupplier(
      h.supplierCompanyAId
    );
    expect(invoices).toHaveLength(2);
    for (const invoice of invoices) {
      expect(invoice.amount).toBe(0);
      expect(invoice.waived).toBe(true);
      expect(invoice.paymentStatus).toBe("unpaid");
    }
  });

  it("bills the third win at BOL gallons x $0.02", async () => {
    await deliver(h.supplierA, 1_000, "BOL-1");
    await deliver(h.supplierA, 1_000, "BOL-2");
    const third = await deliver(h.supplierA, 1_500, "BOL-3");

    const invoice = await h.repo.getCommissionInvoiceByOrder(third.id);
    expect(invoice).toMatchObject({ amount: 30, waived: false });
  });

  it("counts waivers per supplier company, not across the marketplace", async () => {
    await deliver(h.supplierA, 1_000, "BOL-A1");
    await deliver(h.supplierA, 1_000, "BOL-A2");
    await deliver(h.supplierA, 1_000, "BOL-A3");

    const firstForB = await deliver(
      h.supplierB,
      1_000,
      "BOL-B1",
      h.supplierCompanyBId
    );

    const invoice = await h.repo.getCommissionInvoiceByOrder(firstForB.id);
    expect(invoice).toMatchObject({
      supplierCompanyId: h.supplierCompanyBId,
      amount: 0,
      waived: true,
    });
  });

  it("is idempotent: regenerating returns the stored invoice, never a second one", async () => {
    const order = await deliver(h.supplierA, 1_000, "BOL-1");
    const first = await h.commission.getInvoiceByOrder(order.id);

    const again = await h.commission.generateInvoiceForOrder(order.id, LATER);

    expect(again).toEqual(first);
    await expect(h.repo.listCommissionInvoices()).resolves.toHaveLength(1);
  });

  it("generates nothing for an order that has not reached Delivered (Requirement 12.5)", async () => {
    for (const status of ["accepted", "en_route"] as const) {
      const order = await h.makeOrder(status);

      await expect(
        h.commission.generateInvoiceForOrder(order.id, NOW)
      ).resolves.toBeNull();
      await expect(
        h.repo.getCommissionInvoiceByOrder(order.id)
      ).resolves.toBeNull();
    }

    await expect(h.repo.listCommissionInvoices()).resolves.toHaveLength(0);
  });

  it("generates nothing for a Delivered order with no BOL behind it", async () => {
    const order = await h.makeOrder("delivered");

    await expect(
      h.commission.generateInvoiceForOrder(order.id, NOW)
    ).resolves.toBeNull();
  });

  it("generates nothing for an unknown order id", async () => {
    await expect(
      h.commission.generateInvoiceForOrder("no-such-order", NOW)
    ).resolves.toBeNull();
  });

  it("bills a concierge-shaped delivered order through the same entry point (Requirement 17.3)", async () => {
    // What task 12.3 will do: an Order landed straight at Delivered with its
    // Delivery, then the shared generation call — no concierge-specific rules.
    const order = await h.repo.createOrder({
      requestId: null,
      offerId: null,
      buyerCompanyId: h.buyerCompanyId,
      supplierCompanyId: h.supplierCompanyAId,
      status: "delivered",
      isConcierge: true,
      createdAt: NOW,
    });
    await h.repo.createDelivery({
      orderId: order.id,
      bolGallons: 800,
      ticketNumber: "PHONE-DEAL-1",
      ticketPhotoKey: null,
      deliveredAt: NOW,
    });

    const invoice = await h.commission.generateInvoiceForOrder(order.id, NOW);

    expect(invoice).toMatchObject({
      orderId: order.id,
      supplierCompanyId: h.supplierCompanyAId,
      bolGallons: 800,
      amount: 0,
      waived: true,
      paymentStatus: "unpaid",
    });
  });

  it("counts a concierge win toward the same waiver allowance", async () => {
    await deliver(h.supplierA, 1_000, "BOL-1");

    const concierge = await h.repo.createOrder({
      requestId: null,
      offerId: null,
      buyerCompanyId: h.buyerCompanyId,
      supplierCompanyId: h.supplierCompanyAId,
      status: "delivered",
      isConcierge: true,
      createdAt: NOW,
    });
    await h.repo.createDelivery({
      orderId: concierge.id,
      bolGallons: 500,
      ticketNumber: "PHONE-DEAL-1",
      ticketPhotoKey: null,
      deliveredAt: NOW,
    });
    await h.commission.generateInvoiceForOrder(concierge.id, NOW);

    // Third completed win for this supplier, app-originated: now billable.
    const third = await deliver(h.supplierA, 2_000, "BOL-3");
    await expect(
      h.repo.getCommissionInvoiceByOrder(third.id)
    ).resolves.toMatchObject({ amount: 40, waived: false });
  });
});

// ---------------------------------------------------------------------------
// Task 10.3 — mark paid and commission due (Requirements 12.6, 12.7, 12.8)
// ---------------------------------------------------------------------------

describe("markInvoicePaid (Requirements 12.6, 12.7)", () => {
  it("persists Paid plus the acting Admin and the timestamp", async () => {
    const order = await deliver(h.supplierA, 1_000, "BOL-1");
    const invoice = await h.commission.getInvoiceByOrder(order.id);

    const paid = await h.commission.markInvoicePaid(
      h.admin,
      invoice!.id,
      LATER
    );

    expect(paid).toMatchObject({
      paymentStatus: "paid",
      paidByAdminId: h.admin.userId,
      paidAt: LATER,
    });
    await expect(
      h.repo.getCommissionInvoice(invoice!.id)
    ).resolves.toMatchObject({ paymentStatus: "paid", paidAt: LATER });
  });

  it("marks a waived $0 invoice paid like any other", async () => {
    const order = await deliver(h.supplierA, 1_000, "BOL-1");
    const invoice = await h.commission.getInvoiceByOrder(order.id);
    expect(invoice?.amount).toBe(0);

    await expect(
      h.commission.markInvoicePaid(h.admin, invoice!.id, LATER)
    ).resolves.toMatchObject({ paymentStatus: "paid", amount: 0 });
  });

  it("never reverts: repeating leaves it Paid with the original admin and time", async () => {
    const order = await deliver(h.supplierA, 1_000, "BOL-1");
    const invoice = await h.commission.getInvoiceByOrder(order.id);
    await h.commission.markInvoicePaid(h.admin, invoice!.id, NOW);

    const again = await h.commission.markInvoicePaid(
      h.admin,
      invoice!.id,
      LATER
    );

    expect(again).toMatchObject({
      paymentStatus: "paid",
      paidByAdminId: h.admin.userId,
      paidAt: NOW,
    });
  });

  it("denies a non-Admin caller and leaves the invoice Unpaid (Requirement 12.7)", async () => {
    const order = await deliver(h.supplierA, 1_000, "BOL-1");
    const invoice = await h.commission.getInvoiceByOrder(order.id);

    for (const ctx of [h.buyer, h.supplierA]) {
      await expect(
        h.commission.markInvoicePaid(ctx, invoice!.id, LATER)
      ).rejects.toMatchObject({ category: "authorization" });
    }

    await expect(
      h.repo.getCommissionInvoice(invoice!.id)
    ).resolves.toMatchObject({ paymentStatus: "unpaid", paidByAdminId: null });
  });

  it("rejects an unknown invoice id with a validation error", async () => {
    await expect(
      h.commission.markInvoicePaid(h.admin, "no-such-invoice", LATER)
    ).rejects.toMatchObject({
      category: "validation",
      code: "INVOICE_NOT_FOUND",
      field: "invoiceId",
    });
  });
});

describe("commissionDue (Requirement 12.8)", () => {
  /** Three billable wins for each supplier, so nothing is waived. */
  async function warmPastWaiver(
    ctx: AuthContext,
    supplierCompanyId: string,
    prefix: string
  ): Promise<void> {
    await deliver(ctx, 100, `${prefix}-W1`, supplierCompanyId);
    await deliver(ctx, 100, `${prefix}-W2`, supplierCompanyId);
  }

  it("sums Unpaid amounts per supplier company and excludes Paid ones", async () => {
    await warmPastWaiver(h.supplierA, h.supplierCompanyAId, "A");
    await warmPastWaiver(h.supplierB, h.supplierCompanyBId, "B");

    await deliver(h.supplierA, 1_000, "BOL-A3"); // $20 unpaid
    await deliver(h.supplierA, 500, "BOL-A4"); // $10 unpaid
    const settled = await deliver(h.supplierB, 2_000, "BOL-B3", h.supplierCompanyBId); // $40, paid below
    await deliver(h.supplierB, 250, "BOL-B4", h.supplierCompanyBId); // $5 unpaid

    const settledInvoice = await h.commission.getInvoiceByOrder(settled.id);
    await h.commission.markInvoicePaid(h.admin, settledInvoice!.id, LATER);

    const report = await h.commission.commissionDue(h.admin);

    const byCompany = new Map(
      report.rows.map((r) => [r.supplierCompanyId, r])
    );
    // Supplier A: two $0 waived invoices + $20 + $10.
    expect(byCompany.get(h.supplierCompanyAId)).toMatchObject({
      supplierCompanyName: "Buckeye Diesel",
      amountDue: 30,
      unpaidInvoiceCount: 4,
    });
    // Supplier B: two $0 waived invoices + $5; the $40 is paid and excluded.
    expect(byCompany.get(h.supplierCompanyBId)).toMatchObject({
      supplierCompanyName: "Tolleson Fuel",
      amountDue: 5,
      unpaidInvoiceCount: 3,
    });
    expect(report.totalDue).toBe(35);
  });

  it("returns an empty report when nothing is outstanding", async () => {
    const order = await deliver(h.supplierA, 1_000, "BOL-1");
    const invoice = await h.commission.getInvoiceByOrder(order.id);
    await h.commission.markInvoicePaid(h.admin, invoice!.id, LATER);

    const report = await h.commission.commissionDue(h.admin);

    expect(report).toEqual({ rows: [], totalDue: 0 });
  });

  it("orders rows most-owed first", async () => {
    await warmPastWaiver(h.supplierA, h.supplierCompanyAId, "A");
    await warmPastWaiver(h.supplierB, h.supplierCompanyBId, "B");
    await deliver(h.supplierA, 100, "BOL-A3"); // $2
    await deliver(h.supplierB, 5_000, "BOL-B3", h.supplierCompanyBId); // $100

    const report = await h.commission.commissionDue(h.admin);

    expect(report.rows.map((r) => r.supplierCompanyId)).toEqual([
      h.supplierCompanyBId,
      h.supplierCompanyAId,
    ]);
  });

  it("denies a non-Admin caller", async () => {
    for (const ctx of [h.buyer, h.supplierA]) {
      await expect(h.commission.commissionDue(ctx)).rejects.toMatchObject({
        category: "authorization",
      });
    }
  });

  it("aggregates unpaid invoices as a pure function over invoice rows", () => {
    const base = {
      bolGallons: 100,
      waived: false,
      paidByAdminId: null,
      paidAt: null,
      createdAt: NOW,
    };
    const totals = commissionDueBySupplier([
      { id: "i1", orderId: "o1", supplierCompanyId: "s1", amount: 2, paymentStatus: "unpaid", ...base },
      { id: "i2", orderId: "o2", supplierCompanyId: "s1", amount: 0.04, paymentStatus: "unpaid", ...base },
      { id: "i3", orderId: "o3", supplierCompanyId: "s1", amount: 99, paymentStatus: "paid", ...base },
      { id: "i4", orderId: "o4", supplierCompanyId: "s2", amount: 7.5, paymentStatus: "unpaid", ...base },
    ]);

    expect([...totals.entries()].sort()).toEqual([
      ["s1", 2.04],
      ["s2", 7.5],
    ]);
  });
});
