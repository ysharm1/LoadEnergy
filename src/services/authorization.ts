/**
 * Authorization guard — the single place every service asks "may this caller
 * do this?".
 *
 * Requirements:
 *   1.8 an authenticated User of a given role is presented the interface for
 *       that role (`interfaceForRole` / `interfaceFor` supply the data-only
 *       descriptor the client renders; no React here).
 *   1.9 an action reserved for a role the User does not hold is denied with an
 *       authorization error.
 *
 * It also carries the owning-company scope rules that the rest of the spec
 * layers on top of role: 8.5 (only the owning Buyer Company accepts an Offer),
 * 9.5 (only the owning Buyer Company cancels a Request), 11.7 (only the
 * winning Supplier Company records a Delivery), 12.7 / 16.8 / 17.5 (Admin-only
 * marketplace operations).
 *
 * Shape: small, pure, synchronous functions over `AuthContext` — no I/O, no
 * repository, no clock — composed either directly (`requireRole`,
 * `requireCompany`) or through the declarative action policy
 * (`requireAction`). The policy table is the readable authorization matrix and
 * doubles as the source of each role's capability list, so the UI surface and
 * the enforcement path can never drift apart.
 *
 * Failure mode: every denial throws `AuthorizationError` (403) with a stable
 * code. Messages deliberately never echo an id or say whether the resource
 * exists — a caller outside the owning company learns only that the action is
 * limited to the owner.
 */

import { AuthorizationError } from "@/domain/errors";
import type { AuthContext, Order, Role } from "@/domain/types";

// ---------------------------------------------------------------------------
// Error codes (stable; the client keys off these)
// ---------------------------------------------------------------------------

export const AUTHZ_CODES = {
  /** No resolved session reached the guard. Fail-closed. */
  contextMissing: "AUTH_CONTEXT_MISSING",
  /** Caller holds none of the roles the action allows. */
  roleForbidden: "ROLE_FORBIDDEN",
  requireBuyer: "ROLE_REQUIRED_BUYER",
  requireSupplier: "ROLE_REQUIRED_SUPPLIER",
  requireAdmin: "ROLE_REQUIRED_ADMIN",
  /** Right role, wrong company (not the owning buyer / winning supplier). */
  companyForbidden: "COMPANY_SCOPE_FORBIDDEN",
  /** A company-scoped action was invoked without an owning company id. */
  companyScopeUnresolved: "COMPANY_SCOPE_UNRESOLVED",
} as const;

const ROLE_REQUIRED_CODE: Record<Role, string> = {
  buyer: AUTHZ_CODES.requireBuyer,
  supplier: AUTHZ_CODES.requireSupplier,
  admin: AUTHZ_CODES.requireAdmin,
};

const ROLE_LABEL: Record<Role, string> = {
  buyer: "Buyer",
  supplier: "Supplier",
  admin: "Admin",
};

// ---------------------------------------------------------------------------
// Non-throwing predicates (safe for list filtering and UI gating)
// ---------------------------------------------------------------------------

export function hasRole(ctx: AuthContext | null | undefined, role: Role): boolean {
  return ctx?.role === role;
}

export function hasAnyRole(
  ctx: AuthContext | null | undefined,
  roles: readonly Role[]
): boolean {
  return ctx != null && roles.includes(ctx.role);
}

export function belongsToCompany(
  ctx: AuthContext | null | undefined,
  companyId: string | null | undefined
): boolean {
  if (ctx == null) return false;
  if (typeof companyId !== "string" || companyId === "") return false;
  return ctx.companyId === companyId;
}

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

function denyRole(roles: readonly Role[]): never {
  const labels = roles.map((r) => ROLE_LABEL[r]).join(" or ");
  const code =
    roles.length === 1 ? ROLE_REQUIRED_CODE[roles[0]] : AUTHZ_CODES.roleForbidden;
  throw new AuthorizationError(
    code,
    `This action is reserved for the ${labels} role`
  );
}

/** Fail-closed: a guard reached without a resolved session denies. */
export function requireContext(
  ctx: AuthContext | null | undefined
): AuthContext {
  if (ctx == null || typeof ctx.role !== "string" || typeof ctx.companyId !== "string") {
    throw new AuthorizationError(
      AUTHZ_CODES.contextMissing,
      "This action requires an authenticated session"
    );
  }
  return ctx;
}

/** Asserts the caller holds exactly this role (Requirement 1.9). */
export function requireRole(
  ctx: AuthContext | null | undefined,
  role: Role
): AuthContext {
  const resolved = requireContext(ctx);
  if (resolved.role !== role) denyRole([role]);
  return resolved;
}

/** Asserts the caller holds one of these roles (Requirement 1.9). */
export function requireAnyRole(
  ctx: AuthContext | null | undefined,
  roles: readonly Role[]
): AuthContext {
  const resolved = requireContext(ctx);
  if (!roles.includes(resolved.role)) denyRole(roles);
  return resolved;
}

/**
 * Asserts the caller's Company owns the resource.
 *
 * Deliberately strict: an Admin does not inherit a trading company's scope.
 * Admin authority is expressed as Admin-only actions, which are not
 * company-scoped, so there is no path where "admin" silently widens a
 * buyer/supplier ownership check.
 */
export function requireCompany(
  ctx: AuthContext | null | undefined,
  companyId: string | null | undefined
): AuthContext {
  const resolved = requireContext(ctx);
  if (typeof companyId !== "string" || companyId === "") {
    throw new AuthorizationError(
      AUTHZ_CODES.companyScopeUnresolved,
      "This action could not be scoped to an owning company"
    );
  }
  if (resolved.companyId !== companyId) {
    throw new AuthorizationError(
      AUTHZ_CODES.companyForbidden,
      "This action is limited to the owning company"
    );
  }
  return resolved;
}

/** Role AND owning company, checked in that order. */
export function requireRoleAndCompany(
  ctx: AuthContext | null | undefined,
  role: Role,
  companyId: string | null | undefined
): AuthContext {
  requireRole(ctx, role);
  return requireCompany(ctx, companyId);
}

// --- Named conveniences for the rules the spec states repeatedly ------------

/** Buyer-only, no ownership target (create Site / create Request). */
export function requireBuyer(ctx: AuthContext | null | undefined): AuthContext {
  return requireRole(ctx, "buyer");
}

/** Supplier-only, no ownership target (submit Offer). */
export function requireSupplier(
  ctx: AuthContext | null | undefined
): AuthContext {
  return requireRole(ctx, "supplier");
}

/** Admin-only (Requirements 12.7, 16.8, 17.5). */
export function requireAdmin(ctx: AuthContext | null | undefined): AuthContext {
  return requireRole(ctx, "admin");
}

/** A Buyer on the owning Buyer Company (Requirements 8.5, 9.5). */
export function requireOwningBuyerCompany(
  ctx: AuthContext | null | undefined,
  buyerCompanyId: string | null | undefined
): AuthContext {
  return requireRoleAndCompany(ctx, "buyer", buyerCompanyId);
}

/** A Supplier on the winning Supplier Company (Requirement 11.7). */
export function requireWinningSupplierCompany(
  ctx: AuthContext | null | undefined,
  supplierCompanyId: string | null | undefined
): AuthContext {
  return requireRoleAndCompany(ctx, "supplier", supplierCompanyId);
}

/**
 * Read access to an Order: the Buyer on the owning Buyer Company, the Supplier
 * on the winning Supplier Company, or an Admin (who monitors the marketplace).
 * Writes use the stricter `requireWinningSupplierCompany`.
 */
export function requireOrderParty(
  ctx: AuthContext | null | undefined,
  order: Pick<Order, "buyerCompanyId" | "supplierCompanyId">
): AuthContext {
  const resolved = requireContext(ctx);
  if (resolved.role === "admin") return resolved;
  if (resolved.role === "buyer") {
    return requireCompany(resolved, order.buyerCompanyId);
  }
  return requireCompany(resolved, order.supplierCompanyId);
}

// ---------------------------------------------------------------------------
// Declarative action policy — the authorization matrix in one place
// ---------------------------------------------------------------------------

/**
 * Every authorization-bearing marketplace action. Services name the action
 * they are about to perform and let `requireAction` decide, which keeps the
 * matrix reviewable in one place instead of scattered across services.
 */
export const AUTHORIZED_ACTIONS = [
  // Buyer surface
  "site.create",
  "site.list",
  "request.create",
  "request.list",
  "request.cancel",
  "offer.list",
  "offer.accept",
  // Supplier surface
  "supplier.setStatus",
  "rfq.list",
  "offer.create",
  "order.listWon",
  "order.advance",
  "delivery.record",
  // Shared
  "order.read",
  // Admin surface
  "supplier.approve",
  "supplier.setOperatingLocation",
  "supplier.setServiceRadius",
  "geofence.set",
  "order.createConcierge",
  "invoice.markPaid",
  "commission.viewDue",
] as const;

export type AuthorizedAction = (typeof AUTHORIZED_ACTIONS)[number];

/**
 * `own_company` actions must be called with the owning company id (the
 * Request's buyer company, the Order's winning supplier company, the Supplier
 * Company being toggled). `none` actions carry no ownership target because the
 * service derives the company from the caller (`ctx.companyId`) or because the
 * action is Admin-only and not scoped to a trading company.
 */
export type ActionScope = "none" | "own_company";

export interface ActionPolicy {
  roles: readonly Role[];
  scope: ActionScope;
  /** Requirement ids this row enforces, for traceability. */
  requirements: readonly string[];
}

export const ACTION_POLICIES: Record<AuthorizedAction, ActionPolicy> = {
  // --- Buyer -------------------------------------------------------------
  "site.create": { roles: ["buyer"], scope: "none", requirements: ["2.1"] },
  "site.list": { roles: ["buyer"], scope: "own_company", requirements: ["2.3"] },
  "request.create": { roles: ["buyer"], scope: "none", requirements: ["3.1"] },
  "request.list": {
    roles: ["buyer"],
    scope: "own_company",
    requirements: ["3.9"],
  },
  "request.cancel": {
    roles: ["buyer"],
    scope: "own_company",
    requirements: ["9.1", "9.5"],
  },
  "offer.list": { roles: ["buyer"], scope: "own_company", requirements: ["6.6"] },
  "offer.accept": {
    roles: ["buyer"],
    scope: "own_company",
    requirements: ["8.1", "8.5"],
  },

  // --- Supplier ----------------------------------------------------------
  "supplier.setStatus": {
    roles: ["supplier"],
    scope: "own_company",
    requirements: ["5.2"],
  },
  "rfq.list": {
    roles: ["supplier"],
    scope: "own_company",
    requirements: ["4.3"],
  },
  "offer.create": {
    roles: ["supplier"],
    scope: "none",
    requirements: ["6.1"],
  },
  "order.listWon": {
    roles: ["supplier"],
    scope: "own_company",
    requirements: ["8.7"],
  },
  "order.advance": {
    roles: ["supplier"],
    scope: "own_company",
    requirements: ["10.2", "10.3"],
  },
  "delivery.record": {
    roles: ["supplier"],
    scope: "own_company",
    requirements: ["11.1", "11.7"],
  },

  // --- Shared ------------------------------------------------------------
  /**
   * Party scoping for a read spans two companies, so the strict check lives in
   * `requireOrderParty`; this row only states that all three roles have the
   * action on their surface.
   */
  "order.read": {
    roles: ["buyer", "supplier", "admin"],
    scope: "none",
    requirements: ["10.6"],
  },

  // --- Admin (never company-scoped) --------------------------------------
  "supplier.approve": {
    roles: ["admin"],
    scope: "none",
    requirements: ["16.2", "16.8"],
  },
  "supplier.setOperatingLocation": {
    roles: ["admin"],
    scope: "none",
    requirements: ["16.4", "16.8"],
  },
  "supplier.setServiceRadius": {
    roles: ["admin"],
    scope: "none",
    requirements: ["16.5", "16.8"],
  },
  "geofence.set": {
    roles: ["admin"],
    scope: "none",
    requirements: ["16.7", "16.8"],
  },
  "order.createConcierge": {
    roles: ["admin"],
    scope: "none",
    requirements: ["17.1", "17.5"],
  },
  "invoice.markPaid": {
    roles: ["admin"],
    scope: "none",
    requirements: ["12.6", "12.7"],
  },
  "commission.viewDue": {
    roles: ["admin"],
    scope: "none",
    requirements: ["12.8"],
  },
};

export interface ActionScopeInput {
  /** The owning company of the target resource; required for `own_company`. */
  companyId?: string | null;
}

/**
 * The guard services call: asserts the caller's role admits the action and,
 * where the action is company-scoped, that the caller's Company owns the
 * target. Throws `AuthorizationError` (403) on any violation
 * (Requirement 1.9).
 */
export function requireAction(
  ctx: AuthContext | null | undefined,
  action: AuthorizedAction,
  scope: ActionScopeInput = {}
): AuthContext {
  const policy = ACTION_POLICIES[action];
  const resolved = requireAnyRole(ctx, policy.roles);
  if (policy.scope === "own_company") {
    return requireCompany(resolved, scope.companyId);
  }
  return resolved;
}

/** Non-throwing form of `requireAction`, for UI gating and filtering. */
export function canPerform(
  ctx: AuthContext | null | undefined,
  action: AuthorizedAction,
  scope: ActionScopeInput = {}
): boolean {
  try {
    requireAction(ctx, action, scope);
    return true;
  } catch {
    return false;
  }
}

/** Every action a role may attempt (scope still checked per call). */
export function actionsForRole(role: Role): AuthorizedAction[] {
  return AUTHORIZED_ACTIONS.filter((action) =>
    ACTION_POLICIES[action].roles.includes(role)
  );
}

// ---------------------------------------------------------------------------
// Role-appropriate interface selection (Requirement 1.8)
// ---------------------------------------------------------------------------

export type RoleSurface = "buyer" | "supplier" | "admin";

export interface NavigationItem {
  id: string;
  label: string;
  path: string;
}

/**
 * Data-only description of the interface to present for a role. The PWA
 * (task 14) renders from this; nothing here imports React, so the same
 * descriptor is available to the API and to tests.
 */
export interface RoleInterface {
  role: Role;
  surface: RoleSurface;
  homePath: string;
  navigation: readonly NavigationItem[];
  capabilities: readonly AuthorizedAction[];
}

const ROLE_NAVIGATION: Record<Role, readonly NavigationItem[]> = {
  buyer: [
    { id: "loads", label: "My loads", path: "/buyer" },
    { id: "new-request", label: "New request", path: "/buyer/requests/new" },
    { id: "sites", label: "Sites", path: "/buyer/sites" },
  ],
  supplier: [
    { id: "rfqs", label: "RFQ inbox", path: "/supplier" },
    { id: "won-orders", label: "Won orders", path: "/supplier/orders" },
    { id: "availability", label: "Availability", path: "/supplier/status" },
  ],
  admin: [
    { id: "suppliers", label: "Suppliers", path: "/admin/suppliers" },
    { id: "geofence", label: "Pilot geofence", path: "/admin/geofence" },
    { id: "concierge", label: "Concierge order", path: "/admin/concierge" },
    { id: "commission", label: "Commission due", path: "/admin/commission" },
  ],
};

/** The surface for a role (Requirement 1.8). */
export function interfaceForRole(role: Role): RoleInterface {
  return {
    role,
    surface: role,
    homePath: ROLE_NAVIGATION[role][0].path,
    navigation: ROLE_NAVIGATION[role],
    capabilities: actionsForRole(role),
  };
}

/**
 * The surface for the authenticated caller, read from the session-resolved
 * `AuthContext` (Requirement 1.8). Denies when no session resolved, so an
 * unauthenticated caller never gets a role surface by default.
 */
export function interfaceFor(ctx: AuthContext | null | undefined): RoleInterface {
  return interfaceForRole(requireContext(ctx).role);
}
