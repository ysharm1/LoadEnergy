import { getServices } from "@/composition/root";
import { listInvoicesHandler } from "@/http/handlers/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requirement 12.8 — the invoices behind the commission-due totals. */
export function GET(request: Request): Promise<Response> {
  return listInvoicesHandler(getServices(), request);
}
