import { getServices } from "@/composition/root";
import { logoutHandler } from "@/http/handlers/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return logoutHandler(getServices(), request);
}
