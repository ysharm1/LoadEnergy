import { getServices } from "@/composition/root";
import { listRfqInboxHandler } from "@/http/handlers/supplier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requirements 4.3-4.7, 5.3, 9.4, 16.3 — the supplier RFQ inbox. */
export function GET(request: Request): Promise<Response> {
  return listRfqInboxHandler(getServices(), request);
}
