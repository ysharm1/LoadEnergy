import { getServices } from "@/composition/root";
import { loginHandler } from "@/http/handlers/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The only unauthenticated route in the API (Requirements 1.1, 1.2). */
export function POST(request: Request): Promise<Response> {
  return loginHandler(getServices(), request);
}
