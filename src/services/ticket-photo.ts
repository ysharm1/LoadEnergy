/**
 * Ticket-photo storage port and the non-fatal upload rule (Requirement 11.6).
 *
 * A BOL ticket photo is corroborating evidence, not the record: the Delivery's
 * gallons and ticket number are what the marketplace bills from
 * (Requirements 11.1, 11.4, 11.5), and the design states plainly that an
 * upload failure must leave the photo key null and still record the delivery,
 * retryable later. So `uploadTicketPhoto` never throws — it returns the stored
 * key or null plus the reason.
 *
 * That rule lives here rather than in the route handler so it is testable
 * without HTTP and so the single caller cannot accidentally make a dead object
 * store fatal to a driver standing at a jobsite on one bar of LTE.
 *
 * The port is deliberately minimal (`put` -> key). The production adapter is
 * `src/infra/s3-ticket-photo-storage.ts`; tests inject an in-memory one.
 */

import { randomUUID } from "node:crypto";

export interface TicketPhotoUpload {
  /** The object key to store under. */
  key: string;
  body: Uint8Array;
  contentType: string;
}

export interface TicketPhotoStorage {
  /** Stores the object. Resolves with the key it was stored under. */
  put(upload: TicketPhotoUpload): Promise<string>;
}

/** Content types a phone camera realistically produces. */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
};

export const DEFAULT_TICKET_PHOTO_CONTENT_TYPE = "application/octet-stream";

/**
 * Derives the object key: `tickets/{orderId}/{uuid}.{ext}`.
 *
 * Keyed by order with a random suffix rather than by the client's filename,
 * which is attacker-controlled and would otherwise let a caller write outside
 * the prefix (`../`) or overwrite another order's photo. The extension is taken
 * from the content type, from a fixed allow-list, for the same reason.
 */
export function ticketPhotoKeyFor(
  orderId: string,
  contentType: string | null | undefined,
  uuid: () => string = randomUUID
): string {
  const normalized = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const extension = EXTENSION_BY_CONTENT_TYPE[normalized] ?? "bin";
  // `orderId` is a repository-issued id, but it is still confined to key-safe
  // characters so a malformed one cannot shape the key either.
  const safeOrderId = orderId.replace(/[^A-Za-z0-9._-]/g, "");
  return `tickets/${safeOrderId}/${uuid()}.${extension}`;
}

export interface TicketPhotoResult {
  /** Null when there was nothing to upload, or the upload failed. */
  key: string | null;
  /** Present only on failure, for logging — never surfaced to the client. */
  error?: string;
}

/**
 * Stores a ticket photo, treating any failure as non-fatal (Requirement 11.6).
 *
 * Returns `{ key: null }` when no storage is configured or no photo was sent,
 * so the caller can hand the result straight to `recordDelivery` either way.
 */
export async function uploadTicketPhoto(
  storage: TicketPhotoStorage | undefined,
  orderId: string,
  photo: { body: Uint8Array; contentType: string | null } | null,
  uuid: () => string = randomUUID
): Promise<TicketPhotoResult> {
  if (!storage || !photo || photo.body.byteLength === 0) return { key: null };

  const key = ticketPhotoKeyFor(orderId, photo.contentType, uuid);
  try {
    const stored = await storage.put({
      key,
      body: photo.body,
      contentType: photo.contentType ?? DEFAULT_TICKET_PHOTO_CONTENT_TYPE,
    });
    return { key: stored };
  } catch (error) {
    // Non-fatal by design: the gallons and ticket number still record.
    const message =
      error instanceof Error ? error.message : "Ticket photo upload failed";
    console.error("Ticket photo upload failed", { orderId, key, error });
    return { key: null, error: message };
  }
}
