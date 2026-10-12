import { getServices } from "@/composition/root";
import { advanceOrderStatusHandler } from "@/http/handlers/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ orderId: string }>;
}

/** Requirements 10.2-10.5 — forward-only. */
export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { orderId } = await params;
  return advanceOrderStatusHandler(getServices(), request, orderId);
}
