import { getServices } from "@/composition/root";
import { createSiteHandler, listSitesHandler } from "@/http/handlers/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requirements 2.1, 2.2, 2.4. */
export function POST(request: Request): Promise<Response> {
  return createSiteHandler(getServices(), request);
}

/** Requirement 2.3 — scoped to the caller's Company. */
export function GET(request: Request): Promise<Response> {
  return listSitesHandler(getServices(), request);
}
