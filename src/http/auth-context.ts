/**
 * Session resolution for protected routes.
 *
 * Every route except `POST /api/auth/login` passes through `requireAuth`. The
 * `AuthContext` it returns is resolved from the HTTP-only session cookie and
 * the User row behind it (`AuthService.resolveAuthContext`), never from the
 * request body or a header a client controls — so a caller cannot nominate
 * their own role, company, or user id, and a role change takes effect on the
 * next request rather than being frozen into the cookie.
 *
 * A missing, unknown, or expired session is an `AuthenticationError` (401),
 * which the shared mapper turns into the redirect-to-sign-in response the
 * design's Error Handling table specifies.
 */

import type { AuthContext } from "@/domain/types";
import type { AuthService } from "@/services/auth";
import { readSessionToken } from "./session-cookie";

/** Pulls the opaque session token out of the request's `Cookie` header. */
export function sessionTokenFrom(request: Request): string | null {
  return readSessionToken(request.headers.get("cookie"));
}

/**
 * Resolves the caller's `AuthContext` or throws `AuthenticationError` (401).
 * This is the only way a handler learns who is calling.
 */
export async function requireAuth(
  request: Request,
  auth: AuthService,
  now: Date = new Date()
): Promise<AuthContext> {
  return auth.requireAuthContext(sessionTokenFrom(request), now);
}
