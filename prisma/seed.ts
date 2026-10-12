/**
 * Bootstrap seed — creates the first operator Company and its Admin User.
 *
 * ## Why this exists
 *
 * Every write path in the app is authenticated and identity provisioning is
 * Admin-only, so a freshly migrated database is a database nobody can log
 * into: there is no public sign-up, and the authenticated route that creates
 * companies and users needs an Admin who does not exist yet. This script is
 * the way in — once, by an operator with shell access.
 *
 * ## It goes through the real service, not the tables
 *
 * The rows are created by `CompanyUserService` over `PrismaRepository` and
 * `BcryptPasswordHasher` — the same graph the composition root builds. Hand
 * written inserts would have to restate E.164 normalisation and pick a bcrypt
 * cost, and the first time either drifted the seeded admin would stop being
 * able to sign in. Going through the service means the seeded user is
 * byte-for-byte the user the app would have created.
 *
 * ## Idempotent on purpose
 *
 * Render re-runs whatever you point at a deploy hook, and an operator will
 * run this twice just to be sure. If a User already holds the phone number,
 * the script says so and exits 0 — the unique index on `User.phone` would
 * otherwise turn a harmless second run into a failed deploy. A half-finished
 * previous run is also survivable: an existing operator Company with the
 * configured name is reused rather than duplicated.
 *
 * ## Input
 *
 *   SEED_ADMIN_PHONE         required, E.164 (e.g. +16025550134)
 *   SEED_ADMIN_PASSWORD      required, non-blank
 *   SEED_ADMIN_EMAIL         optional
 *   SEED_ADMIN_COMPANY_NAME  optional, defaults to "Load Energy Operations"
 *
 * The password is read, hashed, and never written to stdout, stderr, or an
 * audit row. It is deliberately not a CLI argument: argv shows up in process
 * listings and shell history.
 *
 * Usage:  npm run seed      (or `npx prisma db seed`)
 *
 * Run by `tsx`, which is the reason for two small constraints: imports are
 * relative rather than `@/`-aliased (so the file does not depend on a bundler
 * resolving tsconfig paths), and the entry point is `seed().catch(...)` rather
 * than top-level `await` (this package is not `"type": "module"`, so the file
 * is transformed as CommonJS, where top-level await is a syntax error).
 */

import { PrismaClient } from "@prisma/client";
import { isDomainError } from "../src/domain/errors";
import type { Company } from "../src/domain/types";
import { PrismaRepository } from "../src/repository/prisma";
import {
  CompanyUserService,
  requireE164Phone,
} from "../src/services/company-user";
import { BcryptPasswordHasher } from "../src/services/password";

const DEFAULT_COMPANY_NAME = "Load Energy Operations";

/** A configuration problem the operator can fix, reported without a stack. */
class SeedConfigError extends Error {}

function readRequiredEnv(name: string, hint: string): string {
  const value = (process.env[name] ?? "").trim();
  if (value === "") {
    throw new SeedConfigError(`${name} is required. ${hint}`);
  }
  return value;
}

/**
 * Reuses the operator Company when one with this name already exists so a
 * re-run after a partial failure does not leave two of them behind. Matching
 * is case-insensitive on the trimmed name because that is how a human would
 * retype it.
 */
async function findOperatorCompany(
  repo: PrismaRepository,
  name: string
): Promise<Company | null> {
  const wanted = name.trim().toLowerCase();
  const companies = await repo.listCompanies();
  return (
    companies.find(
      (company) =>
        company.kind === "buyer" && company.name.trim().toLowerCase() === wanted
    ) ?? null
  );
}

async function seed(): Promise<void> {
  if ((process.env.DATABASE_URL ?? "").trim() === "") {
    throw new SeedConfigError(
      "DATABASE_URL is required: the seed writes to Postgres through Prisma. " +
        "On Render it is wired from the database automatically; locally, " +
        "export it or put it in .env."
    );
  }

  // Validated before a client is opened, so a typo costs nothing.
  const phone = requireE164Phone(
    readRequiredEnv(
      "SEED_ADMIN_PHONE",
      "Use E.164 form, e.g. SEED_ADMIN_PHONE=+16025550134"
    )
  );
  // Never logged, never echoed.
  const password = readRequiredEnv(
    "SEED_ADMIN_PASSWORD",
    "Set it to the password the first admin will sign in with."
  );
  const email = (process.env.SEED_ADMIN_EMAIL ?? "").trim() || null;
  const companyName =
    (process.env.SEED_ADMIN_COMPANY_NAME ?? "").trim() || DEFAULT_COMPANY_NAME;

  const prisma = new PrismaClient();
  try {
    const repo = new PrismaRepository(prisma);
    const users = new CompanyUserService({
      repo,
      hasher: new BcryptPasswordHasher(),
    });

    const existing = await repo.getUserByPhone(phone);
    if (existing) {
      console.log(
        `Seed skipped: ${phone} already belongs to a user with role ` +
          `"${existing.role}" (user ${existing.id}, company ` +
          `${existing.companyId}). Nothing to do.`
      );
      return;
    }

    const reused = await findOperatorCompany(repo, companyName);
    const company =
      reused ?? (await users.createCompany({ name: companyName, kind: "buyer" }));
    console.log(
      reused
        ? `Reusing operator company "${company.name}" (${company.id}).`
        : `Created operator company "${company.name}" (${company.id}).`
    );

    const admin = await users.createUser({
      companyId: company.id,
      role: "admin",
      phone,
      email,
      password,
    });

    console.log(
      `Created admin user ${admin.id} (phone ${admin.phone}` +
        `${admin.email ? `, email ${admin.email}` : ""}). ` +
        "Sign in with that phone number and the password from " +
        "SEED_ADMIN_PASSWORD."
    );
  } finally {
    await prisma.$disconnect();
  }
}

seed().catch((error: unknown) => {
  // Configuration and validation problems are the operator's to fix, so they
  // get a one-line message instead of a stack. Anything else is a genuine
  // fault and keeps its stack for debugging.
  if (error instanceof SeedConfigError || isDomainError(error)) {
    console.error(`Seed failed: ${error.message}`);
  } else {
    console.error("Seed failed:", error);
  }
  process.exitCode = 1;
});
