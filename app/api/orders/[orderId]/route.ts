import { getServices } from "@/composition/root";
import { readOrderHandler } from "@/http/handlers/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ orderId: string }>;
}

/** Requirement 10.6 — the status from the last valid transition. */
export async function GET(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { orderId } = await params;
  return readOrderHandler(getServices(), request, orderId);
}
