/**
 * Auth service — credential verification and session resolution.
 *
 * Requirements:
 *   1.1 valid credentials authenticate the User and establish a session.
 *   1.2 invalid credentials are rejected with an authentication error.
 *
 * Pure over its ports (Repository, SessionStore, PasswordHasher) and takes
 * `now` from the caller, so it is testable without HTTP, a database, or a
 * clock. Cookie serialization lives in the thin adapter
 * (`src/http/session-cookie.ts`); nothing here knows about HTTP.
 *
 * Login identifier: phone is the primary identifier because it is the User's
 * required unique field (Requirement 1.5); email is accepted as well when the
 * User supplied one (Requirement 1.7). An identifier containing "@" is treated
 * as an email, anything else as a phone number. Both are normalized with the
 * same helpers user creation uses (`normalizePhone`, `normalizeOptionalEmail`)
 * so a User can sign in with whatever they typed at signup — email lookup is
 * case-insensitive and whitespace-tolerant because emails are stored trimmed
 * and lower-cased.
 *
 * Failure is uniform: every rejected login — unknown identifier, wrong
 * password, blank input — spends a bcrypt verification and returns the same
 * `INVALID_CREDENTIALS` error, so the response reveals nothing about whether
 * the identifier exists.
 */

import { AuthenticationError } from "@/domain/errors";
import type { AuthContext, Company, User } from "@/domain/types";
import type { Repository } from "@/repository/repository";
import {
  generateSessionToken,
  hashSessionToken,
  isSessionExpired,
  type SessionRecord,
  type SessionStore,
} from "@/session/store";
import { normalizeOptionalEmail, normalizePhone } from "./company-user";
import type { PasswordHasher } from "./password";

/** 12 hours — long enough for a field shift, short enough to limit replay. */
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface LoginInput {
  /** Phone (primary) or email address. */
  identifier: string;
  password: string;
}

export interface LoginResult {
  user: User;
  company: Company;
  session: SessionRecord;
  /** The raw token to place in the HTTP-only cookie. Never persisted. */
  token: string;
}

export interface AuthServiceDeps {
  repo: Repository;
  sessions: SessionStore;
  hasher: PasswordHasher;
  sessionTtlMs?: number;
  /** Overridable for deterministic tests. */
  generateToken?: () => string;
}

function invalidCredentials(): AuthenticationError {
  return new AuthenticationError(
    "INVALID_CREDENTIALS",
    "The phone/email and password combination is not valid"
  );
}

function noSession(): AuthenticationError {
  return new AuthenticationError(
    "SESSION_INVALID",
    "No valid session; sign in again"
  );
}

function looksLikeEmail(identifier: string): boolean {
  return identifier.includes("@");
}

export class AuthService {
  private readonly repo: Repository;
  private readonly sessions: SessionStore;
  private readonly hasher: PasswordHasher;
  private readonly sessionTtlMs: number;
  private readonly generateToken: () => string;

  constructor(deps: AuthServiceDeps) {
    this.repo = deps.repo;
    this.sessions = deps.sessions;
    this.hasher = deps.hasher;
    this.sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.generateToken = deps.generateToken ?? generateSessionToken;
  }

  /** Hashes a plaintext password for storage on a User (used by user creation). */
  async hashPassword(password: string): Promise<string> {
    return this.hasher.hash(password);
  }

  /**
   * Verifies credentials and establishes a session (Requirement 1.1).
   * Throws `AuthenticationError` on any failure (Requirement 1.2).
   */
  async login(input: LoginInput, now: Date = new Date()): Promise<LoginResult> {
    const identifier = (input?.identifier ?? "").trim();
    const password = input?.password ?? "";

    const user = identifier === "" ? null : await this.findUser(identifier);

    // Always verify against *a* hash so timing does not disclose whether the
    // identifier matched a User.
    const hash = user?.passwordHash ?? (await this.hasher.decoyHash());
    const passwordOk = await this.hasher.verify(password, hash);

    if (!user || !passwordOk) throw invalidCredentials();

    const company = await this.repo.getCompany(user.companyId);
    if (!company) throw invalidCredentials();

    const token = this.generateToken();
    const session = await this.sessions.create({
      tokenHash: hashSessionToken(token),
      userId: user.id,
      createdAt: new Date(now.getTime()),
      expiresAt: new Date(now.getTime() + this.sessionTtlMs),
    });

    return { user, company, session, token };
  }

  /**
   * Resolves `AuthContext { userId, companyId, role }` for a protected path.
   * Returns null when there is no usable session; expired sessions are evicted.
   *
   * Company and role come from the User row rather than the cookie, so neither
   * is client-supplied and a role change takes effect on the next request.
   */
  async resolveAuthContext(
    token: string | null | undefined,
    now: Date = new Date()
  ): Promise<AuthContext | null> {
    if (!token) return null;

    const tokenHash = hashSessionToken(token);
    const session = await this.sessions.findByTokenHash(tokenHash);
    if (!session) return null;

    if (isSessionExpired(session, now)) {
      await this.sessions.deleteByTokenHash(tokenHash);
      return null;
    }

    const user = await this.repo.getUser(session.userId);
    if (!user) {
      await this.sessions.deleteByTokenHash(tokenHash);
      return null;
    }

    return { userId: user.id, companyId: user.companyId, role: user.role };
  }

  /**
   * Same as `resolveAuthContext` but throws an authentication error instead of
   * returning null — the guard for protected paths.
   */
  async requireAuthContext(
    token: string | null | undefined,
    now: Date = new Date()
  ): Promise<AuthContext> {
    const ctx = await this.resolveAuthContext(token, now);
    if (!ctx) throw noSession();
    return ctx;
  }

  /** Clears the session behind a token. Idempotent. */
  async logout(token: string | null | undefined): Promise<void> {
    if (!token) return;
    await this.sessions.deleteByTokenHash(hashSessionToken(token));
  }

  private async findUser(identifier: string): Promise<User | null> {
    if (looksLikeEmail(identifier)) {
      // Emails are stored trimmed and lower-cased by user creation, so the
      // submitted identifier goes through the same normalization before an
      // exact-match lookup. A malformed address is not a distinct failure —
      // it simply matches no User, keeping the uniform login error.
      let email: string | null;
      try {
        email = normalizeOptionalEmail(identifier);
      } catch {
        return null;
      }
      return email === null ? null : this.repo.getUserByEmail(email);
    }
    return this.repo.getUserByPhone(normalizePhone(identifier));
  }
}
