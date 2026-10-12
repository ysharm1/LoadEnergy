"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "../_lib/api-client";
import type { CompanyDto, CompanyRosterDto, OrderDto } from "../_lib/dto";

/**
 * Concierge order entry (Requirements 17.1, 17.2).
 *
 * A deal arranged over the phone, written down after the fact: the Order lands
 * Delivered with its Delivery, and the same commission path runs as for an
 * in-app win, waived wins included. The ticket number is optional because a
 * phone deal may not have one on file.
 */
export function AdminConcierge() {
  const [roster, setRoster] = useState<CompanyRosterDto | null>(null);
  const [buyerCompanyId, setBuyerCompanyId] = useState("");
  const [supplierCompanyId, setSupplierCompanyId] = useState("");
  const [bolGallons, setBolGallons] = useState("");
  const [ticketNumber, setTicketNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setRoster(await api.get<CompanyRosterDto>("/api/admin/companies"));
      } catch (thrown) {
        setError(errorMessage(thrown));
      }
    })();
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await api.post<{ order: OrderDto }>(
        "/api/admin/concierge-orders",
        {
          buyerCompanyId,
          supplierCompanyId,
          bolGallons: bolGallons.trim(),
          ticketNumber: ticketNumber.trim() === "" ? null : ticketNumber.trim(),
        }
      );
      setNotice(
        `Concierge order recorded as delivered. Commission invoice generated for order ${body.order.id}.`
      );
      setBolGallons("");
      setTicketNumber("");
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  }

  const options = (companies: CompanyDto[]) =>
    companies.map((company) => (
      <option key={company.id} value={company.id}>
        {company.name}
      </option>
    ));

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

      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="buyerCompanyId">Buyer company</label>
          <select
            id="buyerCompanyId"
            required
            value={buyerCompanyId}
            onChange={(event) => setBuyerCompanyId(event.target.value)}
          >
            <option value="">Select a buyer…</option>
            {roster ? options(roster.buyers) : null}
          </select>
        </div>

        <div className="field">
          <label htmlFor="supplierCompanyId">Winning supplier company</label>
          <select
            id="supplierCompanyId"
            required
            value={supplierCompanyId}
            onChange={(event) => setSupplierCompanyId(event.target.value)}
          >
            <option value="">Select a supplier…</option>
            {roster ? options(roster.suppliers) : null}
          </select>
          <p className="hint">This company gets the commission invoice.</p>
        </div>

        <div className="field">
          <label htmlFor="conciergeGallons">BOL gallons</label>
          <input
            id="conciergeGallons"
            type="number"
            inputMode="numeric"
            min="1"
            step="1"
            required
            value={bolGallons}
            onChange={(event) => setBolGallons(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="conciergeTicket">Ticket number (optional)</label>
          <input
            id="conciergeTicket"
            type="text"
            autoCapitalize="characters"
            spellCheck={false}
            value={ticketNumber}
            onChange={(event) => setTicketNumber(event.target.value)}
          />
        </div>

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Recording…" : "Record concierge order"}
        </button>
      </form>
    </div>
  );
}
