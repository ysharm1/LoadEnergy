/**
 * Input parsing at the API boundary.
 *
 * Strictly parsing, never validating: these helpers turn wire formats (a JSON
 * body, a multipart field, a query string) into JavaScript values and stop
 * there. Whether a number is a legal gallon count, whether an enum member
 * exists, whether a price is positive — all of that belongs to the services,
 * which already own those rules and their error codes. A handler that
 * second-guessed them would be a second source of truth.
 *
 * The one thing parsing does reject is a body that is not a JSON object at
 * all, because there is no field for a service to complain about in that case.
 */

import { ValidationError } from "@/domain/errors";

export type JsonObject = Record<string, unknown>;

/**
 * Reads a JSON object body. An absent, malformed, or non-object body is a
 * validation error (400) rather than a 500 — a truncated request from a phone
 * on bad LTE is a client-fixable problem.
 */
export async function readJsonObject(request: Request): Promise<JsonObject> {
  let parsed: unknown;
  try {
    const text = await request.text();
    parsed = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new ValidationError(
      "BODY_INVALID",
      "Request body must be valid JSON"
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError(
      "BODY_INVALID",
      "Request body must be a JSON object"
    );
  }
  return parsed as JsonObject;
}

/** True when the request carries a multipart form (the ticket-photo path). */
export function isMultipart(request: Request): boolean {
  const contentType = request.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("multipart/form-data");
}

/**
 * Coerces a form field to a number for a service that expects one.
 *
 * An unparseable value becomes `NaN` rather than an error, and a missing one
 * stays `undefined`: both are then rejected by the service's own validator
 * (`requireBolGallons`, `requireLandedPrice`, ...) with the field-specific code
 * and message the client knows how to render.
 */
export function numberField(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return Number(trimmed);
}

/** Same contract as `numberField`, for a string field. */
export function stringField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : String(value);
}
