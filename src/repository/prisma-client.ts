/**
 * Process-wide PrismaClient accessor.
 *
 * A PrismaClient owns a connection pool, so building one per request (or per
 * hot reload in `next dev`) exhausts Postgres connections long before it
 * exhausts the developer's patience. The instance is therefore cached on
 * `globalThis`, which survives the module-registry reset that Next's dev
 * server performs on every edit; in production the module is evaluated once
 * and the global is just a convenient home for the singleton.
 *
 * Nothing outside the composition root and the repository adapter should
 * import this. Services depend on the `Repository` port.
 */

import { PrismaClient } from "@prisma/client";

/** True when the environment names a database to connect to. */
export function isDatabaseConfigured(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

const globalForPrisma = globalThis as typeof globalThis & {
  __loadEnergyPrisma?: PrismaClient;
};

export function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.__loadEnergyPrisma) {
    globalForPrisma.__loadEnergyPrisma = new PrismaClient();
  }
  return globalForPrisma.__loadEnergyPrisma;
}
