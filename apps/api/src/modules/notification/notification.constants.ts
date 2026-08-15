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
  /** Periodic sweep that re-enqueues notifications stranded without a job. */
  RECOVER_STUCK: 'recover-stuck',
} as const;

// ─────────────────────────────────────────────
// Stuck-notification recovery
// ─────────────────────────────────────────────

/**
 * How long a row may sit in PENDING/QUEUED past its due time before the sweep
 * treats it as stranded.
 *
 * The longest legitimate gap between a row entering QUEUED and its job running
 * is the last retry backoff (15 minutes) plus however long the queue is behind.
 * 30 minutes clears that with room to spare, so the sweep never races a job
 * that is merely waiting its turn — re-enqueueing one of those would double-send.
 */
export const STUCK_NOTIFICATION_AFTER_MS = 30 * 60_000;

/** Rows re-enqueued per sweep tick. Bounds one tick's work and its Redis writes. */
export const STUCK_RECOVERY_BATCH_SIZE = 200;

/**
 * Sweep cadence. Every 15 minutes: often enough that a stranded transactional
 * notification (an OTP, a booking confirmation) is still worth delivering when
 * it goes out, rare enough that the scan is invisible.
 */
export const STUCK_RECOVERY_CRON = '*/15 * * * *';

/** Stable repeatable-job id, so a redeploy replaces the schedule instead of adding one. */
export const STUCK_RECOVERY_REPEAT_JOB_ID = 'notification-recover-stuck';

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
