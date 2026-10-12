import { getServices } from "@/composition/root";
import { commissionDueHandler } from "@/http/handlers/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requirement 12.8 — unpaid totals grouped by Supplier Company. */
export function GET(request: Request): Promise<Response> {
  return commissionDueHandler(getServices(), request);
}
