/**
 * Session cookie adapter — the thin HTTP layer around the auth service.
 *
 * The cookie carries only the opaque session token: no userId, role, or
 * companyId, so there is nothing for a client to tamper with and no signature
 * to verify. Attributes are set for a session credential:
 *
 *   HttpOnly  — unreadable from JavaScript, so XSS cannot exfiltrate it.
 *   Secure    — HTTPS only in production (relaxed on localhost dev over http).
 *   SameSite  — Lax, so the cookie is not attached to cross-site form posts.
 *   Path=/    — the whole app, including the API routes.
 *   Max-Age   — matches the server-side session TTL.
 */

export const SESSION_COOKIE_NAME = "le_session";

export interface SessionCookieOptions {
  /** Cookie lifetime in seconds. Should match the session TTL. */
  maxAgeSeconds: number;
  /** Defaults to true outside development. */
  secure?: boolean;
  sameSite?: "Lax" | "Strict";
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function serialize(
  value: string,
  maxAgeSeconds: number,
  options: Pick<SessionCookieOptions, "secure" | "sameSite">
): string {
  const secure = options.secure ?? isProduction();
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${options.sameSite ?? "Lax"}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** `Set-Cookie` value that establishes the session. */
export function serializeSessionCookie(
  token: string,
  options: SessionCookieOptions
): string {
  return serialize(token, Math.max(0, Math.floor(options.maxAgeSeconds)), options);
}

/** `Set-Cookie` value that clears the session (logout, invalid session). */
export function serializeClearedSessionCookie(
  options: Omit<SessionCookieOptions, "maxAgeSeconds"> = {}
): string {
  return serialize("", 0, options);
}

/** Reads the session token out of a raw `Cookie` request header. */
export function readSessionToken(
  cookieHeader: string | null | undefined
): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = pair.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}
