import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryRepository } from "@/repository/in-memory";
import type { AuthContext, Company } from "@/domain/types";
import {
  AdminService,
  requireGeofence,
  requireLatLng,
  requireServiceRadiusMiles,
} from "./admin";
import { CompanyUserService } from "./company-user";
import { BcryptPasswordHasher } from "./password";

const NOW = new Date("2025-03-01T09:00:00Z");
const LATER = new Date("2025-03-02T09:00:00Z");

// Phoenix SW Valley-ish box, used as a realistic pilot geofence.
const SW_VALLEY = {
  minLat: 33.2,
  maxLat: 33.6,
  minLng: -112.6,
  maxLng: -112.1,
};

interface Harness {
  repo: InMemoryRepository;
  service: AdminService;
  companies: CompanyUserService;
  admin: AuthContext;
  buyer: AuthContext;
  supplier: AuthContext;
  supplierCompany: Company;
  buyerCompany: Company;
}

async function makeHarness(): Promise<Harness> {
  const repo = new InMemoryRepository();
  const companies = new CompanyUserService({
    repo,
    hasher: new BcryptPasswordHasher(4),
  });
  const service = new AdminService({ repo });

  // The marketplace operator's own company; Admin is not scoped to a trading
  // company, but a User still belongs to exactly one Company (Requirement 1.3).
  const operatorCompany = await companies.createCompany(
    { name: "Load Energy", kind: "buyer" },
    NOW
  );
  const supplierCompany = await companies.createCompany(
    { name: "Buckeye Diesel", kind: "supplier" },
    NOW
  );
  const buyerCompany = await companies.createCompany(
    { name: "SW Valley Concrete", kind: "buyer" },
    NOW
  );

  const adminUser = await companies.createUser(
    {
      companyId: operatorCompany.id,
      role: "admin",
      phone: "+16025550100",
      password: "operator-pw",
    },
    NOW
  );
  const buyerUser = await companies.createUser(
    {
      companyId: buyerCompany.id,
      role: "buyer",
      phone: "+16025550101",
      password: "buyer-pw",
    },
    NOW
  );
  const supplierUser = await companies.createUser(
    {
      companyId: supplierCompany.id,
      role: "supplier",
      phone: "+16025550102",
      password: "supplier-pw",
    },
    NOW
  );

  const ctxFor = (u: { id: string; companyId: string }, role: AuthContext["role"]) => ({
    userId: u.id,
    companyId: u.companyId,
    role,
  });

  return {
    repo,
    service,
    companies,
    admin: ctxFor(adminUser, "admin"),
    buyer: ctxFor(buyerUser, "buyer"),
    supplier: ctxFor(supplierUser, "supplier"),
    supplierCompany,
    buyerCompany,
  };
}

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

describe("approveSupplier (Requirements 16.1, 16.2, 16.8)", () => {
  it("moves a newly created supplier company from Pending to Approved", async () => {
    expect(h.supplierCompany.supplierApprovalStatus).toBe("pending");

    const approved = await h.service.approveSupplier(
      h.admin,
      h.supplierCompany.id
    );

    expect(approved.supplierApprovalStatus).toBe("approved");
    const readBack = await h.service.getSupplierCompany(h.supplierCompany.id);
    expect(readBack?.supplierApprovalStatus).toBe("approved");
  });

  it("leaves Supplier_Status untouched so availability stays the supplier's switch", async () => {
    const approved = await h.service.approveSupplier(
      h.admin,
      h.supplierCompany.id
    );

    expect(approved.supplierStatus).toBe("closed");
  });

  it("is idempotent when the company is already Approved", async () => {
    await h.service.approveSupplier(h.admin, h.supplierCompany.id);

    const again = await h.service.approveSupplier(
      h.admin,
      h.supplierCompany.id
    );

    expect(again.supplierApprovalStatus).toBe("approved");
  });

  it("rejects a buyer company and an unknown id with a validation error", async () => {
    await expect(
      h.service.approveSupplier(h.admin, h.buyerCompany.id)
    ).rejects.toMatchObject({
      category: "validation",
      code: "COMPANY_NOT_SUPPLIER",
      field: "supplierCompanyId",
    });

    await expect(
      h.service.approveSupplier(h.admin, "no-such-company")
    ).rejects.toMatchObject({
      category: "validation",
      code: "SUPPLIER_COMPANY_NOT_FOUND",
    });
  });

  it("denies a non-Admin caller with an authorization error", async () => {
    for (const ctx of [h.buyer, h.supplier]) {
      await expect(
        h.service.approveSupplier(ctx, h.supplierCompany.id)
      ).rejects.toMatchObject({ category: "authorization" });
    }

    const untouched = await h.service.getSupplierCompany(h.supplierCompany.id);
    expect(untouched?.supplierApprovalStatus).toBe("pending");
  });
});

describe("setOperatingLocation (Requirements 16.4, 16.8)", () => {
  it("persists the operating coordinate on the supplier company", async () => {
    const updated = await h.service.setOperatingLocation(
      h.admin,
      h.supplierCompany.id,
      { lat: 33.3703, lng: -112.5838 }
    );

    expect(updated).toMatchObject({
      operatingLat: 33.3703,
      operatingLng: -112.5838,
    });
    const readBack = await h.service.getSupplierCompany(h.supplierCompany.id);
    expect(readBack?.operatingLat).toBe(33.3703);
    expect(readBack?.operatingLng).toBe(-112.5838);
  });

  it("accepts the inclusive coordinate extremes", async () => {
    const updated = await h.service.setOperatingLocation(
      h.admin,
      h.supplierCompany.id,
      { lat: -90, lng: 180 }
    );

    expect(updated).toMatchObject({ operatingLat: -90, operatingLng: 180 });
  });

  it("rejects out-of-range and non-finite coordinates with a validation error", async () => {
    await expect(
      h.service.setOperatingLocation(h.admin, h.supplierCompany.id, {
        lat: 90.5,
        lng: -112.2,
      })
    ).rejects.toMatchObject({
      category: "validation",
      code: "LATITUDE_OUT_OF_RANGE",
      field: "lat",
    });

    await expect(
      h.service.setOperatingLocation(h.admin, h.supplierCompany.id, {
        lat: 33.4,
        lng: -180.001,
      })
    ).rejects.toMatchObject({
      category: "validation",
      code: "LONGITUDE_OUT_OF_RANGE",
      field: "lng",
    });

    await expect(
      h.service.setOperatingLocation(h.admin, h.supplierCompany.id, {
        lat: Number.NaN,
        lng: -112.2,
      })
    ).rejects.toMatchObject({ category: "validation", field: "lat" });

    const untouched = await h.service.getSupplierCompany(h.supplierCompany.id);
    expect(untouched?.operatingLat).toBeNull();
  });

  it("denies a non-Admin caller, including the supplier's own user", async () => {
    await expect(
      h.service.setOperatingLocation(h.supplier, h.supplierCompany.id, {
        lat: 33.4,
        lng: -112.3,
      })
    ).rejects.toMatchObject({ category: "authorization" });
  });
});

describe("setServiceRadius (Requirements 16.5, 16.6, 16.8)", () => {
  it("persists a positive radius", async () => {
    const updated = await h.service.setServiceRadius(
      h.admin,
      h.supplierCompany.id,
      35
    );

    expect(updated.serviceRadiusMiles).toBe(35);
    const readBack = await h.service.getSupplierCompany(h.supplierCompany.id);
    expect(readBack?.serviceRadiusMiles).toBe(35);
  });

  it("rejects zero, negative, and non-finite radii on field serviceRadiusMiles", async () => {
    for (const radius of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        h.service.setServiceRadius(h.admin, h.supplierCompany.id, radius)
      ).rejects.toMatchObject({
        category: "validation",
        code: "SERVICE_RADIUS_INVALID",
        field: "serviceRadiusMiles",
      });
    }

    const untouched = await h.service.getSupplierCompany(h.supplierCompany.id);
    expect(untouched?.serviceRadiusMiles).toBeNull();
  });

  it("denies a non-Admin caller", async () => {
    await expect(
      h.service.setServiceRadius(h.supplier, h.supplierCompany.id, 20)
    ).rejects.toMatchObject({ category: "authorization" });
  });
});

describe("setGeofence / getGeofence (Requirements 16.7, 16.8)", () => {
  it("persists the bounding box with the setting Admin and timestamp", async () => {
    const fence = await h.service.setGeofence(h.admin, SW_VALLEY, NOW);

    expect(fence).toMatchObject({
      ...SW_VALLEY,
      setByAdminId: h.admin.userId,
      updatedAt: NOW,
    });
    await expect(h.service.getGeofence()).resolves.toMatchObject(SW_VALLEY);
  });

  it("returns null before an Admin has configured a fence", async () => {
    await expect(h.service.getGeofence()).resolves.toBeNull();
  });

  it("replaces the single configured box on a later update", async () => {
    await h.service.setGeofence(h.admin, SW_VALLEY, NOW);

    const widened = { minLat: 33.0, maxLat: 33.9, minLng: -112.8, maxLng: -111.9 };
    const updated = await h.service.setGeofence(h.admin, widened, LATER);

    expect(updated).toMatchObject({ ...widened, updatedAt: LATER });
    await expect(h.service.getGeofence()).resolves.toMatchObject(widened);
  });

  it("accepts a degenerate box where min equals max", async () => {
    const pinBox = { minLat: 33.4, maxLat: 33.4, minLng: -112.3, maxLng: -112.3 };

    await expect(
      h.service.setGeofence(h.admin, pinBox, NOW)
    ).resolves.toMatchObject(pinBox);
  });

  it("rejects an inverted box and out-of-range bounds", async () => {
    await expect(
      h.service.setGeofence(
        h.admin,
        { ...SW_VALLEY, minLat: 33.9, maxLat: 33.2 },
        NOW
      )
    ).rejects.toMatchObject({
      category: "validation",
      code: "GEOFENCE_BOUNDS_INVALID",
      field: "minLat",
    });

    await expect(
      h.service.setGeofence(
        h.admin,
        { ...SW_VALLEY, minLng: -112.6, maxLng: -112.9 },
        NOW
      )
    ).rejects.toMatchObject({
      category: "validation",
      code: "GEOFENCE_BOUNDS_INVALID",
      field: "minLng",
    });

    await expect(
      h.service.setGeofence(h.admin, { ...SW_VALLEY, maxLat: 91 }, NOW)
    ).rejects.toMatchObject({
      category: "validation",
      code: "LATITUDE_OUT_OF_RANGE",
      field: "maxLat",
    });

    await expect(h.service.getGeofence()).resolves.toBeNull();
  });

  it("denies a non-Admin caller and leaves the fence unchanged", async () => {
    await h.service.setGeofence(h.admin, SW_VALLEY, NOW);

    for (const ctx of [h.buyer, h.supplier]) {
      await expect(
        h.service.setGeofence(
          ctx,
          { minLat: 0, maxLat: 1, minLng: 0, maxLng: 1 },
          LATER
        )
      ).rejects.toMatchObject({ category: "authorization" });
    }

    await expect(h.service.getGeofence()).resolves.toMatchObject(SW_VALLEY);
  });
});

describe("supplier company reads", () => {
  it("lists supplier companies only, across Pending and Approved", async () => {
    const second = await h.companies.createCompany(
      { name: "Goodyear Fuel", kind: "supplier" },
      NOW
    );
    await h.service.approveSupplier(h.admin, second.id);

    const listed = await h.service.listSupplierCompanies();

    expect(listed.map((c) => c.name).sort()).toEqual([
      "Buckeye Diesel",
      "Goodyear Fuel",
    ]);
    expect(
      listed.find((c) => c.id === h.supplierCompany.id)?.supplierApprovalStatus
    ).toBe("pending");
    expect(
      listed.find((c) => c.id === second.id)?.supplierApprovalStatus
    ).toBe("approved");
  });

  it("does not resolve a buyer company as a supplier company", async () => {
    await expect(
      h.service.getSupplierCompany(h.buyerCompany.id)
    ).resolves.toBeNull();
  });
});

describe("exported validators", () => {
  it("requireServiceRadiusMiles returns the radius or throws on non-positive", () => {
    expect(requireServiceRadiusMiles(0.5)).toBe(0.5);
    expect(() => requireServiceRadiusMiles(0)).toThrowError(
      /greater than zero/
    );
  });

  it("requireLatLng echoes an in-range pair", () => {
    expect(requireLatLng({ lat: 0, lng: 0 })).toEqual({ lat: 0, lng: 0 });
  });

  it("requireGeofence echoes a valid box", () => {
    expect(requireGeofence(SW_VALLEY)).toEqual(SW_VALLEY);
  });
});
