import { getServices } from "@/composition/root";
import { setOperatingLocationHandler } from "@/http/handlers/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ companyId: string }>;
}

/** Requirement 16.4 — the origin for Service_Radius matching. */
export async function PUT(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { companyId } = await params;
  return setOperatingLocationHandler(getServices(), request, companyId);
}
