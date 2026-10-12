import { getServices } from "@/composition/root";
import { recordDeliveryHandler } from "@/http/handlers/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ orderId: string }>;
}

/**
 * Requirements 11.1-11.7. Accepts a multipart form with an optional `photo`
 * field (Requirement 11.6) or a plain JSON body.
 */
export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { orderId } = await params;
  return recordDeliveryHandler(getServices(), request, orderId);
}
