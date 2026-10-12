/**
 * Liveness probe for the hosting platform (Render's health check path).
 *
 * Deliberately the dullest route in the codebase: no session, no services, no
 * database read, and a fixed body. Three reasons.
 *
 * It must be unauthenticated, because the platform's prober has no cookie —
 * so it must also reveal nothing. No version, no commit, no environment name,
 * no connection state: an anonymous caller learns only that a process is
 * answering HTTP.
 *
 * It must not touch Postgres. A probe that fails when the database blinks
 * turns a recoverable database hiccup into a restart loop that takes the web
 * service down with it, and the natural way to report such a failure is to
 * echo the driver's error text, which leaks host names and credentials into
 * an unauthenticated response.
 *
 * `force-dynamic` keeps it from being prerendered into a static asset, so a
 * 200 here means this instance really is serving requests.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
