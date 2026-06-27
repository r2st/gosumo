import { NotificationTemplateChannel, NotificationCategory } from '@prisma/client';

/**
 * Shared constants for the Notification module.
 */

/** Bull queue name for notification dispatch + retry jobs. */
export const NOTIFICATION_QUEUE = 'notifications';

/** Job names processed by {@link NotificationProcessor}. */
export const NOTIFICATION_JOBS = {
  /** Deliver a single notification (immediate or delayed). */
  DISPATCH: 'dispatch',
  /** Expand and enqueue one chunk of a bulk/campaign batch. */
  BATCH: 'batch',
} as const;

/** Default delivery-attempt cap before a notification is marked FAILED. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Backoff (ms) applied before each retry. The Nth retry uses index N-1;
 * attempts beyond the array length reuse the last value.
 * 1 minute → 5 minutes → 15 minutes.
 */
export const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000];

/** Max recipients pushed into a single bulk batch chunk. */
export const BATCH_CHUNK_SIZE = 50;

/**
 * Per-channel rate limits, applied per business via a fixed-window counter.
 * WhatsApp mirrors Meta's 80 msg/sec ceiling per phone number; the others are
 * conservative provider-friendly defaults. In production the window store is
 * Redis-backed; the in-memory limiter here is process-local.
 */
export interface RateLimitRule {
  /** Max notifications allowed within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export const CHANNEL_RATE_LIMITS: Record<
  NotificationTemplateChannel,
  RateLimitRule
> = {
  WHATSAPP: { limit: 80, windowMs: 1_000 },
  SMS: { limit: 10, windowMs: 1_000 },
  EMAIL: { limit: 20, windowMs: 1_000 },
  PUSH: { limit: 100, windowMs: 1_000 },
};

/**
 * Built-in mapping of domain events the module listens to → the default
 * channel + category used when a business has not configured an explicit
 * {@link notification_triggers} row. A business can override or disable any of
 * these via the triggers API.
 */
export interface DefaultTrigger {
  channel: NotificationTemplateChannel;
  category: NotificationCategory;
  /** Default template name to look up (per business); falls back to a built-in body. */
  templateName: string;
}

export const DEFAULT_EVENT_TRIGGERS: Record<string, DefaultTrigger> = {
  'booking.created': {
    channel: NotificationTemplateChannel.WHATSAPP,
    category: NotificationCategory.TRANSACTIONAL,
    templateName: 'booking_created',
  },
  'booking.confirmed': {
    channel: NotificationTemplateChannel.WHATSAPP,
    category: NotificationCategory.TRANSACTIONAL,
    templateName: 'booking_confirmed',
  },
  'booking.cancelled': {
    channel: NotificationTemplateChannel.WHATSAPP,
    category: NotificationCategory.TRANSACTIONAL,
    templateName: 'booking_cancelled',
  },
  'booking.reminder': {
    channel: NotificationTemplateChannel.WHATSAPP,
    category: NotificationCategory.REMINDER,
    templateName: 'booking_reminder',
  },
  'order.created': {
    channel: NotificationTemplateChannel.WHATSAPP,
    category: NotificationCategory.TRANSACTIONAL,
    templateName: 'order_created',
  },
  'order.confirmed': {
    channel: NotificationTemplateChannel.WHATSAPP,
    category: NotificationCategory.TRANSACTIONAL,
    templateName: 'order_confirmed',
  },
  'order.shipped': {
    channel: NotificationTemplateChannel.WHATSAPP,
    category: NotificationCategory.TRANSACTIONAL,
    templateName: 'order_shipped',
  },
  'order.delivered': {
    channel: NotificationTemplateChannel.WHATSAPP,
    category: NotificationCategory.TRANSACTIONAL,
    templateName: 'order_delivered',
  },
  'payment.success': {
    channel: NotificationTemplateChannel.WHATSAPP,
    category: NotificationCategory.TRANSACTIONAL,
    templateName: 'payment_success',
  },
  'payment.failed': {
    channel: NotificationTemplateChannel.WHATSAPP,
    category: NotificationCategory.TRANSACTIONAL,
    templateName: 'payment_failed',
  },
};

/**
 * Domain events the {@link NotificationEventListener} subscribes to. Kept in
 * sync with {@link DEFAULT_EVENT_TRIGGERS} keys so a default exists for each,
 * and passed as the `@OnEvent([...])` argument.
 */
export const SUPPORTED_TRIGGER_EVENTS: string[] = Object.keys(
  DEFAULT_EVENT_TRIGGERS,
);

/** Statuses from which a notification can still be (re)queued for delivery. */
export const RETRYABLE_STATUSES = ['PENDING', 'QUEUED', 'FAILED'] as const;

export interface DispatchJobData {
  businessId: string;
  notificationId: string;
}

export interface BatchJobData {
  businessId: string;
  batchId: string;
  notificationIds: string[];
}
