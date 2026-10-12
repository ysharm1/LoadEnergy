/**
 * Supplier availability — the Open / Limited / Closed toggle a dispatcher owns.
 *
 * Requirements:
 *   5.1 every Supplier Company carries a Supplier_Status of Open, Limited, or
 *       Closed.
 *   5.2 a Supplier changing their Supplier_Status has the new value persisted.
 *
 * The toggle is the supplier's own switch, separate from Admin approval: a
 * Company created by `CompanyUserService` starts `closed` and Admin approval
 * deliberately leaves the status alone, so a newly approved supplier still has
 * to open up before it receives RFQs. Consequently `setStatus` does NOT require
 * approval — a Pending company may pre-set itself Open, and matching
 * (Requirement 16.3) still excludes it until an Admin approves.
 *
 * Authorization is company-scoped through the single `supplier.setStatus`
 * policy row, so only users of that Supplier Company may read or write its
 * availability (Requirement 1.9). The read reuses the same row rather than
 * inventing a second action: the toggle's value and the toggle's control are
 * one surface, and keeping them on one policy means they cannot drift apart.
 */

import { ValidationError } from "@/domain/errors";
import {
  SUPPLIER_STATUSES,
  type AuthContext,
  type Company,
  type SupplierStatus,
} from "@/domain/types";
import type { Repository } from "@/repository/repository";
import { requireAction } from "./authorization";

/**
 * Validates a Supplier_Status against the enum (Requirement 5.1). Anything
 * outside {open, limited, closed} is a validation error on `supplierStatus`,
 * never a silent coercion — a typo'd status must not quietly close a supplier
 * out of the marketplace.
 */
export function requireSupplierStatus(
  value: unknown,
  field = "supplierStatus"
): SupplierStatus {
  if (
    typeof value !== "string" ||
    !SUPPLIER_STATUSES.includes(value as SupplierStatus)
  ) {
    throw new ValidationError(
      "SUPPLIER_STATUS_INVALID",
      `${field} must be one of: ${SUPPLIER_STATUSES.join(", ")}`,
      field
    );
  }
  return value as SupplierStatus;
}

/** Availability values that participate in RFQ matching (Requirement 5.3). */
export const MATCHABLE_SUPPLIER_STATUSES: readonly SupplierStatus[] = [
  "open",
  "limited",
];

/**
 * True when a Supplier_Status admits RFQ matching — Open or Limited, but not
 * Closed (Requirements 4.6, 5.3). Null (a buyer company, or a supplier row that
 * somehow lost its status) fails closed.
 */
export function isMatchableSupplierStatus(
  status: SupplierStatus | null | undefined
): boolean {
  return status != null && MATCHABLE_SUPPLIER_STATUSES.includes(status);
}

export interface SupplierServiceDeps {
  repo: Repository;
}

export class SupplierService {
  private readonly repo: Repository;

  constructor(deps: SupplierServiceDeps) {
    this.repo = deps.repo;
  }

  /**
   * Persists a new Supplier_Status on the caller's Supplier Company
   * (Requirement 5.2).
   *
   * `companyId` defaults to the caller's own Company; naming another Company is
   * denied by the `own_company` scope rather than filtered, so one supplier can
   * never close another out of the market. The write happens immediately and
   * unconditionally — there is no draft or confirmation step, because a
   * dispatcher toggling Closed mid-shift needs it to take effect on the next
   * match evaluation.
   */
  async setStatus(
    ctx: AuthContext,
    status: SupplierStatus,
    companyId?: string
  ): Promise<Company> {
    const target = companyId ?? ctx?.companyId;
    requireAction(ctx, "supplier.setStatus", { companyId: target });

    const next = requireSupplierStatus(status);
    const company = await this.requireSupplierCompany(target as string);

    if (company.supplierStatus === next) return company;

    return this.repo.updateCompany(company.id, { supplierStatus: next });
  }

  /** Reads the current Supplier_Status of the caller's Supplier Company. */
  async getStatus(
    ctx: AuthContext,
    companyId?: string
  ): Promise<SupplierStatus> {
    const target = companyId ?? ctx?.companyId;
    requireAction(ctx, "supplier.setStatus", { companyId: target });

    const company = await this.requireSupplierCompany(target as string);
    /**
     * A supplier row without a status is a data defect, not an availability.
     * Reporting `closed` keeps the read total and fails closed: the worst case
     * is a supplier who has to tap Open, not one who silently receives RFQs.
     */
    return company.supplierStatus ?? "closed";
  }

  /**
   * Resolves the Supplier Company behind the toggle. A missing company, or one
   * of buyer kind, is a validation error on the id: Supplier_Status is a
   * supplier-only field, so pointing the toggle at a buyer is malformed input
   * rather than a state conflict. Mirrors `AdminService`'s resolution so the two
   * report the same way.
   */
  private async requireSupplierCompany(companyId: string): Promise<Company> {
    const id = typeof companyId === "string" ? companyId.trim() : "";
    const company = id === "" ? null : await this.repo.getCompany(id);

    if (!company) {
      throw new ValidationError(
        "SUPPLIER_COMPANY_NOT_FOUND",
        "No such supplier company",
        "companyId"
      );
    }
    if (company.kind !== "supplier") {
      throw new ValidationError(
        "COMPANY_NOT_SUPPLIER",
        "Supplier availability applies only to a supplier company",
        "companyId"
      );
    }
    return company;
  }
}
