/**
 * Commerce contract types for the Catalog, Orders, Bookings and Payments
 * surfaces. These extend the base shapes in ./types with the additional
 * request/response objects documented in API_DESIGN.md (sections 9–12) but
 * not yet defined there. Kept local to the web app, like ./feature-types.
 */
import type {
  Booking,
  BookingStatus,
  CatalogItem,
  CatalogItemType,
  CatalogVariant,
  FulfillmentType,
  ISODate,
  Order,
  OrderStatus,
  Payment,
  PaymentMethod,
  PaymentStatus,
  UUID,
} from './types';

// ── Catalog ──────────────────────────────────────────────────────────────────

export interface CatalogCategory {
  id: UUID;
  businessId: UUID;
  name: string;
  slug: string;
  description?: string;
  imageUrl?: string;
  parentId?: UUID;
  sortOrder: number;
  isActive: boolean;
  itemCount: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface CategoriesResponse {
  categories: CatalogCategory[];
  total: number;
}

export interface CreateCategoryRequest {
  name: string;
  description?: string;
  imageUrl?: string;
  parentId?: string;
  sortOrder?: number;
  isActive?: boolean;
}

export type VariantDraft = Omit<CatalogVariant, 'id' | 'itemId'>;

export interface CreateCatalogItemRequest {
  categoryId?: string;
  type: CatalogItemType;
  name: string;
  description?: string;
  shortDescription?: string;
  imageUrls?: string[];
  basePrice: number;
  currency?: string;
  discountPrice?: number;
  taxRate?: number;
  taxIncluded?: boolean;
  sku?: string;
  hsn?: string;
  unit?: string;
  isActive?: boolean;
  isAvailable?: boolean;
  trackInventory?: boolean;
  stockQuantity?: number;
  lowStockThreshold?: number;
  tags?: string[];
  variants?: VariantDraft[];
}

export interface CatalogItemListQuery {
  categoryId?: string;
  type?: CatalogItemType;
  isActive?: boolean;
  isAvailable?: boolean;
  q?: string;
  lowStock?: boolean;
  page?: number;
  limit?: number;
}

/** Derived stock state for an item, used for the inventory status indicator. */
export type StockState = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNTRACKED';

export function stockStateFor(item: Pick<CatalogItem, 'trackInventory' | 'stockQuantity' | 'lowStockThreshold'>): StockState {
  if (!item.trackInventory) return 'UNTRACKED';
  const qty = item.stockQuantity ?? 0;
  if (qty <= 0) return 'OUT_OF_STOCK';
  if (item.lowStockThreshold != null && qty <= item.lowStockThreshold) return 'LOW_STOCK';
  return 'IN_STOCK';
}

// ── Orders ───────────────────────────────────────────────────────────────────

export interface OrderAddress {
  name: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
}

/** A single order fetched via GET /orders/:id — carries address + internal-note fields. */
export interface OrderDetail extends Order {
  shippingAddress?: OrderAddress;
  billingAddress?: OrderAddress;
  internalNotes?: string;
}

export interface OrderStats {
  totalOrders: number;
  totalRevenue: number;
  avgOrderValue: number;
  statusBreakdown: Partial<Record<OrderStatus, number>>;
  fulfillmentBreakdown: Partial<Record<FulfillmentType, number>>;
  topItems: Array<{ itemId: UUID; name: string; quantity: number; revenue: number }>;
}

export interface OrderListQuery {
  status?: OrderStatus;
  fulfillmentType?: FulfillmentType;
  clientId?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

// ── Bookings ─────────────────────────────────────────────────────────────────

export interface AvailableSlot {
  date: string; // YYYY-MM-DD
  startTime: ISODate;
  endTime: ISODate;
  staffMemberId?: UUID;
  staffName?: string;
  available: boolean;
}

export interface SlotsResponse {
  slots: AvailableSlot[];
  timezone: string;
  nextAvailableDate?: string;
}

export interface CalendarEvent {
  id: UUID; // bookingId
  title: string;
  start: ISODate;
  end: ISODate;
  status: BookingStatus;
  clientId: UUID;
  color?: string;
}

export interface StaffMember {
  id: UUID;
  name: string;
  avatarUrl?: string;
  services: UUID[];
}

export interface CreateBookingRequest {
  clientId: string;
  catalogItemId: string;
  variantId?: string;
  staffMemberId?: string;
  startTime: string; // ISO 8601
  timezone?: string;
  notes?: string;
  sendConfirmation?: boolean;
  createOrder?: boolean;
}

export interface UpdateBookingRequest {
  startTime?: string;
  staffMemberId?: string;
  notes?: string;
  status?: Extract<BookingStatus, 'CONFIRMED' | 'PENDING' | 'NO_SHOW'>;
}

export interface CancelBookingRequest {
  reason?: string;
  notifyClient?: boolean;
  refundPayment?: boolean;
}

export interface BookingListQuery {
  status?: BookingStatus;
  staffMemberId?: string;
  date?: string;
  from?: string;
  to?: string;
  include?: string;
  page?: number;
  limit?: number;
}

// ── Payments ─────────────────────────────────────────────────────────────────

export interface PaymentStats {
  totalRevenue: number;
  totalTransactions: number;
  successRate: number;
  avgTransactionValue: number;
  refundedAmount: number;
  refundCount: number;
  methodBreakdown: Partial<Record<PaymentMethod, { count: number; amount: number }>>;
}

export interface CreatePaymentLinkRequest {
  clientId: string;
  amount: number; // paise
  currency?: string;
  description: string;
  orderId?: string;
  bookingId?: string;
  expiresInHours?: number;
  sendToClient?: boolean;
  acceptPartialPayments?: boolean;
  notifyOnPayment?: boolean;
}

export interface PaymentLinkResponse {
  payment: Payment;
  link: { id: string; url: string; shortUrl: string; expiresAt: ISODate };
  messageSent?: boolean;
}

export interface RefundRequest {
  amount: number;
  reason: string;
  notes?: string;
  notifyClient?: boolean;
}

export interface PaymentListQuery {
  status?: PaymentStatus;
  method?: PaymentMethod;
  clientId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

/**
 * An invoice is a frontend-facing view over a captured payment (and its linked
 * order, if any). The API exposes the underlying payment; the invoice number and
 * document shape are derived here for display.
 */
export interface Invoice {
  number: string;
  payment: Payment;
}

export function invoiceNumber(payment: Pick<Payment, 'id' | 'createdAt'>): string {
  const year = payment.createdAt?.slice(0, 4) ?? '0000';
  return `INV-${year}-${payment.id.slice(0, 8).toUpperCase()}`;
}

/** A captured/partially-refunded payment is treated as an invoice. */
export function isInvoiceable(status: PaymentStatus): boolean {
  return status === 'CAPTURED' || status === 'PARTIALLY_REFUNDED' || status === 'REFUNDED';
}

export { type Booking, type CatalogItem, type CatalogVariant, type Order, type Payment };
