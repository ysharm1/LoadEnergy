/**
 * Request routes (Requirements 3.1, 3.6, 3.9, 9.1).
 *
 *   POST /api/requests                      post a load
 *   GET  /api/requests                      the buyer work list
 *   GET  /api/requests/{id}                 one load
 *   POST /api/requests/{id}/cancel          cancel an Open load
 *   GET  /api/requests/{id}/offers          the quotes on a load
 *
 * Nothing here decides anything. Gallons, the three enums, the notes, and the
 * pin go to `RequestService` as supplied: the geofence rejection (422 with the
 * configured box) and every validation error come back from the service with
 * their own codes, and the shared mapper turns them into responses.
 */

import type { Services } from "@/composition/root";
import type {
  DeliveryMethod,
  DeliveryWindow,
  ProductType,
} from "@/domain/types";
import { requireAuth } from "../auth-context";
import { numberField, readJsonObject, stringField } from "../request";
import { handle, json } from "../respond";

/** `POST /api/requests` (Requirements 3.1-3.8). */
export function createRequestHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const body = await readJsonObject(request);

    const created = await services.requests.createRequest(ctx, {
      gallons: numberField(body.gallons) as number,
      // Enum membership is the service's call (Requirements 3.2-3.4), so the
      // raw value is passed through rather than pre-filtered here.
      productType: stringField(body.productType) as ProductType,
      deliveryMethod: stringField(body.deliveryMethod) as DeliveryMethod,
      deliveryWindow: stringField(body.deliveryWindow) as DeliveryWindow,
      lat: numberField(body.lat) as number,
      lng: numberField(body.lng) as number,
      notes: stringField(body.notes) ?? null,
    });

    return json({ request: created }, 201);
  });
}

/** `GET /api/requests` — the buyer work list (Requirement 3.9). */
export function listRequestsHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const workList = await services.requests.getWorkList(ctx);
    return json(workList);
  });
}

/** `GET /api/requests/{requestId}` — evaluates window-end expiry as it reads. */
export function readRequestHandler(
  services: Services,
  request: Request,
  requestId: string
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const found = await services.requests.getRequest(ctx, requestId);
    return json({ request: found });
  });
}

/** `POST /api/requests/{requestId}/cancel` (Requirements 9.1, 9.2, 9.5). */
export function cancelRequestHandler(
  services: Services,
  request: Request,
  requestId: string
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const cancelled = await services.requests.cancelRequest(ctx, requestId);
    return json({ request: cancelled });
  });
}

/** `GET /api/requests/{requestId}/offers` (Requirements 6.6, 7.4). */
export function listOffersForRequestHandler(
  services: Services,
  request: Request,
  requestId: string
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const offers = await services.offers.listOffersForRequest(ctx, requestId);
    return json({ offers });
  });
}
