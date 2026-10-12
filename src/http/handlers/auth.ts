/**
 * Auth routes (Requirements 1.1, 1.2).
 *
 *   POST /api/auth/login   credentials -> session cookie + { user, company, role }
 *   POST /api/auth/logout  clears the session
 *
 * Login is the only unauthenticated route in the API. Everything else resolves
 * its `AuthContext` from the cookie this route sets.
 *
 * The response body is a projection, not the stored row: `passwordHash` never
 * leaves the server. The session token likewise travels only in the HTTP-only
 * cookie and never in the body, so no client-side script can read it.
 */

import type { Company, User } from "@/domain/types";
import type { Services } from "@/composition/root";
import { requireAuth, sessionTokenFrom } from "../auth-context";
import { readJsonObject, stringField } from "../request";
import { handle, json } from "../respond";
import {
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "../session-cookie";

/** The User as the client may see it. No password hash, ever. */
export interface PublicUser {
  id: string;
  companyId: string;
  role: User["role"];
  phone: string;
  email: string | null;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    companyId: user.companyId,
    role: user.role,
    phone: user.phone,
    email: user.email,
  };
}

/** The Company as the client may see it. */
export function toPublicCompany(company: Company) {
  return {
    id: company.id,
    name: company.name,
    kind: company.kind,
    supplierApprovalStatus: company.supplierApprovalStatus,
    supplierStatus: company.supplierStatus,
    operatingLat: company.operatingLat,
    operatingLng: company.operatingLng,
    serviceRadiusMiles: company.serviceRadiusMiles,
  };
}

/**
 * `POST /api/auth/login` (Requirements 1.1, 1.2).
 *
 * Invalid credentials surface as the service's uniform `INVALID_CREDENTIALS`
 * authentication error, mapped to 401 — the handler adds no detail of its own,
 * so the response still reveals nothing about whether the identifier exists.
 */
export function loginHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const body = await readJsonObject(request);

    const result = await services.auth.login({
      identifier: stringField(body.identifier) ?? "",
      password: stringField(body.password) ?? "",
    });

    const maxAgeSeconds = Math.floor(
      (result.session.expiresAt.getTime() - result.session.createdAt.getTime()) /
        1000
    );

    return json(
      {
        user: toPublicUser(result.user),
        company: toPublicCompany(result.company),
        role: result.user.role,
      },
      200,
      { "Set-Cookie": serializeSessionCookie(result.token, { maxAgeSeconds }) }
    );
  });
}

/**
 * `POST /api/auth/logout`.
 *
 * Authenticated like every other non-login route, but the cleared cookie rides
 * on the failure path too: a caller whose session already expired gets a 401
 * *and* loses the stale cookie, so they land on sign-in instead of looping.
 */
export function logoutHandler(
  services: Services,
  request: Request
): Promise<Response> {
  const cleared = { "Set-Cookie": serializeClearedSessionCookie() };

  return handle(async () => {
    await requireAuth(request, services.auth);
    await services.auth.logout(sessionTokenFrom(request));
    return json({ ok: true }, 200, cleared);
  }, cleared);
}
