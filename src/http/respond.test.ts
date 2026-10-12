/**
 * Unit tests for the shared error mapper at the API boundary (task 13.4).
 *
 * This is the one place a thrown domain error becomes an HTTP response, so the
 * category -> status table from the design's Error Handling section is pinned
 * here with a representative real error per category:
 *
 *   validation     400  non-positive gallons on a Request   (Req 3.5)
 *   authentication 401  invalid credential pair             (Req 1.2)
 *   authorization  403  non-owner Offer acceptance          (Req 8.5)
 *   conflict       409  expired Offer hold                  (Req 7.3)
 *                       acceptance on a non-Open Request    (Req 8.4)
 *   geofence       422  pin outside the Pilot_Geofence      (Req 3.6)
 *
 * Anything that is not a `DomainError` is a defect, not a rejected request,
 * and must leave as an opaque 500 that leaks neither the original message nor
 * its stack to a field device.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  DomainError,
  GeofenceError,
  ValidationError,
} from "@/domain/errors";
import { requireGallons } from "@/services/request";
import { requireOwningBuyerCompany } from "@/services/authorization";
import type { AuthContext } from "@/domain/types";
import { errorResponse, handle, json, noContent } from "./respond";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    field?: string;
    details?: Record<string, unknown>;
  };
}

/** Runs a thrower and hands back what it threw, so real errors can be mapped. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

async function bodyOf(response: Response): Promise<ErrorBody> {
  return (await response.json()) as ErrorBody;
}

// ---------------------------------------------------------------------------
// Representative errors, as the services actually throw them
// ---------------------------------------------------------------------------

/** Requirement 3.5 — real throw from the Request service's gallons guard. */
const NON_POSITIVE_GALLONS = thrownBy(() => requireGallons(0));

/** Requirement 8.5 — real throw from the owning-buyer-company guard. */
const NON_OWNER_ACCEPT = thrownBy(() => {
  const outsider: AuthContext = {
    userId: "user-outsider",
    companyId: "company-outsider",
    role: "buyer",
  };
  return requireOwningBuyerCompany(outsider, "company-owning-buyer");
});

/** Requirement 1.2 — `AuthService` on an invalid credential pair. */
const INVALID_CREDENTIALS = new AuthenticationError(
  "INVALID_CREDENTIALS",
  "The phone/email and password combination is not valid"
);

/** Requirement 7.3 — `OrderService.acceptOffer` on an elapsed hold. */
const EXPIRED_OFFER = new ConflictError(
  "OFFER_EXPIRED",
  "This offer's hold has expired and can no longer be accepted"
);

/** Requirement 8.4 — acceptance attempted on a Request that is not Open. */
const REQUEST_NOT_OPEN = new ConflictError(
  "REQUEST_NOT_OPEN",
  "This load is no longer open, so no offer on it can be accepted"
);

/** The Phoenix-area pilot box the geofence rejection echoes back. */
const PILOT_FENCE = {
  minLat: 33.2,
  maxLat: 33.75,
  minLng: -112.6,
  maxLng: -111.6,
};

/** Requirement 3.6 — `RequestService.create` on an out-of-area pin. */
const OUTSIDE_GEOFENCE = new GeofenceError(
  "This location is outside the pilot service area",
  { fence: { ...PILOT_FENCE } }
);

describe("json", () => {
  it("defaults to 200 and declares a JSON content type", async () => {
    const response = json({ ok: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(JSON_CONTENT_TYPE);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("honors an explicit status and merges extra headers", () => {
    const response = json({ id: "req-1" }, 201, { "X-Request-Id": "abc" });

    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Type")).toBe(JSON_CONTENT_TYPE);
    expect(response.headers.get("X-Request-Id")).toBe("abc");
  });

  it("serializes an undefined body as JSON null rather than an empty body", async () => {
    await expect(json(undefined).json()).resolves.toBeNull();
  });
});

describe("noContent", () => {
  it("returns 204 with no body", async () => {
    const response = noContent();

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe("");
  });
});

describe("errorResponse category mapping", () => {
  const cases: ReadonlyArray<{
    label: string;
    error: unknown;
    status: number;
    code: string;
  }> = [
    {
      label: "validation: non-positive gallons (Req 3.5)",
      error: NON_POSITIVE_GALLONS,
      status: 400,
      code: "GALLONS_INVALID",
    },
    {
      label: "authentication: invalid credentials (Req 1.2)",
      error: INVALID_CREDENTIALS,
      status: 401,
      code: "INVALID_CREDENTIALS",
    },
    {
      label: "authorization: non-owner acceptance (Req 8.5)",
      error: NON_OWNER_ACCEPT,
      status: 403,
      code: "COMPANY_SCOPE_FORBIDDEN",
    },
    {
      label: "conflict: expired offer hold (Req 7.3)",
      error: EXPIRED_OFFER,
      status: 409,
      code: "OFFER_EXPIRED",
    },
    {
      label: "conflict: acceptance on a non-Open request (Req 8.4)",
      error: REQUEST_NOT_OPEN,
      status: 409,
      code: "REQUEST_NOT_OPEN",
    },
    {
      label: "geofence: pin outside the pilot area (Req 3.6)",
      error: OUTSIDE_GEOFENCE,
      status: 422,
      code: "OUTSIDE_GEOFENCE",
    },
  ];

  it.each(cases)(
    "maps $label to $status with code $code",
    async ({ error, status, code }) => {
      const response = errorResponse(error);

      expect(response.status).toBe(status);
      expect(response.headers.get("Content-Type")).toBe(JSON_CONTENT_TYPE);

      const body = await bodyOf(response);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe((error as DomainError).message);
      // The message is the client-facing one the service wrote, not a stack.
      expect(body.error.message).not.toContain("respond.test.ts");
    }
  );

  it("covers every category in the design's error table", () => {
    const covered = new Set(
      cases.map((c) => (c.error as DomainError).category)
    );
    expect([...covered].sort()).toEqual([
      "authentication",
      "authorization",
      "conflict",
      "geofence",
      "validation",
    ]);
  });

  it("merges extra headers into an error response", () => {
    const response = errorResponse(INVALID_CREDENTIALS, {
      "Set-Cookie": "session=; Max-Age=0",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBe("session=; Max-Age=0");
  });
});

describe("errorResponse body shape", () => {
  it("includes field only when the error carries one", async () => {
    const withField = await bodyOf(errorResponse(NON_POSITIVE_GALLONS));
    expect(withField.error.field).toBe("gallons");

    const withoutField = await bodyOf(errorResponse(NON_OWNER_ACCEPT));
    expect(withoutField.error).not.toHaveProperty("field");
    expect(Object.keys(withoutField.error).sort()).toEqual(["code", "message"]);
  });

  it("passes the configured bounding box through on a geofence rejection", async () => {
    const body = await bodyOf(errorResponse(OUTSIDE_GEOFENCE));

    expect(body.error.details).toEqual({ fence: PILOT_FENCE });
  });

  it("omits details when the error carries none", async () => {
    const body = await bodyOf(errorResponse(EXPIRED_OFFER));

    expect(body.error).not.toHaveProperty("details");
  });

  it("carries field and details together when both are present", async () => {
    const both = new DomainError(
      "validation",
      "HOLD_HOURS_INVALID",
      "Hold hours must be between 1 and 8 inclusive",
      "holdHours",
      { min: 1, max: 8 }
    );

    const body = await bodyOf(errorResponse(both));
    expect(body).toEqual({
      error: {
        code: "HOLD_HOURS_INVALID",
        message: "Hold hours must be between 1 and 8 inclusive",
        field: "holdHours",
        details: { min: 1, max: 8 },
      },
    });
  });
});

describe("errorResponse on an unexpected fault", () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logged.mockRestore();
  });

  it("returns an opaque 500 that leaks neither message nor stack", async () => {
    const leaky = new Error(
      "connect ECONNREFUSED postgres://admin:s3cret@10.0.0.4:5432/load_energy"
    );

    const response = errorResponse(leaky);
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toBe(JSON_CONTENT_TYPE);
    expect(JSON.parse(raw)).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong handling this request",
      },
    });
    expect(raw).not.toContain("ECONNREFUSED");
    expect(raw).not.toContain("s3cret");
    expect(raw).not.toContain("respond.test.ts");

    // The original is kept server-side for diagnosis.
    expect(logged).toHaveBeenCalledWith("Unhandled API error", leaky);
  });

  it.each([
    ["a thrown string", "boom"],
    ["a thrown null", null],
    ["a plain object", { category: "validation", code: "SPOOFED" }],
  ])("maps %s to the same opaque 500", async (_label, value) => {
    const response = errorResponse(value);

    expect(response.status).toBe(500);
    await expect(bodyOf(response)).resolves.toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong handling this request",
      },
    });
  });
});

describe("handle", () => {
  it("returns the handler's response untouched when nothing throws", async () => {
    const expected = json({ requests: [] });

    await expect(handle(async () => expected)).resolves.toBe(expected);
  });

  it.each([
    { label: "validation (Req 3.5)", error: NON_POSITIVE_GALLONS, status: 400 },
    { label: "authentication (Req 1.2)", error: INVALID_CREDENTIALS, status: 401 },
    { label: "authorization (Req 8.5)", error: NON_OWNER_ACCEPT, status: 403 },
    { label: "conflict (Req 8.4)", error: REQUEST_NOT_OPEN, status: 409 },
    { label: "geofence (Req 3.6)", error: OUTSIDE_GEOFENCE, status: 422 },
  ])("maps a thrown $label through to $status", async ({ error, status }) => {
    const response = await handle(async () => {
      throw error;
    });

    expect(response.status).toBe(status);
    expect(response.headers.get("Content-Type")).toBe(JSON_CONTENT_TYPE);
    const body = await bodyOf(response);
    expect(body.error.code).toBe((error as DomainError).code);
  });

  it("applies the caller's headers to a mapped error", async () => {
    const response = await handle(
      async () => {
        throw new ValidationError(
          "SITE_NAME_REQUIRED",
          "A site name is required",
          "name"
        );
      },
      { "Cache-Control": "no-store" }
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(bodyOf(response)).resolves.toEqual({
      error: {
        code: "SITE_NAME_REQUIRED",
        message: "A site name is required",
        field: "name",
      },
    });
  });

  it("maps a rejected promise the same way as a synchronous throw", async () => {
    const error = new AuthorizationError(
      "ROLE_REQUIRED_ADMIN",
      "This action is reserved for the Admin role"
    );

    const response = await handle(() => Promise.reject(error));

    expect(response.status).toBe(403);
    await expect(bodyOf(response)).resolves.toEqual({
      error: {
        code: "ROLE_REQUIRED_ADMIN",
        message: "This action is reserved for the Admin role",
      },
    });
  });
});
