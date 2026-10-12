/**
 * Domain error taxonomy for Load Energy.
 *
 * Five categories map to stable HTTP responses at the API boundary
 * (see design.md "Error Handling"):
 *   validation     -> 400
 *   geofence       -> 422
 *   authentication -> 401
 *   authorization  -> 403
 *   conflict       -> 409
 *
 * The service layer throws these; route handlers translate them into the
 * shared `{ error: { code, message, field? } }` response shape.
 */

export const ERROR_CATEGORIES = [
  "validation",
  "geofence",
  "authentication",
  "authorization",
  "conflict",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** Category -> HTTP status, per the design's Error Handling table. */
export const HTTP_STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  validation: 400,
  authentication: 401,
  authorization: 403,
  geofence: 422,
  conflict: 409,
};

export class DomainError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly field?: string;
  /** Extra context echoed to the client (e.g., the configured bounding box). */
  readonly details?: Record<string, unknown>;

  constructor(
    category: ErrorCategory,
    code: string,
    message: string,
    field?: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "DomainError";
    this.category = category;
    this.code = code;
    this.field = field;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS_BY_CATEGORY[this.category];
  }
}

export class ValidationError extends DomainError {
  constructor(code: string, message: string, field?: string) {
    super("validation", code, message, field);
    this.name = "ValidationError";
  }
}

/** Request pin outside the Pilot_Geofence (422, code `OUTSIDE_GEOFENCE`). */
export class GeofenceError extends DomainError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    code = "OUTSIDE_GEOFENCE"
  ) {
    super("geofence", code, message, undefined, details);
    this.name = "GeofenceError";
  }
}

export class AuthenticationError extends DomainError {
  constructor(code: string, message: string) {
    super("authentication", code, message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends DomainError {
  constructor(code: string, message: string) {
    super("authorization", code, message);
    this.name = "AuthorizationError";
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string) {
    super("conflict", code, message);
    this.name = "ConflictError";
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

export function httpStatusFor(category: ErrorCategory): number {
  return HTTP_STATUS_BY_CATEGORY[category];
}
