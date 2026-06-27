"use strict";
// ─────────────────────────────────────────────
// CHANNEL & MESSAGING
// ─────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.CartStatus = exports.DiscountType = exports.CatalogItemType = exports.CampaignType = exports.InvoiceStatus = exports.RefundMethod = exports.RefundType = exports.RefundStatus = exports.PaymentGateway = exports.TeamRole = exports.ShipmentStatus = exports.RecurrenceFrequency = exports.BookingActor = exports.BookingLocationType = exports.BookingStatus = exports.PaymentMethod = exports.PaymentStatus = exports.OrderStatus = exports.ConfidenceMode = exports.IntentType = exports.TaskPriority = exports.TaskType = exports.TaskStatus = exports.ConversationPriority = exports.ConversationStatus = exports.MessageStatus = exports.MessageContentType = exports.MessageDirection = exports.ChannelType = void 0;
var ChannelType;
(function (ChannelType) {
    ChannelType["WHATSAPP"] = "WHATSAPP";
    ChannelType["INSTAGRAM"] = "INSTAGRAM";
    ChannelType["SMS"] = "SMS";
    ChannelType["WEB_CHAT"] = "WEB_CHAT";
    ChannelType["EMAIL"] = "EMAIL";
})(ChannelType || (exports.ChannelType = ChannelType = {}));
var MessageDirection;
(function (MessageDirection) {
    MessageDirection["INBOUND"] = "INBOUND";
    MessageDirection["OUTBOUND"] = "OUTBOUND";
})(MessageDirection || (exports.MessageDirection = MessageDirection = {}));
var MessageContentType;
(function (MessageContentType) {
    MessageContentType["TEXT"] = "TEXT";
    MessageContentType["IMAGE"] = "IMAGE";
    MessageContentType["DOCUMENT"] = "DOCUMENT";
    MessageContentType["LOCATION"] = "LOCATION";
    MessageContentType["INTERACTIVE"] = "INTERACTIVE";
    MessageContentType["PAYMENT_LINK"] = "PAYMENT_LINK";
    MessageContentType["TEMPLATE"] = "TEMPLATE";
})(MessageContentType || (exports.MessageContentType = MessageContentType = {}));
var MessageStatus;
(function (MessageStatus) {
    MessageStatus["PENDING"] = "PENDING";
    MessageStatus["SENT"] = "SENT";
    MessageStatus["DELIVERED"] = "DELIVERED";
    MessageStatus["READ"] = "READ";
    MessageStatus["FAILED"] = "FAILED";
})(MessageStatus || (exports.MessageStatus = MessageStatus = {}));
// ─────────────────────────────────────────────
// CONVERSATION
// ─────────────────────────────────────────────
var ConversationStatus;
(function (ConversationStatus) {
    ConversationStatus["OPEN"] = "OPEN";
    ConversationStatus["PENDING_HUMAN"] = "PENDING_HUMAN";
    ConversationStatus["ESCALATED"] = "ESCALATED";
    ConversationStatus["RESOLVED"] = "RESOLVED";
    ConversationStatus["SNOOZED"] = "SNOOZED";
})(ConversationStatus || (exports.ConversationStatus = ConversationStatus = {}));
var ConversationPriority;
(function (ConversationPriority) {
    ConversationPriority["LOW"] = "LOW";
    ConversationPriority["MEDIUM"] = "MEDIUM";
    ConversationPriority["HIGH"] = "HIGH";
    ConversationPriority["URGENT"] = "URGENT";
})(ConversationPriority || (exports.ConversationPriority = ConversationPriority = {}));
// ─────────────────────────────────────────────
// TASKS (HITL)
// ─────────────────────────────────────────────
var TaskStatus;
(function (TaskStatus) {
    TaskStatus["PENDING"] = "PENDING";
    TaskStatus["IN_PROGRESS"] = "IN_PROGRESS";
    TaskStatus["RESOLVED"] = "RESOLVED";
    TaskStatus["ESCALATED"] = "ESCALATED";
    TaskStatus["EXPIRED"] = "EXPIRED";
})(TaskStatus || (exports.TaskStatus = TaskStatus = {}));
var TaskType;
(function (TaskType) {
    TaskType["REVIEW_RESPONSE"] = "REVIEW_RESPONSE";
    TaskType["APPROVE_REFUND"] = "APPROVE_REFUND";
    TaskType["APPROVE_DISCOUNT"] = "APPROVE_DISCOUNT";
    TaskType["HANDLE_COMPLAINT"] = "HANDLE_COMPLAINT";
    TaskType["CLARIFY_INTENT"] = "CLARIFY_INTENT";
    TaskType["FOLLOW_UP"] = "FOLLOW_UP";
    TaskType["APPROVE_ORDER"] = "APPROVE_ORDER";
    TaskType["CUSTOM"] = "CUSTOM";
})(TaskType || (exports.TaskType = TaskType = {}));
var TaskPriority;
(function (TaskPriority) {
    TaskPriority["LOW"] = "LOW";
    TaskPriority["MEDIUM"] = "MEDIUM";
    TaskPriority["HIGH"] = "HIGH";
    TaskPriority["URGENT"] = "URGENT";
})(TaskPriority || (exports.TaskPriority = TaskPriority = {}));
// ─────────────────────────────────────────────
// AI ENGINE
// ─────────────────────────────────────────────
var IntentType;
(function (IntentType) {
    IntentType["BOOKING"] = "BOOKING";
    IntentType["PRICING"] = "PRICING";
    IntentType["ORDER"] = "ORDER";
    IntentType["PAYMENT"] = "PAYMENT";
    IntentType["COMPLAINT"] = "COMPLAINT";
    IntentType["PROMOTION_RESPONSE"] = "PROMOTION_RESPONSE";
    IntentType["GENERAL_INQUIRY"] = "GENERAL_INQUIRY";
    IntentType["CANCELLATION"] = "CANCELLATION";
    IntentType["REFUND"] = "REFUND";
    IntentType["FOLLOW_UP"] = "FOLLOW_UP";
    IntentType["CHIT_CHAT"] = "CHIT_CHAT";
    IntentType["ORDER_TRACKING"] = "ORDER_TRACKING";
    IntentType["RETURNS"] = "RETURNS";
})(IntentType || (exports.IntentType = IntentType = {}));
var ConfidenceMode;
(function (ConfidenceMode) {
    /** AI acts autonomously — confidence >= 90% */
    ConfidenceMode["AUTO_PILOT"] = "AUTO_PILOT";
    /** AI prepares a draft for human review — confidence 70-89% */
    ConfidenceMode["DRAFT"] = "DRAFT";
    /** AI surfaces options, human picks — confidence 50-69% */
    ConfidenceMode["GUIDED"] = "GUIDED";
    /** Full hand-off to human — confidence < 50% */
    ConfidenceMode["ESCALATION"] = "ESCALATION";
})(ConfidenceMode || (exports.ConfidenceMode = ConfidenceMode = {}));
// ─────────────────────────────────────────────
// COMMERCE — ORDERS
// ─────────────────────────────────────────────
var OrderStatus;
(function (OrderStatus) {
    OrderStatus["DRAFT"] = "DRAFT";
    OrderStatus["CONFIRMED"] = "CONFIRMED";
    OrderStatus["PROCESSING"] = "PROCESSING";
    OrderStatus["PACKED"] = "PACKED";
    OrderStatus["SHIPPED"] = "SHIPPED";
    OrderStatus["DELIVERED"] = "DELIVERED";
    OrderStatus["CANCELLED"] = "CANCELLED";
    OrderStatus["REFUNDED"] = "REFUNDED";
    OrderStatus["PARTIALLY_REFUNDED"] = "PARTIALLY_REFUNDED";
    OrderStatus["RETURNED"] = "RETURNED";
})(OrderStatus || (exports.OrderStatus = OrderStatus = {}));
// ─────────────────────────────────────────────
// COMMERCE — PAYMENTS
// ─────────────────────────────────────────────
var PaymentStatus;
(function (PaymentStatus) {
    PaymentStatus["PENDING"] = "PENDING";
    PaymentStatus["INITIATED"] = "INITIATED";
    PaymentStatus["SUCCESS"] = "SUCCESS";
    PaymentStatus["FAILED"] = "FAILED";
    PaymentStatus["EXPIRED"] = "EXPIRED";
    PaymentStatus["REFUNDED"] = "REFUNDED";
    PaymentStatus["PARTIALLY_REFUNDED"] = "PARTIALLY_REFUNDED";
})(PaymentStatus || (exports.PaymentStatus = PaymentStatus = {}));
var PaymentMethod;
(function (PaymentMethod) {
    PaymentMethod["UPI"] = "UPI";
    PaymentMethod["CARD"] = "CARD";
    PaymentMethod["NET_BANKING"] = "NET_BANKING";
    PaymentMethod["WALLET"] = "WALLET";
    PaymentMethod["COD"] = "COD";
    PaymentMethod["CASH_PICKUP"] = "CASH_PICKUP";
    PaymentMethod["CASH_INSTORE"] = "CASH_INSTORE";
})(PaymentMethod || (exports.PaymentMethod = PaymentMethod = {}));
// ─────────────────────────────────────────────
// COMMERCE — BOOKINGS
// ─────────────────────────────────────────────
var BookingStatus;
(function (BookingStatus) {
    /** Awaiting confirmation (e.g. deposit/payment pending) */
    BookingStatus["PENDING"] = "PENDING";
    /** Confirmed and on the calendar */
    BookingStatus["CONFIRMED"] = "CONFIRMED";
    /** Time was changed after confirmation */
    BookingStatus["RESCHEDULED"] = "RESCHEDULED";
    BookingStatus["CANCELLED"] = "CANCELLED";
    BookingStatus["COMPLETED"] = "COMPLETED";
    BookingStatus["NO_SHOW"] = "NO_SHOW";
})(BookingStatus || (exports.BookingStatus = BookingStatus = {}));
/** Where a booking takes place. Stored as a string on the booking row. */
var BookingLocationType;
(function (BookingLocationType) {
    BookingLocationType["IN_PERSON"] = "IN_PERSON";
    BookingLocationType["ONLINE"] = "ONLINE";
    BookingLocationType["HOME_VISIT"] = "HOME_VISIT";
})(BookingLocationType || (exports.BookingLocationType = BookingLocationType = {}));
/** Who triggered a booking state change. */
var BookingActor;
(function (BookingActor) {
    BookingActor["CLIENT"] = "CLIENT";
    BookingActor["BUSINESS"] = "BUSINESS";
    BookingActor["SYSTEM"] = "SYSTEM";
})(BookingActor || (exports.BookingActor = BookingActor = {}));
/** Recurrence frequency for recurring appointment series. */
var RecurrenceFrequency;
(function (RecurrenceFrequency) {
    RecurrenceFrequency["DAILY"] = "DAILY";
    RecurrenceFrequency["WEEKLY"] = "WEEKLY";
    RecurrenceFrequency["MONTHLY"] = "MONTHLY";
})(RecurrenceFrequency || (exports.RecurrenceFrequency = RecurrenceFrequency = {}));
// ─────────────────────────────────────────────
// COMMERCE — SHIPMENTS
// ─────────────────────────────────────────────
var ShipmentStatus;
(function (ShipmentStatus) {
    ShipmentStatus["CREATED"] = "CREATED";
    ShipmentStatus["LABEL_GENERATED"] = "LABEL_GENERATED";
    ShipmentStatus["PICKED_UP"] = "PICKED_UP";
    ShipmentStatus["IN_TRANSIT"] = "IN_TRANSIT";
    ShipmentStatus["OUT_FOR_DELIVERY"] = "OUT_FOR_DELIVERY";
    ShipmentStatus["DELIVERED"] = "DELIVERED";
    ShipmentStatus["RTO"] = "RTO";
    ShipmentStatus["FAILED"] = "FAILED";
    ShipmentStatus["CANCELLED"] = "CANCELLED";
})(ShipmentStatus || (exports.ShipmentStatus = ShipmentStatus = {}));
// ─────────────────────────────────────────────
// PLATFORM
// ─────────────────────────────────────────────
var TeamRole;
(function (TeamRole) {
    TeamRole["OWNER"] = "OWNER";
    TeamRole["MANAGER"] = "MANAGER";
    TeamRole["STAFF"] = "STAFF";
})(TeamRole || (exports.TeamRole = TeamRole = {}));
// ─────────────────────────────────────────────
// COMMERCE — PAYMENT GATEWAYS
// ─────────────────────────────────────────────
var PaymentGateway;
(function (PaymentGateway) {
    PaymentGateway["RAZORPAY"] = "RAZORPAY";
    PaymentGateway["PAYTM"] = "PAYTM";
    PaymentGateway["PHONEPE"] = "PHONEPE";
    PaymentGateway["STRIPE"] = "STRIPE";
    PaymentGateway["MANUAL"] = "MANUAL";
})(PaymentGateway || (exports.PaymentGateway = PaymentGateway = {}));
// ─────────────────────────────────────────────
// REFUNDS
// ─────────────────────────────────────────────
var RefundStatus;
(function (RefundStatus) {
    RefundStatus["INITIATED"] = "INITIATED";
    RefundStatus["PROCESSING"] = "PROCESSING";
    RefundStatus["COMPLETED"] = "COMPLETED";
    RefundStatus["FAILED"] = "FAILED";
    RefundStatus["REJECTED"] = "REJECTED";
})(RefundStatus || (exports.RefundStatus = RefundStatus = {}));
var RefundType;
(function (RefundType) {
    RefundType["FULL"] = "FULL";
    RefundType["PARTIAL"] = "PARTIAL";
    RefundType["DEPOSIT_ONLY"] = "DEPOSIT_ONLY";
})(RefundType || (exports.RefundType = RefundType = {}));
var RefundMethod;
(function (RefundMethod) {
    RefundMethod["ORIGINAL_PAYMENT"] = "ORIGINAL_PAYMENT";
    RefundMethod["STORE_CREDIT"] = "STORE_CREDIT";
    RefundMethod["MANUAL_TRANSFER"] = "MANUAL_TRANSFER";
})(RefundMethod || (exports.RefundMethod = RefundMethod = {}));
// ─────────────────────────────────────────────
// INVOICES
// ─────────────────────────────────────────────
var InvoiceStatus;
(function (InvoiceStatus) {
    InvoiceStatus["DRAFT"] = "DRAFT";
    InvoiceStatus["ISSUED"] = "ISSUED";
    InvoiceStatus["PAID"] = "PAID";
    InvoiceStatus["CANCELLED"] = "CANCELLED";
    InvoiceStatus["VOID"] = "VOID";
})(InvoiceStatus || (exports.InvoiceStatus = InvoiceStatus = {}));
// ─────────────────────────────────────────────
// CAMPAIGNS
// ─────────────────────────────────────────────
var CampaignType;
(function (CampaignType) {
    CampaignType["BIRTHDAY"] = "BIRTHDAY";
    CampaignType["WIN_BACK"] = "WIN_BACK";
    CampaignType["LOYALTY"] = "LOYALTY";
    CampaignType["FEEDBACK"] = "FEEDBACK";
    CampaignType["REMINDER"] = "REMINDER";
    CampaignType["CUSTOM"] = "CUSTOM";
})(CampaignType || (exports.CampaignType = CampaignType = {}));
// ─────────────────────────────────────────────
// COMMERCE — CATALOG
// ─────────────────────────────────────────────
var CatalogItemType;
(function (CatalogItemType) {
    CatalogItemType["PRODUCT"] = "PRODUCT";
    CatalogItemType["SERVICE"] = "SERVICE";
    CatalogItemType["DIGITAL"] = "DIGITAL";
    CatalogItemType["SUBSCRIPTION"] = "SUBSCRIPTION";
})(CatalogItemType || (exports.CatalogItemType = CatalogItemType = {}));
/**
 * How a coupon/discount value is interpreted.
 * PERCENT — value is a percentage (0–100) of the order subtotal.
 * FIXED   — value is a flat amount in rupees subtracted from the subtotal.
 */
var DiscountType;
(function (DiscountType) {
    DiscountType["PERCENT"] = "PERCENT";
    DiscountType["FIXED"] = "FIXED";
})(DiscountType || (exports.DiscountType = DiscountType = {}));
/**
 * Lifecycle of a shopping cart.
 * ACTIVE    — the customer is still adding/removing items.
 * CONVERTED — the cart became an order at checkout.
 * ABANDONED — the cart was explicitly abandoned or expired.
 */
var CartStatus;
(function (CartStatus) {
    CartStatus["ACTIVE"] = "ACTIVE";
    CartStatus["CONVERTED"] = "CONVERTED";
    CartStatus["ABANDONED"] = "ABANDONED";
})(CartStatus || (exports.CartStatus = CartStatus = {}));
//# sourceMappingURL=index.js.map