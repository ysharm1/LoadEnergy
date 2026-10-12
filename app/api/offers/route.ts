import { getServices } from "@/composition/root";
import { createOfferHandler } from "@/http/handlers/offers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requirements 6.1-6.5, 5.4, 5.5. */
export function POST(request: Request): Promise<Response> {
  return createOfferHandler(getServices(), request);
}
