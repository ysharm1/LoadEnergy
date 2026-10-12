import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NewRequestForm, type GeolocationSource } from "./new-request-form";

/**
 * New Request form unit tests (Requirements 15.2 and 15.3).
 *
 * 15.2 is a layout claim — gallons, Product_Type, Delivery_Method, the pin,
 * and the Delivery_Window are each enterable on one form — so it is checked by
 * finding every one of those controls by its label in a single render.
 *
 * 15.3 is about the default pin, which is why the form takes an injectable
 * `geolocation` source: these tests supply one and drive it by hand, including
 * the cases a phone on a job site actually produces — a denial, a timeout, and
 * a fix that arrives after the user has already typed the pin.
 */

const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

function position(lat: number, lng: number): GeolocationPosition {
  return {
    coords: {
      latitude: lat,
      longitude: lng,
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: Date.now(),
  } as unknown as GeolocationPosition;
}

/** `code` 1 is PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT. */
function geolocationError(code: number): GeolocationPositionError {
  return {
    code,
    message: "test",
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as unknown as GeolocationPositionError;
}

interface PendingFix {
  success: PositionCallback;
  failure?: PositionErrorCallback | null;
}

/**
 * A geolocation source that hands back control: nothing resolves until the
 * test reports a fix or an error, which is how a real phone behaves.
 */
function controllableGeolocation() {
  const pending: PendingFix[] = [];
  const source: GeolocationSource = {
    getCurrentPosition: (success, failure) => {
      pending.push({ success, failure });
    },
  };
  return {
    source,
    pending,
    report(lat: number, lng: number, index = pending.length - 1) {
      act(() => {
        pending[index].success(position(lat, lng));
      });
    },
    fail(code: number, index = pending.length - 1) {
      act(() => {
        pending[index].failure?.(geolocationError(code));
      });
    },
  };
}

function typePin(lat: string, lng: string) {
  fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: lat } });
  fireEvent.change(screen.getByLabelText("Longitude"), {
    target: { value: lng },
  });
}

const latField = () => screen.getByLabelText("Latitude") as HTMLInputElement;
const lngField = () => screen.getByLabelText("Longitude") as HTMLInputElement;

describe("NewRequestForm fields (Req 15.2)", () => {
  it("collects gallons, product, method, pin, window, and notes on one form", () => {
    render(<NewRequestForm geolocation={null} />);

    const gallons = screen.getByLabelText("Gallons") as HTMLInputElement;
    expect(gallons.type).toBe("number");
    expect(gallons.required).toBe(true);

    expect(screen.getByRole("group", { name: "Product" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Clear ULSD" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Dyed off-road" })).toBeDefined();

    expect(screen.getByRole("group", { name: "Delivery method" })).toBeDefined();
    expect(
      screen.getByRole("radio", { name: "Wet hose (fuel equipment)" })
    ).toBeDefined();
    expect(screen.getByRole("radio", { name: "Yard tank fill" })).toBeDefined();

    expect(screen.getByRole("group", { name: "Delivery window" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Today" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Tomorrow AM" })).toBeDefined();

    expect(screen.getByRole("group", { name: "Delivery pin" })).toBeDefined();
    expect(latField().required).toBe(true);
    expect(lngField().required).toBe(true);

    expect(screen.getByLabelText("Notes (optional)")).toBeDefined();
    expect(screen.getByRole("button", { name: "Post load" })).toBeDefined();
  });

  it("lets the buyer change each choice", () => {
    render(<NewRequestForm geolocation={null} />);

    fireEvent.change(screen.getByLabelText("Gallons"), {
      target: { value: "2500" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Dyed off-road" }));
    fireEvent.click(screen.getByRole("radio", { name: "Yard tank fill" }));
    fireEvent.click(screen.getByRole("radio", { name: "Tomorrow AM" }));

    expect((screen.getByLabelText("Gallons") as HTMLInputElement).value).toBe(
      "2500"
    );
    expect(
      (screen.getByRole("radio", { name: "Dyed off-road" }) as HTMLInputElement)
        .checked
    ).toBe(true);
    expect(
      (screen.getByRole("radio", { name: "Yard tank fill" }) as HTMLInputElement)
        .checked
    ).toBe(true);
    expect(
      (screen.getByRole("radio", { name: "Tomorrow AM" }) as HTMLInputElement)
        .checked
    ).toBe(true);
  });
});

describe("NewRequestForm default pin (Req 15.3)", () => {
  it("offers a reported device position as the default pin", () => {
    const device = controllableGeolocation();
    render(<NewRequestForm geolocation={device.source} />);

    expect(device.pending).toHaveLength(1);
    device.report(33.4484, -112.074);

    expect(latField().value).toBe("33.448400");
    expect(lngField().value).toBe("-112.074000");
    expect(screen.getByRole("status").textContent).toContain(
      "Pin set from this device's location"
    );
  });

  it("leaves the pin editable, and says so, when the user denies location", () => {
    const device = controllableGeolocation();
    render(<NewRequestForm geolocation={device.source} />);

    device.fail(1);

    expect(latField().value).toBe("");
    expect(latField().disabled).toBe(false);
    expect(lngField().disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe(
      "No device location available — enter the pin."
    );

    typePin("33.5", "-112.1");
    expect(latField().value).toBe("33.5");
    expect(lngField().value).toBe("-112.1");
  });

  it("leaves the pin editable when the fix times out", () => {
    const device = controllableGeolocation();
    render(<NewRequestForm geolocation={device.source} />);

    device.fail(3);

    expect(screen.getByRole("status").textContent).toBe(
      "No device location available — enter the pin."
    );
    typePin("33.1", "-111.9");
    expect(latField().value).toBe("33.1");
  });

  it("says no location is available when the device exposes none", () => {
    render(<NewRequestForm geolocation={null} />);

    expect(screen.getByRole("status").textContent).toBe(
      "No device location available — enter the pin."
    );
  });

  it("never lets a late fix overwrite a pin typed by hand", () => {
    const device = controllableGeolocation();
    render(<NewRequestForm geolocation={device.source} />);

    typePin("33.580000", "-112.240000");
    // The fix lands after the superintendent has already placed the pin.
    device.report(33.4484, -112.074);

    expect(latField().value).toBe("33.580000");
    expect(lngField().value).toBe("-112.240000");
    expect(screen.getByRole("status").textContent).toBe(
      "Using the pin you entered."
    );
  });

  it("replaces a hand-typed pin only when the buyer asks for the device location", () => {
    const device = controllableGeolocation();
    render(<NewRequestForm geolocation={device.source} />);

    typePin("33.580000", "-112.240000");
    fireEvent.click(screen.getByRole("button", { name: "Use my location" }));
    expect(device.pending).toHaveLength(2);
    device.report(33.4484, -112.074);

    expect(latField().value).toBe("33.448400");
    expect(lngField().value).toBe("-112.074000");
  });
});
