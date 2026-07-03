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
  PACKED = 'PACKED',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  RETURNED = 'RETURNED',
}

// ─────────────────────────────────────────────
// COMMERCE — PAYMENTS
// ─────────────────────────────────────────────

export enum PaymentStatus {
  PENDING = 'PENDING',
  INITIATED = 'INITIATED',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
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
  /** Awaiting confirmation (e.g. deposit/payment pending) */
  PENDING = 'PENDING',
  /** Confirmed and on the calendar */
  CONFIRMED = 'CONFIRMED',
  /** Time was changed after confirmation */
  RESCHEDULED = 'RESCHEDULED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
  NO_SHOW = 'NO_SHOW',
}

/** Where a booking takes place. Stored as a string on the booking row. */
export enum BookingLocationType {
  IN_PERSON = 'IN_PERSON',
  ONLINE = 'ONLINE',
  HOME_VISIT = 'HOME_VISIT',
}

/** Who triggered a booking state change. */
export enum BookingActor {
  CLIENT = 'CLIENT',
  BUSINESS = 'BUSINESS',
  SYSTEM = 'SYSTEM',
}

/** Recurrence frequency for recurring appointment series. */
export enum RecurrenceFrequency {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
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
// COMMERCE — PAYMENT GATEWAYS
// ─────────────────────────────────────────────

export enum PaymentGateway {
  RAZORPAY = 'RAZORPAY',
  PAYTM = 'PAYTM',
  PHONEPE = 'PHONEPE',
  STRIPE = 'STRIPE',
  MANUAL = 'MANUAL',
}

// ─────────────────────────────────────────────
// REFUNDS
// ─────────────────────────────────────────────

export enum RefundStatus {
  INITIATED = 'INITIATED',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REJECTED = 'REJECTED',
}

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
// INVOICES
// ─────────────────────────────────────────────

export enum InvoiceStatus {
  DRAFT = 'DRAFT',
  ISSUED = 'ISSUED',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
  VOID = 'VOID',
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

// ─────────────────────────────────────────────
// COMMERCE — CATALOG
// ─────────────────────────────────────────────

export enum CatalogItemType {
  PRODUCT = 'PRODUCT',
  SERVICE = 'SERVICE',
  DIGITAL = 'DIGITAL',
  SUBSCRIPTION = 'SUBSCRIPTION',
}

/**
 * How a coupon/discount value is interpreted.
 * PERCENT — value is a percentage (0–100) of the order subtotal.
 * FIXED   — value is a flat amount in rupees subtracted from the subtotal.
 */
export enum DiscountType {
  PERCENT = 'PERCENT',
  FIXED = 'FIXED',
}

/**
 * Lifecycle of a shopping cart.
 * ACTIVE    — the customer is still adding/removing items.
 * CONVERTED — the cart became an order at checkout.
 * ABANDONED — the cart was explicitly abandoned or expired.
 */
export enum CartStatus {
  ACTIVE = 'ACTIVE',
  CONVERTED = 'CONVERTED',
  ABANDONED = 'ABANDONED',
}

// ─────────────────────────────────────────────
// REALTY — LEADS
// ─────────────────────────────────────────────

/**
 * Where a real-estate lead was born. Attribution is recorded at birth
 * (blueprint §14) and never mutated — it drives source-level ROI.
 */
export enum LeadSource {
  PORTAL = 'PORTAL', // 99acres / MagicBricks / Housing enquiry emails
  META_LEAD_AD = 'META_LEAD_AD', // Meta Lead Ads webhook
  CTWA = 'CTWA', // Click-to-WhatsApp ad / listing chat link
  IVR = 'IVR', // Missed-call → WhatsApp
  REFERRAL = 'REFERRAL',
  CSV = 'CSV', // Bulk / historical import
  WALK_IN = 'WALK_IN',
  EXCHANGE_INBOUND = 'EXCHANGE_INBOUND', // Syndicated from another broker (L2)
  MANUAL = 'MANUAL',
}

/** Lead heat, derived from the qualification score. */
export enum LeadTemperature {
  HOT = 'HOT',
  WARM = 'WARM',
  COLD = 'COLD',
  JUNK = 'JUNK',
}

/**
 * Pipeline stage. Ordered NEW → … → CLOSED; DORMANT is a re-activation pool.
 * Mirrors the broker's pipeline board on the dashboard.
 */
export enum LeadStage {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  QUALIFIED = 'QUALIFIED',
  VISIT_BOOKED = 'VISIT_BOOKED',
  VISITED = 'VISITED',
  NEGOTIATING = 'NEGOTIATING',
  CLOSED_WON = 'CLOSED_WON',
  CLOSED_LOST = 'CLOSED_LOST',
  DORMANT = 'DORMANT',
}

/** Why the buyer is buying — changes matching and the follow-up track. */
export enum LeadPurpose {
  END_USE = 'END_USE',
  INVEST = 'INVEST',
}

/** Financing posture — one of the BLTC-adjacent qualification slots. */
export enum FinancingStatus {
  CASH = 'CASH',
  PREAPPROVED = 'PREAPPROVED',
  NEEDS_LOAN = 'NEEDS_LOAN',
}

/** A lead's participation state in the co-broking exchange (L2). */
export enum LeadExchangeStatus {
  NONE = 'NONE',
  ELIGIBLE = 'ELIGIBLE', // qualified but unmatched to own inventory
  OFFERED = 'OFFERED',
  SYNDICATED = 'SYNDICATED',
  CLOSED = 'CLOSED',
}

// ─────────────────────────────────────────────
// REALTY — INVENTORY (grounding layer)
// ─────────────────────────────────────────────

/** Construction / sale status of a project. */
export enum ProjectStatus {
  PRELAUNCH = 'PRELAUNCH',
  UC = 'UC', // under construction
  RTM = 'RTM', // ready to move
}

/**
 * Availability of a specific unit. The AI may only assert AVAILABLE when
 * `verified_at` is within 24 h — otherwise it must say "confirming".
 */
export enum UnitAvailability {
  AVAILABLE = 'AVAILABLE',
  HOLD = 'HOLD',
  SOLD = 'SOLD',
  UNVERIFIED = 'UNVERIFIED',
}

/** Whether a project/unit is exposed to the co-broking exchange (L2/L3). */
export enum NetworkVisibility {
  PRIVATE = 'PRIVATE',
  EXCHANGE = 'EXCHANGE',
}

/** Kind of verified media asset attached to a project. */
export enum RealtyAssetType {
  BROCHURE = 'BROCHURE',
  FLOORPLAN = 'FLOORPLAN',
  PRICESHEET = 'PRICESHEET',
  VIDEO = 'VIDEO',
  PIN = 'PIN', // location pin
}

// ─────────────────────────────────────────────
// REALTY — SITE VISITS (Phase 3, blueprint §14)
// ─────────────────────────────────────────────

/**
 * Lifecycle of a scheduled site visit. BOOKED on creation; CONFIRMED once the
 * buyer acknowledges; COMPLETED / NO_SHOW are terminal outcomes; RESCHEDULED
 * marks a moved visit; CANCELLED frees the slot.
 */
export enum SiteVisitStatus {
  BOOKED = 'BOOKED',
  CONFIRMED = 'CONFIRMED',
  COMPLETED = 'COMPLETED',
  NO_SHOW = 'NO_SHOW',
  RESCHEDULED = 'RESCHEDULED',
  CANCELLED = 'CANCELLED',
}

/**
 * Post-visit outcome logged by the broker (drives the follow-up track and
 * pipeline stage). PENDING until the visit is completed and reviewed.
 */
export enum SiteVisitOutcome {
  PENDING = 'PENDING',
  INTERESTED = 'INTERESTED',
  NOT_INTERESTED = 'NOT_INTERESTED',
  WANTS_ALTERNATIVE = 'WANTS_ALTERNATIVE',
  NEEDS_FOLLOWUP = 'NEEDS_FOLLOWUP',
  TOKEN_BOOKED = 'TOKEN_BOOKED',
}

// ─────────────────────────────────────────────
// REALTY — INGESTION (Phase 4, blueprint §15)
// ─────────────────────────────────────────────

/**
 * Recognised property-portal enquiry sources. Parsed from portal enquiry
 * emails and stored as the lead's `sub_source` for source-level ROI.
 */
export enum RealtyPortal {
  NINETYNINE_ACRES = '99ACRES',
  MAGICBRICKS = 'MAGICBRICKS',
  HOUSING = 'HOUSING',
  UNKNOWN = 'UNKNOWN',
}

// ─────────────────────────────────────────────
// REALTY — AI LOOP (intent set + routing, blueprint §16)
// ─────────────────────────────────────────────

/**
 * The 14 real-estate conversational intents the AI loop classifies every
 * inbound buyer/seller message into (blueprint §16.1). `GENERAL` is the
 * catch-all fallback when nothing more specific is resolved.
 */
export enum RealtyIntent {
  NEW_ENQUIRY = 'NEW_ENQUIRY', // first contact about a property/listing
  PRICE_INQUIRY = 'PRICE_INQUIRY', // "kitne ka hai", asking price/rate
  AVAILABILITY = 'AVAILABILITY', // is X config/unit available?
  SITE_VISIT = 'SITE_VISIT', // wants to visit / book a viewing
  DOC_REQUEST = 'DOC_REQUEST', // brochure, floor plan, price sheet, RERA doc
  LOCATION_AMENITY = 'LOCATION_AMENITY', // where is it, what's nearby, amenities
  LOAN_QUERY = 'LOAN_QUERY', // home loan / EMI / financing question
  NEGOTIATION = 'NEGOTIATION', // asking for a discount / price drop
  LEGAL_RERA = 'LEGAL_RERA', // RERA, possession date, approvals, legal
  SELLER_LEAD = 'SELLER_LEAD', // owner wanting to sell/list a property
  RENTAL = 'RENTAL', // looking to rent, not buy
  REACTIVATION_REPLY = 'REACTIVATION_REPLY', // replying to a nurture/cadence ping
  COMPLAINT_ABUSE = 'COMPLAINT_ABUSE', // complaint, spam report, abuse
  GENERAL = 'GENERAL', // fallback — greeting/chit-chat/unclear
}

/**
 * Per-intent default autonomy ceiling. Overrides any numeric confidence — the
 * AI may never act beyond an intent's policy (blueprint §16.3 hard rules).
 */
export enum RealtyRoutePolicy {
  /** May auto-execute when data + policy are clear (e.g. fresh AVAILABILITY, DOC send). */
  AUTO_ALLOWED = 'AUTO_ALLOWED',
  /** Never auto-send; always draft for a human first (e.g. PRICE_INQUIRY). */
  DRAFT_ONLY = 'DRAFT_ONLY',
  /** Always a full human hand-off (NEGOTIATION, LEGAL_RERA, LOAN_QUERY, SELLER_LEAD, COMPLAINT_ABUSE). */
  ESCALATE = 'ESCALATE',
}

// ─────────────────────────────────────────────
// REALTY — CADENCES & COMPLIANCE (Phase 5, blueprint §17 / §21)
// ─────────────────────────────────────────────

/** What enrols a lead into a follow-up cadence. */
export enum CadenceTrigger {
  NO_RESPONSE = 'NO_RESPONSE', // buyer went quiet after an enquiry
  POST_VISIT = 'POST_VISIT', // site visit completed — nurture to close
  DORMANT = 'DORMANT', // long-cold lead reactivation
}

/** A signal that halts a running cadence immediately. */
export enum CadenceStopOn {
  REPLY = 'REPLY', // buyer replied — human/AI takes the wheel
  OPTOUT = 'OPTOUT', // buyer opted out — absolute stop
  STAGE_CHANGE = 'STAGE_CHANGE', // pipeline moved on — cadence no longer applies
}

/** Lifecycle of a single lead's enrolment in a cadence. */
export enum CadenceEnrollmentStatus {
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED', // ran to the last step
  STOPPED = 'STOPPED', // halted by a stop_on signal
}

/**
 * WhatsApp template category. Enforced in code: a MARKETING template may never
 * be sent inside a closed 24h service window, and only category-correct
 * templates are allowed (blueprint §21 WhatsApp hygiene).
 */
export enum TemplateCategory {
  UTILITY = 'UTILITY',
  MARKETING = 'MARKETING',
}

/** Meta approval state of a template — sends are blocked unless APPROVED. */
export enum TemplateApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

// ─────────────────────────────────────────────
// REALTY — BROKER SURFACE (Phase 6, blueprint §16)
// ─────────────────────────────────────────────

/** State of an AI draft awaiting human review (70–89% confidence band). */
export enum ApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED', // sent verbatim
  EDITED = 'EDITED', // broker edited then sent
  REJECTED = 'REJECTED', // discarded
}

/**
 * Per-account AI independence level (the "autonomy dial"). Raised only on
 * evidence during pilot migration.
 */
export enum AutonomyLevel {
  SUGGEST = 'SUGGEST', // AI drafts everything; broker approves every send
  ASSISTED = 'ASSISTED', // AI auto-sends high-confidence, drafts the rest
  AUTONOMOUS = 'AUTONOMOUS', // AI runs the desk; only escalations surface
}

/** Who currently owns a conversation — the AI or a human broker (takeover). */
export enum ConversationOwner {
  AI = 'AI',
  HUMAN = 'HUMAN',
}

/** Kinds of item that surface in the broker's notification centre. */
export enum BrokerAlertType {
  HOT_LEAD = 'HOT_LEAD', // a lead crossed the hot threshold
  MORNING_BRIEFING = 'MORNING_BRIEFING', // the 7:30 AM digest
  APPROVAL_PENDING = 'APPROVAL_PENDING', // an AI draft needs review
  TAKEOVER = 'TAKEOVER', // a conversation was handed to a human
  VISIT_REMINDER = 'VISIT_REMINDER', // an upcoming site visit
}
