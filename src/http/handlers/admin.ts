/**
 * Admin routes (Requirements 12.6, 12.8, 16.2, 16.4, 16.5, 16.7, 17.1).
 *
 *   POST /api/admin/suppliers/{id}/approve             approve a supplier
 *   PUT  /api/admin/suppliers/{id}/operating-location  set the match origin
 *   PUT  /api/admin/suppliers/{id}/service-radius      set the match radius
 *   PUT  /api/admin/geofence                           set the pilot box
 *   POST /api/admin/concierge-orders                   enter an off-app deal
 *   POST /api/admin/invoices/{id}/mark-paid            record a payment
 *   GET  /api/admin/commission-due                     the collection list
 *
 * Admin-only is enforced where it belongs — inside the services, through the
 * `requireAction` policy rows that carry Requirements 12.7, 16.8, and 17.5 —
 * not by the URL prefix. A Buyer or Supplier who finds these paths is denied
 * with a 403 by the same guard the rest of the marketplace uses, so the prefix
 * is documentation rather than a security boundary.
 */

import type { Services } from "@/composition/root";
import { requireAuth } from "../auth-context";
import { numberField, readJsonObject, stringField } from "../request";
import { handle, json } from "../respond";

/** `POST /api/admin/suppliers/{companyId}/approve` (Requirement 16.2). */
export function approveSupplierHandler(
  services: Services,
  request: Request,
  companyId: string
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const company = await services.admin.approveSupplier(ctx, companyId);
    return json({ company });
  });
}

/**
 * `PUT /api/admin/suppliers/{companyId}/operating-location`
 * (Requirement 16.4).
 */
export function setOperatingLocationHandler(
  services: Services,
  request: Request,
  companyId: string
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const body = await readJsonObject(request);

    const company = await services.admin.setOperatingLocation(ctx, companyId, {
      lat: numberField(body.lat) as number,
      lng: numberField(body.lng) as number,
    });

    return json({ company });
  });
}

/**
 * `PUT /api/admin/suppliers/{companyId}/service-radius`
 * (Requirements 16.5, 16.6).
 */
export function setServiceRadiusHandler(
  services: Services,
  request: Request,
  companyId: string
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const body = await readJsonObject(request);

    const company = await services.admin.setServiceRadius(
      ctx,
      companyId,
      numberField(body.serviceRadiusMiles) as number
    );

    return json({ company });
  });
}

/** `PUT /api/admin/geofence` (Requirement 16.7). */
export function setGeofenceHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const body = await readJsonObject(request);

    const geofence = await services.admin.setGeofence(ctx, {
      minLat: numberField(body.minLat) as number,
      maxLat: numberField(body.maxLat) as number,
      minLng: numberField(body.minLng) as number,
      maxLng: numberField(body.maxLng) as number,
    });

    return json({ geofence });
  });
}

/** `GET /api/admin/geofence` — the configured box, for the admin editor. */
export function readGeofenceHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    await requireAuth(request, services.auth);
    const geofence = await services.admin.getGeofence();
    return json({ geofence });
  });
}

/** `POST /api/admin/concierge-orders` (Requirements 17.1-17.5). */
export function createConciergeOrderHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const body = await readJsonObject(request);

    const order = await services.orders.createConciergeOrder(ctx, {
      buyerCompanyId: stringField(body.buyerCompanyId) as string,
      supplierCompanyId: stringField(body.supplierCompanyId) as string,
      bolGallons: numberField(body.bolGallons) as number,
      ticketNumber: stringField(body.ticketNumber) ?? null,
      ticketPhotoKey: stringField(body.ticketPhotoKey) ?? null,
    });

    return json({ order }, 201);
  });
}

/** `POST /api/admin/invoices/{invoiceId}/mark-paid` (Requirements 12.6, 12.7). */
export function markInvoicePaidHandler(
  services: Services,
  request: Request,
  invoiceId: string
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const invoice = await services.commission.markInvoicePaid(ctx, invoiceId);
    return json({ invoice });
  });
}

/**
 * `GET /api/admin/companies` — the approval list and the concierge pickers.
 *
 * Admin-only inside the service, like every other route in this file. The
 * caller is resolved from the session cookie, so a Buyer or Supplier who finds
 * the path gets a 403 rather than the marketplace's company roster.
 */
export function listCompaniesHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const companies = await services.admin.listCompanies(ctx);
    return json(companies);
  });
}

/**
 * `GET /api/admin/invoices` — the invoices behind the commission-due totals
 * (Requirement 12.8), which is where mark-paid gets its invoice ids.
 *
 * `?unpaid=1` narrows the list to what is still owed.
 */
export function listInvoicesHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const unpaidOnly = new URL(request.url).searchParams.get("unpaid") === "1";
    const invoices = await services.commission.listInvoices(ctx, { unpaidOnly });
    return json({ invoices });
  });
}

/** `GET /api/admin/commission-due` (Requirement 12.8). */
export function commissionDueHandler(
  services: Services,
  request: Request
): Promise<Response> {
  return handle(async () => {
    const ctx = await requireAuth(request, services.auth);
    const report = await services.commission.commissionDue(ctx);
    return json(report);
  });
}
