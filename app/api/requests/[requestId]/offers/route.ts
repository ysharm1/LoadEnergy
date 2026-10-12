import { getServices } from "@/composition/root";
import { listOffersForRequestHandler } from "@/http/handlers/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ requestId: string }>;
}

/** Requirements 6.6, 7.4 — each quote with its active/expired indicator. */
export async function GET(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { requestId } = await params;
  return listOffersForRequestHandler(getServices(), request, requestId);
}
