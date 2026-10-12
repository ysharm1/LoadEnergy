"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../_lib/api-client";
import type { OrderViewDto } from "../_lib/dto";
import { ORDER_STATUS_LABELS, gallons, shortTime } from "../_lib/format";

const STEPS = ["accepted", "en_route", "delivered"] as const;

/**
 * The order status view (Requirement 10.6).
 *
 * Shows the status produced by the last valid transition, with the forward-only
 * sequence drawn out so a superintendent can see where the load sits, plus the
 * BOL once a Delivery is recorded (Requirements 11.1-11.3).
 *
 * Read-only on purpose: advancing status and recording the BOL belong to the
 * winning Supplier Company, and the API would deny a Buyer either way.
 */
export function OrderStatus({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<OrderViewDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await api.get<{ order: OrderViewDto }>(
        `/api/orders/${orderId}`
      );
      setOrder(body.order);
      setError(null);
    } catch (thrown) {
      setError(errorMessage(thrown));
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }
  if (!order) return <p className="empty">Loading order…</p>;

  const reached = STEPS.indexOf(order.status);

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2 className="card-title">{ORDER_STATUS_LABELS[order.status]}</h2>
          <span
            className={
              order.status === "delivered" ? "badge badge-ok" : "badge badge-warn"
            }
          >
            {ORDER_STATUS_LABELS[order.status]}
          </span>
        </div>

        <ol className="stack" style={{ margin: 0, paddingLeft: "1.25rem" }}>
          {STEPS.map((step, index) => (
            <li key={step} className={index <= reached ? undefined : "muted"}>
              {ORDER_STATUS_LABELS[step]}
              {index <= reached ? " ✓" : ""}
            </li>
          ))}
        </ol>

        <dl className="facts">
          <dt>Ordered</dt>
          <dd>{shortTime(order.createdAt)}</dd>
          {order.isConcierge ? (
            <>
              <dt>Entered</dt>
              <dd>By Load Energy on your behalf</dd>
            </>
          ) : null}
        </dl>

        <button type="button" className="btn btn-block" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {order.delivery ? (
        <div className="card">
          <h2 className="card-title">Delivered</h2>
          <dl className="facts">
            <dt>BOL gallons</dt>
            <dd>{gallons(order.delivery.bolGallons)}</dd>
            <dt>Ticket</dt>
            <dd>{order.delivery.ticketNumber ?? "Not on file"}</dd>
            <dt>Delivered</dt>
            <dd>{shortTime(order.delivery.deliveredAt)}</dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
