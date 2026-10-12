import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { ServiceWorkerRegister } from "./service-worker-register";

/**
 * Service worker registration (Requirement 15.1).
 *
 * The component is what makes the app installable in a real browser, so the
 * two things worth pinning down are that it registers `/sw.js` where the
 * browser supports it — whether the document has already loaded or not — and
 * that it quietly does nothing where the browser does not.
 */

function withServiceWorkerSupport() {
  const register = vi.fn().mockResolvedValue({ scope: "/" });
  Object.defineProperty(navigator, "serviceWorker", {
    value: { register },
    configurable: true,
    writable: true,
  });
  return register;
}

function setReadyState(state: DocumentReadyState) {
  Object.defineProperty(document, "readyState", {
    value: state,
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  setReadyState("complete");
  vi.restoreAllMocks();
});

describe("ServiceWorkerRegister (Req 15.1)", () => {
  it("registers /sw.js when the document has already loaded", () => {
    const register = withServiceWorkerSupport();
    setReadyState("complete");

    render(<ServiceWorkerRegister />);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("waits for the load event when the document is still loading", () => {
    const register = withServiceWorkerSupport();
    setReadyState("loading");

    render(<ServiceWorkerRegister />);
    expect(register).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new Event("load"));
    });

    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("registers only once per load", () => {
    const register = withServiceWorkerSupport();
    setReadyState("loading");

    render(<ServiceWorkerRegister />);
    act(() => {
      window.dispatchEvent(new Event("load"));
      window.dispatchEvent(new Event("load"));
    });

    expect(register).toHaveBeenCalledTimes(1);
  });

  it("no-ops where the browser has no service worker support", () => {
    const register = withServiceWorkerSupport();
    Reflect.deleteProperty(navigator, "serviceWorker");
    expect("serviceWorker" in navigator).toBe(false);

    expect(() => render(<ServiceWorkerRegister />)).not.toThrow();
    expect(register).not.toHaveBeenCalled();
  });

  it("survives a rejected registration", () => {
    const register = vi.fn().mockRejectedValue(new Error("no https"));
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register },
      configurable: true,
      writable: true,
    });

    expect(() => render(<ServiceWorkerRegister />)).not.toThrow();
    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("renders nothing", () => {
    withServiceWorkerSupport();

    const { container } = render(<ServiceWorkerRegister />);

    expect(container.innerHTML).toBe("");
  });
});
