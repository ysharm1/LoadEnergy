import { getServices } from "@/composition/root";
import { createConciergeOrderHandler } from "@/http/handlers/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requirements 17.1-17.5 — a Delivered Order, its Delivery, and its invoice. */
export function POST(request: Request): Promise<Response> {
  return createConciergeOrderHandler(getServices(), request);
}
