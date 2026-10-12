"use client";

import { useState } from "react";
import { interfaceForRole } from "@/services/authorization";
import { api, errorMessage } from "../_lib/api-client";
import type { SessionDto } from "../_lib/dto";

/**
 * Sign-in (Requirements 1.1, 1.2, 1.8).
 *
 * The identifier is the phone on the User row, or the email where one is on
 * file. The session itself comes back as an HTTP-only cookie the client cannot
 * read; all this screen learns is the role, which picks the surface to land on
 * through the same `interfaceForRole` the server uses.
 *
 * A full-page assignment rather than a client-side route change, so the next
 * paint is a server render that has already resolved the session.
 */
export function SignInForm() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session = await api.post<SessionDto>("/api/auth/login", {
        identifier,
        password,
      });
      window.location.assign(interfaceForRole(session.role).homePath);
    } catch (thrown) {
      setError(errorMessage(thrown));
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="identifier">Phone or email</label>
        <input
          id="identifier"
          name="identifier"
          type="text"
          inputMode="tel"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          required
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
        />
        <p className="hint" id="identifier-hint">
          Use the mobile number on your account, e.g. +16025551234.
        </p>
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
