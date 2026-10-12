"use client";

import { useState } from "react";
import { api } from "../_lib/api-client";

/**
 * Ends the session server-side (the cookie is HTTP-only, so the client cannot
 * clear it itself) and reloads onto sign-in.
 */
export function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await api.post("/api/auth/logout");
    } catch {
      // The route clears the cookie on the failure path too, so landing on
      // sign-in is the right move either way.
    }
    window.location.assign("/");
  }

  return (
    <button type="button" className="btn" onClick={signOut} disabled={busy}>
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
