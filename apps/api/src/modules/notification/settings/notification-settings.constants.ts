/**
 * Constants for operator-facing notification settings.
 *
 * These govern alerts sent to the *business's own team* — escalations, SLA
 * breaches, channel outages — and the periodic digest. They are a different
 * concern from `notification_preferences`, which is per-*client* and governs
 * what a customer receives. The two never consult each other.
 */

/**
 * What an operator alert is about.
 *
 * Stored as plain strings in `business_notification_settings.realtime_alerts`
 * rather than a Postgres enum: a dashboard shipped ahead of the API may write a
 * kind this build has never heard of, and rejecting the whole settings row for
 * one unknown array entry would brick the settings page. Unknown entries are
 * ignored on read instead (see `isKnownAlertKind`).
 */
export const ALERT_KINDS = [
  'ESCALATION',
  'SLA_BREACH',
  'ASSIGNMENT',
  'PAYMENT_FAILED',
  'CHANNEL_DOWN',
  'AI_LOW_CONFIDENCE',
  'SYSTEM',
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

const ALERT_KIND_SET: ReadonlySet<string> = new Set(ALERT_KINDS);

/** Whether `value` is an alert kind this build understands. */
export function isKnownAlertKind(value: string): value is AlertKind {
  return ALERT_KIND_SET.has(value);
}

/**
 * How loud an alert is. Ordered — the numeric rank is what comparisons use, so
 * the names can be reordered here only by also renumbering {@link SEVERITY_RANK}.
 */
export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Comparable rank per severity. Higher is louder. */
export const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
};

/**
 * Rank of a severity string that came out of the database.
 *
 * The columns are `varchar`, not an enum, so a value written by a newer build
 * can be unreadable to this one. An unknown severity ranks at the *floor*
 * rather than the ceiling: a threshold nobody can interpret should not silently
 * become "page for everything", and an alert of unknown loudness is better
 * delivered than dropped. Both fall out of returning 0.
 */
export function severityRank(value: string | null | undefined): number {
  if (value == null) return SEVERITY_RANK.INFO;
  const rank = SEVERITY_RANK[value as AlertSeverity];
  return rank ?? SEVERITY_RANK.INFO;
}

/** Conversation channels an operator may mute alerts for. */
export const MUTABLE_CHANNELS = [
  'WHATSAPP',
  'INSTAGRAM',
  'SMS',
  'WEBCHAT',
  'EMAIL',
] as const;

export type MutableChannel = (typeof MUTABLE_CHANNELS)[number];

/** Default IANA zone for a new settings row — matches the product's home market. */
export const DEFAULT_SETTINGS_TIMEZONE = 'Asia/Kolkata';

/** Default minimum severity for realtime alerts. */
export const DEFAULT_MIN_SEVERITY: AlertSeverity = 'WARNING';

/** Default hour-of-day (in the row's timezone) the digest is cut. */
export const DEFAULT_DIGEST_HOUR = 9;

/** Default day-of-week for a WEEKLY digest. 0 = Sunday, so 1 = Monday. */
export const DEFAULT_DIGEST_DAY_OF_WEEK = 1;

/** Upper bound on `digest_recipients`, so one row cannot fan out unbounded. */
export const MAX_DIGEST_RECIPIENTS = 20;

// ─────────────────────────────────────────────
// Digest sweep
// ─────────────────────────────────────────────

/** Job name for the due-digest sweep on the notifications queue. */
export const DIGEST_SWEEP_JOB = 'digest-sweep';

/**
 * Sweep cadence. Every 15 minutes: `next_digest_at` is stored to the minute, so
 * the worst-case lateness of a digest is one tick. Hourly would make an HOURLY
 * digest meaningless.
 */
export const DIGEST_SWEEP_CRON = '*/15 * * * *';

/** Stable repeatable-job id, so a redeploy replaces the schedule rather than adding one. */
export const DIGEST_SWEEP_REPEAT_JOB_ID = 'notification-digest-sweep';

/** Rows claimed per sweep tick. Bounds one tick's work. */
export const DIGEST_SWEEP_BATCH_SIZE = 100;

/** Reasons {@link resolveAlertDelivery} may withhold or defer an alert. */
export const ALERT_SUPPRESSION_REASONS = {
  REALTIME_DISABLED: 'Realtime alerts are disabled for this business',
  KIND_UNSUBSCRIBED: 'Alert kind is not in the subscribed list',
  CHANNEL_MUTED: 'Alerts from this channel are muted',
  BELOW_MIN_SEVERITY: 'Alert severity is below the configured minimum',
  QUIET_HOURS: 'Deferred to the end of quiet hours',
} as const;
