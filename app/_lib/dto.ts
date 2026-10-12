/**
 * The API's JSON shapes as the client sees them.
 *
 * Identical to the service-layer projections except that `Date` has been
 * through `JSON.stringify` and arrives as an ISO string. The enums are
 * imported as types from the domain so a renamed member breaks the UI at
 * compile time rather than at a field site.
 */

import type {
  DeliveryMethod,
  DeliveryWindow,
  OfferStatus,
  OrderStatus,
  PaymentStatus,
  ProductType,
  RequestStatus,
  Role,
  SupplierApprovalStatus,
  SupplierStatus,
} from "@/domain/types";

export interface CompanyDto {
  id: string;
  name: string;
  kind: "buyer" | "supplier";
  supplierApprovalStatus: SupplierApprovalStatus | null;
  supplierStatus: SupplierStatus | null;
  operatingLat: number | null;
  operatingLng: number | null;
  serviceRadiusMiles: number | null;
}

/** The User as the API projects it — no password hash, ever. */
export interface UserDto {
  id: string;
  companyId: string;
  role: Role;
  phone: string;
  email: string | null;
}

export interface SessionDto {
  user: UserDto;
  company: CompanyDto;
  role: Role;
}

export interface SiteDto {
  id: string;
  companyId: string;
  name: string;
  lat: number;
  lng: number;
  createdAt: string;
}

export interface RequestDto {
  id: string;
  buyerCompanyId: string;
  createdByUserId: string;
  gallons: number;
  productType: ProductType;
  deliveryMethod: DeliveryMethod;
  deliveryWindow: DeliveryWindow;
  pinLat: number;
  pinLng: number;
  notes: string | null;
  status: RequestStatus;
  windowEndsAt: string;
  createdAt: string;
}

export interface OrderDto {
  id: string;
  requestId: string | null;
  offerId: string | null;
  buyerCompanyId: string;
  supplierCompanyId: string;
  status: OrderStatus;
  isConcierge: boolean;
  createdAt: string;
}

export interface OrderViewDto {
  orderId: string;
  requestId: string | null;
  offerId: string | null;
  buyerCompanyId: string;
  supplierCompanyId: string;
  status: OrderStatus;
  isConcierge: boolean;
  createdAt: string;
  delivery: {
    deliveryId: string;
    bolGallons: number;
    ticketNumber: string | null;
    ticketPhotoKey: string | null;
    deliveredAt: string;
  } | null;
}

/** Requirements 6.6, 7.4 — supplier, price, ETA, expiry, active/expired. */
export interface OfferViewDto {
  offerId: string;
  requestId: string;
  supplierCompanyId: string;
  supplierName: string;
  landedPricePerGal: number;
  etaMinutes: number | null;
  holdHours: number;
  expiresAt: string;
  status: OfferStatus;
  activeness: "active" | "expired";
  isActive: boolean;
}

export interface GeofenceDto {
  id: string;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  setByAdminId: string;
  updatedAt: string;
}

export interface CommissionDueRowDto {
  supplierCompanyId: string;
  supplierCompanyName: string | null;
  unpaidInvoiceCount: number;
  amountDue: number;
}

export interface CommissionDueDto {
  rows: CommissionDueRowDto[];
  totalDue: number;
}

export interface InvoiceDto {
  id: string;
  orderId: string;
  supplierCompanyId: string;
  supplierCompanyName: string | null;
  bolGallons: number;
  amount: number;
  waived: boolean;
  paymentStatus: PaymentStatus;
  paidByAdminId: string | null;
  paidAt: string | null;
  createdAt: string;
}

// --- Envelopes ------------------------------------------------------------

export interface WorkListDto {
  requests: RequestDto[];
  orders: OrderDto[];
}

export interface CompanyRosterDto {
  buyers: CompanyDto[];
  suppliers: CompanyDto[];
}
