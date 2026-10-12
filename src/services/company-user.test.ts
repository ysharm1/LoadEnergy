import { describe, expect, it } from "vitest";
import { AuthorizationError, ValidationError } from "@/domain/errors";
import type { AuthContext, Role } from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import {
  CompanyUserService,
  isValidE164,
  normalizeOptionalEmail,
  normalizePhone,
} from "./company-user";
import { BcryptPasswordHasher } from "./password";

const NOW = new Date("2025-01-01T12:00:00Z");

// Real bcrypt at a low cost: fast enough for unit tests, still genuine hashing.
function makeService() {
  const repo = new InMemoryRepository();
  const hasher = new BcryptPasswordHasher(4);
  return { repo, hasher, service: new CompanyUserService({ repo, hasher }) };
}

describe("createCompany", () => {
  it("creates a buyer company with supplier-only fields null", async () => {
    const { service } = makeService();

    const company = await service.createCompany(
      { name: "SW Valley Concrete", kind: "buyer" },
      NOW
    );

    expect(company).toMatchObject({
      name: "SW Valley Concrete",
      kind: "buyer",
      supplierApprovalStatus: null,
      supplierStatus: null,
      operatingLat: null,
      operatingLng: null,
      serviceRadiusMiles: null,
      createdAt: NOW,
    });
  });

  it("creates a supplier company Pending approval and Closed (Requirement 16.1)", async () => {
    const { service } = makeService();

    const company = await service.createCompany(
      { name: "Buckeye Diesel", kind: "supplier" },
      NOW
    );

    expect(company.supplierApprovalStatus).toBe("pending");
    expect(company.supplierStatus).toBe("closed");
    expect(company.operatingLat).toBeNull();
    expect(company.serviceRadiusMiles).toBeNull();
  });

  it("rejects a blank name and an unknown kind", async () => {
    const { service } = makeService();

    await expect(
      service.createCompany({ name: "   ", kind: "buyer" }, NOW)
    ).rejects.toMatchObject({ category: "validation", field: "name" });

    await expect(
      service.createCompany(
        { name: "Nope", kind: "hauler" as unknown as "buyer" },
        NOW
      )
    ).rejects.toMatchObject({ category: "validation", field: "kind" });
  });
});

describe("createUser", () => {
  async function withCompany(kind: "buyer" | "supplier" = "buyer") {
    const ctx = makeService();
    const company = await ctx.service.createCompany(
      { name: "Acme", kind },
      NOW
    );
    return { ...ctx, company };
  }

  it("links the User to exactly one Company and role, storing phone and email", async () => {
    const { service, company } = await withCompany();

    const user = await service.createUser(
      {
        companyId: company.id,
        role: "buyer",
        phone: "+16025550134",
        email: "Super@Site.example",
        password: "correct horse battery",
      },
      NOW
    );

    expect(user.companyId).toBe(company.id);
    expect(user.role).toBe("buyer");
    expect(user.phone).toBe("+16025550134");
    expect(user.email).toBe("super@site.example");
    expect(user.createdAt).toEqual(NOW);

    // Requirements 1.3, 1.4, 1.7: the round trip preserves company and role.
    const readBack = await service.getUser(user.id);
    expect(readBack).toEqual(user);
  });

  it("stores null email when none is supplied (Requirement 1.7)", async () => {
    const { service, company } = await withCompany();

    const noEmail = await service.createUser(
      {
        companyId: company.id,
        role: "supplier",
        phone: "+16025550135",
        password: "pw",
      },
      NOW
    );
    const blankEmail = await service.createUser(
      {
        companyId: company.id,
        role: "supplier",
        phone: "+16025550136",
        email: "   ",
        password: "pw",
      },
      NOW
    );

    expect(noEmail.email).toBeNull();
    expect(blankEmail.email).toBeNull();
  });

  it("never stores the plaintext password", async () => {
    const { service, hasher, company } = await withCompany();

    const user = await service.createUser(
      {
        companyId: company.id,
        role: "admin",
        phone: "+16025550137",
        password: "plaintext-secret",
      },
      NOW
    );

    expect(user.passwordHash).not.toContain("plaintext-secret");
    await expect(hasher.verify("plaintext-secret", user.passwordHash)).resolves.toBe(
      true
    );
  });

  it("normalizes a formatted phone number to E.164", async () => {
    const { service, company } = await withCompany();

    const user = await service.createUser(
      {
        companyId: company.id,
        role: "buyer",
        phone: " +1 (602) 555-0138 ",
        password: "pw",
      },
      NOW
    );

    expect(user.phone).toBe("+16025550138");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["no plus sign", "6025550134"],
    ["zero country code", "+06025550134"],
    ["too short", "+123456"],
    ["too long", "+1234567890123456"],
    ["letters", "+1602555ABCD"],
  ])(
    "rejects a %s phone with a validation error on field phone (Requirement 1.6)",
    async (_label, phone) => {
      const { service, company } = await withCompany();

      const promise = service.createUser(
        {
          companyId: company.id,
          role: "buyer",
          phone: phone as unknown as string,
          password: "pw",
        },
        NOW
      );

      await expect(promise).rejects.toBeInstanceOf(ValidationError);
      await expect(promise).rejects.toMatchObject({
        category: "validation",
        field: "phone",
      });
    }
  );

  it("rejects a malformed email, an unknown role, a blank password, and an unknown company", async () => {
    const { service, company } = await withCompany();
    const base = {
      companyId: company.id,
      role: "buyer" as const,
      phone: "+16025550139",
      password: "pw",
    };

    await expect(
      service.createUser({ ...base, email: "not-an-email" }, NOW)
    ).rejects.toMatchObject({ category: "validation", field: "email" });

    await expect(
      service.createUser(
        { ...base, role: "dispatcher" as unknown as "buyer" },
        NOW
      )
    ).rejects.toMatchObject({ category: "validation", field: "role" });

    await expect(
      service.createUser({ ...base, password: "" }, NOW)
    ).rejects.toMatchObject({ category: "validation", field: "password" });

    await expect(
      service.createUser({ ...base, companyId: "company-does-not-exist" }, NOW)
    ).rejects.toMatchObject({ category: "validation", field: "companyId" });
  });
});

// ---------------------------------------------------------------------------
// The guarded onboarding entry points (Requirements 1.3, 1.4, 1.9, 16.1)
// ---------------------------------------------------------------------------

describe("createCompanyAsAdmin / createUserAsAdmin (Requirement 1.9)", () => {
  const ctxFor = (role: Role): AuthContext => ({
    userId: `user-${role}`,
    companyId: "co-operator",
    role,
  });

  it("creates a company for an Admin, with the same result as the trusted path", async () => {
    const { service } = makeService();

    const company = await service.createCompanyAsAdmin(
      ctxFor("admin"),
      { name: "Buckeye Diesel", kind: "supplier" },
      NOW
    );

    // Requirement 16.1 — a new supplier is Pending and closed.
    expect(company).toMatchObject({
      name: "Buckeye Diesel",
      kind: "supplier",
      supplierApprovalStatus: "pending",
      supplierStatus: "closed",
      createdAt: NOW,
    });
  });

  it("creates a user on another company for an Admin (Requirements 1.3, 1.4)", async () => {
    const { service } = makeService();
    const company = await service.createCompany(
      { name: "SW Valley Concrete", kind: "buyer" },
      NOW
    );

    const user = await service.createUserAsAdmin(
      ctxFor("admin"),
      {
        companyId: company.id,
        role: "buyer",
        phone: "+1 (602) 555-0134",
        password: "pw",
      },
      NOW
    );

    expect(user).toMatchObject({
      companyId: company.id,
      role: "buyer",
      phone: "+16025550134",
      email: null,
    });
    expect(user.passwordHash).not.toBe("pw");
  });

  it("denies a Buyer, a Supplier, and an unauthenticated caller, writing nothing", async () => {
    const { repo, service } = makeService();
    const company = await service.createCompany(
      { name: "SW Valley Concrete", kind: "buyer" },
      NOW
    );
    const before = (await repo.listCompanies()).length;

    for (const ctx of [ctxFor("buyer"), ctxFor("supplier"), null]) {
      await expect(
        service.createCompanyAsAdmin(ctx, { name: "Sneaky Fuel", kind: "supplier" }, NOW)
      ).rejects.toMatchObject({ category: "authorization", httpStatus: 403 });

      await expect(
        service.createUserAsAdmin(
          ctx,
          {
            companyId: company.id,
            role: "admin",
            phone: "+16025550199",
            password: "pw",
          },
          NOW
        )
      ).rejects.toMatchObject({ category: "authorization", httpStatus: 403 });
    }

    // A denial decides nothing, so it writes nothing.
    expect((await repo.listCompanies()).length).toBe(before);
    expect(await repo.listUsersByCompany(company.id)).toHaveLength(0);
  });

  it("denies before validating, so a malformed input still reads as a denial", async () => {
    const { service } = makeService();

    await expect(
      service.createCompanyAsAdmin(ctxFor("buyer"), { name: "", kind: "buyer" }, NOW)
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("validation helpers", () => {
  it("accepts E.164 at the length bounds and rejects outside them", () => {
    expect(isValidE164("+1234567")).toBe(true); // 7 digits
    expect(isValidE164("+123456789012345")).toBe(true); // 15 digits
    expect(isValidE164("+123456")).toBe(false); // 6 digits
    expect(isValidE164("+1234567890123456")).toBe(false); // 16 digits
  });

  it("strips human formatting from a phone number", () => {
    expect(normalizePhone("+1 (602) 555.0134")).toBe("+16025550134");
  });

  it("treats absent and blank email as null", () => {
    expect(normalizeOptionalEmail(undefined)).toBeNull();
    expect(normalizeOptionalEmail(null)).toBeNull();
    expect(normalizeOptionalEmail("  ")).toBeNull();
    expect(normalizeOptionalEmail(" Ops@Example.COM ")).toBe("ops@example.com");
  });
});
