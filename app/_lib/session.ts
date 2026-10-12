/**
 * Server-side session resolution for the PWA's pages (Requirement 1.8).
 *
 * Mirrors `src/http/auth-context.ts`: the caller is resolved from the HTTP-only
 * session cookie through `AuthService.resolveAuthContext`, never from a query
 * parameter, a header, or anything else a client controls. The role that comes
 * back selects the surface via `interfaceForRole`, so the interface a page
 * renders and the actions the services will actually permit are decided by the
 * same source of truth.
 *
 * Server-only — it reads `next/headers`. Client components get their data from
 * the REST API instead.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getServices } from "@/composition/root";
import type { AuthContext, Role } from "@/domain/types";
import { SESSION_COOKIE_NAME } from "@/http/session-cookie";
import { interfaceForRole, type RoleInterface } from "@/services/authorization";

export interface Session {
  ctx: AuthContext;
  /** The role-appropriate surface descriptor (Requirement 1.8). */
  surface: RoleInterface;
  companyName: string | null;
}

/** The signed-in caller, or null when no valid session is on the request. */
export async function currentSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  if (!token) return null;

  const services = getServices();
  const ctx = await services.auth.resolveAuthContext(token);
  if (!ctx) return null;

  const company = await services.repo.getCompany(ctx.companyId);
  return {
    ctx,
    surface: interfaceForRole(ctx.role),
    companyName: company?.name ?? null,
  };
}

/**
 * Gates a page on one role (Requirement 1.8).
 *
 * No session sends the caller to sign-in; the wrong role sends them to their
 * own home rather than showing a denial, because a Buyer landing on an admin
 * path is a stale link, not an attack. The real enforcement is still in the
 * services behind the API: these redirects only decide what gets drawn.
 */
export async function requireSession(role: Role): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect("/");
  if (session.ctx.role !== role) redirect(session.surface.homePath);
  return session;
}
