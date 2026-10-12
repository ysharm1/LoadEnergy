// Load Energy service worker — the installable PWA's offline app shell
// (Req 15.1).
//
// Three rules, in this order:
//
//   1. `/api/*` is never cached. Those responses are authenticated, per-user,
//      and change by the minute; a stale RFQ inbox or an expired hold served
//      from a cache shared by everyone on the device would be worse than an
//      honest network error.
//   2. Navigations go to the network first and fall back to the cached shell,
//      so a dispatcher who drives out of signal still gets the app frame and a
//      plain explanation rather than the browser's dinosaur.
//   3. Everything else same-origin (the build's static assets, the manifest,
//      the icon) is cache-first, which is what makes a cold launch on LTE
//      fast.

const CACHE_NAME = "load-energy-shell-v2";

/** The unauthenticated shell: safe to hold in a device-wide cache. */
const APP_SHELL = ["/", "/offline", "/manifest.json", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Individually, so one 404 cannot fail the whole install.
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => undefined)
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Rule 1 — the API is always live.
  if (sameOrigin && url.pathname.startsWith("/api/")) return;

  // Rule 2 — navigations: network, then the cached shell, then the offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (
          (await cache.match(request, { ignoreSearch: true })) ||
          (await cache.match("/offline")) ||
          (await cache.match("/")) ||
          Response.error()
        );
      })
    );
    return;
  }

  if (!sameOrigin) return;

  // Rule 3 — static assets: cache first, filling the cache as they are used.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        cache.put(request, response.clone()).catch(() => undefined);
      }
      return response;
    })
  );
});
