/**
 * The API boundary's response shaping — the one place a thrown domain error
 * becomes an HTTP response.
 *
 * Every route handler returns through `json` or `errorResponse`, so the
 * category -> status mapping from the design's Error Handling table
 * (validation 400, authentication 401, authorization 403, conflict 409,
 * geofence 422) is applied in exactly one place and cannot drift per route:
 *
 *   `DomainError.httpStatus` already carries the mapping (see
 *   `HTTP_STATUS_BY_CATEGORY`), so this module reads it rather than restating
 *   it. Anything that is not a `DomainError` is a bug, not a rejected request,
 *   and becomes an opaque 500.
 *
 * All error bodies share the shape `{ error: { code, message, field? } }`.
 * `details` is appended only where the service attached context the client is
 * meant to see — in practice the configured bounding box on a geofence
 * rejection, which the design calls for so the PWA can say "outside service
 * area" with the area in hand.
 */

import { isDomainError } from "@/domain/errors";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    field?: string;
    /** Extra client-facing context (e.g. the geofence bounds). */
    details?: Record<string, unknown>;
  };
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/** A JSON success response. */
export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** `204 No Content`, for a write with nothing useful to return. */
export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers });
}

/**
 * The shared error mapper. A `DomainError` reports its own category's status
 * and its stable code; anything else is an unexpected fault.
 *
 * Unexpected faults are deliberately opaque: the message is fixed and the
 * original is logged server-side rather than returned, so a stack trace, a
 * database message, or a connection string can never reach a field device.
 */
export function errorResponse(
  error: unknown,
  headers: Record<string, string> = {}
): Response {
  if (isDomainError(error)) {
    const body: ApiErrorBody = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.field !== undefined ? { field: error.field } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    };
    return json(body, error.httpStatus, headers);
  }

  // Not a rejected request — a defect. Log it, tell the client nothing.
  console.error("Unhandled API error", error);
  const body: ApiErrorBody = {
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong handling this request",
    },
  };
  return json(body, 500, headers);
}

/**
 * Runs a handler and maps anything it throws (Requirements 1.2, 3.5, 3.6, 7.3,
 * 8.4, 8.5 and every other error-bearing criterion) through `errorResponse`.
 * Every route goes through this so no handler can forget the mapping.
 */
export async function handle(
  run: () => Promise<Response>,
  headers: Record<string, string> = {}
): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    return errorResponse(error, headers);
  }
}
