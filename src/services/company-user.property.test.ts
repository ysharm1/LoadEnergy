/**
 * Property-based tests for the Company/User service.
 *
 * Feature: load-energy — Property 1 (task 2.4), Property 2 (task 2.5).
 *
 * Runs the real `CompanyUserService` against the real `InMemoryRepository`
 * (which mirrors the Prisma uniqueness constraints) and a real bcrypt hasher at
 * a low cost factor: genuine hashing, cheap enough for 100+ iterations.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { InMemoryRepository } from "@/repository/in-memory";
import {
  COMPANY_KINDS,
  ROLES,
  type CompanyKind,
  type Role,
} from "@/domain/types";
import { ValidationError } from "@/domain/errors";
import {
  CompanyUserService,
  E164_MAX_DIGITS,
  E164_MIN_DIGITS,
  isValidE164,
  normalizePhone,
  type CreateUserInput,
} from "./company-user";
import { BcryptPasswordHasher } from "./password";

const NOW = new Date("2025-03-14T09:30:00Z");

const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A short token usable inside a name, an email local part, or a domain label. */
const token = (maxLength: number) =>
  fc.stringOf(fc.constantFrom(...LOWER_ALNUM.split("")), {
    minLength: 1,
    maxLength,
  });

/**
 * Well-formed E.164: a leading `+`, a non-zero first (country code) digit, and
 * a total digit count inside the service's inclusive [7, 15] bound. Generating
 * only valid numbers keeps this property about the round trip; rejection of
 * malformed input is Property 2's job (task 2.5).
 */
const e164Phone = fc
  .tuple(
    fc.integer({ min: 1, max: 9 }),
    fc.array(fc.integer({ min: 0, max: 9 }), {
      minLength: E164_MIN_DIGITS - 1,
      maxLength: E164_MAX_DIGITS - 1,
    })
  )
  .map(([countryDigit, rest]) => `+${countryDigit}${rest.join("")}`);

/**
 * A second, guaranteed-distinct phone derived from the generated one by
 * bumping its last digit. The repository enforces phone uniqueness (a real
 * constraint, and not what this property is about), so the decoy user planted
 * on the other Company needs a number that can never collide.
 */
function distinctPhone(phone: string): string {
  const lastDigit = Number(phone.slice(-1));
  return `${phone.slice(0, -1)}${(lastDigit + 1) % 10}`;
}

/** A valid email, sometimes with mixed case and padding the service trims. */
const email = fc
  .tuple(
    token(8),
    token(8),
    fc.constantFrom("com", "example", "co", "net"),
    fc.boolean(),
    fc.boolean()
  )
  .map(([local, domain, tld, upperCased, padded]) => {
    const address = `${local}@${domain}.${tld}`;
    const cased = upperCased ? address.toUpperCase() : address;
    return padded ? `  ${cased}  ` : cased;
  });

/** Supplied, explicitly null, or simply absent (Requirement 1.7). */
const optionalEmail = fc.oneof(
  { arbitrary: email, weight: 2 },
  { arbitrary: fc.constant(null), weight: 1 },
  { arbitrary: fc.constant(undefined), weight: 1 }
);

interface UserCase {
  companyName: string;
  companyKind: CompanyKind;
  otherCompanyName: string;
  role: Role;
  phone: string;
  email: string | null | undefined;
  password: string;
}

const userCase: fc.Arbitrary<UserCase> = fc.record({
  companyName: token(12),
  companyKind: fc.constantFrom(...COMPANY_KINDS),
  otherCompanyName: token(12),
  role: fc.constantFrom(...ROLES),
  phone: e164Phone,
  email: optionalEmail,
  password: token(16),
});

/** The stored form of a supplied email: trimmed and lower-cased. */
function expectedEmail(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed.toLowerCase();
}

describe("Property 1: User round trip", () => {
  // Feature: load-energy, Property 1: User round trip with required phone and optional email
  // **Validates: Requirements 1.3, 1.4, 1.5, 1.7**
  it("links the User to exactly one Company and round-trips role, phone, and optional email", async () => {
    await fc.assert(
      fc.asyncProperty(userCase, async (input) => {
        // A fresh store per generated case keeps runs independent; phone and
        // email uniqueness is then satisfied by construction.
        const repo = new InMemoryRepository();
        const service = new CompanyUserService({
          repo,
          hasher: new BcryptPasswordHasher(4),
        });

        const company = await service.createCompany(
          { name: input.companyName, kind: input.companyKind },
          NOW
        );
        const otherCompany = await service.createCompany(
          { name: input.otherCompanyName, kind: input.companyKind },
          NOW
        );

        const user = await service.createUser(
          {
            companyId: company.id,
            role: input.role,
            phone: input.phone,
            email: input.email,
            password: input.password,
          },
          NOW
        );

        // A decoy User on the other Company: linkage must not leak across
        // companies (Requirement 1.3).
        const decoy = await service.createUser(
          {
            companyId: otherCompany.id,
            role: input.role,
            phone: distinctPhone(input.phone),
            password: input.password,
          },
          NOW
        );

        // Requirement 1.3: exactly one Company, and it is the one supplied.
        expect(user.companyId).toBe(company.id);
        expect(user.companyId).not.toBe(otherCompany.id);

        // Requirement 1.4: exactly the one role assigned.
        expect(user.role).toBe(input.role);

        // Requirement 1.5: the phone stored in normalized E.164 form.
        expect(user.phone).toBe(input.phone);

        // Requirement 1.7: the email when supplied, absent (null) otherwise.
        expect(user.email).toBe(expectedEmail(input.email));

        // Reading the User back by id yields the same record.
        const readBack = await service.getUser(user.id);
        expect(readBack).toEqual(user);

        // ...and the Company link reads back as exactly this one User.
        const companyUsers = await service.listUsersByCompany(company.id);
        expect(companyUsers).toEqual([user]);
        const otherCompanyUsers = await service.listUsersByCompany(
          otherCompany.id
        );
        expect(otherCompanyUsers).toEqual([decoy]);
      })
    );
  });
});

/**
 * Feature: load-energy — Property 2 (task 2.5).
 *
 * Requirement 1.6: creating a User without a phone number is rejected with a
 * validation error. "Without a phone" covers both the absent cases (undefined,
 * null, empty, whitespace-only) and the malformed cases, because Requirement
 * 1.5 defines the stored phone as E.164 form — a value that can never be an
 * E.164 number is not a phone number the system can reach the User on.
 */

/** Whitespace `String.prototype.trim` removes, so the value trims to empty. */
const WHITESPACE_CHARS = [
  " ",
  "\t",
  "\n",
  "\r",
  "\f",
  "\v",
  "\u00a0",
  "\u2028",
  "\u3000",
  "\ufeff",
];

/**
 * Characters `normalizePhone` does NOT strip, so injecting one keeps the value
 * malformed. Deliberately excludes whitespace, parentheses, dots, and the
 * hyphen family, which normalization removes.
 */
const NON_PHONE_CHARS = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."ABCXYZ",
  ..."#*/_,;:'\"!?=@$~^|<>[]{}%&+",
];

const digits = (count: number) =>
  fc
    .array(fc.integer({ min: 0, max: 9 }), {
      minLength: count,
      maxLength: count,
    })
    .map((ds) => ds.join(""));

const digitRun = (min: number, max: number) =>
  fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength: min, maxLength: max })
    .map((ds) => ds.join(""));

const nonZeroDigit = fc.integer({ min: 1, max: 9 });

interface MissingPhoneCase {
  /** Names the shape of "no phone" so a counterexample reads clearly. */
  shape: string;
  /** Omit the `phone` key entirely rather than passing a value. */
  absent?: true;
  phone?: unknown;
}

/** The `phone` key is simply not present on the input object. */
const absentPhone: fc.Arbitrary<MissingPhoneCase> = fc.constant({
  shape: "absent",
  absent: true as const,
});

const nullPhone: fc.Arbitrary<MissingPhoneCase> = fc.constant({
  shape: "null",
  phone: null,
});

const emptyPhone: fc.Arbitrary<MissingPhoneCase> = fc.constant({
  shape: "empty string",
  phone: "",
});

/** One or more whitespace characters and nothing else. */
const whitespacePhone: fc.Arbitrary<MissingPhoneCase> = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), { minLength: 1, maxLength: 6 })
  .map((chars) => ({ shape: "whitespace only", phone: chars.join("") }));

/** Right digit count, but no leading `+` (Requirement 1.5 form violated). */
const missingPlusPhone: fc.Arbitrary<MissingPhoneCase> = fc
  .tuple(nonZeroDigit, digitRun(E164_MIN_DIGITS - 1, E164_MAX_DIGITS - 1))
  .map(([first, rest]) => ({
    shape: "missing leading +",
    phone: `${first}${rest}`,
  }));

/** Leading `+` but a zero country-code digit. */
const zeroCountryCodePhone: fc.Arbitrary<MissingPhoneCase> = fc
  .tuple(digitRun(E164_MIN_DIGITS - 1, E164_MAX_DIGITS - 1))
  .map(([rest]) => ({
    shape: "zero country code digit",
    phone: `+0${rest}`,
  }));

/** Fewer than the minimum total digits. */
const tooShortPhone: fc.Arbitrary<MissingPhoneCase> = fc
  .tuple(nonZeroDigit, digitRun(0, E164_MIN_DIGITS - 2))
  .map(([first, rest]) => ({
    shape: "too few digits",
    phone: `+${first}${rest}`,
  }));

/** More than the E.164 maximum of 15 total digits. */
const tooLongPhone: fc.Arbitrary<MissingPhoneCase> = fc
  .tuple(nonZeroDigit, digitRun(E164_MAX_DIGITS, E164_MAX_DIGITS + 10))
  .map(([first, rest]) => ({
    shape: "too many digits",
    phone: `+${first}${rest}`,
  }));

/**
 * An otherwise plausible number with a letter or symbol spliced in at an
 * arbitrary position — including before the `+`.
 */
const junkCharPhone: fc.Arbitrary<MissingPhoneCase> = fc
  .tuple(
    nonZeroDigit,
    digits(E164_MIN_DIGITS - 1),
    fc.constantFrom(...NON_PHONE_CHARS),
    fc.nat()
  )
  .map(([first, rest, junk, rawIndex]) => {
    const base = `+${first}${rest}`;
    const at = rawIndex % (base.length + 1);
    return {
      shape: "contains a letter or symbol",
      phone: `${base.slice(0, at)}${junk}${base.slice(at)}`,
    };
  });

/**
 * A value genuinely lacks a phone number when it is not a string at all, is
 * blank once trimmed, or cannot be read as E.164 after the service's own
 * formatting normalization. Used as a generator guard so no draw can produce a
 * false failure by accidentally being a valid number.
 */
function lacksPhone(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  if (trimmed === "") return true;
  return !isValidE164(normalizePhone(trimmed));
}

const missingPhoneCase: fc.Arbitrary<MissingPhoneCase> = fc
  .oneof(
    absentPhone,
    nullPhone,
    emptyPhone,
    whitespacePhone,
    missingPlusPhone,
    zeroCountryCodePhone,
    tooShortPhone,
    tooLongPhone,
    junkCharPhone
  )
  .filter((c) => lacksPhone(c.absent ? undefined : c.phone));

describe("Property 2: User creation requires a phone", () => {
  // Feature: load-energy, Property 2: User creation requires a phone
  // **Validates: Requirements 1.6**
  it("rejects User creation with a phone validation error and persists nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        missingPhoneCase,
        fc.constantFrom(...ROLES),
        fc.constantFrom(...COMPANY_KINDS),
        token(12),
        token(16),
        async (phoneCase, role, companyKind, companyName, password) => {
          const repo = new InMemoryRepository();
          const service = new CompanyUserService({
            repo,
            hasher: new BcryptPasswordHasher(4),
          });

          const company = await service.createCompany(
            { name: companyName, kind: companyKind },
            NOW
          );

          // Everything except the phone is valid, so the phone is the only
          // reason creation can fail.
          const base = { companyId: company.id, role, password };
          const input = (
            phoneCase.absent ? base : { ...base, phone: phoneCase.phone }
          ) as CreateUserInput;

          let thrown: unknown;
          try {
            await service.createUser(input, NOW);
          } catch (error) {
            thrown = error;
          }

          // Requirement 1.6: rejected, and rejected as a validation error on
          // the phone field (400 at the API boundary).
          expect(thrown, `shape: ${phoneCase.shape}`).toBeInstanceOf(
            ValidationError
          );
          const error = thrown as ValidationError;
          expect(error.category).toBe("validation");
          expect(error.httpStatus).toBe(400);
          expect(error.field).toBe("phone");

          // Rejection means rejection: no User was written as a side effect.
          expect(await service.listUsersByCompany(company.id)).toEqual([]);
        }
      )
    );
  });
});
