/**
 * Site service — the Buyer's reusable delivery locations.
 *
 * Requirements:
 *   2.1 a Buyer submitting a Site with a name and a geographic pin creates the
 *       Site associated with the Buyer's Company.
 *   2.2 the pin is stored as a latitude/longitude pair.
 *   2.3 listing returns only Sites belonging to the caller's Company.
 *   2.4 a latitude outside [-90, 90] or a longitude outside [-180, 180] is
 *       rejected with a validation error.
 *
 * Same shape as the other services: a class over the injected `Repository`, a
 * caller-supplied `now`, and every entry point through `requireAction` so the
 * authorization matrix stays the single source of truth. Coordinate validation
 * reuses `requireLatitude` / `requireLongitude` from the Admin service rather
 * than restating the bounds, so a Site pin and an Operating_Location are held
 * to exactly the same rule.
 *
 * A Site is not geofenced. The Pilot_Geofence gates Requests (Requirement 3.6),
 * not the address book, so a Buyer can keep a site on file that is currently
 * outside the pilot area.
 */

import { ValidationError } from "@/domain/errors";
import type { AuthContext, Site } from "@/domain/types";
import type { Repository } from "@/repository/repository";
import { requireLatLng } from "./admin";
import { requireAction } from "./authorization";

export interface CreateSiteInput {
  name: string;
  lat: number;
  lng: number;
}

export interface SiteServiceDeps {
  repo: Repository;
}

export class SiteService {
  private readonly repo: Repository;

  constructor(deps: SiteServiceDeps) {
    this.repo = deps.repo;
  }

  /**
   * Creates a Site on the caller's Buyer Company (Requirements 2.1, 2.2).
   *
   * The owning company is taken from the session, never from the request body,
   * so a Buyer cannot plant a Site on another Company. Coordinates are
   * validated before anything is written (Requirement 2.4).
   */
  async createSite(
    ctx: AuthContext,
    input: CreateSiteInput,
    now: Date = new Date()
  ): Promise<Site> {
    const caller = requireAction(ctx, "site.create");

    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (name === "") {
      throw new ValidationError(
        "SITE_NAME_REQUIRED",
        "A site name is required",
        "name"
      );
    }

    const { lat, lng } = requireLatLng(input);

    const company = await this.repo.getCompany(caller.companyId);
    if (!company) {
      throw new ValidationError(
        "COMPANY_NOT_FOUND",
        "A Site must belong to an existing Company",
        "companyId"
      );
    }

    return this.repo.createSite({
      companyId: company.id,
      name,
      lat,
      lng,
      createdAt: new Date(now.getTime()),
    });
  }

  /**
   * Lists the caller's Company's Sites (Requirement 2.3).
   *
   * `companyId` defaults to the caller's own Company; passing another
   * Company's id is denied with an authorization error by the `own_company`
   * scope rather than quietly returning an empty list, so a cross-tenant read
   * is a visible failure.
   */
  async listSites(ctx: AuthContext, companyId?: string): Promise<Site[]> {
    const target = companyId ?? ctx?.companyId;
    requireAction(ctx, "site.list", { companyId: target });
    return this.repo.listSitesByCompany(target as string);
  }
}
