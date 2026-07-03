export declare enum ChannelType {
    WHATSAPP = "WHATSAPP",
    INSTAGRAM = "INSTAGRAM",
    SMS = "SMS",
    WEB_CHAT = "WEB_CHAT",
    EMAIL = "EMAIL"
}
export declare enum MessageDirection {
    INBOUND = "INBOUND",
    OUTBOUND = "OUTBOUND"
}
export declare enum MessageContentType {
    TEXT = "TEXT",
    IMAGE = "IMAGE",
    DOCUMENT = "DOCUMENT",
    LOCATION = "LOCATION",
    INTERACTIVE = "INTERACTIVE",
    PAYMENT_LINK = "PAYMENT_LINK",
    TEMPLATE = "TEMPLATE"
}
export declare enum MessageStatus {
    PENDING = "PENDING",
    SENT = "SENT",
    DELIVERED = "DELIVERED",
    READ = "READ",
    FAILED = "FAILED"
}
export declare enum ConversationStatus {
    OPEN = "OPEN",
    PENDING_HUMAN = "PENDING_HUMAN",
    ESCALATED = "ESCALATED",
    RESOLVED = "RESOLVED",
    SNOOZED = "SNOOZED"
}
export declare enum ConversationPriority {
    LOW = "LOW",
    MEDIUM = "MEDIUM",
    HIGH = "HIGH",
    URGENT = "URGENT"
}
export declare enum TaskStatus {
    PENDING = "PENDING",
    IN_PROGRESS = "IN_PROGRESS",
    RESOLVED = "RESOLVED",
    ESCALATED = "ESCALATED",
    EXPIRED = "EXPIRED"
}
export declare enum TaskType {
    REVIEW_RESPONSE = "REVIEW_RESPONSE",
    APPROVE_REFUND = "APPROVE_REFUND",
    APPROVE_DISCOUNT = "APPROVE_DISCOUNT",
    HANDLE_COMPLAINT = "HANDLE_COMPLAINT",
    CLARIFY_INTENT = "CLARIFY_INTENT",
    FOLLOW_UP = "FOLLOW_UP",
    APPROVE_ORDER = "APPROVE_ORDER",
    CUSTOM = "CUSTOM"
}
export declare enum TaskPriority {
    LOW = "LOW",
    MEDIUM = "MEDIUM",
    HIGH = "HIGH",
    URGENT = "URGENT"
}
export declare enum IntentType {
    BOOKING = "BOOKING",
    PRICING = "PRICING",
    ORDER = "ORDER",
    PAYMENT = "PAYMENT",
    COMPLAINT = "COMPLAINT",
    PROMOTION_RESPONSE = "PROMOTION_RESPONSE",
    GENERAL_INQUIRY = "GENERAL_INQUIRY",
    CANCELLATION = "CANCELLATION",
    REFUND = "REFUND",
    FOLLOW_UP = "FOLLOW_UP",
    CHIT_CHAT = "CHIT_CHAT",
    ORDER_TRACKING = "ORDER_TRACKING",
    RETURNS = "RETURNS"
}
export declare enum ConfidenceMode {
    /** AI acts autonomously — confidence >= 90% */
    AUTO_PILOT = "AUTO_PILOT",
    /** AI prepares a draft for human review — confidence 70-89% */
    DRAFT = "DRAFT",
    /** AI surfaces options, human picks — confidence 50-69% */
    GUIDED = "GUIDED",
    /** Full hand-off to human — confidence < 50% */
    ESCALATION = "ESCALATION"
}
export declare enum OrderStatus {
    DRAFT = "DRAFT",
    CONFIRMED = "CONFIRMED",
    PROCESSING = "PROCESSING",
    PACKED = "PACKED",
    SHIPPED = "SHIPPED",
    DELIVERED = "DELIVERED",
    CANCELLED = "CANCELLED",
    REFUNDED = "REFUNDED",
    PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED",
    RETURNED = "RETURNED"
}
export declare enum PaymentStatus {
    PENDING = "PENDING",
    INITIATED = "INITIATED",
    SUCCESS = "SUCCESS",
    FAILED = "FAILED",
    EXPIRED = "EXPIRED",
    REFUNDED = "REFUNDED",
    PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED"
}
export declare enum PaymentMethod {
    UPI = "UPI",
    CARD = "CARD",
    NET_BANKING = "NET_BANKING",
    WALLET = "WALLET",
    COD = "COD",
    CASH_PICKUP = "CASH_PICKUP",
    CASH_INSTORE = "CASH_INSTORE"
}
export declare enum BookingStatus {
    /** Awaiting confirmation (e.g. deposit/payment pending) */
    PENDING = "PENDING",
    /** Confirmed and on the calendar */
    CONFIRMED = "CONFIRMED",
    /** Time was changed after confirmation */
    RESCHEDULED = "RESCHEDULED",
    CANCELLED = "CANCELLED",
    COMPLETED = "COMPLETED",
    NO_SHOW = "NO_SHOW"
}
/** Where a booking takes place. Stored as a string on the booking row. */
export declare enum BookingLocationType {
    IN_PERSON = "IN_PERSON",
    ONLINE = "ONLINE",
    HOME_VISIT = "HOME_VISIT"
}
/** Who triggered a booking state change. */
export declare enum BookingActor {
    CLIENT = "CLIENT",
    BUSINESS = "BUSINESS",
    SYSTEM = "SYSTEM"
}
/** Recurrence frequency for recurring appointment series. */
export declare enum RecurrenceFrequency {
    DAILY = "DAILY",
    WEEKLY = "WEEKLY",
    MONTHLY = "MONTHLY"
}
export declare enum ShipmentStatus {
    CREATED = "CREATED",
    LABEL_GENERATED = "LABEL_GENERATED",
    PICKED_UP = "PICKED_UP",
    IN_TRANSIT = "IN_TRANSIT",
    OUT_FOR_DELIVERY = "OUT_FOR_DELIVERY",
    DELIVERED = "DELIVERED",
    RTO = "RTO",
    FAILED = "FAILED",
    CANCELLED = "CANCELLED"
}
export declare enum TeamRole {
    OWNER = "OWNER",
    MANAGER = "MANAGER",
    STAFF = "STAFF"
}
export declare enum PaymentGateway {
    RAZORPAY = "RAZORPAY",
    PAYTM = "PAYTM",
    PHONEPE = "PHONEPE",
    STRIPE = "STRIPE",
    MANUAL = "MANUAL"
}
export declare enum RefundStatus {
    INITIATED = "INITIATED",
    PROCESSING = "PROCESSING",
    COMPLETED = "COMPLETED",
    FAILED = "FAILED",
    REJECTED = "REJECTED"
}
export declare enum RefundType {
    FULL = "FULL",
    PARTIAL = "PARTIAL",
    DEPOSIT_ONLY = "DEPOSIT_ONLY"
}
export declare enum RefundMethod {
    ORIGINAL_PAYMENT = "ORIGINAL_PAYMENT",
    STORE_CREDIT = "STORE_CREDIT",
    MANUAL_TRANSFER = "MANUAL_TRANSFER"
}
export declare enum InvoiceStatus {
    DRAFT = "DRAFT",
    ISSUED = "ISSUED",
    PAID = "PAID",
    CANCELLED = "CANCELLED",
    VOID = "VOID"
}
export declare enum CampaignType {
    BIRTHDAY = "BIRTHDAY",
    WIN_BACK = "WIN_BACK",
    LOYALTY = "LOYALTY",
    FEEDBACK = "FEEDBACK",
    REMINDER = "REMINDER",
    CUSTOM = "CUSTOM"
}
export declare enum CatalogItemType {
    PRODUCT = "PRODUCT",
    SERVICE = "SERVICE",
    DIGITAL = "DIGITAL",
    SUBSCRIPTION = "SUBSCRIPTION"
}
/**
 * How a coupon/discount value is interpreted.
 * PERCENT — value is a percentage (0–100) of the order subtotal.
 * FIXED   — value is a flat amount in rupees subtracted from the subtotal.
 */
export declare enum DiscountType {
    PERCENT = "PERCENT",
    FIXED = "FIXED"
}
/**
 * Lifecycle of a shopping cart.
 * ACTIVE    — the customer is still adding/removing items.
 * CONVERTED — the cart became an order at checkout.
 * ABANDONED — the cart was explicitly abandoned or expired.
 */
export declare enum CartStatus {
    ACTIVE = "ACTIVE",
    CONVERTED = "CONVERTED",
    ABANDONED = "ABANDONED"
}
/**
 * Where a real-estate lead was born. Attribution is recorded at birth
 * (blueprint §14) and never mutated — it drives source-level ROI.
 */
export declare enum LeadSource {
    PORTAL = "PORTAL",// 99acres / MagicBricks / Housing enquiry emails
    META_LEAD_AD = "META_LEAD_AD",// Meta Lead Ads webhook
    CTWA = "CTWA",// Click-to-WhatsApp ad / listing chat link
    IVR = "IVR",// Missed-call → WhatsApp
    REFERRAL = "REFERRAL",
    CSV = "CSV",// Bulk / historical import
    WALK_IN = "WALK_IN",
    EXCHANGE_INBOUND = "EXCHANGE_INBOUND",// Syndicated from another broker (L2)
    MANUAL = "MANUAL"
}
/** Lead heat, derived from the qualification score. */
export declare enum LeadTemperature {
    HOT = "HOT",
    WARM = "WARM",
    COLD = "COLD",
    JUNK = "JUNK"
}
/**
 * Pipeline stage. Ordered NEW → … → CLOSED; DORMANT is a re-activation pool.
 * Mirrors the broker's pipeline board on the dashboard.
 */
export declare enum LeadStage {
    NEW = "NEW",
    CONTACTED = "CONTACTED",
    QUALIFIED = "QUALIFIED",
    VISIT_BOOKED = "VISIT_BOOKED",
    VISITED = "VISITED",
    NEGOTIATING = "NEGOTIATING",
    CLOSED_WON = "CLOSED_WON",
    CLOSED_LOST = "CLOSED_LOST",
    DORMANT = "DORMANT"
}
/** Why the buyer is buying — changes matching and the follow-up track. */
export declare enum LeadPurpose {
    END_USE = "END_USE",
    INVEST = "INVEST"
}
/** Financing posture — one of the BLTC-adjacent qualification slots. */
export declare enum FinancingStatus {
    CASH = "CASH",
    PREAPPROVED = "PREAPPROVED",
    NEEDS_LOAN = "NEEDS_LOAN"
}
/** A lead's participation state in the co-broking exchange (L2). */
export declare enum LeadExchangeStatus {
    NONE = "NONE",
    ELIGIBLE = "ELIGIBLE",// qualified but unmatched to own inventory
    OFFERED = "OFFERED",
    SYNDICATED = "SYNDICATED",
    CLOSED = "CLOSED"
}
/** Construction / sale status of a project. */
export declare enum ProjectStatus {
    PRELAUNCH = "PRELAUNCH",
    UC = "UC",// under construction
    RTM = "RTM"
}
/**
 * Availability of a specific unit. The AI may only assert AVAILABLE when
 * `verified_at` is within 24 h — otherwise it must say "confirming".
 */
export declare enum UnitAvailability {
    AVAILABLE = "AVAILABLE",
    HOLD = "HOLD",
    SOLD = "SOLD",
    UNVERIFIED = "UNVERIFIED"
}
/** Whether a project/unit is exposed to the co-broking exchange (L2/L3). */
export declare enum NetworkVisibility {
    PRIVATE = "PRIVATE",
    EXCHANGE = "EXCHANGE"
}
/** Kind of verified media asset attached to a project. */
export declare enum RealtyAssetType {
    BROCHURE = "BROCHURE",
    FLOORPLAN = "FLOORPLAN",
    PRICESHEET = "PRICESHEET",
    VIDEO = "VIDEO",
    PIN = "PIN"
}
//# sourceMappingURL=index.d.ts.map