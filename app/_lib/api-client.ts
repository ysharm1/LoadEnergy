"use client";

/**
 * The browser's single door to the REST API.
 *
 * Credentials ride on the HTTP-only session cookie (`same-origin`), so no
 * token ever reaches JavaScript and no screen has to pass a user, company, or
 * role — the server resolves all three from the cookie. Responses are never
 * cached: a stale RFQ inbox or an out-of-date hold is worse than a round trip.
 *
 * Errors arrive in the API's shared `{ error: { code, message, field? } }`
 * shape, so every screen can render the server's own message inline instead of
 * inventing its own copy. A 401 means the session is gone, and the only useful
 * response is to land back on sign-in.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PUT";

async function send<T>(
  method: Method,
  path: string,
  body?: unknown
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    cache: "no-store",
  };

  if (body instanceof FormData) {
    // Let the browser set the multipart boundary.
    init.body = body;
  } else if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(
      0,
      "NETWORK_UNAVAILABLE",
      "No connection. Check signal and try again."
    );
  }

  const text = response.status === 204 ? "" : await response.text();
  let payload: unknown = null;
  if (text !== "") {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.location.assign("/");
    }
    const error = (payload as { error?: { code?: string; message?: string; field?: string } } | null)
      ?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? "That did not go through. Try again.",
      error?.field
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => send<T>("GET", path),
  post: <T>(path: string, body?: unknown) => send<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => send<T>("PUT", path, body),
};

/** The server's message for a thrown error, for inline display. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message !== "") return error.message;
  return "Something went wrong. Try again.";
}
