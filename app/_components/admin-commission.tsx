"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../_lib/api-client";
import type { CommissionDueDto, InvoiceDto } from "../_lib/dto";
import { dollars, gallons, shortTime } from "../_lib/format";

/**
 * Commission due and mark-paid (Requirements 12.6, 12.8).
 *
 * The totals are the report the service produces — Unpaid amounts grouped by
 * Supplier Company — and the invoices under each heading are the rows behind
 * that total, which is where mark-paid gets its id. Waived $0 invoices appear
 * until they are marked paid: they are genuinely unpaid paperwork.
 *
 * Mark-paid is one-way server-side, so a double tap is harmless.
 */
export function AdminCommission() {
  const [due, setDue] = useState<CommissionDueDto | null>(null);
  const [invoices, setInvoices] = useState<InvoiceDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [report, unpaid] = await Promise.all([
        api.get<CommissionDueDto>("/api/admin/commission-due"),
        api.get<{ invoices: InvoiceDto[] }>("/api/admin/invoices?unpaid=1"),
      ]);
      setDue(report);
      setInvoices(unpaid.invoices);
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function markPaid(invoice: InvoiceDto) {
    setBusy(invoice.id);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/api/admin/invoices/${invoice.id}/mark-paid`);
      setNotice(`Marked ${dollars(invoice.amount)} paid.`);
      await load();
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(null);
    }
  }

  if (!due && !error) return <p className="empty">Loading commission…</p>;

  return (
    <div className="stack">
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Total due</h2>
          <span className="badge badge-warn">{dollars(due?.totalDue ?? 0)}</span>
        </div>
        <button type="button" className="btn btn-block" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {due && due.rows.length === 0 ? (
        <p className="empty">Nothing outstanding.</p>
      ) : null}

      {due?.rows.map((row) => {
        const supplierInvoices = invoices.filter(
          (invoice) => invoice.supplierCompanyId === row.supplierCompanyId
        );
        return (
          <section className="card" key={row.supplierCompanyId}>
            <div className="card-head">
              <h2 className="card-title">
                {row.supplierCompanyName ?? row.supplierCompanyId}
              </h2>
              <span className="badge badge-warn">{dollars(row.amountDue)}</span>
            </div>
            <p className="card-meta">
              {row.unpaidInvoiceCount}{" "}
              {row.unpaidInvoiceCount === 1 ? "unpaid invoice" : "unpaid invoices"}
            </p>

            <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {supplierInvoices.map((invoice) => (
                <li key={invoice.id} className="card">
                  <div className="card-head">
                    <h3 className="card-title">{dollars(invoice.amount)}</h3>
                    {invoice.waived ? (
                      <span className="badge">Waived win</span>
                    ) : null}
                  </div>
                  <dl className="facts">
                    <dt>Gallons</dt>
                    <dd>{gallons(invoice.bolGallons)}</dd>
                    <dt>Order</dt>
                    <dd>{invoice.orderId}</dd>
                    <dt>Raised</dt>
                    <dd>{shortTime(invoice.createdAt)}</dd>
                  </dl>
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    disabled={busy === invoice.id}
                    onClick={() => void markPaid(invoice)}
                  >
                    {busy === invoice.id ? "Recording…" : "Mark paid"}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
