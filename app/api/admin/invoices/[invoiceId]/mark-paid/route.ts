import { getServices } from "@/composition/root";
import { markInvoicePaidHandler } from "@/http/handlers/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ invoiceId: string }>;
}

/** Requirements 12.6, 12.7 — one-way, and attributed to the acting Admin. */
export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { invoiceId } = await params;
  return markInvoicePaidHandler(getServices(), request, invoiceId);
}
