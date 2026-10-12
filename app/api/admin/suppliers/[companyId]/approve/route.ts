import { getServices } from "@/composition/root";
import { approveSupplierHandler } from "@/http/handlers/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ companyId: string }>;
}

/** Requirements 16.2, 16.8 — license verification stays an offline process. */
export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { companyId } = await params;
  return approveSupplierHandler(getServices(), request, companyId);
}
