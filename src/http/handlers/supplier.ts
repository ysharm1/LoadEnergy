/**
 * Supplier availability and RFQ routes (Requirements 4.3, 5.2, 5.3).
 *
 *   GET /api/supplier/status  read the Supplier_Status toggle
 *   PUT /api/supplier/status  persist Open / Limited / Closed
 *   GET /api/rfqs             the RFQ inbox for the caller's Supplier Company
 *
 * The Supplier Company is never named by the client. Both the toggle and the
 * inbox let the service default to `ctx.companyId` from the session-resolved
 * `AuthContext`, so there is no body field or query parameter that could point
 * at a competitor's availability or RFQ flow — and the `own_company` scope on
 * the `supplier.setStatus` / `rfq.list` policy rows would deny it anyway.
 *
 * Enum membership for the status is the service's call
 * (`requireSupplierStatus`), so the raw value is passed through rather than
 * pre-filtered here.
 */

import type { Services } from "@/composition/root";
import type { SupplierStatus } from "@/domain/types";
import { requireAuth } from "../auth-context";
import { readJsonObject, stringField } from "../request";
import { handle, json } from "../respond";
import { toPublicCompany } from "./auth";

/** `GET /api/supplier/status` (Requirement 5.1). */
export function readSupplierStatusHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const supplierStatus = await services.suppliers.getStatus(ctx);
    return json({ supplierStatus });
  });
}

/** `PUT /api/supplier/status` (Requirement 5.2). */
export function setSupplierStatusHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const body = await readJsonObject(request);

    const company = await services.suppliers.setStatus(
      ctx,
      stringField(body.supplierStatus) as SupplierStatus
    );

    return json({
      company: toPublicCompany(company),
      supplierStatus: company.supplierStatus,
    });
  });
}

/**
 * `GET /api/rfqs` — the supplier RFQ inbox (Requirements 4.3-4.7, 5.3, 9.4,
 * 16.3).
 *
 * The matching predicate and lazy window-end expiry both run inside the
 * service, so a dispatcher refreshing the inbox sees exactly the loads they are
 * eligible for at that moment.
 */
export function listRfqInboxHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const requests = await services.matching.listRfqInbox(ctx);
    return json({ requests });
  });
}
