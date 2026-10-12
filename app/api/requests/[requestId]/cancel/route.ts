import { getServices } from "@/composition/root";
import { cancelRequestHandler } from "@/http/handlers/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ requestId: string }>;
}

/** Requirements 9.1, 9.2, 9.5 — owner-only, Open loads only. */
export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { requestId } = await params;
  return cancelRequestHandler(getServices(), request, requestId);
}
