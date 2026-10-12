/**
 * Property-based test for the Supplier availability toggle.
 *
 * Feature: load-energy — Property 10 (task 5.7).
 *
 * Runs the real `SupplierService` against the real `InMemoryRepository`, with
 * the real `CompanyUserService` + `BcryptPasswordHasher` (cost 4: genuine
 * hashing, cheap enough for 100+ iterations) creating the Supplier Companies
 * and their dispatchers. No mocks, no fakes.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { InMemoryRepository } from "@/repository/in-memory";
import {
  SUPPLIER_STATUSES,
  type AuthContext,
  type Company,
  type SupplierStatus,
} from "@/domain/types";
import { CompanyUserService } from "./company-user";
import { BcryptPasswordHasher } from "./password";
import { SupplierService } from "./supplier";

const NOW = new Date("2025-03-01T09:00:00Z");

const supplierStatus: fc.Arbitrary<SupplierStatus> = fc.constantFrom(
  ...SUPPLIER_STATUSES
);

/** One or more statuses, applied in order: the last write is what must read back. */
const statusSequence = fc.array(supplierStatus, { minLength: 1, maxLength: 5 });

interface Harness {
  service: SupplierService;
  supplier: AuthContext;
  company: Company;
  /** A second Supplier Company, to catch a write leaking across companies. */
  other: AuthContext;
  otherCompany: Company;
}

async function makeHarness(seed: number): Promise<Harness> {
  const repo = new InMemoryRepository();
  const companies = new CompanyUserService({
    repo,
    hasher: new BcryptPasswordHasher(4),
  });
  const service = new SupplierService({ repo });

  const company = await companies.createCompany(
    { name: `supplier-a-${seed}`, kind: "supplier" },
    NOW
  );
  const otherCompany = await companies.createCompany(
    { name: `supplier-b-${seed}`, kind: "supplier" },
    NOW
  );
  const user = await companies.createUser(
    {
      companyId: company.id,
      role: "supplier",
      phone: "+16025550171",
      password: "pw-a",
    },
    NOW
  );
  const otherUser = await companies.createUser(
    {
      companyId: otherCompany.id,
      role: "supplier",
      phone: "+16025550172",
      password: "pw-b",
    },
    NOW
  );

  return {
    service,
    company,
    otherCompany,
    supplier: {
      userId: user.id,
      companyId: company.id,
      role: "supplier",
    },
    other: {
      userId: otherUser.id,
      companyId: otherCompany.id,
      role: "supplier",
    },
  };
}

describe("Property 10: Supplier status persistence round trip", () => {
  // Feature: load-energy, Property 10: Supplier status persistence round trip
  // **Validates: Requirements 5.1, 5.2**
  it("reads back exactly the status that was set, for every value and every sequence of writes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ seed: fc.nat(), statuses: statusSequence }),
        async ({ seed, statuses }) => {
          const h = await makeHarness(seed);

          // Requirement 5.1: a Supplier Company always carries one of the three
          // statuses — a freshly created one is Closed until its dispatcher
          // opens up.
          expect(SUPPLIER_STATUSES).toContain(
            await h.service.getStatus(h.supplier)
          );

          for (const status of statuses) {
            // Requirement 5.2: the write persists, both in what `setStatus`
            // returns and in what a subsequent read reports.
            const written = await h.service.setStatus(h.supplier, status);
            expect(written.id).toBe(h.company.id);
            expect(written.supplierStatus).toBe(status);
            expect(await h.service.getStatus(h.supplier)).toBe(status);

            // Re-reading does not drift, and naming the company explicitly
            // gives the same answer as the caller's own company.
            expect(await h.service.getStatus(h.supplier, h.company.id)).toBe(
              status
            );

            // The write is scoped to one Supplier Company: the second company's
            // availability is untouched by any of these writes.
            expect(await h.service.getStatus(h.other)).toBe("closed");
          }

          // After the whole sequence, the last status written is the one stored.
          expect(await h.service.getStatus(h.supplier)).toBe(
            statuses[statuses.length - 1]
          );
        }
      )
    );
  });
});
