import { getServices } from "@/composition/root";
import { createUserHandler } from "@/http/handlers/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requirements 1.3-1.7 — onboard a User onto an existing Company. */
export function POST(request: Request): Promise<Response> {
  return createUserHandler(getServices(), request);
}
