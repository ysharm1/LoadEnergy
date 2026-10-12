/**
 * Offer routes (Requirements 6.1, 8.1).
 *
 *   POST /api/offers              submit a quote
 *   POST /api/offers/{id}/accept  accept a quote, producing the Order
 *
 * Acceptance lives on the Offer path because that is the resource the Buyer
 * taps, but it is `OrderService.acceptOffer` that runs — the single gatekeeper
 * for anything that creates or moves an Order.
 */

import type { Services } from "@/composition/root";
import { requireAuth } from "../auth-context";
import { numberField, readJsonObject, stringField } from "../request";
import { handle, json } from "../respond";

/** `POST /api/offers` (Requirements 6.1-6.5, 5.4, 5.5). */
export function createOfferHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const body = await readJsonObject(request);

    const offer = await services.offers.createOffer(ctx, {
      requestId: stringField(body.requestId) as string,
      landedPricePerGal: numberField(body.landedPricePerGal) as number,
      holdHours: numberField(body.holdHours) as number,
      etaMinutes: numberField(body.etaMinutes) ?? null,
    });

    return json({ offer }, 201);
  });
}

/**
 * `POST /api/offers/{offerId}/accept` (Requirements 7.3, 8.1-8.7).
 *
 * An expired hold, a load that is no longer Open, and a Closed supplier all
 * come back as conflicts (409) with their own codes, which is what tells the
 * PWA to refresh the resource rather than retry the tap.
 */
export function acceptOfferHandler(
  services: Services,
  request: Request,
  offerId: string
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const order = await services.orders.acceptOffer(ctx, offerId);
    return json({ order }, 201);
  });
}
