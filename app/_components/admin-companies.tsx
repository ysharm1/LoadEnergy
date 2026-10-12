"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../_lib/api-client";
import type { CompanyDto, CompanyRosterDto } from "../_lib/dto";

/**
 * Company onboarding (Requirements 1.3, 16.1).
 *
 * The first screen of the two-sided pilot: an Admin names a company and says
 * which side of the market it sits on. A Supplier Company lands Pending and
 * closed (Requirement 16.1), so the Suppliers screen is the next stop — the
 * notice says so rather than leaving the Admin to guess why no RFQs arrive.
 *
 * Validation stays on the server: a blank name or an unknown kind comes back
 * as the service's own message and is rendered inline.
 */
export function AdminCompanies() {
  const [roster, setRoster] = useState<CompanyRosterDto | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CompanyDto["kind"]>("buyer");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRoster(await api.get<CompanyRosterDto>("/api/admin/companies"));
    } catch (thrown) {
      setError(errorMessage(thrown));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await api.post<{ company: CompanyDto }>(
        "/api/admin/companies",
        { name: name.trim(), kind }
      );
      setNotice(
        body.company.kind === "supplier"
          ? `${body.company.name} created. It is pending approval — approve it and set its operating pin and radius on Suppliers.`
          : `${body.company.name} created. Add a buyer user on New user.`
      );
      setName("");
      await load();
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  }

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
          <label htmlFor="companyName">Company name</label>
          <input
            id="companyName"
            name="name"
            type="text"
            autoComplete="organization"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <fieldset className="options">
          <legend>Side of the market</legend>
          <label className="option" htmlFor="kind-buyer">
            <input
              id="kind-buyer"
              type="radio"
              name="kind"
              value="buyer"
              checked={kind === "buyer"}
              onChange={() => setKind("buyer")}
            />
            Buyer — posts loads
          </label>
          <label className="option" htmlFor="kind-supplier">
            <input
              id="kind-supplier"
              type="radio"
              name="kind"
              value="supplier"
              checked={kind === "supplier"}
              onChange={() => setKind("supplier")}
            />
            Supplier — quotes and delivers
          </label>
        </fieldset>

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Creating…" : "Create company"}
        </button>
      </form>

      <section className="stack" aria-labelledby="roster-heading">
        <h2 id="roster-heading" className="card-title">
          Companies on the pilot
        </h2>
        {roster == null ? (
          <p className="empty">Loading companies…</p>
        ) : roster.buyers.length + roster.suppliers.length === 0 ? (
          <p className="empty">No companies yet.</p>
        ) : (
          <ul
            className="stack"
            style={{ listStyle: "none", margin: 0, padding: 0 }}
          >
            {[...roster.buyers, ...roster.suppliers].map((company) => (
              <li key={company.id} className="card">
                <div className="card-head">
                  <h3 className="card-title">{company.name}</h3>
                  <span className="badge">
                    {company.kind === "buyer" ? "Buyer" : "Supplier"}
                  </span>
                </div>
                {company.kind === "supplier" ? (
                  <p className="card-meta">
                    {company.supplierApprovalStatus === "approved"
                      ? "Approved"
                      : "Pending approval"}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
