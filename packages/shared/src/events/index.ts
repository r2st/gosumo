import { ChannelType, ConversationStatus, IntentType, MessageStatus, OrderStatus, PaymentStatus, BookingStatus, ShipmentStatus } from '../enums';
import { ConfidenceScore, SuggestedAction } from '../interfaces';

// ─────────────────────────────────────────────
// BASE EVENT
// ─────────────────────────────────────────────

/**
 * All domain events extend BaseEvent.
 * The event bus and BullMQ processors use these fields for
 * routing, deduplication, and distributed tracing.
 */
export interface BaseEvent {
  /** Unique event ID (UUID v4) — used for idempotency */
  id: string;
  /** ISO-8601 timestamp of when the event was emitted */
  timestamp: string;
  /** Tenant scope — every event carries businessId for multi-tenant safety */
  businessId: string;
  /** Distributed trace ID shared across all events in one request chain */
  correlationId: string;
}

// ─────────────────────────────────────────────
// MESSAGING EVENTS
// ─────────────────────────────────────────────

/** Emitted by the channel adapter after normalizing an inbound message */
export interface MessageReceivedEvent extends BaseEvent {
  readonly type: 'message.received';
  messageId: string;
  conversationId: string;
  channelAccountId: string;
  channel: ChannelType;
  senderExternalId: string;
  clientId: string;
}

/** Emitted after a message is successfully sent to the channel */
export interface MessageSentEvent extends BaseEvent {
  readonly type: 'message.sent';
  messageId: string;
  conversationId: string;
  channelAccountId: string;
  channel: ChannelType;
  externalMessageId: string;
  recipientExternalId: string;
  /** Wall-clock time from emit to channel acknowledgement (ms) */
  latencyMs: number;
}

/** Emitted when an outbound message delivery fails permanently */
export interface MessageFailedEvent extends BaseEvent {
  readonly type: 'message.failed';
  messageId: string;
  conversationId: string;
  channelAccountId: string;
  channel: ChannelType;
  recipientExternalId: string;
  reason: string;
  attempts: number;
}

// ─────────────────────────────────────────────
// CONVERSATION EVENTS
// ─────────────────────────────────────────────

export interface ConversationCreatedEvent extends BaseEvent {
  readonly type: 'conversation.created';
  conversationId: string;
  clientId: string;
  channelAccountId: string;
  channel: ChannelType;
}

export interface ConversationResolvedEvent extends BaseEvent {
  readonly type: 'conversation.resolved';
  conversationId: string;
  clientId: string;
  /** "AI" | "HUMAN" | "SYSTEM" */
  resolvedBy: string;
  resolvedByActorId?: string;
  /** Duration from first message to resolution (seconds) */
  resolutionDurationSeconds: number;
  csatScore?: number;
}

export interface ConversationEscalatedEvent extends BaseEvent {
  readonly type: 'conversation.escalated';
  conversationId: string;
  clientId: string;
  taskId: string;
  /** The team member the conversation was assigned to */
  assignedToMemberId?: string;
  reason: string;
}

export interface ConversationStatusChangedEvent extends BaseEvent {
  readonly type: 'conversation.status.changed';
  conversationId: string;
  clientId: string;
  previousStatus: ConversationStatus;
  newStatus: ConversationStatus;
  /** ID of the actor who triggered the status change (team_member or system) */
  actorId?: string;
}

export interface ConversationAssignedEvent extends BaseEvent {
  readonly type: 'conversation.assigned';
  conversationId: string;
  clientId: string;
  assigneeId: string;
  /** Previous assignee, if any */
  previousAssigneeId?: string;
}

// ─────────────────────────────────────────────
// MESSAGE STORAGE EVENTS
// ─────────────────────────────────────────────

/** Emitted after an inbound or outbound message is persisted to the database */
export interface MessageStoredEvent extends BaseEvent {
  readonly type: 'message.stored';
  messageId: string;
  conversationId: string;
  channelAccountId: string;
  channel: ChannelType;
  direction: string;
  senderType: string;
}

// ─────────────────────────────────────────────
// AI ENGINE EVENTS
// ─────────────────────────────────────────────

export interface AIIntentClassifiedEvent extends BaseEvent {
  readonly type: 'ai.intent.classified';
  conversationId: string;
  messageId: string;
  intent: IntentType;
  confidence: number;
  alternativeIntents: Array<{ intent: IntentType; confidence: number }>;
}

export interface AIResponseGeneratedEvent extends BaseEvent {
  readonly type: 'ai.response.generated';
  conversationId: string;
  messageId: string;
  aiDecisionId: string;
  intent: IntentType;
  confidenceScore: ConfidenceScore;
  suggestedActions: SuggestedAction[];
  modelId: string;
  latencyMs: number;
}

export interface AIResponseApprovedEvent extends BaseEvent {
  readonly type: 'ai.response.approved';
  conversationId: string;
  aiDecisionId: string;
  taskId: string;
  approvedByMemberId: string;
  /** Whether the human edited the AI draft before approving */
  wasEdited: boolean;
}

export interface AIResponseRejectedEvent extends BaseEvent {
  readonly type: 'ai.response.rejected';
  conversationId: string;
  aiDecisionId: string;
  taskId: string;
  rejectedByMemberId: string;
  rejectionReason?: string;
}

// ─────────────────────────────────────────────
// TASK (HITL) EVENTS
// ─────────────────────────────────────────────

export interface TaskCreatedEvent extends BaseEvent {
  readonly type: 'task.created';
  taskId: string;
  conversationId: string;
  aiDecisionId?: string;
  taskType: string;
  priority: string;
  assignedToMemberId?: string;
  dueAt?: string;
}

export interface TaskAssignedEvent extends BaseEvent {
  readonly type: 'task.assigned';
  taskId: string;
  conversationId: string;
  assignedToMemberId: string;
}

export interface TaskResolvedEvent extends BaseEvent {
  readonly type: 'task.resolved';
  taskId: string;
  conversationId: string;
  resolvedByMemberId: string;
  resolutionNote?: string;
  /** Wall-clock time from task creation to resolution (seconds) */
  resolutionDurationSeconds: number;
  slaBreach: boolean;
}

// ─────────────────────────────────────────────
// ORDER EVENTS
// ─────────────────────────────────────────────

export interface OrderCreatedEvent extends BaseEvent {
  readonly type: 'order.created';
  orderId: string;
  orderNumber: string;
  clientId: string;
  conversationId?: string;
  /** Total in paise */
  totalPaise: number;
  currency: string;
  lineItemCount: number;
}

export interface OrderPaidEvent extends BaseEvent {
  readonly type: 'order.paid';
  orderId: string;
  orderNumber: string;
  clientId: string;
  paymentId: string;
  /** Amount paid in paise */
  amountPaise: number;
  currency: string;
  status: OrderStatus;
}

export interface OrderConfirmedEvent extends BaseEvent {
  readonly type: 'order.confirmed';
  orderId: string;
  orderNumber: string;
  clientId: string;
  confirmedAt: string;
}

export interface OrderCancelledEvent extends BaseEvent {
  readonly type: 'order.cancelled';
  orderId: string;
  orderNumber: string;
  clientId: string;
  reason?: string;
  cancelledBy: string;
}

export interface OrderPackedEvent extends BaseEvent {
  readonly type: 'order.packed';
  orderId: string;
  orderNumber: string;
  clientId: string;
}

export interface OrderShippedEvent extends BaseEvent {
  readonly type: 'order.shipped';
  orderId: string;
  orderNumber: string;
  clientId: string;
  shipmentId: string;
  trackingNumber?: string;
  trackingUrl?: string;
  carrier?: string;
  estimatedDeliveryAt?: string;
}

export interface OrderDeliveredEvent extends BaseEvent {
  readonly type: 'order.delivered';
  orderId: string;
  orderNumber: string;
  clientId: string;
  deliveredAt: string;
}

export interface OrderReturnedEvent extends BaseEvent {
  readonly type: 'order.returned';
  orderId: string;
  orderNumber: string;
  clientId: string;
  reason?: string;
  returnedAt: string;
}

// ─────────────────────────────────────────────
// PAYMENT EVENTS
// ─────────────────────────────────────────────

export interface PaymentCreatedEvent extends BaseEvent {
  readonly type: 'payment.created';
  paymentId: string;
  orderId?: string;
  clientId: string;
  /** Amount in paise */
  amountPaise: number;
  currency: string;
  paymentLinkUrl?: string;
}

export interface PaymentSuccessEvent extends BaseEvent {
  readonly type: 'payment.success';
  paymentId: string;
  orderId?: string;
  clientId: string;
  /** Amount captured in paise */
  amountPaise: number;
  currency: string;
  status: PaymentStatus;
  gatewayPaymentId: string;
}

export interface PaymentFailedEvent extends BaseEvent {
  readonly type: 'payment.failed';
  paymentId: string;
  orderId?: string;
  clientId: string;
  /** Amount in paise */
  amountPaise: number;
  currency: string;
  reason: string;
}

export interface PaymentRefundEvent extends BaseEvent {
  readonly type: 'payment.refund.initiated' | 'payment.refund.completed';
  refundId: string;
  paymentId: string;
  orderId?: string;
  clientId: string;
  /** Refund amount in paise */
  amountPaise: number;
  currency: string;
  reason?: string;
}

// ─────────────────────────────────────────────
// INVOICE EVENTS
// ─────────────────────────────────────────────

export interface InvoiceCreatedEvent extends BaseEvent {
  readonly type: 'invoice.created';
  invoiceId: string;
  invoiceNumber: string;
  orderId?: string;
  clientId: string;
  paymentId?: string;
  /** Total amount in paise */
  totalPaise: number;
  currency: string;
}

export interface InvoiceIssuedEvent extends BaseEvent {
  readonly type: 'invoice.issued';
  invoiceId: string;
  invoiceNumber: string;
  clientId: string;
  /** Total amount in paise */
  totalPaise: number;
  currency: string;
}

export interface InvoicePaidEvent extends BaseEvent {
  readonly type: 'invoice.paid';
  invoiceId: string;
  invoiceNumber: string;
  paymentId: string;
  clientId: string;
  /** Total amount in paise */
  totalPaise: number;
  currency: string;
}

// ─────────────────────────────────────────────
// BOOKING EVENTS
// ─────────────────────────────────────────────

export interface BookingCreatedEvent extends BaseEvent {
  readonly type: 'booking.created';
  bookingId: string;
  clientId: string;
  catalogItemId?: string;
  staffMemberId?: string;
  startAt: string;
  endAt: string;
  status: BookingStatus;
}

export interface BookingCancelledEvent extends BaseEvent {
  readonly type: 'booking.cancelled';
  bookingId: string;
  clientId: string;
  /** "CLIENT" | "BUSINESS" | "SYSTEM" */
  cancelledBy: string;
  cancelledByActorId?: string;
  reason?: string;
}

/** Emitted when a booking transitions PENDING → CONFIRMED. */
export interface BookingConfirmedEvent extends BaseEvent {
  readonly type: 'booking.confirmed';
  bookingId: string;
  clientId: string;
  catalogItemId?: string;
  staffMemberId?: string;
  startAt: string;
  endAt: string;
}

/** Emitted when a booking's time is changed. */
export interface BookingRescheduledEvent extends BaseEvent {
  readonly type: 'booking.rescheduled';
  bookingId: string;
  clientId: string;
  staffMemberId?: string;
  oldStartAt: string;
  oldEndAt: string;
  newStartAt: string;
  newEndAt: string;
  /** "CLIENT" | "BUSINESS" | "SYSTEM" */
  rescheduledBy: string;
}

/** Emitted when a booking is marked COMPLETED. */
export interface BookingCompletedEvent extends BaseEvent {
  readonly type: 'booking.completed';
  bookingId: string;
  clientId: string;
  catalogItemId?: string;
  staffMemberId?: string;
}

/**
 * Emitted ahead of an appointment so the notification module can deliver a
 * reminder to the customer. `minutesBefore` distinguishes the 24h vs 1h reminder.
 */
export interface BookingReminderEvent extends BaseEvent {
  readonly type: 'booking.reminder';
  bookingId: string;
  clientId: string;
  catalogItemId?: string;
  staffMemberId?: string;
  startAt: string;
  /** Lead time of this reminder, e.g. 1440 (24h) or 60 (1h). */
  minutesBefore: number;
}

// ─────────────────────────────────────────────
// CLIENT PROFILE EVENTS
// ─────────────────────────────────────────────

export interface ClientProfileUpdatedEvent extends BaseEvent {
  readonly type: 'client.profile.updated';
  clientId: string;
  /** Only the fields that changed */
  changedFields: string[];
  updatedBy: 'AI' | 'HUMAN' | 'SYSTEM';
  updatedByActorId?: string;
}

// ─────────────────────────────────────────────
// CATALOG EVENTS
// ─────────────────────────────────────────────

export interface CatalogItemCreatedEvent extends BaseEvent {
  readonly type: 'catalog.item.created';
  itemId: string;
  sku: string;
  categoryId?: string;
}

export interface CatalogItemUpdatedEvent extends BaseEvent {
  readonly type: 'catalog.item.updated';
  itemId: string;
  changedFields: string[];
}

export interface CatalogStockLowEvent extends BaseEvent {
  readonly type: 'catalog.stock.low';
  itemId: string;
  variantId?: string;
  currentStock: number;
  threshold: number;
}

export interface CatalogStockOutEvent extends BaseEvent {
  readonly type: 'catalog.stock.out';
  itemId: string;
  variantId?: string;
}

// ─────────────────────────────────────────────
// NOTIFICATION EVENTS
// ─────────────────────────────────────────────

/** Emitted when a notification has been created and accepted into the queue. */
export interface NotificationQueuedEvent extends BaseEvent {
  readonly type: 'notification.queued';
  notificationId: string;
  clientId?: string;
  /** WHATSAPP | SMS | EMAIL | PUSH */
  channel: string;
  /** TRANSACTIONAL | MARKETING | REMINDER | SYSTEM */
  category: string;
  /** The domain event that triggered it, if any */
  triggerEvent?: string;
  scheduledAt?: string;
}

/** Emitted when a notification was handed to the channel provider. */
export interface NotificationSentEvent extends BaseEvent {
  readonly type: 'notification.sent';
  notificationId: string;
  clientId?: string;
  channel: string;
  category: string;
  recipient: string;
  providerMessageId?: string;
  /** Wall-clock time from dispatch start to provider acknowledgement (ms) */
  latencyMs: number;
}

/** Emitted when the provider confirms delivery to the recipient's device. */
export interface NotificationDeliveredEvent extends BaseEvent {
  readonly type: 'notification.delivered';
  notificationId: string;
  clientId?: string;
  channel: string;
  providerMessageId?: string;
}

/** Emitted when a notification permanently fails after exhausting retries. */
export interface NotificationFailedEvent extends BaseEvent {
  readonly type: 'notification.failed';
  notificationId: string;
  clientId?: string;
  channel: string;
  category: string;
  recipient: string;
  reason: string;
  attempts: number;
}

/** Emitted when a notification is skipped because of an opt-out/preference. */
export interface NotificationSkippedEvent extends BaseEvent {
  readonly type: 'notification.skipped';
  notificationId: string;
  clientId?: string;
  channel: string;
  category: string;
  reason: string;
}

// ─────────────────────────────────────────────
// UNION TYPE (for typed event bus subscriptions)
// ─────────────────────────────────────────────

export type DomainEvent =
  | MessageReceivedEvent
  | MessageSentEvent
  | MessageFailedEvent
  | MessageStoredEvent
  | ConversationCreatedEvent
  | ConversationResolvedEvent
  | ConversationEscalatedEvent
  | ConversationStatusChangedEvent
  | ConversationAssignedEvent
  | AIIntentClassifiedEvent
  | AIResponseGeneratedEvent
  | AIResponseApprovedEvent
  | AIResponseRejectedEvent
  | TaskCreatedEvent
  | TaskAssignedEvent
  | TaskResolvedEvent
  | OrderCreatedEvent
  | OrderConfirmedEvent
  | OrderCancelledEvent
  | OrderPackedEvent
  | OrderPaidEvent
  | OrderShippedEvent
  | OrderDeliveredEvent
  | OrderReturnedEvent
  | PaymentCreatedEvent
  | PaymentSuccessEvent
  | PaymentFailedEvent
  | PaymentRefundEvent
  | InvoiceCreatedEvent
  | InvoiceIssuedEvent
  | InvoicePaidEvent
  | BookingCreatedEvent
  | BookingCancelledEvent
  | BookingConfirmedEvent
  | BookingRescheduledEvent
  | BookingCompletedEvent
  | BookingReminderEvent
  | ClientProfileUpdatedEvent
  | CatalogItemCreatedEvent
  | CatalogItemUpdatedEvent
  | CatalogStockLowEvent
  | CatalogStockOutEvent
  | NotificationQueuedEvent
  | NotificationSentEvent
  | NotificationDeliveredEvent
  | NotificationFailedEvent
  | NotificationSkippedEvent;

/** Infer the event type from the `type` discriminant */
export type EventType = DomainEvent['type'];
