import { getServices } from "@/composition/root";
import {
  createCompanyHandler,
  listCompaniesHandler,
} from "@/http/handlers/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requirements 16.2, 16.4, 16.5, 17.1 — the Admin surface's company roster. */
export function GET(request: Request): Promise<Response> {
  return listCompaniesHandler(getServices(), request);
}

/** Requirement 16.1 — onboard a Buyer or Supplier Company. */
export function POST(request: Request): Promise<Response> {
  return createCompanyHandler(getServices(), request);
}
