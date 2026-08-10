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
/**
 * Lifecycle of a scheduled site visit. BOOKED on creation; CONFIRMED once the
 * buyer acknowledges; COMPLETED / NO_SHOW are terminal outcomes; RESCHEDULED
 * marks a moved visit; CANCELLED frees the slot.
 */
export declare enum SiteVisitStatus {
    BOOKED = "BOOKED",
    CONFIRMED = "CONFIRMED",
    COMPLETED = "COMPLETED",
    NO_SHOW = "NO_SHOW",
    RESCHEDULED = "RESCHEDULED",
    CANCELLED = "CANCELLED"
}
/**
 * Post-visit outcome logged by the broker (drives the follow-up track and
 * pipeline stage). PENDING until the visit is completed and reviewed.
 */
export declare enum SiteVisitOutcome {
    PENDING = "PENDING",
    INTERESTED = "INTERESTED",
    NOT_INTERESTED = "NOT_INTERESTED",
    WANTS_ALTERNATIVE = "WANTS_ALTERNATIVE",
    NEEDS_FOLLOWUP = "NEEDS_FOLLOWUP",
    TOKEN_BOOKED = "TOKEN_BOOKED"
}
/**
 * Recognised property-portal enquiry sources. Parsed from portal enquiry
 * emails and stored as the lead's `sub_source` for source-level ROI.
 */
export declare enum RealtyPortal {
    NINETYNINE_ACRES = "99ACRES",
    MAGICBRICKS = "MAGICBRICKS",
    HOUSING = "HOUSING",
    UNKNOWN = "UNKNOWN"
}
/**
 * The 14 real-estate conversational intents the AI loop classifies every
 * inbound buyer/seller message into (blueprint §16.1). `GENERAL` is the
 * catch-all fallback when nothing more specific is resolved.
 */
export declare enum RealtyIntent {
    NEW_ENQUIRY = "NEW_ENQUIRY",// first contact about a property/listing
    PRICE_INQUIRY = "PRICE_INQUIRY",// "kitne ka hai", asking price/rate
    AVAILABILITY = "AVAILABILITY",// is X config/unit available?
    SITE_VISIT = "SITE_VISIT",// wants to visit / book a viewing
    DOC_REQUEST = "DOC_REQUEST",// brochure, floor plan, price sheet, RERA doc
    LOCATION_AMENITY = "LOCATION_AMENITY",// where is it, what's nearby, amenities
    LOAN_QUERY = "LOAN_QUERY",// home loan / EMI / financing question
    NEGOTIATION = "NEGOTIATION",// asking for a discount / price drop
    LEGAL_RERA = "LEGAL_RERA",// RERA, possession date, approvals, legal
    SELLER_LEAD = "SELLER_LEAD",// owner wanting to sell/list a property
    RENTAL = "RENTAL",// looking to rent, not buy
    REACTIVATION_REPLY = "REACTIVATION_REPLY",// replying to a nurture/cadence ping
    COMPLAINT_ABUSE = "COMPLAINT_ABUSE",// complaint, spam report, abuse
    GENERAL = "GENERAL"
}
/**
 * Per-intent default autonomy ceiling. Overrides any numeric confidence — the
 * AI may never act beyond an intent's policy (blueprint §16.3 hard rules).
 */
export declare enum RealtyRoutePolicy {
    /** May auto-execute when data + policy are clear (e.g. fresh AVAILABILITY, DOC send). */
    AUTO_ALLOWED = "AUTO_ALLOWED",
    /** Never auto-send; always draft for a human first (e.g. PRICE_INQUIRY). */
    DRAFT_ONLY = "DRAFT_ONLY",
    /** Always a full human hand-off (NEGOTIATION, LEGAL_RERA, LOAN_QUERY, SELLER_LEAD, COMPLAINT_ABUSE). */
    ESCALATE = "ESCALATE"
}
/** What enrols a lead into a follow-up cadence. */
export declare enum CadenceTrigger {
    NO_RESPONSE = "NO_RESPONSE",// buyer went quiet after an enquiry
    POST_VISIT = "POST_VISIT",// site visit completed — nurture to close
    DORMANT = "DORMANT"
}
/** A signal that halts a running cadence immediately. */
export declare enum CadenceStopOn {
    REPLY = "REPLY",// buyer replied — human/AI takes the wheel
    OPTOUT = "OPTOUT",// buyer opted out — absolute stop
    STAGE_CHANGE = "STAGE_CHANGE"
}
/** Lifecycle of a single lead's enrolment in a cadence. */
export declare enum CadenceEnrollmentStatus {
    ACTIVE = "ACTIVE",
    COMPLETED = "COMPLETED",// ran to the last step
    STOPPED = "STOPPED"
}
/**
 * WhatsApp template category. Enforced in code: a MARKETING template may never
 * be sent inside a closed 24h service window, and only category-correct
 * templates are allowed (blueprint §21 WhatsApp hygiene).
 */
export declare enum TemplateCategory {
    UTILITY = "UTILITY",
    MARKETING = "MARKETING"
}
/** Meta approval state of a template — sends are blocked unless APPROVED. */
export declare enum TemplateApprovalStatus {
    PENDING = "PENDING",
    APPROVED = "APPROVED",
    REJECTED = "REJECTED"
}
/** GoSumo Realty subscription tiers (business plan §9). */
export declare enum RealtyPlan {
    SOLO = "SOLO",// ₹3,999/mo · 1 seat · 300 leads/mo
    TEAM = "TEAM",// ₹9,999/mo · 5 seats · 1,500 leads/mo · routing + analytics
    DEVELOPER = "DEVELOPER"
}
/** The DPDPA consent purpose a buyer has granted (or had revoked). */
export declare enum ConsentType {
    PROCESSING = "PROCESSING",// process personal data to assist the property search
    MARKETING = "MARKETING",// enrol in follow-up / marketing cadences
    EXCHANGE = "EXCHANGE"
}
/** State of an AI draft awaiting human review (70–89% confidence band). */
export declare enum ApprovalStatus {
    PENDING = "PENDING",
    APPROVED = "APPROVED",// sent verbatim
    EDITED = "EDITED",// broker edited then sent
    REJECTED = "REJECTED"
}
/**
 * Per-account AI independence level (the "autonomy dial"). Raised only on
 * evidence during pilot migration.
 */
export declare enum AutonomyLevel {
    SUGGEST = "SUGGEST",// AI drafts everything; broker approves every send
    ASSISTED = "ASSISTED",// AI auto-sends high-confidence, drafts the rest
    AUTONOMOUS = "AUTONOMOUS"
}
/** Who currently owns a conversation — the AI or a human broker (takeover). */
export declare enum ConversationOwner {
    AI = "AI",
    HUMAN = "HUMAN"
}
/** Kinds of item that surface in the broker's notification centre. */
export declare enum BrokerAlertType {
    HOT_LEAD = "HOT_LEAD",// a lead crossed the hot threshold
    MORNING_BRIEFING = "MORNING_BRIEFING",// the 7:30 AM digest
    APPROVAL_PENDING = "APPROVAL_PENDING",// an AI draft needs review
    TAKEOVER = "TAKEOVER",// a conversation was handed to a human
    VISIT_REMINDER = "VISIT_REMINDER"
}
/** What kind of existing broker data a pilot-migration run imported. */
export declare enum MigrationKind {
    LEADS = "LEADS",// active enquiries with (partial) BLTC
    CONTACTS = "CONTACTS",// a plain phonebook — leads with minimal profile
    INVENTORY = "INVENTORY"
}
/**
 * Lifecycle of a migration run. A dry-run ends at VALIDATED (nothing written);
 * a committed run ends COMMITTED (or FAILED if the write path errored).
 */
export declare enum MigrationStatus {
    VALIDATED = "VALIDATED",// parsed + validated, nothing persisted (dry-run)
    COMMITTED = "COMMITTED",// rows written to the domain modules
    FAILED = "FAILED"
}
/**
 * Direction the evidence-driven autonomy dial moved on an evaluation. The dial
 * only ever OPENs one rung at a time, and any no-ship incident forces a CLOSE
 * back to the safe floor (blueprint §24 no-ship rule).
 */
export declare enum AutonomyDirection {
    OPEN = "OPEN",// evidence met — AI given more independence
    HOLD = "HOLD",// evidence not yet sufficient — no change
    CLOSE = "CLOSE"
}
/** Who triggered an autonomy-dial change — an operator or an automatic sweep. */
export declare enum AutonomyActorType {
    HUMAN = "HUMAN",
    AI = "AI"
}
/**
 * A "no-ship" condition that reached (or would have reached) a buyer — the
 * launch-gate hard fails if any occurred in the window (blueprint §24). In a
 * healthy system the guardrails block these upstream, so the ledger stays empty.
 */
export declare enum NoShipKind {
    UNVERIFIED_PRICE = "UNVERIFIED_PRICE",// a price absent from a verified sheet
    STALE_AVAILABILITY = "STALE_AVAILABILITY",// availability affirmed for SOLD/HOLD/UNVERIFIED
    OPTED_OUT_SEND = "OPTED_OUT_SEND",// a send to an opted-out number
    RERA_CLAIM = "RERA_CLAIM",// a RERA claim beyond sheet-verbatim
    CROSS_BUYER = "CROSS_BUYER"
}
/** Overall verdict of the launch-readiness gate (blueprint §24). */
export declare enum LaunchGateStatus {
    GO = "GO",// every gate passed — cleared to launch
    NO_GO = "NO_GO",// at least one gate hard-failed
    NOT_READY = "NOT_READY"
}
/** Per-check outcome inside a launch-gate report. */
export declare enum LaunchCheckStatus {
    PASS = "PASS",
    FAIL = "FAIL",
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
}
/**
 * The corridor-pattern metrics computed nightly by the micro-market intelligence
 * layer. Each aggregate row carries exactly one; the JSONB payload shape is
 * metric-specific (documented in the realty-intelligence module CLAUDE.md).
 */
export declare enum IntelligenceMetricType {
    CADENCE_CONVERSION = "CADENCE_CONVERSION",// which follow-up timing converts, by corridor
    OBJECTION_FREQUENCY = "OBJECTION_FREQUENCY",// recurring objections, by project/config type
    PRICE_ELASTICITY = "PRICE_ELASTICITY",// realistic budget bands, by locality
    SOURCE_QUALITY = "SOURCE_QUALITY",// downstream quality of each lead source
    SEASONAL_VELOCITY = "SEASONAL_VELOCITY"
}
/**
 * Lifecycle of a co-broking syndication — the formalised 50:50 deal share.
 * OFFERED once the originating broker syndicates a consented lead; ACCEPTED
 * when the counterparty takes it on; VISIT after the buyer physically visits;
 * CLOSED on a booked deal (commission pool + platform fee settle); EXPIRED if
 * the offer lapses unaccepted; DISPUTED if either side contests the split.
 */
export declare enum SyndicationState {
    OFFERED = "OFFERED",
    ACCEPTED = "ACCEPTED",
    VISIT = "VISIT",
    CLOSED = "CLOSED",
    EXPIRED = "EXPIRED",
    DISPUTED = "DISPUTED"
}
/**
 * Settlement posture of a syndication's money leg — tracked separately from the
 * deal `state` so a CLOSED deal can still be awaiting payout. UNSETTLED until
 * close; PENDING once the platform fee is computed and collection is due;
 * SETTLED after payout; REVERSED if a dispute unwinds it.
 */
export declare enum SettlementState {
    UNSETTLED = "UNSETTLED",
    PENDING = "PENDING",
    SETTLED = "SETTLED",
    REVERSED = "REVERSED"
}
/**
 * Status of a resale listing — Tier-1 "oxygen" supply that also feeds the
 * exchange. ACTIVE is matchable; UNDER_OFFER is soft-held; SOLD / WITHDRAWN are
 * terminal and excluded from matching.
 */
export declare enum ResaleListingStatus {
    ACTIVE = "ACTIVE",
    UNDER_OFFER = "UNDER_OFFER",
    SOLD = "SOLD",
    WITHDRAWN = "WITHDRAWN"
}
