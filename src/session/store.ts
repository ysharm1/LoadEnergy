/**
 * Session persistence port.
 *
 * Sessions are server-side state. The client only ever holds an opaque,
 * cryptographically random token in an HTTP-only cookie — no userId, role, or
 * companyId travels in a client-readable (and therefore tamperable) form.
 *
 * What is stored is the SHA-256 hash of the token, not the token itself, so a
 * dump of the session table cannot be replayed as a live session. The record
 * also deliberately carries no role or company: `AuthContext` is resolved from
 * the User row at request time, so a role or company change takes effect on
 * the next request instead of being frozen into the session.
 */

import { createHash, randomBytes } from "node:crypto";

export interface SessionRecord {
  /** SHA-256 (hex) of the session token. The raw token is never stored. */
  tokenHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface SessionStore {
  create(record: SessionRecord): Promise<SessionRecord>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  deleteByTokenHash(tokenHash: string): Promise<void>;
  /** Drops every session for a user (e.g., on password change). */
  deleteByUser(userId: string): Promise<void>;
}

/** 32 bytes of CSPRNG output, URL-safe — the cookie value. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isSessionExpired(session: SessionRecord, now: Date): boolean {
  return now.getTime() >= session.expiresAt.getTime();
}

/** In-memory store for tests and single-process development. */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async create(record: SessionRecord): Promise<SessionRecord> {
    this.sessions.set(record.tokenHash, { ...record });
    return { ...record };
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const found = this.sessions.get(tokenHash);
    return found ? { ...found } : null;
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async deleteByUser(userId: string): Promise<void> {
    for (const [tokenHash, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(tokenHash);
    }
  }

  /** Test helper: drops every session. */
  reset(): void {
    this.sessions.clear();
  }
}
