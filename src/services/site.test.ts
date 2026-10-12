import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/repository/in-memory";
import type { AuthContext } from "@/domain/types";
import { CompanyUserService } from "./company-user";
import { BcryptPasswordHasher } from "./password";
import { SiteService } from "./site";

const NOW = new Date("2025-03-01T09:00:00Z");

interface Harness {
  repo: InMemoryRepository;
  service: SiteService;
  buyer: AuthContext;
  otherBuyer: AuthContext;
  supplier: AuthContext;
}

async function makeHarness(): Promise<Harness> {
  const repo = new InMemoryRepository();
  const companies = new CompanyUserService({
    repo,
    hasher: new BcryptPasswordHasher(4),
  });
  const service = new SiteService({ repo });

  const buyerCompany = await companies.createCompany(
    { name: "SW Valley Concrete", kind: "buyer" },
    NOW
  );
  const rivalCompany = await companies.createCompany(
    { name: "Goodyear Grading", kind: "buyer" },
    NOW
  );
  const supplierCompany = await companies.createCompany(
    { name: "Buckeye Diesel", kind: "supplier" },
    NOW
  );

  const buyerUser = await companies.createUser(
    {
      companyId: buyerCompany.id,
      role: "buyer",
      phone: "+16025550111",
      password: "buyer-pw",
    },
    NOW
  );
  const rivalUser = await companies.createUser(
    {
      companyId: rivalCompany.id,
      role: "buyer",
      phone: "+16025550112",
      password: "rival-pw",
    },
    NOW
  );
  const supplierUser = await companies.createUser(
    {
      companyId: supplierCompany.id,
      role: "supplier",
      phone: "+16025550113",
      password: "supplier-pw",
    },
    NOW
  );

  return {
    repo,
    service,
    buyer: {
      userId: buyerUser.id,
      companyId: buyerUser.companyId,
      role: "buyer",
    },
    otherBuyer: {
      userId: rivalUser.id,
      companyId: rivalUser.companyId,
      role: "buyer",
    },
    supplier: {
      userId: supplierUser.id,
      companyId: supplierUser.companyId,
      role: "supplier",
    },
  };
}

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

describe("SiteService.createSite", () => {
  it("creates a Site on the caller's Company with its pin (Req 2.1, 2.2)", async () => {
    const site = await h.service.createSite(
      h.buyer,
      { name: "  Estrella Pad 4  ", lat: 33.42, lng: -112.38 },
      NOW
    );

    expect(site.companyId).toBe(h.buyer.companyId);
    expect(site.name).toBe("Estrella Pad 4");
    expect(site.lat).toBe(33.42);
    expect(site.lng).toBe(-112.38);
    expect(site.createdAt).toEqual(NOW);

    const stored = await h.repo.getSite(site.id);
    expect(stored).toEqual(site);
  });

  it("requires a name", async () => {
    await expect(
      h.service.createSite(h.buyer, { name: "   ", lat: 33.4, lng: -112.3 }, NOW)
    ).rejects.toMatchObject({
      category: "validation",
      code: "SITE_NAME_REQUIRED",
      field: "name",
    });
  });

  it("rejects a latitude outside [-90, 90] (Req 2.4)", async () => {
    await expect(
      h.service.createSite(h.buyer, { name: "Bad", lat: 90.0001, lng: -112.3 }, NOW)
    ).rejects.toMatchObject({
      category: "validation",
      code: "LATITUDE_OUT_OF_RANGE",
      field: "lat",
    });
  });

  it("rejects a longitude outside [-180, 180] (Req 2.4)", async () => {
    await expect(
      h.service.createSite(h.buyer, { name: "Bad", lat: 33.4, lng: -180.5 }, NOW)
    ).rejects.toMatchObject({
      category: "validation",
      code: "LONGITUDE_OUT_OF_RANGE",
      field: "lng",
    });
  });

  it("accepts the extremes of both coordinate ranges (Req 2.4 inclusive)", async () => {
    const site = await h.service.createSite(
      h.buyer,
      { name: "South Pole Depot", lat: -90, lng: 180 },
      NOW
    );
    expect({ lat: site.lat, lng: site.lng }).toEqual({ lat: -90, lng: 180 });
  });

  it("denies a Supplier creating a Site (Req 1.9)", async () => {
    await expect(
      h.service.createSite(h.supplier, { name: "Yard", lat: 33.4, lng: -112.3 }, NOW)
    ).rejects.toMatchObject({ category: "authorization" });
  });
});

describe("SiteService.listSites", () => {
  it("returns only the caller's Company's Sites (Req 2.3)", async () => {
    const mine = await h.service.createSite(
      h.buyer,
      { name: "Estrella Pad 4", lat: 33.42, lng: -112.38 },
      NOW
    );
    await h.service.createSite(
      h.otherBuyer,
      { name: "Litchfield Yard", lat: 33.5, lng: -112.35 },
      NOW
    );

    const listed = await h.service.listSites(h.buyer);
    expect(listed).toEqual([mine]);
  });

  it("denies reading another Company's Sites (Req 2.3 tenant isolation)", async () => {
    await expect(
      h.service.listSites(h.buyer, h.otherBuyer.companyId)
    ).rejects.toMatchObject({
      category: "authorization",
      code: "COMPANY_SCOPE_FORBIDDEN",
    });
  });

  it("returns an empty list before any Site exists", async () => {
    expect(await h.service.listSites(h.buyer)).toEqual([]);
  });
});
