"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../_lib/api-client";
import type { SiteDto } from "../_lib/dto";
import { pin } from "../_lib/format";

/**
 * The Company's saved jobsites (Requirements 2.1, 2.3).
 *
 * A convenience list beside the work list: the pin on a Request is entered on
 * the New Request form, so nothing here is on the critical path for posting a
 * load. Coordinate range is the service's rule (Requirement 2.4) and its error
 * is shown as returned.
 */
export function BuyerSites() {
  const [sites, setSites] = useState<SiteDto[] | null>(null);
  const [name, setName] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await api.get<{ sites: SiteDto[] }>("/api/sites");
      setSites(body.sites);
      setError(null);
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
    try {
      await api.post("/api/sites", {
        name: name.trim(),
        lat: lat.trim(),
        lng: lng.trim(),
      });
      setName("");
      setLat("");
      setLng("");
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

      <form className="form card" onSubmit={submit} noValidate>
        <h2 className="card-title">Add a site</h2>
        <div className="field">
          <label htmlFor="site-name">Site name</label>
          <input
            id="site-name"
            type="text"
            required
            value={name}
            placeholder="Loop 303 yard"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="pair">
          <div className="field">
            <label htmlFor="site-lat">Latitude</label>
            <input
              id="site-lat"
              type="number"
              inputMode="decimal"
              step="any"
              required
              value={lat}
              onChange={(event) => setLat(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="site-lng">Longitude</label>
            <input
              id="site-lng"
              type="number"
              inputMode="decimal"
              step="any"
              required
              value={lng}
              onChange={(event) => setLng(event.target.value)}
            />
          </div>
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Saving…" : "Save site"}
        </button>
      </form>

      <section className="stack" aria-labelledby="site-list">
        <h2 id="site-list">Saved sites</h2>
        {sites && sites.length === 0 ? (
          <p className="empty">No sites saved yet.</p>
        ) : null}
        <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {sites?.map((site) => (
            <li key={site.id} className="card">
              <h3 className="card-title">{site.name}</h3>
              <p className="card-meta">{pin(site.lat, site.lng)}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
