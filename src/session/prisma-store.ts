/**
 * Prisma/PostgreSQL SessionStore.
 *
 * The in-memory store keeps sessions in a process map, which means every
 * signed-in user is logged out by a restart, a redeploy, or by landing on a
 * second instance. The schema already models `Session`, so once the repository
 * is durable there is no reason for the session table not to be: this adapter
 * is wired alongside `PrismaRepository` in the composition root.
 *
 * What is stored is still only the SHA-256 hash of the token (see
 * `store.ts`) — a dump of this table cannot be replayed as a live session, and
 * the row carries no role or company, so `AuthContext` is resolved from the
 * User row on every request.
 *
 * `create` upserts rather than inserts, mirroring the in-memory map's `set`:
 * re-issuing against an existing hash replaces the record instead of raising a
 * unique-constraint error. Deletes are `deleteMany`, so removing a session
 * that is already gone is a no-op, which is what the port's callers expect on
 * a double sign-out.
 */

import type { PrismaClient } from "@prisma/client";
import type { SessionRecord, SessionStore } from "./store";

export class PrismaSessionStore implements SessionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(record: SessionRecord): Promise<SessionRecord> {
    const row = await this.prisma.session.upsert({
      where: { tokenHash: record.tokenHash },
      create: record,
      update: {
        userId: record.userId,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      },
    });
    return toSessionRecord(row);
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const row = await this.prisma.session.findUnique({ where: { tokenHash } });
    return row ? toSessionRecord(row) : null;
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash } });
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { userId } });
  }
}

/** Drops the surrogate `id`; the port's record is keyed by token hash. */
function toSessionRecord(row: {
  tokenHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}): SessionRecord {
  return {
    tokenHash: row.tokenHash,
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
