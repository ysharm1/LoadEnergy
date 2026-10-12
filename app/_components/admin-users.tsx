"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "../_lib/api-client";
import type { CompanyDto, CompanyRosterDto, UserDto } from "../_lib/dto";

const ROLE_OPTIONS = [
  { value: "buyer", label: "Buyer" },
  { value: "supplier", label: "Supplier" },
  { value: "admin", label: "Admin" },
] as const;

/**
 * User onboarding (Requirements 1.3-1.7).
 *
 * One User, one Company (Requirement 1.3), one role (Requirement 1.4). The
 * phone number is the sign-in identifier and is required (Requirements 1.5,
 * 1.6); email is optional (Requirement 1.7). Shape checks live in the service,
 * so a malformed number comes back with the server's own message — the field
 * hint tells the Admin the expected form up front instead.
 *
 * The password is set here because the pilot has no invite flow: an Admin hands
 * it over out of band and the driver signs in with their phone number.
 */
export function AdminUsers() {
  const [roster, setRoster] = useState<CompanyRosterDto | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [role, setRole] = useState<UserDto["role"]>("buyer");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      const body = await api.post<{ user: UserDto }>("/api/admin/users", {
        companyId,
        role,
        phone: phone.trim(),
        email: email.trim() === "" ? null : email.trim(),
        password,
      });
      setNotice(
        `User created. They sign in with ${body.user.phone} and the password you set.`
      );
      setPhone("");
      setEmail("");
      setPassword("");
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  }

  const group = (label: string, companies: CompanyDto[]) =>
    companies.length === 0 ? null : (
      <optgroup key={label} label={label}>
        {companies.map((company) => (
          <option key={company.id} value={company.id}>
            {company.name}
          </option>
        ))}
      </optgroup>
    );

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
          <label htmlFor="userCompanyId">Company</label>
          <select
            id="userCompanyId"
            name="companyId"
            required
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
          >
            <option value="">Select a company…</option>
            {roster ? group("Buyers", roster.buyers) : null}
            {roster ? group("Suppliers", roster.suppliers) : null}
          </select>
          <p className="hint">A user belongs to exactly one company.</p>
        </div>

        <div className="field">
          <label htmlFor="userRole">Role</label>
          <select
            id="userRole"
            name="role"
            required
            value={role}
            onChange={(event) => setRole(event.target.value as UserDto["role"])}
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="hint">The role decides which screens they get.</p>
        </div>

        <div className="field">
          <label htmlFor="userPhone">Phone number</label>
          <input
            id="userPhone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
          <p className="hint">
            E.164 form, e.g. +16025550134. This is how they sign in.
          </p>
        </div>

        <div className="field">
          <label htmlFor="userEmail">Email (optional)</label>
          <input
            id="userEmail"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="userPassword">Temporary password</label>
          <input
            id="userPassword"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p className="hint">Hand this over out of band. It is stored hashed.</p>
        </div>

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Creating…" : "Create user"}
        </button>
      </form>
    </div>
  );
}
