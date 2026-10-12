/**
 * Repository interface — the persistence port for the service layer.
 *
 * Services depend on this interface, never on Prisma directly. Two adapters
 * implement it: an in-memory version for fast, deterministic property/unit
 * tests, and (in a later task) a Prisma/PostgreSQL version for production.
 *
 * Create methods accept the entity minus its `id`; the repository assigns the
 * `id` and returns the stored record. Callers control timestamps (passed via
 * the `New*` inputs) so business logic stays deterministic.
 *
 * Note the AuditEntry surface: insert and read only. There is deliberately no
 * update or delete path, which is what makes the audit log append-only
 * (Requirement 14.7).
 */

import type {
  AuditEntry,
  CommissionInvoice,
  Company,
  Delivery,
  NewAuditEntry,
  NewCommissionInvoice,
  NewCompany,
  NewDelivery,
  NewOffer,
  NewOrder,
  NewPilotGeofence,
  NewRequest,
  NewSite,
  NewUser,
  Offer,
  Order,
  PilotGeofence,
  Request,
  RequestStatus,
  Site,
  User,
} from "@/domain/types";

export interface Repository {
  // --- Company ---
  createCompany(input: NewCompany): Promise<Company>;
  getCompany(id: string): Promise<Company | null>;
  listCompanies(): Promise<Company[]>;
  /** All supplier-kind companies (used by matching). */
  listSupplierCompanies(): Promise<Company[]>;
  updateCompany(
    id: string,
    patch: Partial<Omit<Company, "id">>
  ): Promise<Company>;

  // --- User ---
  createUser(input: NewUser): Promise<User>;
  getUser(id: string): Promise<User | null>;
  /** Phone is the required unique identifier for a User. */
  getUserByPhone(phone: string): Promise<User | null>;
  /** Email is optional; absent for users who did not supply one. */
  getUserByEmail(email: string): Promise<User | null>;
  listUsersByCompany(companyId: string): Promise<User[]>;

  // --- Site ---
  createSite(input: NewSite): Promise<Site>;
  getSite(id: string): Promise<Site | null>;
  listSitesByCompany(companyId: string): Promise<Site[]>;

  // --- Request ---
  createRequest(input: NewRequest): Promise<Request>;
  getRequest(id: string): Promise<Request | null>;
  listRequestsByBuyerCompany(buyerCompanyId: string): Promise<Request[]>;
  listRequestsByStatus(status: RequestStatus): Promise<Request[]>;
  updateRequest(
    id: string,
    patch: Partial<Omit<Request, "id">>
  ): Promise<Request>;

  // --- Offer ---
  createOffer(input: NewOffer): Promise<Offer>;
  getOffer(id: string): Promise<Offer | null>;
  listOffersByRequest(requestId: string): Promise<Offer[]>;
  listOffersBySupplierCompany(supplierCompanyId: string): Promise<Offer[]>;
  updateOffer(id: string, patch: Partial<Omit<Offer, "id">>): Promise<Offer>;

  // --- Order ---
  createOrder(input: NewOrder): Promise<Order>;
  getOrder(id: string): Promise<Order | null>;
  getOrderByRequest(requestId: string): Promise<Order | null>;
  getOrderByOffer(offerId: string): Promise<Order | null>;
  listOrdersByBuyerCompany(buyerCompanyId: string): Promise<Order[]>;
  listOrdersBySupplierCompany(supplierCompanyId: string): Promise<Order[]>;
  updateOrder(id: string, patch: Partial<Omit<Order, "id">>): Promise<Order>;

  // --- Delivery ---
  createDelivery(input: NewDelivery): Promise<Delivery>;
  getDelivery(id: string): Promise<Delivery | null>;
  getDeliveryByOrder(orderId: string): Promise<Delivery | null>;

  // --- CommissionInvoice ---
  createCommissionInvoice(
    input: NewCommissionInvoice
  ): Promise<CommissionInvoice>;
  getCommissionInvoice(id: string): Promise<CommissionInvoice | null>;
  getCommissionInvoiceByOrder(
    orderId: string
  ): Promise<CommissionInvoice | null>;
  listCommissionInvoices(): Promise<CommissionInvoice[]>;
  listCommissionInvoicesBySupplier(
    supplierCompanyId: string
  ): Promise<CommissionInvoice[]>;
  updateCommissionInvoice(
    id: string,
    patch: Partial<Omit<CommissionInvoice, "id">>
  ): Promise<CommissionInvoice>;
  /**
   * Count of a supplier's completed (Delivered) wins — used to decide the
   * waiver of the first two commissions.
   */
  countDeliveredOrdersBySupplier(supplierCompanyId: string): Promise<number>;

  // --- AuditEntry (append-only: insert and read only, no update/delete) ---
  appendAuditEntry(input: NewAuditEntry): Promise<AuditEntry>;
  listAuditEntries(): Promise<AuditEntry[]>;
  listAuditEntriesBySubject(subjectId: string): Promise<AuditEntry[]>;
  countAuditEntries(): Promise<number>;

  // --- PilotGeofence (single Admin-configured bounding box) ---
  getPilotGeofence(): Promise<PilotGeofence | null>;
  /** Upserts the single pilot geofence record. */
  setPilotGeofence(input: NewPilotGeofence): Promise<PilotGeofence>;
}
