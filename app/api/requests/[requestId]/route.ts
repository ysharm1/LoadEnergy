import { getServices } from "@/composition/root";
import { readRequestHandler } from "@/http/handlers/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ requestId: string }>;
}

export async function GET(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { requestId } = await params;
  return readRequestHandler(getServices(), request, requestId);
}
