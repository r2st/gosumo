// ─────────────────────────────────────────────
// CHANNEL & MESSAGING
// ─────────────────────────────────────────────

export enum ChannelType {
  WHATSAPP = 'WHATSAPP',
  INSTAGRAM = 'INSTAGRAM',
  SMS = 'SMS',
  WEB_CHAT = 'WEB_CHAT',
  EMAIL = 'EMAIL',
}

export enum MessageDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

export enum MessageContentType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  DOCUMENT = 'DOCUMENT',
  LOCATION = 'LOCATION',
  INTERACTIVE = 'INTERACTIVE',
  PAYMENT_LINK = 'PAYMENT_LINK',
  TEMPLATE = 'TEMPLATE',
}

export enum MessageStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
  FAILED = 'FAILED',
}

// ─────────────────────────────────────────────
// CONVERSATION
// ─────────────────────────────────────────────

export enum ConversationStatus {
  OPEN = 'OPEN',
  PENDING_HUMAN = 'PENDING_HUMAN',
  ESCALATED = 'ESCALATED',
  RESOLVED = 'RESOLVED',
  SNOOZED = 'SNOOZED',
}

export enum ConversationPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

// ─────────────────────────────────────────────
// TASKS (HITL)
// ─────────────────────────────────────────────

export enum TaskStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  ESCALATED = 'ESCALATED',
  EXPIRED = 'EXPIRED',
}

export enum TaskType {
  REVIEW_RESPONSE = 'REVIEW_RESPONSE',
  APPROVE_REFUND = 'APPROVE_REFUND',
  APPROVE_DISCOUNT = 'APPROVE_DISCOUNT',
  HANDLE_COMPLAINT = 'HANDLE_COMPLAINT',
  CLARIFY_INTENT = 'CLARIFY_INTENT',
  FOLLOW_UP = 'FOLLOW_UP',
  APPROVE_ORDER = 'APPROVE_ORDER',
  CUSTOM = 'CUSTOM',
}

export enum TaskPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

// ─────────────────────────────────────────────
// AI ENGINE
// ─────────────────────────────────────────────

export enum IntentType {
  BOOKING = 'BOOKING',
  PRICING = 'PRICING',
  ORDER = 'ORDER',
  PAYMENT = 'PAYMENT',
  COMPLAINT = 'COMPLAINT',
  PROMOTION_RESPONSE = 'PROMOTION_RESPONSE',
  GENERAL_INQUIRY = 'GENERAL_INQUIRY',
  CANCELLATION = 'CANCELLATION',
  REFUND = 'REFUND',
  FOLLOW_UP = 'FOLLOW_UP',
  CHIT_CHAT = 'CHIT_CHAT',
  ORDER_TRACKING = 'ORDER_TRACKING',
  RETURNS = 'RETURNS',
}

export enum ConfidenceMode {
  /** AI acts autonomously — confidence >= 90% */
  AUTO_PILOT = 'AUTO_PILOT',
  /** AI prepares a draft for human review — confidence 70-89% */
  DRAFT = 'DRAFT',
  /** AI surfaces options, human picks — confidence 50-69% */
  GUIDED = 'GUIDED',
  /** Full hand-off to human — confidence < 50% */
  ESCALATION = 'ESCALATION',
}

// ─────────────────────────────────────────────
// COMMERCE — ORDERS
// ─────────────────────────────────────────────

export enum OrderStatus {
  DRAFT = 'DRAFT',
  CONFIRMED = 'CONFIRMED',
  PROCESSING = 'PROCESSING',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  RETURNED = 'RETURNED',
}

// ─────────────────────────────────────────────
// COMMERCE — PAYMENTS
// ─────────────────────────────────────────────

export enum PaymentStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
}

export enum PaymentMethod {
  UPI = 'UPI',
  CARD = 'CARD',
  NET_BANKING = 'NET_BANKING',
  WALLET = 'WALLET',
  COD = 'COD',
  CASH_PICKUP = 'CASH_PICKUP',
  CASH_INSTORE = 'CASH_INSTORE',
}

// ─────────────────────────────────────────────
// COMMERCE — BOOKINGS
// ─────────────────────────────────────────────

export enum BookingStatus {
  CONFIRMED = 'CONFIRMED',
  MODIFIED = 'MODIFIED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
  NO_SHOW = 'NO_SHOW',
}

// ─────────────────────────────────────────────
// COMMERCE — SHIPMENTS
// ─────────────────────────────────────────────

export enum ShipmentStatus {
  CREATED = 'CREATED',
  LABEL_GENERATED = 'LABEL_GENERATED',
  PICKED_UP = 'PICKED_UP',
  IN_TRANSIT = 'IN_TRANSIT',
  OUT_FOR_DELIVERY = 'OUT_FOR_DELIVERY',
  DELIVERED = 'DELIVERED',
  RTO = 'RTO',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

// ─────────────────────────────────────────────
// PLATFORM
// ─────────────────────────────────────────────

export enum TeamRole {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  STAFF = 'STAFF',
}

// ─────────────────────────────────────────────
// REFUNDS
// ─────────────────────────────────────────────

export enum RefundType {
  FULL = 'FULL',
  PARTIAL = 'PARTIAL',
  DEPOSIT_ONLY = 'DEPOSIT_ONLY',
}

export enum RefundMethod {
  ORIGINAL_PAYMENT = 'ORIGINAL_PAYMENT',
  STORE_CREDIT = 'STORE_CREDIT',
  MANUAL_TRANSFER = 'MANUAL_TRANSFER',
}

// ─────────────────────────────────────────────
// CAMPAIGNS
// ─────────────────────────────────────────────

export enum CampaignType {
  BIRTHDAY = 'BIRTHDAY',
  WIN_BACK = 'WIN_BACK',
  LOYALTY = 'LOYALTY',
  FEEDBACK = 'FEEDBACK',
  REMINDER = 'REMINDER',
  CUSTOM = 'CUSTOM',
}
