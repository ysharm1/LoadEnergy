"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../_lib/api-client";
import type { OfferViewDto, RequestDto, WorkListDto } from "../_lib/dto";
import {
  ORDER_STATUS_LABELS,
  PRODUCT_LABELS,
  METHOD_LABELS,
  WINDOW_LABELS,
  eta,
  gallons,
  pin,
  pricePerGallon,
  shortTime,
  timeUntil,
} from "../_lib/format";

/**
 * The buyer work list (Requirements 3.9, 6.6, 7.4, 8.1, 9.1, 10.6).
 *
 * One screen: the Company's Open Requests with their quotes, and the Company's
 * Orders with the status of each. The quotes for a load are fetched when the
 * superintendent opens them rather than up front — on LTE, four extra requests
 * for loads nobody is looking at is four too many.
 *
 * Accept and Cancel both re-read the work list afterwards instead of patching
 * local state: acceptance moves the Request to Accepted, creates the Order, and
 * voids the sibling quotes server-side, and the only honest way to show that is
 * to ask the server what is true now.
 */
export function BuyerWorkList() {
  const [workList, setWorkList] = useState<WorkListDto | null>(null);
  const [quotes, setQuotes] = useState<Record<string, OfferViewDto[]>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setWorkList(await api.get<WorkListDto>("/api/requests"));
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function readQuotes(requestId: string) {
    setBusy(requestId);
    try {
      const body = await api.get<{ offers: OfferViewDto[] }>(
        `/api/requests/${requestId}/offers`
      );
      setQuotes((prior) => ({ ...prior, [requestId]: body.offers }));
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(null);
    }
  }

  async function toggleQuotes(requestId: string) {
    if (openId === requestId) {
      setOpenId(null);
      return;
    }
    setOpenId(requestId);
    await readQuotes(requestId);
  }

  async function accept(offer: OfferViewDto) {
    setBusy(offer.offerId);
    setNotice(null);
    try {
      await api.post(`/api/offers/${offer.offerId}/accept`);
      setNotice(`Accepted ${offer.supplierName}. The order is on its way.`);
      setError(null);
      setOpenId(null);
      await load();
    } catch (thrown) {
      setError(errorMessage(thrown));
      // A rejected tap means this load moved on; show what it looks like now.
      await readQuotes(offer.requestId);
    } finally {
      setBusy(null);
    }
  }

  async function cancel(request: RequestDto) {
    const confirmed = window.confirm(
      `Cancel this ${gallons(request.gallons)} load? Any live quotes are voided.`
    );
    if (!confirmed) return;

    setBusy(request.id);
    setNotice(null);
    try {
      await api.post(`/api/requests/${request.id}/cancel`);
      setNotice("Load cancelled.");
      setError(null);
      await load();
    } catch (thrown) {
      setError(errorMessage(thrown));
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!workList && !error) {
    return <p className="empty">Loading your loads…</p>;
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

      <Link href="/buyer/requests/new" className="btn btn-primary btn-block">
        New request
      </Link>

      <section className="stack" aria-labelledby="open-requests">
        <h2 id="open-requests">Open requests</h2>
        {workList && workList.requests.length === 0 ? (
          <p className="empty">
            No open loads. Post one and local suppliers get paged.
          </p>
        ) : null}

        <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {workList?.requests.map((request) => {
            const offers = quotes[request.id] ?? [];
            const expanded = openId === request.id;
            return (
              <li key={request.id} className="card">
                <div className="card-head">
                  <h3 className="card-title">
                    {gallons(request.gallons)} {PRODUCT_LABELS[request.productType]}
                  </h3>
                  <span className="badge badge-warn">Open</span>
                </div>

                <dl className="facts">
                  <dt>Method</dt>
                  <dd>{METHOD_LABELS[request.deliveryMethod]}</dd>
                  <dt>Window</dt>
                  <dd>
                    {WINDOW_LABELS[request.deliveryWindow]} · ends{" "}
                    {shortTime(request.windowEndsAt)}
                  </dd>
                  <dt>Pin</dt>
                  <dd>{pin(request.pinLat, request.pinLng)}</dd>
                  {request.notes ? (
                    <>
                      <dt>Notes</dt>
                      <dd>{request.notes}</dd>
                    </>
                  ) : null}
                </dl>

                <div className="row">
                  <button
                    type="button"
                    className="btn"
                    aria-expanded={expanded}
                    onClick={() => void toggleQuotes(request.id)}
                  >
                    {expanded ? "Hide quotes" : "Quotes"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy === request.id}
                    onClick={() => void cancel(request)}
                  >
                    Cancel load
                  </button>
                </div>

                {expanded ? (
                  <div className="stack">
                    <h4 className="sr-only">Quotes on this load</h4>
                    {busy === request.id && offers.length === 0 ? (
                      <p className="muted">Loading quotes…</p>
                    ) : null}
                    {offers.length === 0 && busy !== request.id ? (
                      <p className="empty">
                        No quotes yet. Suppliers in range have been paged.
                      </p>
                    ) : null}
                    {offers.map((offer) => (
                      <div key={offer.offerId} className="card">
                        <div className="card-head">
                          <h5 className="card-title">{offer.supplierName}</h5>
                          <span
                            className={
                              offer.isActive ? "badge badge-ok" : "badge badge-off"
                            }
                          >
                            {offer.isActive ? "Active" : "Expired"}
                          </span>
                        </div>
                        <dl className="facts">
                          <dt>Landed</dt>
                          <dd>{pricePerGallon(offer.landedPricePerGal)}</dd>
                          <dt>ETA</dt>
                          <dd>{eta(offer.etaMinutes)}</dd>
                          <dt>Hold</dt>
                          <dd>
                            {shortTime(offer.expiresAt)} ({timeUntil(offer.expiresAt)})
                          </dd>
                        </dl>
                        <button
                          type="button"
                          className="btn btn-primary btn-block"
                          disabled={!offer.isActive || busy === offer.offerId}
                          onClick={() => void accept(offer)}
                        >
                          {busy === offer.offerId
                            ? "Accepting…"
                            : `Accept ${pricePerGallon(offer.landedPricePerGal)}`}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="stack" aria-labelledby="orders">
        <h2 id="orders">Orders</h2>
        {workList && workList.orders.length === 0 ? (
          <p className="empty">No orders yet.</p>
        ) : null}
        <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {workList?.orders.map((order) => (
            <li key={order.id} className="card">
              <div className="card-head">
                <h3 className="card-title">
                  {ORDER_STATUS_LABELS[order.status]}
                </h3>
                <span
                  className={
                    order.status === "delivered"
                      ? "badge badge-ok"
                      : "badge badge-warn"
                  }
                >
                  {ORDER_STATUS_LABELS[order.status]}
                </span>
              </div>
              <p className="card-meta">
                Ordered {shortTime(order.createdAt)}
                {order.isConcierge ? " · entered by Load Energy" : ""}
              </p>
              <Link href={`/buyer/orders/${order.id}`} className="btn btn-block">
                Track order
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
