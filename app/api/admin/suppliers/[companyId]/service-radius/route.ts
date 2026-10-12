import { getServices } from "@/composition/root";
import { setServiceRadiusHandler } from "@/http/handlers/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ companyId: string }>;
}

/** Requirements 16.5, 16.6 — a radius <= 0 is a validation error. */
export async function PUT(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { companyId } = await params;
  return setServiceRadiusHandler(getServices(), request, companyId);
}
