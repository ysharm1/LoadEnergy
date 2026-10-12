import { getServices } from "@/composition/root";
import {
  readSupplierStatusHandler,
  setSupplierStatusHandler,
} from "@/http/handlers/supplier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requirement 5.1 — the current Supplier_Status of the caller's Company. */
export function GET(request: Request): Promise<Response> {
  return readSupplierStatusHandler(getServices(), request);
}

/** Requirement 5.2 — persist Open / Limited / Closed. */
export function PUT(request: Request): Promise<Response> {
  return setSupplierStatusHandler(getServices(), request);
}
