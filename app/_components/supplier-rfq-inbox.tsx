"use client";

import { useCallback, useEffect, useState } from "react";
import { MAX_HOLD_HOURS, MIN_HOLD_HOURS } from "@/domain/types";
import { api, errorMessage } from "../_lib/api-client";
import type { RequestDto } from "../_lib/dto";
import {
  METHOD_LABELS,
  PRODUCT_LABELS,
  WINDOW_LABELS,
  gallons,
  pin,
  pricePerGallon,
  shortTime,
} from "../_lib/format";

const HOLD_CHOICES = Array.from(
  { length: MAX_HOLD_HOURS - MIN_HOLD_HOURS + 1 },
  (_, index) => MIN_HOLD_HOURS + index
);

/**
 * The supplier RFQ inbox and quote box (Requirements 4.3, 6.1, 6.2).
 *
 * The inbox is exactly what the matching predicate admits for this Supplier
 * Company — Approved, Open or Limited, in radius, load still Open — so a
 * dispatcher never quotes something they are not eligible for, and a Closed
 * toggle empties this screen.
 *
 * The quote box asks for the landed price per gallon and the hold, and nothing
 * else: price floor, the inclusive 1-8 hour hold bound, and the supplier's own
 * approval and availability are the service's rules, and its rejections are
 * shown as returned.
 */
export function SupplierRfqInbox() {
  const [requests, setRequests] = useState<RequestDto[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [price, setPrice] = useState("");
  const [holdHours, setHoldHours] = useState(String(MIN_HOLD_HOURS + 1));
  const [etaMinutes, setEtaMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await api.get<{ requests: RequestDto[] }>("/api/rfqs");
      setRequests(body.requests);
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openQuoteBox(requestId: string) {
    setOpenId(openId === requestId ? null : requestId);
    setPrice("");
    setEtaMinutes("");
    setHoldHours(String(MIN_HOLD_HOURS + 1));
  }

  async function quote(request: RequestDto) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const body = await api.post<{ offer: { id: string; expiresAt: string } }>(
        "/api/offers",
        {
          requestId: request.id,
          landedPricePerGal: price.trim(),
          holdHours: holdHours,
          etaMinutes: etaMinutes.trim() === "" ? null : etaMinutes.trim(),
        }
      );
      setNotice(
        `Quote sent at ${pricePerGallon(Number(price))}, held until ${shortTime(
          body.offer.expiresAt
        )}.`
      );
      setOpenId(null);
      await load();
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  }

  if (!requests && !error) return <p className="empty">Loading RFQs…</p>;

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

      <button type="button" className="btn btn-block" onClick={() => void load()}>
        Refresh inbox
      </button>

      {requests && requests.length === 0 ? (
        <p className="empty">
          No live RFQs in range. Check your availability toggle and service
          radius if this looks wrong.
        </p>
      ) : null}

      <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {requests?.map((request) => (
          <li key={request.id} className="card">
            <div className="card-head">
              <h2 className="card-title">
                {gallons(request.gallons)} {PRODUCT_LABELS[request.productType]}
              </h2>
              <span className="badge badge-warn">
                {WINDOW_LABELS[request.deliveryWindow]}
              </span>
            </div>

            <dl className="facts">
              <dt>Method</dt>
              <dd>{METHOD_LABELS[request.deliveryMethod]}</dd>
              <dt>Window ends</dt>
              <dd>{shortTime(request.windowEndsAt)}</dd>
              <dt>Pin</dt>
              <dd>{pin(request.pinLat, request.pinLng)}</dd>
              {request.notes ? (
                <>
                  <dt>Notes</dt>
                  <dd>{request.notes}</dd>
                </>
              ) : null}
            </dl>

            <button
              type="button"
              className="btn btn-primary btn-block"
              aria-expanded={openId === request.id}
              onClick={() => openQuoteBox(request.id)}
            >
              {openId === request.id ? "Close quote box" : "Quote this load"}
            </button>

            {openId === request.id ? (
              <form
                className="form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void quote(request);
                }}
                noValidate
              >
                <div className="field">
                  <label htmlFor={`price-${request.id}`}>Landed $/gal</label>
                  <input
                    id={`price-${request.id}`}
                    type="number"
                    inputMode="decimal"
                    step="0.0001"
                    min="0"
                    required
                    placeholder="3.4750"
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                  />
                  <p className="hint">
                    All-in delivered price per gallon, taxes and fees included.
                  </p>
                </div>

                <div className="field">
                  <label htmlFor={`hold-${request.id}`}>Hold</label>
                  <select
                    id={`hold-${request.id}`}
                    value={holdHours}
                    onChange={(event) => setHoldHours(event.target.value)}
                  >
                    {HOLD_CHOICES.map((hours) => (
                      <option key={hours} value={String(hours)}>
                        {hours} {hours === 1 ? "hour" : "hours"}
                      </option>
                    ))}
                  </select>
                  <p className="hint">
                    How long you will honour this price ({MIN_HOLD_HOURS}-
                    {MAX_HOLD_HOURS} hours).
                  </p>
                </div>

                <div className="field">
                  <label htmlFor={`eta-${request.id}`}>ETA minutes (optional)</label>
                  <input
                    id={`eta-${request.id}`}
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    value={etaMinutes}
                    onChange={(event) => setEtaMinutes(event.target.value)}
                  />
                </div>

                <button
                  type="submit"
                  className="btn btn-primary btn-block"
                  disabled={busy}
                >
                  {busy ? "Sending quote…" : "Send quote"}
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
