import { getServices } from "@/composition/root";
import { acceptOfferHandler } from "@/http/handlers/offers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ offerId: string }>;
}

/** Requirements 7.3, 8.1-8.7 — one exclusive, linked Order. */
export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { offerId } = await params;
  return acceptOfferHandler(getServices(), request, offerId);
}
