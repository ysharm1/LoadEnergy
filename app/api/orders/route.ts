import { getServices } from "@/composition/root";
import { listWonOrdersHandler } from "@/http/handlers/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requirement 8.7 — the winning Supplier Company's won orders. */
export function GET(request: Request): Promise<Response> {
  return listWonOrdersHandler(getServices(), request);
}
