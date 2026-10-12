/**
 * The shared `Repository` contract, run against Postgres.
 *
 * This suite needs a real database, so it is gated on `TEST_DATABASE_URL`.
 * With the variable unset the whole suite is *skipped*, not failed, which
 * keeps `npm test` green on a laptop with no Postgres and in CI jobs that do
 * not provision one.
 *
 * To run it for real:
 *
 *   createdb load_energy_test
 *   export TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/load_energy_test?schema=public"
 *   DATABASE_URL="$TEST_DATABASE_URL" npm run prisma:db-push
 *   npm test
 *
 * The database is emptied before every test, so it must be a throwaway: point
 * `TEST_DATABASE_URL` at a dedicated database, never at a shared one.
 */

import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaRepository } from "./prisma";
import {
  buyerCompany,
  describeRepositoryContract,
  user,
} from "./repository-contract";
import { PrismaSessionStore } from "@/session/prisma-store";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim();
const skip = !TEST_DATABASE_URL;

/**
 * One client for the file, built on first use. Construction is deferred into
 * the hooks so that nothing connects when the suite is skipped.
 */
let client: PrismaClient | null = null;

function prisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
  }
  return client;
}

/** Empties every table, children before parents. */
async function truncateAll(): Promise<void> {
  const db = prisma();
  await db.commissionInvoice.deleteMany();
  await db.delivery.deleteMany();
  await db.order.deleteMany();
  await db.offer.deleteMany();
  await db.request.deleteMany();
  await db.auditEntry.deleteMany();
  await db.pilotGeofence.deleteMany();
  await db.session.deleteMany();
  await db.site.deleteMany();
  await db.user.deleteMany();
  await db.company.deleteMany();
}

async function disconnect(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

describeRepositoryContract({
  label: "PrismaRepository",
  skip,
  reset: truncateAll,
  create: () => new PrismaRepository(prisma()),
  teardown: disconnect,
});

const suite = skip ? describe.skip : describe;

suite("PrismaSessionStore", () => {
  afterAll(disconnect);

  it("round-trips, replaces, and deletes sessions", async () => {
    await truncateAll();
    const db = prisma();
    const repo = new PrismaRepository(db);
    const sessions = new PrismaSessionStore(db);

    const company = await repo.createCompany(buyerCompany("Acme Job Sites"));
    const seat = await repo.createUser(user(company.id, "+16025550100"));

    const record = {
      tokenHash: "a".repeat(64),
      userId: seat.id,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      expiresAt: new Date("2025-01-08T00:00:00Z"),
    };

    const created = await sessions.create(record);
    expect(created).toEqual(record);
    expect(await sessions.findByTokenHash(record.tokenHash)).toEqual(record);
    expect(await sessions.findByTokenHash("b".repeat(64))).toBeNull();

    // Re-issuing against the same hash replaces rather than conflicting.
    const reissued = await sessions.create({
      ...record,
      expiresAt: new Date("2025-02-01T00:00:00Z"),
    });
    expect(reissued.expiresAt).toEqual(new Date("2025-02-01T00:00:00Z"));

    // Deleting something already gone is a no-op, not an error.
    await sessions.deleteByTokenHash("b".repeat(64));
    await sessions.deleteByTokenHash(record.tokenHash);
    expect(await sessions.findByTokenHash(record.tokenHash)).toBeNull();

    await sessions.create(record);
    await sessions.deleteByUser(seat.id);
    expect(await sessions.findByTokenHash(record.tokenHash)).toBeNull();
  });
});
