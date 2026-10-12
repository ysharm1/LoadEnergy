"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DELIVERY_METHODS,
  DELIVERY_WINDOWS,
  PRODUCT_TYPES,
  type DeliveryMethod,
  type DeliveryWindow,
  type ProductType,
} from "@/domain/types";
import { api, errorMessage } from "../_lib/api-client";
import type { RequestDto } from "../_lib/dto";
import {
  METHOD_LABELS,
  PRODUCT_LABELS,
  WINDOW_LABELS,
} from "../_lib/format";

/**
 * The single New Request form (Requirements 3.1, 15.2, 15.3, 15.4).
 *
 * Everything the load needs — gallons, Product_Type, Delivery_Method, the pin,
 * the Delivery_Window, and notes — is on one screen, because the target is a
 * superintendent finishing this in under a minute with one thumb. Choices are
 * radio tiles rather than dropdowns: a 48px tile is easier to hit with gloves
 * than a native picker, and it keeps every interactive control above the 44x44
 * CSS-pixel floor (Requirement 15.4).
 *
 * Where the device reports a position, it is offered as the default pin
 * (Requirement 15.3) — offered, not imposed: the two coordinate fields stay
 * editable, because the truck goes to the pin and the phone may be sitting in
 * a trailer half a mile from the tank.
 *
 * No client-side validation beyond the browser's own `required`. Gallons,
 * the enums, and the geofence are the service's rules; re-stating them here
 * would be a second source of truth that could disagree with the server.
 */

/** The slice of the Geolocation API this form needs, so tests can supply one. */
export type GeolocationSource = Pick<Geolocation, "getCurrentPosition">;

export interface NewRequestFormProps {
  /** Defaults to the device's geolocation where the browser exposes one. */
  geolocation?: GeolocationSource | null;
}

type PinSource = "pending" | "device" | "manual" | "unavailable";

export function NewRequestForm({ geolocation }: NewRequestFormProps) {
  const router = useRouter();

  const [gallons, setGallons] = useState("");
  const [productType, setProductType] = useState<ProductType>("ulsd");
  const [deliveryMethod, setDeliveryMethod] =
    useState<DeliveryMethod>("wet_hose");
  const [deliveryWindow, setDeliveryWindow] =
    useState<DeliveryWindow>("today");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [notes, setNotes] = useState("");

  const [pinSource, setPinSource] = useState<PinSource>("pending");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set once the pin has been typed, so a late fix cannot move the load. */
  const editedByHand = useRef(false);

  const source =
    geolocation ??
    (typeof navigator !== "undefined" ? navigator.geolocation : null);

  /**
   * Offers the device position as the default pin. Never overwrites a pin the
   * user typed: a late-arriving fix must not move a load somebody has already
   * placed by hand.
   */
  const useDeviceLocation = useCallback(
    (replaceManual: boolean) => {
      if (!source) {
        setPinSource("unavailable");
        return;
      }
      source.getCurrentPosition(
        (position) => {
          if (editedByHand.current && !replaceManual) return;
          editedByHand.current = false;
          setLat(position.coords.latitude.toFixed(6));
          setLng(position.coords.longitude.toFixed(6));
          setPinSource("device");
        },
        () => {
          // Denied, timed out, or no fix: the pin fields are the fallback.
          if (!editedByHand.current) setPinSource("unavailable");
        },
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
      );
    },
    [source]
  );

  useEffect(() => {
    useDeviceLocation(false);
  }, [useDeviceLocation]);

  function editPin(next: string, set: (value: string) => void) {
    editedByHand.current = true;
    set(next);
    setPinSource("manual");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post<{ request: RequestDto }>("/api/requests", {
        gallons: gallons.trim(),
        productType,
        deliveryMethod,
        deliveryWindow,
        lat: lat.trim(),
        lng: lng.trim(),
        notes: notes.trim() === "" ? null : notes.trim(),
      });
      router.push("/buyer");
      router.refresh();
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
        <label htmlFor="gallons">Gallons</label>
        <input
          id="gallons"
          name="gallons"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          required
          placeholder="2500"
          value={gallons}
          onChange={(event) => setGallons(event.target.value)}
        />
      </div>

      <fieldset className="options">
        <legend>Product</legend>
        {PRODUCT_TYPES.map((value) => (
          <label className="option" key={value}>
            <input
              type="radio"
              name="productType"
              value={value}
              checked={productType === value}
              onChange={() => setProductType(value)}
            />
            <span>{PRODUCT_LABELS[value]}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="options">
        <legend>Delivery method</legend>
        {DELIVERY_METHODS.map((value) => (
          <label className="option" key={value}>
            <input
              type="radio"
              name="deliveryMethod"
              value={value}
              checked={deliveryMethod === value}
              onChange={() => setDeliveryMethod(value)}
            />
            <span>{METHOD_LABELS[value]}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="options">
        <legend>Delivery window</legend>
        {DELIVERY_WINDOWS.map((value) => (
          <label className="option" key={value}>
            <input
              type="radio"
              name="deliveryWindow"
              value={value}
              checked={deliveryWindow === value}
              onChange={() => setDeliveryWindow(value)}
            />
            <span>{WINDOW_LABELS[value]}</span>
          </label>
        ))}
      </fieldset>

      <div className="field">
        <span className="field-label" id="pin-label">
          Delivery pin
        </span>
        <div className="pair" role="group" aria-labelledby="pin-label">
          <div className="field">
            <label htmlFor="lat">Latitude</label>
            <input
              id="lat"
              name="lat"
              type="number"
              inputMode="decimal"
              step="any"
              required
              value={lat}
              onChange={(event) => editPin(event.target.value, setLat)}
            />
          </div>
          <div className="field">
            <label htmlFor="lng">Longitude</label>
            <input
              id="lng"
              name="lng"
              type="number"
              inputMode="decimal"
              step="any"
              required
              value={lng}
              onChange={(event) => editPin(event.target.value, setLng)}
            />
          </div>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => useDeviceLocation(true)}
        >
          Use my location
        </button>
        <p className="hint" role="status">
          {pinSource === "device"
            ? "Pin set from this device's location. Edit it if the tank is elsewhere."
            : pinSource === "manual"
              ? "Using the pin you entered."
              : pinSource === "unavailable"
                ? "No device location available — enter the pin."
                : "Checking this device's location…"}
        </p>
      </div>

      <div className="field">
        <label htmlFor="notes">Notes (optional)</label>
        <textarea
          id="notes"
          name="notes"
          value={notes}
          placeholder="Gate code, equipment to fuel, who to call on arrival."
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>

      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? "Posting load…" : "Post load"}
      </button>
    </form>
  );
}
