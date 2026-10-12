"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../_lib/api-client";
import type { CompanyDto, CompanyRosterDto } from "../_lib/dto";
import { SUPPLIER_STATUS_LABELS, pin } from "../_lib/format";

/**
 * Supplier approval and matching configuration (Requirements 16.2, 16.4,
 * 16.5).
 *
 * The three Admin-set fields that decide who sees an RFQ live on one card per
 * company: approval, the Operating_Location that matching measures from, and
 * the Service_Radius it measures against. A non-positive radius is rejected by
 * the service (Requirement 16.6) and its message is shown inline.
 *
 * License verification is deliberately absent — it is an offline ADOT check an
 * Admin performs before tapping Approve.
 */
export function AdminSuppliers() {
  const [suppliers, setSuppliers] = useState<CompanyDto[] | null>(null);
  const [edits, setEdits] = useState<
    Record<string, { lat: string; lng: string; radius: string }>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const roster = await api.get<CompanyRosterDto>("/api/admin/companies");
      setSuppliers(roster.suppliers);
      setEdits(
        Object.fromEntries(
          roster.suppliers.map((company) => [
            company.id,
            {
              lat: company.operatingLat == null ? "" : String(company.operatingLat),
              lng: company.operatingLng == null ? "" : String(company.operatingLng),
              radius:
                company.serviceRadiusMiles == null
                  ? ""
                  : String(company.serviceRadiusMiles),
            },
          ])
        )
      );
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(
    id: string,
    patch: Partial<{ lat: string; lng: string; radius: string }>
  ) {
    setEdits((prior) => {
      const current = prior[id] ?? { lat: "", lng: "", radius: "" };
      return { ...prior, [id]: { ...current, ...patch } };
    });
  }

  async function run(id: string, work: () => Promise<void>, message: string) {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(message);
      await load();
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(null);
    }
  }

  if (!suppliers && !error) return <p className="empty">Loading suppliers…</p>;

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

      {suppliers && suppliers.length === 0 ? (
        <p className="empty">No supplier companies yet.</p>
      ) : null}

      <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {suppliers?.map((company) => {
          const draft = edits[company.id] ?? { lat: "", lng: "", radius: "" };
          const approved = company.supplierApprovalStatus === "approved";
          return (
            <li key={company.id} className="card">
              <div className="card-head">
                <h2 className="card-title">{company.name}</h2>
                <span className={approved ? "badge badge-ok" : "badge badge-warn"}>
                  {approved ? "Approved" : "Pending"}
                </span>
              </div>

              <dl className="facts">
                <dt>Availability</dt>
                <dd>
                  {company.supplierStatus
                    ? SUPPLIER_STATUS_LABELS[company.supplierStatus]
                    : "Unknown"}
                </dd>
                <dt>Operating pin</dt>
                <dd>
                  {company.operatingLat != null && company.operatingLng != null
                    ? pin(company.operatingLat, company.operatingLng)
                    : "Not set"}
                </dd>
                <dt>Radius</dt>
                <dd>
                  {company.serviceRadiusMiles == null
                    ? "Not set"
                    : `${company.serviceRadiusMiles} mi`}
                </dd>
              </dl>

              {approved ? null : (
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  disabled={busy === company.id}
                  onClick={() =>
                    void run(
                      company.id,
                      async () => {
                        await api.post(
                          `/api/admin/suppliers/${company.id}/approve`
                        );
                      },
                      `${company.name} approved.`
                    )
                  }
                >
                  Approve supplier
                </button>
              )}

              <form
                className="form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(
                    company.id,
                    async () => {
                      await api.put(
                        `/api/admin/suppliers/${company.id}/operating-location`,
                        { lat: draft.lat.trim(), lng: draft.lng.trim() }
                      );
                    },
                    `Operating location saved for ${company.name}.`
                  );
                }}
                noValidate
              >
                <div className="pair">
                  <div className="field">
                    <label htmlFor={`lat-${company.id}`}>Operating latitude</label>
                    <input
                      id={`lat-${company.id}`}
                      type="number"
                      inputMode="decimal"
                      step="any"
                      required
                      value={draft.lat}
                      onChange={(event) =>
                        edit(company.id, { lat: event.target.value })
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`lng-${company.id}`}>Operating longitude</label>
                    <input
                      id={`lng-${company.id}`}
                      type="number"
                      inputMode="decimal"
                      step="any"
                      required
                      value={draft.lng}
                      onChange={(event) =>
                        edit(company.id, { lng: event.target.value })
                      }
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  className="btn btn-block"
                  disabled={busy === company.id}
                >
                  Save operating location
                </button>
              </form>

              <form
                className="form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(
                    company.id,
                    async () => {
                      await api.put(
                        `/api/admin/suppliers/${company.id}/service-radius`,
                        { serviceRadiusMiles: draft.radius.trim() }
                      );
                    },
                    `Service radius saved for ${company.name}.`
                  );
                }}
                noValidate
              >
                <div className="field">
                  <label htmlFor={`radius-${company.id}`}>
                    Service radius (miles)
                  </label>
                  <input
                    id={`radius-${company.id}`}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    required
                    value={draft.radius}
                    onChange={(event) =>
                      edit(company.id, { radius: event.target.value })
                    }
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-block"
                  disabled={busy === company.id}
                >
                  Save radius
                </button>
              </form>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
