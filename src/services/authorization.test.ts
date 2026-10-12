import { describe, expect, it } from "vitest";
import { AuthorizationError } from "@/domain/errors";
import type { AuthContext, Role } from "@/domain/types";
import {
  ACTION_POLICIES,
  AUTHORIZED_ACTIONS,
  AUTHZ_CODES,
  actionsForRole,
  belongsToCompany,
  canPerform,
  hasAnyRole,
  hasRole,
  interfaceFor,
  interfaceForRole,
  requireAction,
  requireAdmin,
  requireAnyRole,
  requireBuyer,
  requireCompany,
  requireContext,
  requireOrderParty,
  requireOwningBuyerCompany,
  requireRole,
  requireRoleAndCompany,
  requireSupplier,
  requireWinningSupplierCompany,
} from "./authorization";

const BUYER_CO = "co-buyer-1";
const OTHER_BUYER_CO = "co-buyer-2";
const SUPPLIER_CO = "co-supplier-1";
const OTHER_SUPPLIER_CO = "co-supplier-2";
const ADMIN_CO = "co-admin";

function ctxFor(role: Role, companyId: string): AuthContext {
  return { userId: `user-${role}`, companyId, role };
}

const buyer = ctxFor("buyer", BUYER_CO);
const otherBuyer = ctxFor("buyer", OTHER_BUYER_CO);
const supplier = ctxFor("supplier", SUPPLIER_CO);
const otherSupplier = ctxFor("supplier", OTHER_SUPPLIER_CO);
const admin = ctxFor("admin", ADMIN_CO);

/** Asserts the thrown error is a 403 `AuthorizationError` with `code`. */
function expectDenied(fn: () => unknown, code: string): void {
  expect(fn).toThrow(AuthorizationError);
  try {
    fn();
  } catch (error) {
    const denial = error as AuthorizationError;
    expect(denial.category).toBe("authorization");
    expect(denial.httpStatus).toBe(403);
    expect(denial.code).toBe(code);
    // Never leak the id of the resource the caller was denied.
    expect(denial.message).not.toMatch(/co-|user-|order-/);
  }
}

describe("requireContext", () => {
  it("returns the context when a session resolved", () => {
    expect(requireContext(buyer)).toBe(buyer);
  });

  it("fails closed on a missing or malformed context", () => {
    expectDenied(() => requireContext(null), AUTHZ_CODES.contextMissing);
    expectDenied(() => requireContext(undefined), AUTHZ_CODES.contextMissing);
    expectDenied(
      () => requireContext({ userId: "u", companyId: BUYER_CO } as AuthContext),
      AUTHZ_CODES.contextMissing
    );
  });
});

describe("requireRole (Requirement 1.9)", () => {
  it("allows the matching role for each role", () => {
    expect(requireBuyer(buyer)).toBe(buyer);
    expect(requireSupplier(supplier)).toBe(supplier);
    expect(requireAdmin(admin)).toBe(admin);
  });

  it("denies every other role with a role-specific code", () => {
    // Buyer-only action attempted by supplier and admin.
    expectDenied(() => requireBuyer(supplier), AUTHZ_CODES.requireBuyer);
    expectDenied(() => requireBuyer(admin), AUTHZ_CODES.requireBuyer);
    // Supplier-only action attempted by buyer and admin.
    expectDenied(() => requireSupplier(buyer), AUTHZ_CODES.requireSupplier);
    expectDenied(() => requireSupplier(admin), AUTHZ_CODES.requireSupplier);
    // Admin-only action attempted by buyer and supplier.
    expectDenied(() => requireAdmin(buyer), AUTHZ_CODES.requireAdmin);
    expectDenied(() => requireAdmin(supplier), AUTHZ_CODES.requireAdmin);
  });

  it("names the required role in the message", () => {
    expect(() => requireRole(buyer, "admin")).toThrow(/Admin/);
  });
});

describe("requireAnyRole", () => {
  it("admits any listed role and denies the rest", () => {
    expect(requireAnyRole(buyer, ["buyer", "admin"])).toBe(buyer);
    expect(requireAnyRole(admin, ["buyer", "admin"])).toBe(admin);
    expectDenied(
      () => requireAnyRole(supplier, ["buyer", "admin"]),
      AUTHZ_CODES.roleForbidden
    );
  });
});

describe("requireCompany (owning-company scope)", () => {
  it("allows the owning company", () => {
    expect(requireCompany(buyer, BUYER_CO)).toBe(buyer);
  });

  it("denies a different company", () => {
    expectDenied(
      () => requireCompany(buyer, OTHER_BUYER_CO),
      AUTHZ_CODES.companyForbidden
    );
  });

  it("does not let an Admin inherit a trading company's scope", () => {
    expectDenied(
      () => requireCompany(admin, BUYER_CO),
      AUTHZ_CODES.companyForbidden
    );
  });

  it("denies when no owning company id was supplied", () => {
    expectDenied(
      () => requireCompany(buyer, undefined),
      AUTHZ_CODES.companyScopeUnresolved
    );
    expectDenied(
      () => requireCompany(buyer, ""),
      AUTHZ_CODES.companyScopeUnresolved
    );
  });
});

describe("requireRoleAndCompany", () => {
  it("checks the role before the company", () => {
    // Supplier attempting a buyer-owned action fails on role, not company.
    expectDenied(
      () => requireRoleAndCompany(supplier, "buyer", SUPPLIER_CO),
      AUTHZ_CODES.requireBuyer
    );
  });

  it("allows the owning buyer and denies a non-owning buyer (Requirements 8.5, 9.5)", () => {
    expect(requireOwningBuyerCompany(buyer, BUYER_CO)).toBe(buyer);
    expectDenied(
      () => requireOwningBuyerCompany(otherBuyer, BUYER_CO),
      AUTHZ_CODES.companyForbidden
    );
  });

  it("allows the winning supplier and denies another supplier (Requirement 11.7)", () => {
    expect(requireWinningSupplierCompany(supplier, SUPPLIER_CO)).toBe(supplier);
    expectDenied(
      () => requireWinningSupplierCompany(otherSupplier, SUPPLIER_CO),
      AUTHZ_CODES.companyForbidden
    );
  });
});

describe("requireOrderParty", () => {
  const order = { buyerCompanyId: BUYER_CO, supplierCompanyId: SUPPLIER_CO };

  it("admits the owning buyer, the winning supplier, and an admin", () => {
    expect(requireOrderParty(buyer, order)).toBe(buyer);
    expect(requireOrderParty(supplier, order)).toBe(supplier);
    expect(requireOrderParty(admin, order)).toBe(admin);
  });

  it("denies an unrelated buyer or supplier", () => {
    expectDenied(
      () => requireOrderParty(otherBuyer, order),
      AUTHZ_CODES.companyForbidden
    );
    expectDenied(
      () => requireOrderParty(otherSupplier, order),
      AUTHZ_CODES.companyForbidden
    );
  });
});

describe("requireAction", () => {
  it("allows the buyer-only actions the spec reserves for buyers", () => {
    expect(requireAction(buyer, "request.create")).toBe(buyer);
    expect(requireAction(buyer, "site.create")).toBe(buyer);
    expect(
      requireAction(buyer, "offer.accept", { companyId: BUYER_CO })
    ).toBe(buyer);
    expect(
      requireAction(buyer, "request.cancel", { companyId: BUYER_CO })
    ).toBe(buyer);
  });

  it("denies buyer-only actions to suppliers and admins (Requirement 1.9)", () => {
    for (const other of [supplier, admin]) {
      expectDenied(
        () => requireAction(other, "request.create"),
        AUTHZ_CODES.requireBuyer
      );
      expectDenied(
        () => requireAction(other, "offer.accept", { companyId: BUYER_CO }),
        AUTHZ_CODES.requireBuyer
      );
    }
  });

  it("denies a non-owning buyer on company-scoped actions (Requirements 8.5, 9.5)", () => {
    expectDenied(
      () => requireAction(otherBuyer, "offer.accept", { companyId: BUYER_CO }),
      AUTHZ_CODES.companyForbidden
    );
    expectDenied(
      () => requireAction(otherBuyer, "request.cancel", { companyId: BUYER_CO }),
      AUTHZ_CODES.companyForbidden
    );
  });

  it("allows supplier-only actions for the owning supplier company", () => {
    expect(requireAction(supplier, "offer.create")).toBe(supplier);
    expect(
      requireAction(supplier, "supplier.setStatus", { companyId: SUPPLIER_CO })
    ).toBe(supplier);
    expect(
      requireAction(supplier, "order.advance", { companyId: SUPPLIER_CO })
    ).toBe(supplier);
    expect(
      requireAction(supplier, "delivery.record", { companyId: SUPPLIER_CO })
    ).toBe(supplier);
  });

  it("denies supplier-only actions to buyers and admins", () => {
    for (const other of [buyer, admin]) {
      expectDenied(
        () => requireAction(other, "offer.create"),
        AUTHZ_CODES.requireSupplier
      );
      expectDenied(
        () =>
          requireAction(other, "delivery.record", { companyId: SUPPLIER_CO }),
        AUTHZ_CODES.requireSupplier
      );
    }
  });

  it("denies a non-winning supplier recording a delivery (Requirement 11.4/11.7)", () => {
    expectDenied(
      () =>
        requireAction(otherSupplier, "delivery.record", {
          companyId: SUPPLIER_CO,
        }),
      AUTHZ_CODES.companyForbidden
    );
    expectDenied(
      () =>
        requireAction(otherSupplier, "order.advance", {
          companyId: SUPPLIER_CO,
        }),
      AUTHZ_CODES.companyForbidden
    );
  });

  it("allows admin-only actions and denies everyone else (Requirements 12.7, 16.8, 17.5)", () => {
    const adminActions = [
      "supplier.approve",
      "supplier.setOperatingLocation",
      "supplier.setServiceRadius",
      "geofence.set",
      "order.createConcierge",
      "invoice.markPaid",
      "commission.viewDue",
    ] as const;

    for (const action of adminActions) {
      expect(requireAction(admin, action)).toBe(admin);
      expectDenied(() => requireAction(buyer, action), AUTHZ_CODES.requireAdmin);
      expectDenied(
        () => requireAction(supplier, action),
        AUTHZ_CODES.requireAdmin
      );
    }
  });

  it("denies a company-scoped action invoked without an owning company", () => {
    expectDenied(
      () => requireAction(buyer, "offer.accept"),
      AUTHZ_CODES.companyScopeUnresolved
    );
  });

  it("fails closed with no session", () => {
    expectDenied(
      () => requireAction(null, "request.create"),
      AUTHZ_CODES.contextMissing
    );
  });
});

describe("non-throwing helpers", () => {
  it("mirror the guards without raising", () => {
    expect(hasRole(buyer, "buyer")).toBe(true);
    expect(hasRole(buyer, "admin")).toBe(false);
    expect(hasRole(null, "buyer")).toBe(false);

    expect(hasAnyRole(supplier, ["buyer", "supplier"])).toBe(true);
    expect(hasAnyRole(admin, ["buyer", "supplier"])).toBe(false);

    expect(belongsToCompany(buyer, BUYER_CO)).toBe(true);
    expect(belongsToCompany(buyer, OTHER_BUYER_CO)).toBe(false);
    expect(belongsToCompany(buyer, null)).toBe(false);

    expect(canPerform(buyer, "offer.accept", { companyId: BUYER_CO })).toBe(true);
    expect(canPerform(otherBuyer, "offer.accept", { companyId: BUYER_CO })).toBe(
      false
    );
    expect(canPerform(supplier, "invoice.markPaid")).toBe(false);
  });
});

describe("role-appropriate interface selection (Requirement 1.8)", () => {
  it("returns the surface for the caller's role", () => {
    expect(interfaceFor(buyer).surface).toBe("buyer");
    expect(interfaceFor(supplier).surface).toBe("supplier");
    expect(interfaceFor(admin).surface).toBe("admin");
  });

  it("gives each role a home path and navigation drawn from its own surface", () => {
    for (const role of ["buyer", "supplier", "admin"] as const) {
      const surface = interfaceForRole(role);
      expect(surface.navigation.length).toBeGreaterThan(0);
      expect(surface.homePath).toBe(surface.navigation[0].path);
      expect(surface.capabilities).toEqual(actionsForRole(role));
    }
  });

  it("scopes capabilities to the actions that role may attempt", () => {
    const buyerCaps = interfaceForRole("buyer").capabilities;
    expect(buyerCaps).toContain("request.create");
    expect(buyerCaps).not.toContain("offer.create");
    expect(buyerCaps).not.toContain("invoice.markPaid");

    const supplierCaps = interfaceForRole("supplier").capabilities;
    expect(supplierCaps).toContain("offer.create");
    expect(supplierCaps).not.toContain("request.create");

    const adminCaps = interfaceForRole("admin").capabilities;
    expect(adminCaps).toContain("invoice.markPaid");
    expect(adminCaps).toContain("order.createConcierge");
    expect(adminCaps).not.toContain("offer.accept");
  });

  it("denies a role surface without a session", () => {
    expectDenied(() => interfaceFor(null), AUTHZ_CODES.contextMissing);
  });
});

describe("action policy table", () => {
  it("covers every declared action with at least one role", () => {
    for (const action of AUTHORIZED_ACTIONS) {
      const policy = ACTION_POLICIES[action];
      expect(policy.roles.length).toBeGreaterThan(0);
      expect(policy.requirements.length).toBeGreaterThan(0);
    }
  });

  it("never company-scopes an admin-only action", () => {
    for (const action of actionsForRole("admin")) {
      const policy = ACTION_POLICIES[action];
      if (policy.roles.length === 1) expect(policy.scope).toBe("none");
    }
  });
});
