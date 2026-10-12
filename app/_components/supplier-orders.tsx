"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../_lib/api-client";
import type { OrderDto } from "../_lib/dto";
import { ORDER_STATUS_LABELS, shortTime } from "../_lib/format";

/**
 * Won orders, the en-route mark, and the delivery form (Requirements 8.7,
 * 10.2, 11.1, 11.6).
 *
 * The state machine is forward-only server-side, so this screen offers the one
 * move an order actually has: Mark en route while it is Accepted, and the BOL
 * form until a Delivery is on file. Recording a Delivery is permitted straight
 * from Accepted, so the form is available without marking en route first — a
 * driver who forgot to tap should not be blocked at the tank.
 *
 * The ticket photo is corroboration, not a precondition (Requirement 11.6):
 * the form posts as multipart when a photo is attached, and the response says
 * whether the photo landed. A failed upload still records the gallons and the
 * ticket number, and the screen says so rather than implying the delivery
 * failed.
 */
export function SupplierOrders() {
  const [orders, setOrders] = useState<OrderDto[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [bolGallons, setBolGallons] = useState("");
  const [ticketNumber, setTicketNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const photoRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await api.get<{ orders: OrderDto[] }>("/api/orders");
      setOrders(body.orders);
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function markEnRoute(order: OrderDto) {
    setBusy(order.id);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/api/orders/${order.id}/status`, { status: "en_route" });
      setNotice("Marked en route. The buyer can see it.");
      await load();
    } catch (thrown) {
      setError(errorMessage(thrown));
      await load();
    } finally {
      setBusy(null);
    }
  }

  function openDeliveryForm(orderId: string) {
    setOpenId(openId === orderId ? null : orderId);
    setBolGallons("");
    setTicketNumber("");
    if (photoRef.current) photoRef.current.value = "";
  }

  async function recordDelivery(order: OrderDto) {
    setBusy(order.id);
    setError(null);
    setNotice(null);

    const photo = photoRef.current?.files?.[0] ?? null;
    try {
      let stored: { ticketPhotoStored: boolean };
      if (photo) {
        const form = new FormData();
        form.set("bolGallons", bolGallons.trim());
        form.set("ticketNumber", ticketNumber.trim());
        form.set("photo", photo);
        stored = await api.post<{ ticketPhotoStored: boolean }>(
          `/api/orders/${order.id}/delivery`,
          form
        );
      } else {
        stored = await api.post<{ ticketPhotoStored: boolean }>(
          `/api/orders/${order.id}/delivery`,
          {
            bolGallons: bolGallons.trim(),
            ticketNumber: ticketNumber.trim(),
          }
        );
      }

      setNotice(
        photo && !stored.ticketPhotoStored
          ? "Delivery recorded. The ticket photo did not upload — gallons and ticket number are saved."
          : "Delivery recorded."
      );
      setOpenId(null);
      await load();
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(null);
    }
  }

  if (!orders && !error) return <p className="empty">Loading won orders…</p>;

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

      {orders && orders.length === 0 ? (
        <p className="empty">No won orders yet.</p>
      ) : null}

      <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {orders?.map((order) => (
          <li key={order.id} className="card">
            <div className="card-head">
              <h2 className="card-title">{ORDER_STATUS_LABELS[order.status]}</h2>
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
            <p className="card-meta">Won {shortTime(order.createdAt)}</p>

            {order.status === "accepted" ? (
              <button
                type="button"
                className="btn btn-block"
                disabled={busy === order.id}
                onClick={() => void markEnRoute(order)}
              >
                {busy === order.id ? "Saving…" : "Mark en route"}
              </button>
            ) : null}

            {order.status !== "delivered" ? (
              <button
                type="button"
                className="btn btn-primary btn-block"
                aria-expanded={openId === order.id}
                onClick={() => openDeliveryForm(order.id)}
              >
                {openId === order.id ? "Close BOL form" : "Record delivery"}
              </button>
            ) : null}

            {openId === order.id ? (
              <form
                className="form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void recordDelivery(order);
                }}
                noValidate
              >
                <div className="field">
                  <label htmlFor={`bol-${order.id}`}>BOL gallons</label>
                  <input
                    id={`bol-${order.id}`}
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    required
                    value={bolGallons}
                    onChange={(event) => setBolGallons(event.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor={`ticket-${order.id}`}>Ticket number</label>
                  <input
                    id={`ticket-${order.id}`}
                    type="text"
                    required
                    autoCapitalize="characters"
                    spellCheck={false}
                    value={ticketNumber}
                    onChange={(event) => setTicketNumber(event.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor={`photo-${order.id}`}>
                    Ticket photo (optional)
                  </label>
                  <input
                    id={`photo-${order.id}`}
                    ref={photoRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                  />
                  <p className="hint">
                    A photo is corroboration only — the delivery records without
                    it.
                  </p>
                </div>

                <button
                  type="submit"
                  className="btn btn-primary btn-block"
                  disabled={busy === order.id}
                >
                  {busy === order.id ? "Recording…" : "Record delivery"}
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
