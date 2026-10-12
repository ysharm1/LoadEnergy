import { getServices } from "@/composition/root";
import {
  readGeofenceHandler,
  setGeofenceHandler,
} from "@/http/handlers/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requirement 16.7 — Admin-only, enforced in the service. */
export function PUT(request: Request): Promise<Response> {
  return setGeofenceHandler(getServices(), request);
}

/** The configured box, readable by any signed-in user (it is not secret). */
export function GET(request: Request): Promise<Response> {
  return readGeofenceHandler(getServices(), request);
}
