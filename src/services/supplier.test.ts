import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/repository/in-memory";
import type { AuthContext } from "@/domain/types";
import { CompanyUserService } from "./company-user";
import { BcryptPasswordHasher } from "./password";
import {
  SupplierService,
  isMatchableSupplierStatus,
  requireSupplierStatus,
} from "./supplier";

const NOW = new Date("2025-03-01T09:00:00Z");

interface Harness {
  repo: InMemoryRepository;
  service: SupplierService;
  supplier: AuthContext;
  rivalSupplier: AuthContext;
  buyer: AuthContext;
  admin: AuthContext;
  supplierCompanyId: string;
  rivalCompanyId: string;
  buyerCompanyId: string;
}

async function makeHarness(): Promise<Harness> {
  const repo = new InMemoryRepository();
  const companies = new CompanyUserService({
    repo,
    hasher: new BcryptPasswordHasher(4),
  });
  const service = new SupplierService({ repo });

  const supplierCompany = await companies.createCompany(
    { name: "Buckeye Diesel", kind: "supplier" },
    NOW
  );
  const rivalCompany = await companies.createCompany(
    { name: "Tolleson Fuel", kind: "supplier" },
    NOW
  );
  const buyerCompany = await companies.createCompany(
    { name: "SW Valley Concrete", kind: "buyer" },
    NOW
  );

  const supplierUser = await companies.createUser(
    {
      companyId: supplierCompany.id,
      role: "supplier",
      phone: "+16025550131",
      password: "supplier-pw",
    },
    NOW
  );
  const rivalUser = await companies.createUser(
    {
      companyId: rivalCompany.id,
      role: "supplier",
      phone: "+16025550132",
      password: "rival-pw",
    },
    NOW
  );
  const buyerUser = await companies.createUser(
    {
      companyId: buyerCompany.id,
      role: "buyer",
      phone: "+16025550133",
      password: "buyer-pw",
    },
    NOW
  );
  const adminUser = await companies.createUser(
    {
      companyId: buyerCompany.id,
      role: "admin",
      phone: "+16025550134",
      password: "admin-pw",
    },
    NOW
  );

  return {
    repo,
    service,
    supplier: {
      userId: supplierUser.id,
      companyId: supplierCompany.id,
      role: "supplier",
    },
    rivalSupplier: {
      userId: rivalUser.id,
      companyId: rivalCompany.id,
      role: "supplier",
    },
    buyer: { userId: buyerUser.id, companyId: buyerCompany.id, role: "buyer" },
    admin: { userId: adminUser.id, companyId: buyerCompany.id, role: "admin" },
    supplierCompanyId: supplierCompany.id,
    rivalCompanyId: rivalCompany.id,
    buyerCompanyId: buyerCompany.id,
  };
}

describe("requireSupplierStatus", () => {
  it("accepts every enum value", () => {
    expect(requireSupplierStatus("open")).toBe("open");
    expect(requireSupplierStatus("limited")).toBe("limited");
    expect(requireSupplierStatus("closed")).toBe("closed");
  });

  it("rejects anything outside the enum with a validation error", () => {
    for (const bad of ["OPEN", "busy", "", null, undefined, 1, {}]) {
      expect(() => requireSupplierStatus(bad)).toThrowError(
        /supplierStatus must be one of/
      );
    }
  });
});

describe("isMatchableSupplierStatus", () => {
  it("admits Open and Limited only", () => {
    expect(isMatchableSupplierStatus("open")).toBe(true);
    expect(isMatchableSupplierStatus("limited")).toBe(true);
    expect(isMatchableSupplierStatus("closed")).toBe(false);
    expect(isMatchableSupplierStatus(null)).toBe(false);
  });
});

describe("SupplierService status read and write", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("starts a new supplier company Closed", async () => {
    await expect(h.service.getStatus(h.supplier)).resolves.toBe("closed");
  });

  it("persists each status immediately on change", async () => {
    for (const status of ["open", "limited", "closed", "open"] as const) {
      const updated = await h.service.setStatus(h.supplier, status);
      expect(updated.supplierStatus).toBe(status);
      await expect(h.service.getStatus(h.supplier)).resolves.toBe(status);
      const stored = await h.repo.getCompany(h.supplierCompanyId);
      expect(stored?.supplierStatus).toBe(status);
    }
  });

  it("does not require Admin approval to open up", async () => {
    const company = await h.repo.getCompany(h.supplierCompanyId);
    expect(company?.supplierApprovalStatus).toBe("pending");

    const updated = await h.service.setStatus(h.supplier, "open");
    expect(updated.supplierStatus).toBe("open");
    expect(updated.supplierApprovalStatus).toBe("pending");
  });

  it("rejects a status outside the enum", async () => {
    await expect(
      h.service.setStatus(h.supplier, "busy" as never)
    ).rejects.toMatchObject({ category: "validation", code: "SUPPLIER_STATUS_INVALID" });
  });

  it("denies another supplier company toggling this one", async () => {
    await expect(
      h.service.setStatus(h.rivalSupplier, "closed", h.supplierCompanyId)
    ).rejects.toMatchObject({
      category: "authorization",
      code: "COMPANY_SCOPE_FORBIDDEN",
    });
    await expect(h.service.getStatus(h.supplier)).resolves.toBe("closed");
  });

  it("denies a buyer and an admin the supplier toggle", async () => {
    await expect(
      h.service.setStatus(h.buyer, "open", h.supplierCompanyId)
    ).rejects.toMatchObject({ category: "authorization" });
    await expect(
      h.service.setStatus(h.admin, "open", h.supplierCompanyId)
    ).rejects.toMatchObject({ category: "authorization" });
  });

  it("denies an unauthenticated caller", async () => {
    await expect(
      h.service.setStatus(null as never, "open", h.supplierCompanyId)
    ).rejects.toMatchObject({ category: "authorization" });
  });

  it("rejects a toggle aimed at a buyer company", async () => {
    const ctx: AuthContext = {
      userId: "someone",
      companyId: h.buyerCompanyId,
      role: "supplier",
    };
    await expect(h.service.setStatus(ctx, "open")).rejects.toMatchObject({
      category: "validation",
      code: "COMPANY_NOT_SUPPLIER",
    });
  });
});
