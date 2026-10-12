/**
 * Order routes (Requirements 10.2, 10.6, 11.1, 11.6).
 *
 *   GET  /api/orders/{id}           read an Order and its Delivery
 *   POST /api/orders/{id}/status    advance the forward-only status
 *   POST /api/orders/{id}/delivery  record the BOL, optionally with a photo
 *
 * The delivery route is the only handler in the API that touches
 * infrastructure directly, because the ticket photo is the only payload that
 * is not a database row. Its rule (Requirement 11.6) is that the photo is
 * corroboration, never a precondition: `uploadTicketPhoto` cannot throw, so a
 * dead object store costs the photo key and nothing else — the gallons and the
 * ticket number still record and the Order still reaches Delivered.
 */

import type { Services } from "@/composition/root";
import type { OrderStatus } from "@/domain/types";
import { uploadTicketPhoto } from "@/services/ticket-photo";
import { requireAuth } from "../auth-context";
import {
  isMultipart,
  numberField,
  readJsonObject,
  stringField,
} from "../request";
import { handle, json } from "../respond";

/**
 * Upper bound on a ticket photo, a little above what a phone camera produces.
 *
 * An oversize file is skipped rather than rejected, on the same reasoning as an
 * upload failure: a driver at a jobsite must be able to record the BOL, and
 * refusing the whole delivery over an attachment would be the one outcome the
 * requirement rules out. The miss is logged and the photo can be retried.
 */
export const MAX_TICKET_PHOTO_BYTES = 15 * 1024 * 1024;

/**
 * `GET /api/orders` — the winning Supplier Company's won orders
 * (Requirement 8.7).
 *
 * Supplier-only by the `order.listWon` policy row, and scoped to the caller's
 * own Company: the company is taken from the session, never from a query
 * parameter, so this cannot be pointed at another supplier's book of business.
 * A Buyer's orders arrive on the work list (`GET /api/requests`) instead.
 */
export function listWonOrdersHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const orders = await services.orders.listWonOrders(ctx);
    return json({ orders });
  });
}

/** `GET /api/orders/{orderId}` (Requirement 10.6). */
export function readOrderHandler(
  services: Services,
  request: Request,
  orderId: string
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const order = await services.orders.readOrder(ctx, orderId);
    return json({ order });
  });
}

/** `POST /api/orders/{orderId}/status` (Requirements 10.2-10.5). */
export function advanceOrderStatusHandler(
  services: Services,
  request: Request,
  orderId: string
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const body = await readJsonObject(request);

    // Status membership and the forward-only rule are the service's call.
    const next = stringField(body.status) as OrderStatus;
    const order = await services.orders.advanceStatus(ctx, orderId, next);

    return json({ order });
  });
}

interface DeliveryInput {
  bolGallons: number;
  ticketNumber: string;
  photo: { body: Uint8Array; contentType: string | null } | null;
  /** A key from a client that uploaded the photo out of band. */
  ticketPhotoKey: string | null;
}

/**
 * Accepts both shapes the field UI needs: a multipart form (the delivery form
 * with a camera capture) and a plain JSON body (no photo, or a key the client
 * already holds).
 */
async function readDeliveryInput(request: Request): Promise<DeliveryInput> {
  if (!isMultipart(request)) {
    const body = await readJsonObject(request);
    return {
      bolGallons: numberField(body.bolGallons) as number,
      ticketNumber: stringField(body.ticketNumber) as string,
      photo: null,
      ticketPhotoKey: stringField(body.ticketPhotoKey) ?? null,
    };
  }

  const form = await request.formData();
  const photoField = form.get("photo");
  let photo: DeliveryInput["photo"] = null;

  if (photoField != null && typeof photoField !== "string") {
    const file = photoField as Blob;
    if (file.size > 0 && file.size <= MAX_TICKET_PHOTO_BYTES) {
      photo = {
        body: new Uint8Array(await file.arrayBuffer()),
        contentType: file.type === "" ? null : file.type,
      };
    } else if (file.size > MAX_TICKET_PHOTO_BYTES) {
      console.warn(
        `Ticket photo of ${file.size} bytes exceeds the ${MAX_TICKET_PHOTO_BYTES} byte limit; recording the delivery without it`
      );
    }
  }

  return {
    bolGallons: numberField(form.get("bolGallons")) as number,
    ticketNumber: stringField(form.get("ticketNumber")) as string,
    photo,
    ticketPhotoKey: stringField(form.get("ticketPhotoKey")) ?? null,
  };
}

/**
 * `POST /api/orders/{orderId}/delivery` (Requirements 11.1-11.7, 11.6).
 *
 * The photo is stored first because the key is part of the Delivery row and
 * there is no path that edits a Delivery afterwards. An authenticated caller
 * who turns out not to own the Order can therefore leave one orphaned object
 * behind under that order's prefix before `recordDelivery` denies them; the
 * key is order-scoped and random, so the object is unreachable and sweepable,
 * which is a better trade than a Delivery whose photo can never be attached.
 */
export function recordDeliveryHandler(
  services: Services,
  request: Request,
  orderId: string
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const input = await readDeliveryInput(request);

    // Requirement 11.6 — never throws; a failure yields a null key.
    const uploaded = await uploadTicketPhoto(
      services.ticketPhotos,
      orderId,
      input.photo
    );

    const delivery = await services.orders.recordDelivery(ctx, orderId, {
      bolGallons: input.bolGallons,
      ticketNumber: input.ticketNumber,
      ticketPhotoKey: uploaded.key ?? input.ticketPhotoKey,
    });

    return json(
      {
        delivery,
        // Lets the client offer a retry without guessing why the key is null.
        ticketPhotoStored: delivery.ticketPhotoKey !== null,
      },
      201
    );
  });
}
