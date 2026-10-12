"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../_lib/api-client";
import type { GeofenceDto } from "../_lib/dto";
import { shortTime } from "../_lib/format";

/**
 * The Pilot_Geofence editor (Requirement 16.7).
 *
 * One bounding box for the whole pilot: saving it replaces the current box and
 * applies to newly created Requests, so a pin outside it is refused at posting
 * time with the box attached to the error. Bounds ordering and coordinate range
 * are the service's rules.
 */
export function AdminGeofence() {
  const [fence, setFence] = useState<GeofenceDto | null>(null);
  const [draft, setDraft] = useState({
    minLat: "",
    maxLat: "",
    minLng: "",
    maxLng: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await api.get<{ geofence: GeofenceDto | null }>(
        "/api/admin/geofence"
      );
      setFence(body.geofence);
      if (body.geofence) {
        setDraft({
          minLat: String(body.geofence.minLat),
          maxLat: String(body.geofence.maxLat),
          minLng: String(body.geofence.minLng),
          maxLng: String(body.geofence.maxLng),
        });
      }
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setLoaded(true);
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
      await api.put("/api/admin/geofence", {
        minLat: draft.minLat.trim(),
        maxLat: draft.maxLat.trim(),
        minLng: draft.minLng.trim(),
        maxLng: draft.maxLng.trim(),
      });
      setNotice("Pilot geofence saved. New requests are checked against it.");
      await load();
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <p className="empty">Loading geofence…</p>;

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
        <h2 className="card-title">Current box</h2>
        {fence ? (
          <dl className="facts">
            <dt>Latitude</dt>
            <dd>
              {fence.minLat} to {fence.maxLat}
            </dd>
            <dt>Longitude</dt>
            <dd>
              {fence.minLng} to {fence.maxLng}
            </dd>
            <dt>Updated</dt>
            <dd>{shortTime(fence.updatedAt)}</dd>
          </dl>
        ) : (
          <p className="card-meta">
            No geofence set. Requests cannot be posted until one exists.
          </p>
        )}
      </div>

      <form className="form" onSubmit={submit} noValidate>
        <div className="pair">
          <div className="field">
            <label htmlFor="minLat">Min latitude</label>
            <input
              id="minLat"
              type="number"
              inputMode="decimal"
              step="any"
              required
              value={draft.minLat}
              onChange={(event) =>
                setDraft({ ...draft, minLat: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="maxLat">Max latitude</label>
            <input
              id="maxLat"
              type="number"
              inputMode="decimal"
              step="any"
              required
              value={draft.maxLat}
              onChange={(event) =>
                setDraft({ ...draft, maxLat: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="minLng">Min longitude</label>
            <input
              id="minLng"
              type="number"
              inputMode="decimal"
              step="any"
              required
              value={draft.minLng}
              onChange={(event) =>
                setDraft({ ...draft, minLng: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="maxLng">Max longitude</label>
            <input
              id="maxLng"
              type="number"
              inputMode="decimal"
              step="any"
              required
              value={draft.maxLng}
              onChange={(event) =>
                setDraft({ ...draft, maxLng: event.target.value })
              }
            />
          </div>
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Saving…" : "Save geofence"}
        </button>
      </form>
    </div>
  );
}
