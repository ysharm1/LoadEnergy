/**
 * Company and User service.
 *
 * Requirements:
 *   1.3 each User is associated with exactly one Company.
 *   1.4 each User is assigned exactly one role (buyer | supplier | admin).
 *   1.5 a phone number in E.164 (or equivalent) form is stored with the User.
 *   1.6 creation without a phone number is rejected with a validation error.
 *   1.7 an email address is stored when the User provides one.
 *  16.1 a newly created Supplier Company starts Pending approval.
 *
 * Pure over its injected ports (Repository, PasswordHasher) with a
 * caller-supplied `now`, matching the established service style: no HTTP, no
 * database, no ambient clock. Passwords are hashed through the
 * `PasswordHasher` port before storage — plaintext never reaches the
 * repository.
 */

import { ValidationError } from "@/domain/errors";
import {
  ROLES,
  COMPANY_KINDS,
  type Company,
  type CompanyKind,
  type Role,
  type User,
} from "@/domain/types";
import type { Repository } from "@/repository/repository";
import type { PasswordHasher } from "./password";

/**
 * E.164 allows at most 15 digits after the leading `+`, starting with a
 * non-zero country code digit. The lower bound of 7 total digits is the
 * shortest assigned international number (e.g. a 3-digit country code plus a
 * 4-digit subscriber number), so it rejects obvious junk without excluding
 * real numbers.
 */
export const E164_MIN_DIGITS = 7;
export const E164_MAX_DIGITS = 15;
const E164_PATTERN = new RegExp(
  `^\\+[1-9]\\d{${E164_MIN_DIGITS - 1},${E164_MAX_DIGITS - 1}}$`
);

/**
 * Minimal email shape check: a non-empty local part, a single `@`, and a
 * dotted domain with no whitespace. Deliberately permissive — deliverability
 * is proven by actually sending, not by a regex.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export interface CreateCompanyInput {
  name: string;
  kind: CompanyKind;
}

export interface CreateUserInput {
  companyId: string;
  role: Role;
  /** Required, E.164 (or equivalent) form (Requirements 1.5, 1.6). */
  phone: string;
  /** Optional (Requirement 1.7). Absent or blank is stored as null. */
  email?: string | null;
  password: string;
}

export interface CompanyUserServiceDeps {
  repo: Repository;
  hasher: PasswordHasher;
}

/**
 * Strips the formatting a person may type around a phone number (spaces,
 * parentheses, dots, hyphens) before validation, so `+1 (602) 555-0134` and
 * `+16025550134` are the same number. Mirrors the normalization
 * `AuthService` applies to a login identifier, which is what lets a User sign
 * in with the number they typed at signup.
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s().\-\u2010-\u2015]/g, "");
}

/** True when the value is a well-formed E.164 number. */
export function isValidE164(phone: string): boolean {
  return E164_PATTERN.test(phone);
}

/**
 * Validates and normalizes a phone number for storage.
 * Throws a `ValidationError` on `field: "phone"` for missing, blank, or
 * malformed input (Requirement 1.6).
 */
export function requireE164Phone(phone: unknown): string {
  if (typeof phone !== "string" || phone.trim() === "") {
    throw new ValidationError(
      "PHONE_REQUIRED",
      "A phone number in E.164 form (e.g. +16025550134) is required",
      "phone"
    );
  }

  const normalized = normalizePhone(phone.trim());
  if (!isValidE164(normalized)) {
    throw new ValidationError(
      "PHONE_INVALID",
      `A phone number must be in E.164 form: a leading +, a country code, and ${E164_MIN_DIGITS}-${E164_MAX_DIGITS} digits total (e.g. +16025550134)`,
      "phone"
    );
  }
  return normalized;
}

/**
 * Normalizes an optional email for storage: absent, null, or blank becomes
 * null; anything else is trimmed, lower-cased, and shape-checked
 * (Requirement 1.7).
 */
export function normalizeOptionalEmail(email: unknown): string | null {
  if (email === undefined || email === null) return null;
  if (typeof email !== "string") {
    throw new ValidationError("EMAIL_INVALID", "Email must be text", "email");
  }

  const trimmed = email.trim();
  if (trimmed === "") return null;

  const normalized = trimmed.toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new ValidationError(
      "EMAIL_INVALID",
      "Email must look like name@example.com",
      "email"
    );
  }
  return normalized;
}

export class CompanyUserService {
  private readonly repo: Repository;
  private readonly hasher: PasswordHasher;

  constructor(deps: CompanyUserServiceDeps) {
    this.repo = deps.repo;
    this.hasher = deps.hasher;
  }

  /**
   * Creates a Company.
   *
   * A Supplier Company starts with Supplier_Approval_Status Pending
   * (Requirement 16.1) and Supplier_Status closed, so it cannot receive RFQs
   * or quote until an Admin approves it (offline ADOT check) and the supplier
   * opens up. Operating_Location and Service_Radius are Admin-set and start
   * null. A Buyer Company leaves every supplier-only field null.
   */
  async createCompany(
    input: CreateCompanyInput,
    now: Date = new Date()
  ): Promise<Company> {
    const name = (input?.name ?? "").trim();
    if (name === "") {
      throw new ValidationError(
        "COMPANY_NAME_REQUIRED",
        "A company name is required",
        "name"
      );
    }

    const kind = input?.kind;
    if (!COMPANY_KINDS.includes(kind as CompanyKind)) {
      throw new ValidationError(
        "COMPANY_KIND_INVALID",
        `Company kind must be one of: ${COMPANY_KINDS.join(", ")}`,
        "kind"
      );
    }

    const isSupplier = kind === "supplier";
    return this.repo.createCompany({
      name,
      kind,
      supplierApprovalStatus: isSupplier ? "pending" : null,
      supplierStatus: isSupplier ? "closed" : null,
      operatingLat: null,
      operatingLng: null,
      serviceRadiusMiles: null,
      createdAt: new Date(now.getTime()),
    });
  }

  /**
   * Creates a User linked to exactly one existing Company (Requirement 1.3)
   * with exactly one role (Requirement 1.4), a required E.164 phone
   * (Requirements 1.5, 1.6), and an optional email (Requirement 1.7).
   *
   * The role is persisted on the User row, which is what `AuthContext`
   * resolution reads so the client can present the role-appropriate interface
   * (Requirement 1.7/1.8 handoff to the UI layer).
   */
  async createUser(
    input: CreateUserInput,
    now: Date = new Date()
  ): Promise<User> {
    const phone = requireE164Phone(input?.phone);
    const email = normalizeOptionalEmail(input?.email);

    const role = input?.role;
    if (!ROLES.includes(role as Role)) {
      throw new ValidationError(
        "ROLE_INVALID",
        `Role must be one of: ${ROLES.join(", ")}`,
        "role"
      );
    }

    const password = input?.password ?? "";
    if (password === "") {
      throw new ValidationError(
        "PASSWORD_REQUIRED",
        "A password is required",
        "password"
      );
    }

    const companyId = (input?.companyId ?? "").trim();
    const company = companyId === "" ? null : await this.repo.getCompany(companyId);
    if (!company) {
      throw new ValidationError(
        "COMPANY_NOT_FOUND",
        "A User must belong to exactly one existing Company",
        "companyId"
      );
    }

    return this.repo.createUser({
      companyId: company.id,
      role,
      phone,
      email,
      passwordHash: await this.hasher.hash(password),
      createdAt: new Date(now.getTime()),
    });
  }

  /** Reads a User back by id (used by callers and the round-trip tests). */
  async getUser(id: string): Promise<User | null> {
    return this.repo.getUser(id);
  }

  /** Every User belonging to one Company. */
  async listUsersByCompany(companyId: string): Promise<User[]> {
    return this.repo.listUsersByCompany(companyId);
  }
}
