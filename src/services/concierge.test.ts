/**
 * Admin concierge order entry (task 12.3): a deal arranged over the phone
 * landing as a Delivered Order with its Delivery, billed by the shared
 * commission rules and written to the audit log.
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { COMMISSION_RATE_PER_GAL, type AuthContext } from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import { AuditService } from "./audit";
import { CommissionService } from "./commission";
import { OrderService } from "./order";

const NOW = new Date("2025-03-03T16:00:00Z");
const BUCKEYE = { lat: 33.3703, lng: -112.5838 };

interface Harness {
  repo: InMemoryRepository;
  orders: OrderService;
  commission: CommissionService;
  audit: AuditService;
  admin: AuthContext;
  buyer: AuthContext;
  supplier: AuthContext;
  buyerCompanyId: string;
  supplierCompanyId: string;
  /** A second, still-Pending supplier company. */
  pendingSupplierCompanyId: string;
}

async function makeHarness(): Promise<Harness> {
  const repo = new InMemoryRepository();
  const audit = new AuditService({ repo });
  const commission = new CommissionService({ repo, audit });
  const orders = new OrderService({ repo, commission, audit });

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

  async function supplierCompany(
    name: string,
    approval: "approved" | "pending"
  ) {
    return repo.createCompany({
      name,
      kind: "supplier",
      supplierApprovalStatus: approval,
      supplierStatus: approval === "approved" ? "open" : "closed",
      operatingLat: BUCKEYE.lat,
      operatingLng: BUCKEYE.lng,
      serviceRadiusMiles: 25,
      createdAt: NOW,
    });
  }

  const supplierCo = await supplierCompany("Buckeye Diesel", "approved");
  const pendingCo = await supplierCompany("Tolleson Fuel", "pending");

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

  return {
    repo,
    orders,
    commission,
    audit,
    admin: { userId: adminUser.id, companyId: buyerCo.id, role: "admin" },
    buyer: { userId: buyerUser.id, companyId: buyerCo.id, role: "buyer" },
    supplier: {
      userId: supplierUser.id,
      companyId: supplierCo.id,
      role: "supplier",
    },
    buyerCompanyId: buyerCo.id,
    supplierCompanyId: supplierCo.id,
    pendingSupplierCompanyId: pendingCo.id,
  };
}

function conciergeInput(h: Harness, overrides: Record<string, unknown> = {}) {
  return {
    buyerCompanyId: h.buyerCompanyId,
    supplierCompanyId: h.supplierCompanyId,
    bolGallons: 800,
    ticketNumber: "PHONE-DEAL-1",
    ...overrides,
  } as Parameters<OrderService["createConciergeOrder"]>[1];
}

describe("OrderService.createConciergeOrder (task 12.3)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("creates a Delivered order with its delivery, marked concierge (Req 17.1)", async () => {
    const order = await h.orders.createConciergeOrder(
      h.admin,
      conciergeInput(h),
      NOW
    );

    expect(order).toMatchObject({
      buyerCompanyId: h.buyerCompanyId,
      supplierCompanyId: h.supplierCompanyId,
      status: "delivered",
      isConcierge: true,
      // No RFQ and no winning quote behind an off-app deal.
      requestId: null,
      offerId: null,
      createdAt: NOW,
    });

    await expect(h.repo.getDeliveryByOrder(order.id)).resolves.toMatchObject({
      orderId: order.id,
      bolGallons: 800,
      ticketNumber: "PHONE-DEAL-1",
      ticketPhotoKey: null,
      deliveredAt: NOW,
    });
  });

  it("stores the ticket number when provided, trimmed (Req 17.2)", async () => {
    const order = await h.orders.createConciergeOrder(
      h.admin,
      conciergeInput(h, { ticketNumber: "  BOL-5521  " }),
      NOW
    );

    const delivery = await h.repo.getDeliveryByOrder(order.id);
    expect(delivery?.ticketNumber).toBe("BOL-5521");
  });

  it.each([undefined, null, "   "])(
    "accepts a concierge entry with no ticket number (%p) (Req 17.2)",
    async (ticketNumber) => {
      const order = await h.orders.createConciergeOrder(
        h.admin,
        conciergeInput(h, { ticketNumber }),
        NOW
      );

      const delivery = await h.repo.getDeliveryByOrder(order.id);
      expect(delivery?.ticketNumber).toBeNull();
      expect(delivery?.bolGallons).toBe(800);
    }
  );

  it("waives the supplier's first two wins and bills the third (Req 17.3)", async () => {
    const amounts: Array<{ amount: number; waived: boolean }> = [];
    for (const gallons of [800, 500, 1000]) {
      const order = await h.orders.createConciergeOrder(
        h.admin,
        conciergeInput(h, { bolGallons: gallons }),
        NOW
      );
      const invoice = await h.commission.getInvoiceByOrder(order.id);
      expect(invoice).not.toBeNull();
      expect(invoice).toMatchObject({
        supplierCompanyId: h.supplierCompanyId,
        bolGallons: gallons,
        // Requirement 12.4: Unpaid on creation, waived $0 invoices included.
        paymentStatus: "unpaid",
      });
      amounts.push({ amount: invoice!.amount, waived: invoice!.waived });
    }

    expect(amounts).toEqual([
      { amount: 0, waived: true },
      { amount: 0, waived: true },
      { amount: 1000 * COMMISSION_RATE_PER_GAL, waived: false },
    ]);
  });

  it("appends a CONCIERGE_CREATED audit entry naming the admin and order (Req 17.4)", async () => {
    const order = await h.orders.createConciergeOrder(
      h.admin,
      conciergeInput(h),
      NOW
    );
    const invoice = await h.commission.getInvoiceByOrder(order.id);

    const entries = await h.audit.listBySubject(order.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "CONCIERGE_CREATED",
      actorUserId: h.admin.userId,
      subjectId: order.id,
      createdAt: NOW,
    });
    expect(entries[0].payload).toMatchObject({
      orderId: order.id,
      buyerCompanyId: h.buyerCompanyId,
      supplierCompanyId: h.supplierCompanyId,
      bolGallons: 800,
      invoiceId: invoice!.id,
    });
  });

  it.each([
    ["buyer" as const],
    ["supplier" as const],
  ])("denies a %s caller with an authorization error (Req 17.5)", async (role) => {
    const ctx = role === "buyer" ? h.buyer : h.supplier;

    await expect(
      h.orders.createConciergeOrder(ctx, conciergeInput(h), NOW)
    ).rejects.toMatchObject({
      name: "AuthorizationError",
      code: "ROLE_REQUIRED_ADMIN",
    });

    // Nothing was written on the denied path.
    await expect(
      h.repo.listOrdersBySupplierCompany(h.supplierCompanyId)
    ).resolves.toHaveLength(0);
    await expect(h.audit.count()).resolves.toBe(0);
  });

  it.each([0, -1, 12.5])(
    "rejects BOL gallons of %p with a validation error (Req 17.1)",
    async (bolGallons) => {
      await expect(
        h.orders.createConciergeOrder(
          h.admin,
          conciergeInput(h, { bolGallons }),
          NOW
        )
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "GALLONS_INVALID",
        field: "bolGallons",
      });

      await expect(
        h.repo.listOrdersBySupplierCompany(h.supplierCompanyId)
      ).resolves.toHaveLength(0);
    }
  );

  it("rejects company ids that do not resolve to the right kind of company", async () => {
    await expect(
      h.orders.createConciergeOrder(
        h.admin,
        conciergeInput(h, { buyerCompanyId: "no-such-company" }),
        NOW
      )
    ).rejects.toMatchObject({
      code: "BUYER_COMPANY_NOT_FOUND",
      field: "buyerCompanyId",
    });

    await expect(
      h.orders.createConciergeOrder(
        h.admin,
        conciergeInput(h, { supplierCompanyId: h.buyerCompanyId }),
        NOW
      )
    ).rejects.toMatchObject({
      code: "COMPANY_NOT_SUPPLIER",
      field: "supplierCompanyId",
    });
  });

  it("records a deal for a supplier company that is not approved yet (Req 17.1)", async () => {
    // The concierge path exists for the pilot's off-app deals, so onboarding
    // state is not a gate — the Admin-only guard is the control.
    const order = await h.orders.createConciergeOrder(
      h.admin,
      conciergeInput(h, { supplierCompanyId: h.pendingSupplierCompanyId }),
      NOW
    );

    expect(order.status).toBe("delivered");
    await expect(
      h.commission.getInvoiceByOrder(order.id)
    ).resolves.toMatchObject({
      supplierCompanyId: h.pendingSupplierCompanyId,
      waived: true,
    });
  });
});
