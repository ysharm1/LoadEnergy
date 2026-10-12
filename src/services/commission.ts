/**
 * Commission service — the revenue side of the ledger: what a Delivered load
 * owes, the invoice that records it, the Admin's mark-paid, and the
 * commission-due report.
 *
 * Requirements:
 *  12.1 an Order reaching Delivered with recorded BOL_Gallons generates exactly
 *       one Commission_Invoice addressed to the winning Supplier Company.
 *  12.2 the third and later completed win is billed BOL_Gallons x
 *       Commission_Rate ($0.02/gal).
 *  12.3 the first two completed wins are Waived_Wins: amount zero, `waived` set.
 *  12.4 every invoice is created Unpaid, waived $0 invoices included.
 *  12.5 an Order that has not reached Delivered generates no invoice.
 *  12.6 an Admin marking an invoice paid sets Payment_Status Paid and persists
 *       the acting Admin and the timestamp.
 *  12.7 a non-Admin attempting mark-paid is denied with an authorization error.
 *  12.8 an Admin requesting commission due gets the Unpaid total grouped by
 *       Supplier Company.
 *  17.3 a concierge Order uses these same rules, waived wins included.
 *
 * Shape follows the house style: pure helpers at the top (the arithmetic and
 * the aggregation are functions over data, so they property-test without I/O),
 * then a class over an injected `Repository` with a caller-supplied `now`.
 * Authorization goes through `requireAction` so the matrix in
 * `services/authorization.ts` stays the single source of truth.
 *
 * ## Why generation is origin-agnostic
 *
 * `generateInvoiceForOrder` takes an order id and nothing else about where the
 * load came from. The app path (`OrderService.recordDelivery`) and the Admin
 * concierge path (task 12.3) both land on it unchanged, which is what
 * Requirement 17.3 means by "the same commission rules": there is one code
 * path, not two that have to be kept in step. It deliberately carries no
 * `AuthContext` — by the time it runs the caller has already been authorized to
 * record the delivery or to enter the concierge order, and the invoice is the
 * marketplace's own bookkeeping rather than an action a user performs.
 *
 * ## Idempotency
 *
 * `CommissionInvoice.orderId` is unique, so generation is safe to replay: an
 * Order that already has an invoice returns the stored one untouched, and a
 * racing second insert is caught and resolved to the existing row. This is what
 * makes "exactly one invoice per Delivered Order" (Requirement 12.1) a
 * constraint rather than a convention, and it is what lets the delivery path
 * treat a transient generation failure as retryable instead of fatal.
 *
 * Mark-paid is one-way by the same reasoning: an already-Paid invoice is
 * returned as-is, so Payment_Status never moves back to Unpaid.
 */

import { ValidationError } from "@/domain/errors";
import {
  COMMISSION_RATE_PER_GAL,
  WAIVED_WIN_LIMIT,
  type AuthContext,
  type CommissionInvoice,
  type Delivery,
  type Order,
} from "@/domain/types";
import type { Repository } from "@/repository/repository";
import type { AuditService } from "./audit";
import { requireAction } from "./authorization";

// ---------------------------------------------------------------------------
// Pure arithmetic (Requirements 12.2, 12.3)
// ---------------------------------------------------------------------------

/**
 * Money is stored to the cent. BOL gallons are whole numbers and the rate is
 * $0.02, so every commission is already an exact multiple of a cent; this only
 * strips IEEE-754 representation dust so an invoice reads $24.70 rather than
 * $24.700000000000003.
 */
export function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * True while a Supplier Company is inside its waiver allowance
 * (Requirement 12.3): with `priorCompletedWins` completed wins already behind
 * it, this delivery is its (n+1)th, so n = 0 and n = 1 are the first two wins
 * and are waived; n = 2 is the third win and is billed.
 */
export function isWaivedWin(priorCompletedWins: number): boolean {
  return priorCompletedWins < WAIVED_WIN_LIMIT;
}

/**
 * The commission in dollars for one delivered load (Requirements 12.2, 12.3).
 *
 * Total on purpose — no throwing, no clock, no I/O — so it can be reasoned
 * about and property-tested directly. Gallons are validated upstream when the
 * Delivery is recorded (Requirement 11.4), so this never has to defend against
 * a nonsense BOL count.
 */
export function commissionAmount(
  bolGallons: number,
  priorCompletedWins: number
): number {
  if (isWaivedWin(priorCompletedWins)) return 0;
  return roundToCents(bolGallons * COMMISSION_RATE_PER_GAL);
}

/** The invoice numbers a delivered load produces, before it is persisted. */
export interface CommissionTerms {
  amount: number;
  waived: boolean;
}

/** The amount and the waived flag together, so the two can never disagree. */
export function commissionTerms(
  bolGallons: number,
  priorCompletedWins: number
): CommissionTerms {
  return {
    amount: commissionAmount(bolGallons, priorCompletedWins),
    waived: isWaivedWin(priorCompletedWins),
  };
}

// ---------------------------------------------------------------------------
// Pure aggregation (Requirement 12.8)
// ---------------------------------------------------------------------------

/** An invoice still owed: Unpaid, whatever its amount. */
export function isUnpaid(
  invoice: Pick<CommissionInvoice, "paymentStatus">
): boolean {
  return invoice.paymentStatus === "unpaid";
}

/**
 * Unpaid totals keyed by Supplier Company (Requirement 12.8). Paid invoices are
 * excluded entirely; a company with nothing outstanding is absent rather than
 * present with a zero, so "who owes us money" is the key set.
 *
 * A waived $0 invoice keeps a company in the map with a $0 total until an Admin
 * marks it paid — it is genuinely unpaid paperwork, just worth nothing.
 */
export function commissionDueBySupplier(
  invoices: readonly CommissionInvoice[]
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const invoice of invoices) {
    if (!isUnpaid(invoice)) continue;
    const running = totals.get(invoice.supplierCompanyId) ?? 0;
    totals.set(invoice.supplierCompanyId, roundToCents(running + invoice.amount));
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Report projection (Requirement 12.8)
// ---------------------------------------------------------------------------

/** One Supplier Company's outstanding commission. */
export interface CommissionDueRow {
  supplierCompanyId: string;
  /** Null when the company row cannot be resolved (a data defect, not a gap). */
  supplierCompanyName: string | null;
  /** Count of Unpaid invoices behind `amountDue`. */
  unpaidInvoiceCount: number;
  amountDue: number;
}

export interface CommissionDueReport {
  rows: CommissionDueRow[];
  /** Sum of every row's `amountDue`. */
  totalDue: number;
}

/** One invoice with its Supplier Company's name resolved, for the Admin list. */
export interface CommissionInvoiceRow extends CommissionInvoice {
  /** Null when the company row cannot be resolved (a data defect, not a gap). */
  supplierCompanyName: string | null;
}

/** Deterministic order: most owed first, then by company id to break ties. */
function sortDueRows(rows: CommissionDueRow[]): CommissionDueRow[] {
  return rows.sort(
    (a, b) =>
      b.amountDue - a.amountDue ||
      a.supplierCompanyId.localeCompare(b.supplierCompanyId)
  );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CommissionServiceDeps {
  repo: Repository;
  /**
   * Records INVOICE_PAID (Requirement 14.6). Optional, like the other
   * cross-service ports, so the commission arithmetic can be exercised on its
   * own; wired in production so every payment is attributable to the Admin who
   * recorded it.
   */
  audit?: AuditService;
}

export class CommissionService {
  private readonly repo: Repository;
  private readonly audit?: AuditService;

  constructor(deps: CommissionServiceDeps) {
    this.repo = deps.repo;
    this.audit = deps.audit;
  }

  /**
   * Generates the Commission_Invoice for a Delivered Order
   * (Requirements 12.1-12.5, 17.3).
   *
   * Origin-agnostic: the app delivery path and the Admin concierge path both
   * call this with an order id. Returns the invoice, or `null` when there is
   * nothing to bill — an Order that has not reached Delivered, or one with no
   * Delivery behind it (Requirement 12.5). A no-op rather than an error,
   * because "not delivered yet" is the normal state of most Orders and callers
   * sweep this method over them.
   *
   * Replaying is safe: an Order that already has an invoice returns the stored
   * one, so the amount is never recomputed against a different win count.
   */
  async generateInvoiceForOrder(
    orderId: string,
    now: Date = new Date()
  ): Promise<CommissionInvoice | null> {
    const id = typeof orderId === "string" ? orderId.trim() : "";
    const order = id === "" ? null : await this.repo.getOrder(id);
    if (!order) return null;

    // Idempotency first: never recompute terms for an order already billed.
    const existing = await this.repo.getCommissionInvoiceByOrder(order.id);
    if (existing) return existing;

    // Requirement 12.5 — nothing to bill before the fuel lands.
    if (order.status !== "delivered") return null;

    // Requirement 12.1 — commission is billed on recorded BOL gallons, so an
    // Order flagged Delivered with no Delivery row behind it is not billable.
    const delivery = await this.repo.getDeliveryByOrder(order.id);
    if (!delivery) return null;

    return this.createInvoice(order, delivery, now);
  }

  /**
   * Writes the invoice. The unique `orderId` is the real exclusivity gate: if a
   * concurrent caller won the insert, the conflict resolves to that invoice
   * rather than surfacing as a failed delivery.
   */
  private async createInvoice(
    order: Order,
    delivery: Delivery,
    now: Date
  ): Promise<CommissionInvoice> {
    const priorCompletedWins = await this.countPriorCompletedWins(order);
    const { amount, waived } = commissionTerms(
      delivery.bolGallons,
      priorCompletedWins
    );

    try {
      return await this.repo.createCommissionInvoice({
        orderId: order.id,
        // Requirement 12.1 — addressed to the winning Supplier Company.
        supplierCompanyId: order.supplierCompanyId,
        bolGallons: delivery.bolGallons,
        amount,
        waived,
        // Requirement 12.4 — Unpaid on creation, waived $0 invoices included.
        paymentStatus: "unpaid",
        paidByAdminId: null,
        paidAt: null,
        createdAt: new Date(now.getTime()),
      });
    } catch (error) {
      const raced = await this.repo.getCommissionInvoiceByOrder(order.id);
      if (raced) return raced;
      throw error;
    }
  }

  /**
   * How many completed wins this Supplier Company had *before* this load
   * (Requirements 12.2, 12.3).
   *
   * A completed win is a Delivered Order, and this Order is already Delivered
   * by the time it is billed, so it has to be discounted from the count —
   * otherwise the supplier's first delivery would look like its second and the
   * waiver would be off by one in the marketplace's favour.
   */
  private async countPriorCompletedWins(order: Order): Promise<number> {
    const delivered = await this.repo.countDeliveredOrdersBySupplier(
      order.supplierCompanyId
    );
    const excludingThisOrder =
      order.status === "delivered" ? delivered - 1 : delivered;
    return Math.max(0, excludingThisOrder);
  }

  /**
   * Marks an invoice Paid (Requirements 12.6, 12.7).
   *
   * Admin-only; a non-Admin is denied with an authorization error before the
   * invoice is read. Records the acting Admin's id and the timestamp, and is
   * one-way: an already-Paid invoice is returned untouched, so Payment_Status
   * never reverts to Unpaid and a double tap in the admin UI is not an error.
   *
   * The audit row (Requirement 14.6) is written only on the transition, so a
   * repeated tap does not stack identical entries claiming the same payment
   * twice.
   */
  async markInvoicePaid(
    ctx: AuthContext,
    invoiceId: string,
    now: Date = new Date()
  ): Promise<CommissionInvoice> {
    const admin = requireAction(ctx, "invoice.markPaid");
    const invoice = await this.requireInvoice(invoiceId);

    if (invoice.paymentStatus === "paid") return invoice;

    const paid = await this.repo.updateCommissionInvoice(invoice.id, {
      paymentStatus: "paid",
      paidByAdminId: admin.userId,
      paidAt: new Date(now.getTime()),
    });

    // Requirement 14.6 — the acting Admin, the invoice, and both statuses.
    await this.auditInvoicePaid(
      admin.userId,
      paid,
      invoice.paymentStatus,
      paid.paymentStatus,
      now
    );

    return paid;
  }

  /**
   * Appends the INVOICE_PAID entry (Requirement 14.6).
   *
   * Written after the payment state has landed and swallowed on failure, like
   * every other post-commit step: the invoice already reads Paid with the
   * acting Admin and timestamp on it, so an audit fault must not report a
   * failed mark-paid for a payment that is recorded. The row is reconstructible
   * from `paidByAdminId` / `paidAt`.
   */
  private async auditInvoicePaid(
    actorUserId: string,
    invoice: CommissionInvoice,
    priorStatus: CommissionInvoice["paymentStatus"],
    newStatus: CommissionInvoice["paymentStatus"],
    now: Date
  ): Promise<void> {
    if (!this.audit) return;

    try {
      await this.audit.invoicePaid(
        actorUserId,
        invoice,
        priorStatus,
        newStatus,
        now
      );
    } catch {
      // See above: recoverable from the invoice row, so never fatal.
    }
  }

  /**
   * Commission due, grouped by Supplier Company (Requirement 12.8). Admin-only.
   *
   * Paid invoices are excluded and companies with nothing outstanding are
   * omitted, so the report is exactly the collection list.
   */
  async commissionDue(ctx: AuthContext): Promise<CommissionDueReport> {
    requireAction(ctx, "commission.viewDue");

    const invoices = await this.repo.listCommissionInvoices();
    const totals = commissionDueBySupplier(invoices);

    const rows: CommissionDueRow[] = [];
    for (const [supplierCompanyId, amountDue] of totals) {
      const company = await this.repo.getCompany(supplierCompanyId);
      rows.push({
        supplierCompanyId,
        supplierCompanyName: company?.name ?? null,
        unpaidInvoiceCount: invoices.filter(
          (i) => i.supplierCompanyId === supplierCompanyId && isUnpaid(i)
        ).length,
        amountDue,
      });
    }

    return {
      rows: sortDueRows(rows),
      totalDue: roundToCents(
        rows.reduce((sum, row) => sum + row.amountDue, 0)
      ),
    };
  }

  /**
   * The invoices behind the commission-due report, newest first.
   *
   * The grouped report answers "who owes us how much"; mark-paid needs the
   * individual invoice ids, so the Admin surface reads both. Gated by the same
   * `commission.viewDue` policy row (Requirement 12.8) — it is the same
   * Admin-only view of the same rows, at a finer grain.
   */
  async listInvoices(
    ctx: AuthContext,
    options: { unpaidOnly?: boolean } = {}
  ): Promise<CommissionInvoiceRow[]> {
    requireAction(ctx, "commission.viewDue");

    const invoices = await this.repo.listCommissionInvoices();
    const selected = options.unpaidOnly ? invoices.filter(isUnpaid) : invoices;

    const rows: CommissionInvoiceRow[] = [];
    for (const invoice of selected) {
      const company = await this.repo.getCompany(invoice.supplierCompanyId);
      rows.push({
        ...invoice,
        supplierCompanyName: company?.name ?? null,
      });
    }

    return rows.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)
    );
  }

  /** One invoice, for an Admin read (no company scoping — Admins see all). */
  async getInvoiceByOrder(orderId: string): Promise<CommissionInvoice | null> {
    const id = typeof orderId === "string" ? orderId.trim() : "";
    return id === "" ? null : this.repo.getCommissionInvoiceByOrder(id);
  }

  /**
   * Resolves an invoice for an Admin write. A missing id is a validation error
   * on `invoiceId` rather than a 403: mark-paid is already Admin-only, so there
   * is no id to probe and the honest answer is more useful.
   */
  private async requireInvoice(invoiceId: string): Promise<CommissionInvoice> {
    const id = typeof invoiceId === "string" ? invoiceId.trim() : "";
    const invoice = id === "" ? null : await this.repo.getCommissionInvoice(id);
    if (!invoice) {
      throw new ValidationError(
        "INVOICE_NOT_FOUND",
        "No such commission invoice",
        "invoiceId"
      );
    }
    return invoice;
  }
}
