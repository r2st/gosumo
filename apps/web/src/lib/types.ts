// ─────────────────────────────────────────────────────────────────────────────
// GoSumo API contract types.
//
// These mirror the shapes documented in API_DESIGN.md. They intentionally live in
// the web app (rather than importing @gosumo/shared) so the frontend stays
// decoupled from the backend's internal TypeScript source and can be built
// independently. Field names match the REST contract exactly.
// ─────────────────────────────────────────────────────────────────────────────

export type UUID = string;
export type ISODate = string;

// ── Shared envelopes ─────────────────────────────────────────────────────────

export interface Pagination {
  total: number;
  limit: number;
  cursor?: string | null;
  page?: number;
  totalPages?: number;
  hasMore: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: Pagination;
}

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  details?: Record<string, unknown>;
  traceId?: string;
  timestamp?: string;
}

// ── Enums (string unions per the REST contract) ──────────────────────────────

export type ChannelType = 'WHATSAPP' | 'INSTAGRAM' | 'SMS' | 'WEB_CHAT' | 'EMAIL';

/**
 * Includes VIEWER: the API issues VIEWER tokens and `GET /auth/me` returns the
 * role verbatim, so omitting it here did not stop a VIEWER signing in — it only
 * stopped TypeScript noticing that write controls were being rendered for one.
 * Kept identical to `Role` in ./feature-types, which the team surfaces use.
 */
export type UserRole = 'OWNER' | 'MANAGER' | 'STAFF' | 'VIEWER';

export type ConversationStatus = 'OPEN' | 'PENDING' | 'RESOLVED' | 'ESCALATED' | 'BOT_HANDLING';

export type MessageDirection = 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
export type MessageStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
export type MessageContentType =
  | 'TEXT'
  | 'IMAGE'
  | 'DOCUMENT'
  | 'LOCATION'
  | 'INTERACTIVE'
  | 'PAYMENT_LINK'
  | 'TEMPLATE'
  | 'VOICE'
  | 'VIDEO'
  | 'STICKER';

export type HitlTaskType =
  'DRAFT_REVIEW' | 'ESCALATION' | 'APPROVAL_REQUIRED' | 'QUALITY_CHECK' | 'CUSTOMER_REQUEST';
export type HitlTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'RESOLVED' | 'EXPIRED' | 'ESCALATED';
export type HitlPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export type ChurnRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type SentimentLabel =
  'VERY_NEGATIVE' | 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE' | 'VERY_POSITIVE';

export type OrderStatus =
  | 'DRAFT'
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PROCESSING'
  | 'READY_FOR_PICKUP'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'REFUNDED';
export type FulfillmentType = 'DELIVERY' | 'PICKUP' | 'DIGITAL' | 'IN_STORE';

export type BookingStatus =
  'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW' | 'RESCHEDULED';

export type PaymentStatus =
  'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'EXPIRED';
export type PaymentMethod = 'UPI' | 'CARD' | 'NETBANKING' | 'WALLET' | 'COD' | 'EMI';

export type CatalogItemType = 'PRODUCT' | 'SERVICE' | 'PACKAGE' | 'DIGITAL';

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthUser {
  id: UUID;
  email: string;
  name: string;
  role: UserRole;
  businessId: UUID;
  avatarUrl?: string;
  twoFactorEnabled: boolean;
  createdAt: ISODate;
}

export interface LoginResponse {
  user: AuthUser;
  tokens: TokenPair;
  requiresTwoFactor: false;
}

export interface LoginTwoFactorRequired {
  requiresTwoFactor: true;
  twoFactorToken: string;
  twoFactorMethods: Array<'TOTP' | 'SMS'>;
}

export type LoginResult = LoginResponse | LoginTwoFactorRequired;

export interface BusinessProfile {
  id: UUID;
  name: string;
  slug: string;
  industry: string;
  description?: string;
  logo?: string;
  phone?: string;
  email?: string;
  website?: string;
  currency: string;
  timezone: string;
  language: string;
  country: string;
  onboardingStatus: 'PENDING' | 'IN_PROGRESS' | 'COMPLETE';
  subscriptionPlan: 'FREE' | 'STARTER' | 'GROWTH' | 'ENTERPRISE';
  subscriptionStatus: 'ACTIVE' | 'TRIAL' | 'PAST_DUE' | 'CANCELLED';
  trialEndsAt?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ── Conversations & messages ─────────────────────────────────────────────────

export interface ClientSummary {
  id: UUID;
  name: string;
  phone?: string;
  email?: string;
  avatarUrl?: string;
  tags: string[];
}

export interface Conversation {
  id: UUID;
  businessId: UUID;
  clientId: UUID;
  channelId: UUID;
  channelType: ChannelType;
  externalThreadId?: string;
  status: ConversationStatus;
  subject?: string;
  assignedTo?: UUID;
  aiHandling: boolean;
  lastMessageAt?: ISODate;
  lastMessagePreview?: string;
  unreadCount: number;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: ISODate;
  updatedAt: ISODate;
  resolvedAt?: ISODate;
  client?: ClientSummary;
}

export type MessageContent =
  | { type: 'TEXT'; text: string }
  | { type: 'IMAGE'; url: string; caption?: string; mimeType: string; fileSize?: number }
  | { type: 'DOCUMENT'; url: string; filename: string; mimeType: string; fileSize?: number }
  | { type: 'LOCATION'; latitude: number; longitude: number; name?: string; address?: string }
  | { type: 'INTERACTIVE'; interactiveType: string; payload: Record<string, unknown> }
  | { type: 'PAYMENT_LINK'; url: string; amount: number; currency: string; orderId?: string }
  | { type: 'TEMPLATE'; templateName: string; parameters: Record<string, string> }
  | { type: 'VOICE'; url: string; durationSeconds?: number; mimeType: string }
  | { type: 'VIDEO'; url: string; caption?: string; mimeType: string; durationSeconds?: number };

export interface Message {
  id: UUID;
  conversationId: UUID;
  businessId: UUID;
  direction: MessageDirection;
  contentType: MessageContentType;
  content: MessageContent;
  status: MessageStatus;
  sentBy?: UUID;
  sentByAi: boolean;
  aiConfidence?: number;
  externalId?: string;
  timestamp: ISODate;
  deliveredAt?: ISODate;
  readAt?: ISODate;
  failureReason?: string;
  replyToMessageId?: UUID;
  metadata: Record<string, unknown>;
}

// ── HITL ─────────────────────────────────────────────────────────────────────

export interface HitlResolution {
  action: 'APPROVED' | 'EDITED' | 'REJECTED' | 'OVERRIDDEN';
  resolvedBy: UUID;
  editedResponse?: string;
  reason?: string;
  timestamp: ISODate;
}

export interface HitlTask {
  id: UUID;
  businessId: UUID;
  conversationId: UUID;
  messageId?: UUID;
  type: HitlTaskType;
  status: HitlTaskStatus;
  priority: HitlPriority;
  assignedTo?: UUID;
  title: string;
  description: string;
  aiDraft?: string;
  aiConfidence?: number;
  aiReasoning?: string;
  requiredAction?: { type: string; payload: Record<string, unknown> };
  resolution?: HitlResolution;
  expiresAt?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
  resolvedAt?: ISODate;
  client?: ClientSummary;
}

// ── Clients ──────────────────────────────────────────────────────────────────

export interface ClientIntelligence {
  clientId: UUID;
  sentimentScore: number;
  sentimentLabel: SentimentLabel;
  churnRiskScore: number;
  churnRiskLevel: ChurnRiskLevel;
  ltv: number;
  totalOrders: number;
  totalSpend: number;
  avgOrderValue: number;
  preferredChannel?: ChannelType;
  preferredContactTime?: string;
  interests: string[];
  lastSentimentUpdatedAt?: ISODate;
  updatedAt: ISODate;
}

export interface ClientAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
}

export interface ChannelContact {
  id: UUID;
  channel: ChannelType;
  externalId: string;
  displayName?: string | null;
  profilePicUrl?: string | null;
  isOptedIn: boolean;
  firstSeenAt: ISODate;
  lastSeenAt: ISODate;
}

export interface Client {
  id: UUID;
  businessId: UUID;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  profile: Record<string, unknown>;
  optOuts: Record<string, unknown>;
  ltvScore?: number | null;
  churnRisk?: number | null;
  engagementScore?: number | null;
  totalOrders: number;
  totalSpent: number;
  lastInteractionAt?: ISODate | null;
  firstSeenAt: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
  channelContacts?: ChannelContact[];
  // Optional fields that the frontend may reference but are not in the API yet
  tags?: string[];
  source?: string;
  notes?: string;
  address?: ClientAddress;
  intelligence?: ClientIntelligence;
  conversations?: Conversation[];
  orders?: Order[];
  bookings?: Booking[];
}

export type ClientTimelineItem =
  | {
      type: 'MESSAGE';
      timestamp: ISODate;
      data: { direction: MessageDirection; preview: string; conversationId: UUID };
    }
  | { type: 'ORDER'; timestamp: ISODate; data: { orderId: UUID; status: string; amount: number } }
  | {
      type: 'BOOKING';
      timestamp: ISODate;
      data: { bookingId: UUID; status: string; serviceName: string };
    }
  | {
      type: 'PAYMENT';
      timestamp: ISODate;
      data: { paymentId: UUID; status: string; amount: number };
    }
  | {
      type: 'CAMPAIGN';
      timestamp: ISODate;
      data: { campaignId: UUID; campaignName: string; event: string };
    };

/** Timeline event as returned by the API (different shape from ClientTimelineItem). */
export interface TimelineEvent {
  type: 'CONVERSATION' | 'ORDER' | 'BOOKING' | 'PAYMENT';
  id: UUID;
  timestamp: ISODate;
  title: string;
  status: string;
  amountPaise?: number;
  channel?: ChannelType;
}

export interface ClientTimeline {
  clientId: UUID;
  events: TimelineEvent[];
  total: number;
}

export interface ClientSegment {
  id: UUID;
  name: string;
  description: string;
  type: 'AUTO' | 'CUSTOM';
  clientCount: number;
  filter: Record<string, unknown>;
  createdAt: ISODate;
}

// ── Catalog ──────────────────────────────────────────────────────────────────

export interface CatalogVariant {
  id: UUID;
  itemId: UUID;
  name: string;
  sku?: string;
  price: number;
  discountPrice?: number;
  stockQuantity?: number;
  isActive: boolean;
  attributes: Record<string, string>;
  imageUrl?: string;
}

export interface CatalogItem {
  id: UUID;
  businessId: UUID;
  categoryId?: UUID;
  type: CatalogItemType;
  name: string;
  slug: string;
  description?: string;
  shortDescription?: string;
  imageUrls: string[];
  basePrice: number;
  currency: string;
  discountPrice?: number;
  taxRate?: number;
  taxIncluded: boolean;
  sku?: string;
  hsn?: string;
  unit?: string;
  isActive: boolean;
  isAvailable: boolean;
  trackInventory: boolean;
  stockQuantity?: number;
  lowStockThreshold?: number;
  tags: string[];
  variants: CatalogVariant[];
  metadata: Record<string, unknown>;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ── Orders ───────────────────────────────────────────────────────────────────

export interface OrderItem {
  id: UUID;
  orderId: UUID;
  catalogItemId: UUID;
  variantId?: UUID;
  name: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  imageUrl?: string;
}

export interface Order {
  id: UUID;
  businessId: UUID;
  clientId: UUID;
  conversationId?: UUID;
  orderNumber: string;
  status: OrderStatus;
  fulfillmentType: FulfillmentType;
  items: OrderItem[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  shippingAmount: number;
  total: number;
  currency: string;
  paymentId?: UUID;
  shipmentId?: UUID;
  trackingNumber?: string;
  notes?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: ISODate;
  updatedAt: ISODate;
  confirmedAt?: ISODate;
  shippedAt?: ISODate;
  deliveredAt?: ISODate;
  cancelledAt?: ISODate;
  cancelReason?: string;
  client?: ClientSummary;
}

// ── Bookings ─────────────────────────────────────────────────────────────────

export interface Booking {
  id: UUID;
  businessId: UUID;
  clientId: UUID;
  catalogItemId: UUID;
  variantId?: UUID;
  staffMemberId?: UUID;
  status: BookingStatus;
  startTime: ISODate;
  endTime: ISODate;
  timezone: string;
  durationMinutes: number;
  price: number;
  currency: string;
  paymentStatus: 'UNPAID' | 'PAID' | 'PARTIAL' | 'REFUNDED';
  orderId?: UUID;
  paymentId?: UUID;
  notes?: string;
  clientNotes?: string;
  reminderSent: boolean;
  googleEventId?: string;
  metadata: Record<string, unknown>;
  createdAt: ISODate;
  updatedAt: ISODate;
  cancelledAt?: ISODate;
  cancelReason?: string;
  client?: ClientSummary;
  service?: { id: UUID; name: string };
}

// ── Payments ─────────────────────────────────────────────────────────────────

export interface PaymentRefund {
  id: UUID;
  paymentId: UUID;
  amount: number;
  reason: string;
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  processedAt?: ISODate;
  createdAt: ISODate;
}

export interface Payment {
  id: UUID;
  businessId: UUID;
  orderId?: UUID;
  bookingId?: UUID;
  clientId: UUID;
  amount: number;
  currency: string;
  status: PaymentStatus;
  method?: PaymentMethod;
  paymentLinkUrl?: string;
  paymentLinkShortUrl?: string;
  paymentLinkExpiry?: ISODate;
  capturedAt?: ISODate;
  failureReason?: string;
  refunds: PaymentRefund[];
  metadata: Record<string, unknown>;
  createdAt: ISODate;
  updatedAt: ISODate;
  client?: ClientSummary;
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface DashboardMetrics {
  period: { from: ISODate; to: ISODate };
  conversations: {
    total: number;
    open: number;
    resolved: number;
    escalated: number;
    avgResolutionTimeMs: number;
    avgFirstResponseTimeMs: number;
  };
  messages: { inbound: number; outbound: number; aiSent: number; humanSent: number };
  ai: {
    autonomyRate: number;
    avgConfidence: number;
    autoExecuted: number;
    reviewed: number;
    escalated: number;
    approvalRate: number;
  };
  revenue: { total: number; orders: number; payments: number; avgOrderValue: number };
  clients: { total: number; newThisPeriod: number; activeThisPeriod: number; churnRisk: number };
  channels: Array<{ channelType: ChannelType; messageCount: number; conversationCount: number }>;
}

export interface ConversationReport {
  summary: {
    total: number;
    avgResolutionTimeMs: number;
    avgFirstResponseTimeMs: number;
    csat?: number;
  };
  timeSeries: Array<{
    date: string;
    created: number;
    resolved: number;
    escalated: number;
    avgResolutionTimeMs: number;
  }>;
  channelBreakdown: Array<{ channel: ChannelType; count: number; avgResolutionTimeMs: number }>;
  topIntents: Array<{ intent: string; count: number }>;
}

export interface RevenueReport {
  summary: {
    totalRevenue: number;
    totalOrders: number;
    avgOrderValue: number;
    totalRefunds: number;
    netRevenue: number;
  };
  timeSeries: Array<{ date: string; revenue: number; orders: number; refunds: number }>;
  topProducts: Array<{ itemId: UUID; name: string; quantity: number; revenue: number }>;
}
