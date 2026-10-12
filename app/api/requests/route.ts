import { getServices } from "@/composition/root";
import {
  createRequestHandler,
  listRequestsHandler,
} from "@/http/handlers/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requirements 3.1-3.8 (geofence rejection is a 422). */
export function POST(request: Request): Promise<Response> {
  return createRequestHandler(getServices(), request);
}

/** Requirement 3.9 — the buyer work list. */
export function GET(request: Request): Promise<Response> {
  return listRequestsHandler(getServices(), request);
}
