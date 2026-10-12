/**
 * Admin service — supplier approval, matching configuration, and the pilot
 * geofence.
 *
 * Requirements:
 *  16.1 a newly created Supplier Company starts Pending (enforced at creation
 *       in `CompanyUserService.createCompany`; asserted here by the approval
 *       lifecycle tests).
 *  16.2 an Admin approving a Supplier Company sets Supplier_Approval_Status to
 *       Approved.
 *  16.4 an Admin setting a Supplier Company's Operating_Location persists it.
 *  16.5 an Admin setting a Supplier Company's Service_Radius persists it.
 *  16.6 a Service_Radius <= 0 is rejected with a validation error.
 *  16.7 an Admin setting the Pilot_Geofence persists it; `getGeofence` is the
 *       read that Request creation (task 4) consumes so new Requests are
 *       checked against the currently configured box.
 *  16.8 a non-Admin attempting any of the above is denied with an
 *       authorization error.
 *
 * Shape follows the established service style: a class over injected ports, a
 * caller-supplied `now`, and no HTTP or ambient clock. Every entry point goes
 * through `requireAction` so the authorization matrix in
 * `services/authorization.ts` stays the single source of truth — no ad-hoc role
 * checks live here.
 *
 * License verification is deliberately absent: it is an offline ADOT process an
 * Admin performs before calling `approveSupplier`, and the system neither
 * scrapes nor certifies licenses.
 */

import { ValidationError } from "@/domain/errors";
import {
  MAX_LAT,
  MAX_LNG,
  MIN_LAT,
  MIN_LNG,
  type AuthContext,
  type Company,
  type Geofence,
  type LatLng,
  type PilotGeofence,
} from "@/domain/types";
import type { Repository } from "@/repository/repository";
import { requireAction } from "./authorization";

// ---------------------------------------------------------------------------
// Shared coordinate / radius validation (Requirements 2.4, 16.6)
// ---------------------------------------------------------------------------

/**
 * Validates one latitude against the inclusive range [-90, 90], rejecting
 * non-finite values (NaN, +/-Infinity) as well. `field` names the offending
 * input so the client can attach the message inline.
 */
export function requireLatitude(value: unknown, field = "lat"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(
      "LATITUDE_INVALID",
      "Latitude must be a finite number",
      field
    );
  }
  if (value < MIN_LAT || value > MAX_LAT) {
    throw new ValidationError(
      "LATITUDE_OUT_OF_RANGE",
      `Latitude must be between ${MIN_LAT} and ${MAX_LAT}`,
      field
    );
  }
  return value;
}

/** Validates one longitude against the inclusive range [-180, 180]. */
export function requireLongitude(value: unknown, field = "lng"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(
      "LONGITUDE_INVALID",
      "Longitude must be a finite number",
      field
    );
  }
  if (value < MIN_LNG || value > MAX_LNG) {
    throw new ValidationError(
      "LONGITUDE_OUT_OF_RANGE",
      `Longitude must be between ${MIN_LNG} and ${MAX_LNG}`,
      field
    );
  }
  return value;
}

/** Validates a coordinate pair, returning a clean `LatLng`. */
export function requireLatLng(
  point: { lat?: unknown; lng?: unknown } | null | undefined,
  latField = "lat",
  lngField = "lng"
): LatLng {
  return {
    lat: requireLatitude(point?.lat, latField),
    lng: requireLongitude(point?.lng, lngField),
  };
}

/**
 * Validates a Service_Radius (Requirement 16.6). Zero, negative, and
 * non-finite values are all rejected: a radius of 0 would match nothing and a
 * NaN radius would silently make every distance comparison false, so both are
 * configuration errors rather than empty-result cases.
 */
export function requireServiceRadiusMiles(
  value: unknown,
  field = "serviceRadiusMiles"
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(
      "SERVICE_RADIUS_INVALID",
      "Service radius must be a finite number of miles",
      field
    );
  }
  if (value <= 0) {
    throw new ValidationError(
      "SERVICE_RADIUS_INVALID",
      "Service radius must be greater than zero miles",
      field
    );
  }
  return value;
}

/**
 * Validates a Pilot_Geofence bounding box: every corner in range and
 * `min <= max` on both axes. Equal bounds are allowed (a degenerate box that
 * admits a single pin) — the check is inclusive, matching the geofence
 * membership test in task 4.
 */
export function requireGeofence(
  fence: Partial<Geofence> | null | undefined
): Geofence {
  const minLat = requireLatitude(fence?.minLat, "minLat");
  const maxLat = requireLatitude(fence?.maxLat, "maxLat");
  const minLng = requireLongitude(fence?.minLng, "minLng");
  const maxLng = requireLongitude(fence?.maxLng, "maxLng");

  if (minLat > maxLat) {
    throw new ValidationError(
      "GEOFENCE_BOUNDS_INVALID",
      "Geofence minLat must be less than or equal to maxLat",
      "minLat"
    );
  }
  if (minLng > maxLng) {
    throw new ValidationError(
      "GEOFENCE_BOUNDS_INVALID",
      "Geofence minLng must be less than or equal to maxLng",
      "minLng"
    );
  }
  return { minLat, maxLat, minLng, maxLng };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AdminServiceDeps {
  repo: Repository;
}

export class AdminService {
  private readonly repo: Repository;

  constructor(deps: AdminServiceDeps) {
    this.repo = deps.repo;
  }

  /**
   * Approves a Supplier Company (Requirement 16.2).
   *
   * Admin-only (Requirement 16.8). Idempotent: approving an already-Approved
   * company is a no-op that returns the company, so a double tap in the admin
   * UI is not an error.
   *
   * Approval only moves `supplierApprovalStatus`. It deliberately does not
   * touch `supplierStatus` — availability stays the supplier's own switch, so
   * an approved company still has to open up before it receives RFQs.
   */
  async approveSupplier(
    ctx: AuthContext,
    supplierCompanyId: string
  ): Promise<Company> {
    requireAction(ctx, "supplier.approve");
    const company = await this.requireSupplierCompany(supplierCompanyId);

    if (company.supplierApprovalStatus === "approved") return company;

    return this.repo.updateCompany(company.id, {
      supplierApprovalStatus: "approved",
    });
  }

  /**
   * Sets a Supplier Company's Operating_Location — the origin for
   * Service_Radius matching (Requirement 16.4). Admin-only
   * (Requirement 16.8); coordinates must be in range (validation error
   * otherwise).
   */
  async setOperatingLocation(
    ctx: AuthContext,
    supplierCompanyId: string,
    location: LatLng
  ): Promise<Company> {
    requireAction(ctx, "supplier.setOperatingLocation");
    const { lat, lng } = requireLatLng(location);
    const company = await this.requireSupplierCompany(supplierCompanyId);

    return this.repo.updateCompany(company.id, {
      operatingLat: lat,
      operatingLng: lng,
    });
  }

  /**
   * Sets a Supplier Company's Service_Radius in miles (Requirement 16.5).
   * Admin-only (Requirement 16.8); a radius <= 0 (or non-finite) is rejected
   * with a validation error on `serviceRadiusMiles` (Requirement 16.6).
   */
  async setServiceRadius(
    ctx: AuthContext,
    supplierCompanyId: string,
    radiusMiles: number
  ): Promise<Company> {
    requireAction(ctx, "supplier.setServiceRadius");
    const radius = requireServiceRadiusMiles(radiusMiles);
    const company = await this.requireSupplierCompany(supplierCompanyId);

    return this.repo.updateCompany(company.id, {
      serviceRadiusMiles: radius,
    });
  }

  /**
   * Persists the single Pilot_Geofence bounding box (Requirement 16.7).
   * Admin-only (Requirement 16.8). Records the setting Admin and the update
   * timestamp so a later change is attributable.
   *
   * There is exactly one geofence record: setting it replaces the current box,
   * and `getGeofence` is the read Request creation uses, which is what makes an
   * updated fence apply to newly created Requests.
   */
  async setGeofence(
    ctx: AuthContext,
    fence: Geofence,
    now: Date = new Date()
  ): Promise<PilotGeofence> {
    const admin = requireAction(ctx, "geofence.set");
    const bounds = requireGeofence(fence);

    return this.repo.setPilotGeofence({
      ...bounds,
      setByAdminId: admin.userId,
      updatedAt: new Date(now.getTime()),
    });
  }

  /**
   * Reads the configured Pilot_Geofence, or null when an Admin has not set one
   * yet. Unauthenticated-safe on purpose: Request creation (task 4) needs the
   * fence on a Buyer's behalf, and the box is not secret.
   */
  async getGeofence(): Promise<PilotGeofence | null> {
    return this.repo.getPilotGeofence();
  }

  /** One Supplier Company with its Admin-set configuration. */
  async getSupplierCompany(id: string): Promise<Company | null> {
    const company = await this.repo.getCompany(id);
    if (!company || company.kind !== "supplier") return null;
    return company;
  }

  /**
   * Every Supplier Company, for the admin approval/configuration list. Returns
   * both Pending and Approved companies — deciding who still needs approval is
   * the point of the list.
   */
  async listSupplierCompanies(): Promise<Company[]> {
    return this.repo.listSupplierCompanies();
  }

  /**
   * Every Company split by kind — the read behind the Admin surface's approval
   * list, the Operating_Location / Service_Radius editors, and the concierge
   * buyer/supplier pickers.
   *
   * Gated by the existing `supplier.approve` policy row rather than a new
   * action: this list exists only to feed those Admin-only writes, so it
   * carries exactly their authority (Requirement 16.8) and the authorization
   * matrix keeps one row per decision instead of growing a read-only twin.
   */
  async listCompanies(
    ctx: AuthContext
  ): Promise<{ buyers: Company[]; suppliers: Company[] }> {
    requireAction(ctx, "supplier.approve");

    const companies = await this.repo.listCompanies();
    return {
      buyers: companies.filter((company) => company.kind === "buyer"),
      suppliers: companies.filter((company) => company.kind === "supplier"),
    };
  }

  /**
   * Resolves a Supplier Company for an Admin write. A missing company and a
   * Buyer company are both validation errors on the id: approval, operating
   * location, and radius are supplier-only fields, so pointing them at a buyer
   * is a malformed request rather than a state conflict.
   */
  private async requireSupplierCompany(
    supplierCompanyId: string
  ): Promise<Company> {
    const id = typeof supplierCompanyId === "string" ? supplierCompanyId.trim() : "";
    const company = id === "" ? null : await this.repo.getCompany(id);

    if (!company) {
      throw new ValidationError(
        "SUPPLIER_COMPANY_NOT_FOUND",
        "No such supplier company",
        "supplierCompanyId"
      );
    }
    if (company.kind !== "supplier") {
      throw new ValidationError(
        "COMPANY_NOT_SUPPLIER",
        "This action applies only to a supplier company",
        "supplierCompanyId"
      );
    }
    return company;
  }
}
