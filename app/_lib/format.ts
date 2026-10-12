/**
 * Field-readable labels for the domain enums, plus the few number and time
 * formats the screens share.
 *
 * Kept here rather than inline so a superintendent, a dispatcher, and an admin
 * all read the same word for the same stored value.
 */

import type {
  DeliveryMethod,
  DeliveryWindow,
  OrderStatus,
  ProductType,
  RequestStatus,
  SupplierStatus,
} from "@/domain/types";

export const PRODUCT_LABELS: Record<ProductType, string> = {
  ulsd: "Clear ULSD",
  dyed: "Dyed off-road",
};

export const METHOD_LABELS: Record<DeliveryMethod, string> = {
  wet_hose: "Wet hose (fuel equipment)",
  yard_tank: "Yard tank fill",
};

export const WINDOW_LABELS: Record<DeliveryWindow, string> = {
  today: "Today",
  tomorrow_am: "Tomorrow AM",
};

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  open: "Open",
  accepted: "Accepted",
  cancelled: "Cancelled",
  expired: "Expired",
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  accepted: "Accepted",
  en_route: "En route",
  delivered: "Delivered",
};

export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = {
  open: "Open",
  limited: "Limited",
  closed: "Closed",
};

export const SUPPLIER_STATUS_HINTS: Record<SupplierStatus, string> = {
  open: "Taking RFQs normally.",
  limited: "Still receiving RFQs — quote only what you can cover.",
  closed: "No new RFQs reach you while Closed.",
};

/** `$3.4750/gal` — landed price, to the ten-thousandth of a dollar. */
export function pricePerGallon(value: number): string {
  return `$${value.toFixed(4)}/gal`;
}

/** `$1,234.56` — invoice and commission amounts. */
export function dollars(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** `2,500 gal` */
export function gallons(value: number): string {
  return `${value.toLocaleString("en-US")} gal`;
}

/** `4.6480, -112.2010` — a pin, at the precision the API stores. */
export function pin(lat: number, lng: number): string {
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

/** `Mar 1, 2:45 PM` — short local time, which is all a field screen needs. */
export function shortTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** `in 42 min` / `in 3 h 10 m` / `expired` — how long a hold has left. */
export function timeUntil(value: string | Date, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const minutes = Math.floor((date.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return "expired";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours} h ${minutes % 60} m`;
}

/** `35 min ETA` / `ETA not quoted` */
export function eta(minutes: number | null): string {
  return minutes == null ? "ETA not quoted" : `${minutes} min ETA`;
}
