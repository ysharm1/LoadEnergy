import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PWA shell unit tests (Requirement 15.1: the client is delivered as an
 * installable progressive web application).
 *
 * Two halves:
 *
 *   1. The web app manifest — the fields a browser actually requires before it
 *      will offer an install prompt.
 *   2. The service worker's caching rules — asserted by running `public/sw.js`
 *      inside a fabricated worker scope and driving its event handlers. The
 *      rule that matters most is that `/api/*` never enters a device-wide
 *      cache: those responses are authenticated and per-user.
 */

// Vitest runs from the project root; these are the files the browser fetches.
const publicDir = join(process.cwd(), "public");
const manifestPath = join(publicDir, "manifest.json");
const serviceWorkerPath = join(publicDir, "sw.js");

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

describe("web app manifest (Req 15.1)", () => {
  it("is valid JSON", () => {
    expect(() => readManifest()).not.toThrow();
  });

  it("declares the identity and launch fields an install prompt requires", () => {
    const manifest = readManifest();

    expect(manifest.name.trim()).not.toBe("");
    expect(manifest.short_name.trim()).not.toBe("");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    // A start_url outside the scope is never launched as an installed app.
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
  });

  it("declares usable icons, including a maskable one", () => {
    const manifest = readManifest();

    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith("/")).toBe(true);
      expect(icon.sizes.trim()).not.toBe("");
      expect(icon.type.trim()).not.toBe("");
      // The file has to be shipped, not just named.
      expect(existsSync(join(publicDir, icon.src))).toBe(true);
    }

    const purposes = manifest.icons.flatMap((icon) =>
      (icon.purpose ?? "any").split(/\s+/)
    );
    expect(purposes).toContain("any");
    expect(purposes).toContain("maskable");
  });

  it("declares theme and background colors for the standalone chrome", () => {
    const manifest = readManifest();

    expect(manifest.theme_color).toMatch(HEX_COLOR);
    expect(manifest.background_color).toMatch(HEX_COLOR);
  });
});

/* ------------------------------------------------------------------ */
/* A fabricated ServiceWorkerGlobalScope for exercising public/sw.js. */
/* ------------------------------------------------------------------ */

const ORIGIN = "https://loadenergy.test";

type Listener = (event: WorkerEvent) => void;

interface WorkerEvent {
  request?: FakeRequest;
  respondWith: (response: unknown) => void;
  waitUntil: (promise: Promise<unknown>) => void;
}

class FakeRequest {
  readonly url: string;
  readonly method: string;
  readonly mode: string;

  constructor(
    url: string,
    init: { method?: string; mode?: string } = {}
  ) {
    this.url = new URL(url, ORIGIN).href;
    this.method = init.method ?? "GET";
    this.mode = init.mode ?? "no-cors";
  }
}

interface FakeResponse {
  ok: boolean;
  type: string;
  body: string;
  clone: () => FakeResponse;
}

function body(text: string, ok = true, type = "basic"): FakeResponse {
  const response: FakeResponse = {
    ok,
    type,
    body: text,
    clone: () => response,
  };
  return response;
}

/** Keyed by pathname, which is all the shell's rules distinguish. */
class FakeCache {
  readonly entries = new Map<string, FakeResponse>();
  readonly added: string[] = [];

  async add(request: FakeRequest) {
    this.added.push(new URL(request.url).pathname);
    this.entries.set(new URL(request.url).pathname, body("precached"));
  }

  async match(request: FakeRequest | string) {
    const key =
      typeof request === "string"
        ? new URL(request, ORIGIN).pathname
        : new URL(request.url).pathname;
    return this.entries.get(key);
  }

  async put(request: FakeRequest, response: FakeResponse) {
    this.entries.set(new URL(request.url).pathname, response);
  }
}

interface Harness {
  cache: FakeCache;
  fetch: ReturnType<typeof vi.fn>;
  /** Dispatches a fetch event and resolves whatever the worker responded. */
  handleFetch: (
    request: FakeRequest
  ) => Promise<{ responded: boolean; response?: FakeResponse }>;
  /** Dispatches `install` and awaits the work it registered. */
  install: () => Promise<void>;
}

/**
 * Evaluates `public/sw.js` against stand-ins for `self`, `caches`, `fetch`,
 * `Request`, and `Response`, then returns handles for driving it.
 */
function loadServiceWorker(cached: Record<string, string> = {}): Harness {
  const source = readFileSync(serviceWorkerPath, "utf8");
  const listeners = new Map<string, Listener>();
  const cache = new FakeCache();
  for (const [path, text] of Object.entries(cached)) {
    cache.entries.set(path, body(text));
  }

  const self = {
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, listener),
    location: { origin: ORIGIN },
    skipWaiting: () => undefined,
    clients: { claim: () => undefined },
  };

  const caches = {
    open: async () => cache,
    keys: async () => ["load-energy-shell-v1"],
    delete: async () => true,
  };

  const fetchMock = vi.fn(async () => body("from network"));

  const evaluate = new Function(
    "self",
    "caches",
    "fetch",
    "Request",
    "Response",
    source
  );
  evaluate(self, caches, fetchMock, FakeRequest, {
    error: () => body("network error", false, "error"),
  });

  function dispatch(type: string, request?: FakeRequest) {
    const listener = listeners.get(type);
    if (!listener) throw new Error(`sw.js registered no "${type}" listener`);
    let responded = false;
    let response: unknown;
    const waits: Promise<unknown>[] = [];
    listener({
      request,
      respondWith: (value) => {
        responded = true;
        response = value;
      },
      waitUntil: (promise) => waits.push(promise),
    });
    return { responded, response, waits };
  }

  return {
    cache,
    fetch: fetchMock,
    handleFetch: async (request) => {
      const { responded, response } = dispatch("fetch", request);
      if (!responded) return { responded: false };
      return {
        responded: true,
        response: (await response) as FakeResponse,
      };
    },
    install: async () => {
      const { waits } = dispatch("install");
      await Promise.all(waits);
    },
  };
}

describe("service worker caching rules (Req 15.1)", () => {
  it("precaches the unauthenticated app shell on install", async () => {
    const worker = loadServiceWorker();

    await worker.install();

    expect(worker.cache.added).toEqual([
      "/",
      "/offline",
      "/manifest.json",
      "/icons/icon.svg",
    ]);
  });

  it("never caches or serves /api/* from the cache", async () => {
    // A poisoned cache entry: the worker must not reach for it.
    const worker = loadServiceWorker({ "/api/requests": "someone else's RFQs" });

    const result = await worker.handleFetch(
      new FakeRequest("/api/requests?status=open")
    );

    // Not intercepted at all — the request goes straight to the network.
    expect(result.responded).toBe(false);
    expect(worker.fetch).not.toHaveBeenCalled();
    // And nothing new was written under /api either.
    expect([...worker.cache.entries.keys()]).toEqual(["/api/requests"]);
  });

  it("leaves non-GET requests alone", async () => {
    const worker = loadServiceWorker();

    const result = await worker.handleFetch(
      new FakeRequest("/buyer/requests/new", { method: "POST", mode: "navigate" })
    );

    expect(result.responded).toBe(false);
  });

  it("serves navigations from the network when it is reachable", async () => {
    const worker = loadServiceWorker({ "/offline": "offline shell" });

    const result = await worker.handleFetch(
      new FakeRequest("/buyer", { mode: "navigate" })
    );

    expect(result.responded).toBe(true);
    expect(result.response?.body).toBe("from network");
  });

  it("falls back to the cached shell when a navigation cannot reach the network", async () => {
    const worker = loadServiceWorker({ "/offline": "offline shell" });
    worker.fetch.mockRejectedValue(new Error("offline"));

    const result = await worker.handleFetch(
      new FakeRequest("/buyer/requests/new", { mode: "navigate" })
    );

    expect(result.responded).toBe(true);
    expect(result.response?.body).toBe("offline shell");
  });

  it("serves a cached page itself when that navigation is in the cache", async () => {
    const worker = loadServiceWorker({
      "/buyer": "buyer shell",
      "/offline": "offline shell",
    });
    worker.fetch.mockRejectedValue(new Error("offline"));

    const result = await worker.handleFetch(
      new FakeRequest("/buyer?from=install", { mode: "navigate" })
    );

    expect(result.response?.body).toBe("buyer shell");
  });

  it("serves same-origin static assets cache-first and fills the cache", async () => {
    const worker = loadServiceWorker({ "/icons/icon.svg": "cached icon" });

    const cachedHit = await worker.handleFetch(
      new FakeRequest("/icons/icon.svg")
    );
    expect(cachedHit.response?.body).toBe("cached icon");
    expect(worker.fetch).not.toHaveBeenCalled();

    const miss = await worker.handleFetch(new FakeRequest("/manifest.json"));
    expect(miss.response?.body).toBe("from network");
    expect(await worker.cache.match("/manifest.json")).toBeDefined();
  });
});
