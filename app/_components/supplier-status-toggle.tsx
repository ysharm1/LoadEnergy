"use client";

import { useEffect, useState } from "react";
import { SUPPLIER_STATUSES, type SupplierStatus } from "@/domain/types";
import { api, errorMessage } from "../_lib/api-client";
import type { CompanyDto } from "../_lib/dto";
import { SUPPLIER_STATUS_HINTS, SUPPLIER_STATUS_LABELS } from "../_lib/format";

/**
 * The Supplier_Status toggle (Requirements 5.1, 5.2).
 *
 * Writes on tap, with no save step: a dispatcher closing mid-shift needs it to
 * take effect on the next match evaluation, and the service persists the new
 * value immediately. The Company is taken from the session server-side, so
 * this screen cannot move anybody else's availability.
 */
export function SupplierStatusToggle() {
  const [status, setStatus] = useState<SupplierStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const body = await api.get<{ supplierStatus: SupplierStatus }>(
          "/api/supplier/status"
        );
        setStatus(body.supplierStatus);
      } catch (thrown) {
        setError(errorMessage(thrown));
      }
    })();
  }, []);

  async function choose(next: SupplierStatus) {
    const previous = status;
    setStatus(next);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await api.put<{ company: CompanyDto; supplierStatus: SupplierStatus | null }>(
        "/api/supplier/status",
        { supplierStatus: next }
      );
      setStatus(body.supplierStatus ?? next);
      setNotice(`Availability saved: ${SUPPLIER_STATUS_LABELS[next]}.`);
    } catch (thrown) {
      // Roll back to what the server still believes.
      setStatus(previous);
      setError(errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  }

  if (!status && !error) return <p className="empty">Loading availability…</p>;

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

      <fieldset className="options" disabled={busy}>
        <legend>Availability</legend>
        {SUPPLIER_STATUSES.map((value) => (
          <label className="option" key={value}>
            <input
              type="radio"
              name="supplierStatus"
              value={value}
              checked={status === value}
              onChange={() => void choose(value)}
            />
            <span>
              <strong>{SUPPLIER_STATUS_LABELS[value]}</strong>
              <br />
              <span className="muted">{SUPPLIER_STATUS_HINTS[value]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <p className="hint">
        Approval is separate: an Admin approves the company, you control whether
        RFQs reach you.
      </p>
    </div>
  );
}
