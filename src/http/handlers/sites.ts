/**
 * Site routes (Requirements 2.1, 2.3).
 *
 *   POST /api/sites  create a Site on the caller's Buyer Company
 *   GET  /api/sites  list the caller's Company's Sites
 *
 * The owning Company is never read from the body or the query string — the
 * service takes it from the session-resolved `AuthContext`, so there is no
 * parameter a caller could point at another tenant.
 */

import type { Services } from "@/composition/root";
import { requireAuth } from "../auth-context";
import { numberField, readJsonObject, stringField } from "../request";
import { handle, json } from "../respond";

/** `POST /api/sites` (Requirements 2.1, 2.2, 2.4). */
export function createSiteHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const body = await readJsonObject(request);

    const site = await services.sites.createSite(ctx, {
      name: stringField(body.name) as string,
      lat: numberField(body.lat) as number,
      lng: numberField(body.lng) as number,
    });

    return json({ site }, 201);
  });
}

/** `GET /api/sites` (Requirement 2.3). */
export function listSitesHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const sites = await services.sites.listSites(ctx);
    return json({ sites });
  });
}
