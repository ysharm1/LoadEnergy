/**
 * Shared domain types and enums for Load Energy.
 *
 * These are plain TypeScript types (independent of the Prisma client) so the
 * pure service layer and its property-based tests can run fast against the
 * in-memory repository without a database or generated client.
 *
 * The string values intentionally match the Prisma enum values in
 * `prisma/schema.prisma` so the persistence layer can map 1:1.
 */

// ---------------------------------------------------------------------------
// Enums (as string-literal unions + const value arrays for runtime use)
// ---------------------------------------------------------------------------

export const ROLES = ["buyer", "supplier", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const COMPANY_KINDS = ["buyer", "supplier"] as const;
export type CompanyKind = (typeof COMPANY_KINDS)[number];

export const SUPPLIER_APPROVAL_STATUSES = ["pending", "approved"] as const;
export type SupplierApprovalStatus =
  (typeof SUPPLIER_APPROVAL_STATUSES)[number];

export const SUPPLIER_STATUSES = ["open", "limited", "closed"] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const PRODUCT_TYPES = ["ulsd", "dyed"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const DELIVERY_METHODS = ["wet_hose", "yard_tank"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const DELIVERY_WINDOWS = ["today", "tomorrow_am"] as const;
export type DeliveryWindow = (typeof DELIVERY_WINDOWS)[number];

/**
 * Four-state request model (design: "Request.status"). Orders are created only
 * from acceptance (or concierge); there is no Quoted state.
 */
export const REQUEST_STATUSES = [
  "open",
  "accepted",
  "cancelled",
  "expired",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const OFFER_STATUSES = [
  "active",
  "accepted",
  "voided",
  "expired",
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const ORDER_STATUSES = ["accepted", "en_route", "delivered"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ["unpaid", "paid"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Every audited action (Requirements 14.1-14.6, 17.4). */
export const AUDIT_ACTIONS = [
  "OFFER_SUBMITTED",
  "OFFER_ACCEPTED",
  "REQUEST_CANCELLED",
  "REQUEST_EXPIRED",
  "STATUS_CHANGED",
  "CONCIERGE_CREATED",
  "INVOICE_PAID",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// Forward-only order status sequence (design: Accepted -> En_Route -> Delivered).
export const ORDER_STATUS_SEQUENCE: readonly OrderStatus[] = [
  "accepted",
  "en_route",
  "delivered",
];

// Offer hold bounds, inclusive (design: Offer Service).
export const MIN_HOLD_HOURS = 1;
export const MAX_HOLD_HOURS = 8;

// Commission constants (design: Commission & Payment Service).
export const COMMISSION_RATE_PER_GAL = 0.02;
export const WAIVED_WIN_LIMIT = 2;

// Coordinate bounds (Requirement 2.4).
export const MIN_LAT = -90;
export const MAX_LAT = 90;
export const MIN_LNG = -180;
export const MAX_LNG = 180;

// ---------------------------------------------------------------------------
// Value objects
// ---------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

/** Inclusive bounding box used for the Pilot_Geofence check. */
export interface Geofence {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** Resolved from the session for every protected operation. */
export interface AuthContext {
  userId: string;
  companyId: string;
  role: Role;
}

// ---------------------------------------------------------------------------
// Entities (mirror the Prisma models)
// ---------------------------------------------------------------------------

export interface Company {
  id: string;
  name: string;
  kind: CompanyKind;
  /**
   * Supplier-only fields; null for buyer companies. `operatingLat/Lng` and
   * `serviceRadiusMiles` are Admin-set and are the origin/radius for matching.
   */
  supplierApprovalStatus: SupplierApprovalStatus | null;
  supplierStatus: SupplierStatus | null;
  operatingLat: number | null;
  operatingLng: number | null;
  serviceRadiusMiles: number | null;
  createdAt: Date;
}

export interface User {
  id: string;
  companyId: string;
  role: Role;
  /** Required, E.164 (or equivalent) form. */
  phone: string;
  /** Optional. */
  email: string | null;
  passwordHash: string;
  createdAt: Date;
}

export interface Site {
  id: string;
  companyId: string;
  name: string;
  lat: number;
  lng: number;
  createdAt: Date;
}

export interface Request {
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
  /** Derived from `deliveryWindow`; drives window-end expiry. */
  windowEndsAt: Date;
  createdAt: Date;
}

export interface Offer {
  id: string;
  requestId: string;
  supplierCompanyId: string;
  createdByUserId: string;
  landedPricePerGal: number;
  /** Constrained to [MIN_HOLD_HOURS, MAX_HOLD_HOURS] at the service layer. */
  holdHours: number;
  etaMinutes: number | null;
  createdAt: Date;
  expiresAt: Date;
  voided: boolean;
  status: OfferStatus;
}

export interface Order {
  id: string;
  /** Null on the concierge path (no originating Request). */
  requestId: string | null;
  /** Null on the concierge path (no winning Offer). */
  offerId: string | null;
  buyerCompanyId: string;
  supplierCompanyId: string;
  status: OrderStatus;
  isConcierge: boolean;
  createdAt: Date;
}

export interface Delivery {
  id: string;
  /** Unique across deliveries: at most one Delivery per Order. */
  orderId: string;
  bolGallons: number;
  /**
   * Required when a Supplier records the Delivery (Requirement 11.5); null only
   * on an Admin concierge entry with no ticket on file (Requirement 17.2).
   */
  ticketNumber: string | null;
  ticketPhotoKey: string | null;
  deliveredAt: Date;
}

export interface CommissionInvoice {
  id: string;
  /** Unique across invoices: exactly one invoice per Delivered Order. */
  orderId: string;
  supplierCompanyId: string;
  bolGallons: number;
  amount: number;
  /** True for the supplier company's first two completed wins (amount 0). */
  waived: boolean;
  paymentStatus: PaymentStatus;
  /** Set when an Admin marks the invoice paid. */
  paidByAdminId: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface AuditEntry {
  id: string;
  /** Nullable: system-driven request expiry has no acting User. */
  actorUserId: string | null;
  action: AuditAction;
  subjectId: string;
  /** Entity ids and prior/new values where relevant. */
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

/** The single Admin-configured pilot bounding box. */
export interface PilotGeofence extends Geofence {
  id: string;
  setByAdminId: string;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Creation inputs — entity fields minus the repository-assigned `id`.
// Timestamps are supplied by the caller (service layer) so logic stays
// deterministic and testable.
// ---------------------------------------------------------------------------

export type NewCompany = Omit<Company, "id">;
export type NewUser = Omit<User, "id">;
export type NewSite = Omit<Site, "id">;
export type NewRequest = Omit<Request, "id">;
export type NewOffer = Omit<Offer, "id">;
export type NewOrder = Omit<Order, "id">;
export type NewDelivery = Omit<Delivery, "id">;
export type NewCommissionInvoice = Omit<CommissionInvoice, "id">;
export type NewAuditEntry = Omit<AuditEntry, "id">;
export type NewPilotGeofence = Omit<PilotGeofence, "id">;
