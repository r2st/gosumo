/**
 * Constants for the operator alert pipeline.
 *
 * The *rules* — which kinds a business subscribes to, its quiet hours, its
 * minimum severity — live in `../settings`. This file is about the alerts
 * themselves: how they are titled, how repeats collapse, and how a deferred one
 * is released once its quiet window ends.
 */

import type { AlertKind, AlertSeverity } from '../settings/notification-settings.constants';

/** Job name for the deferred-alert release sweep, on the notifications queue. */
export const ALERT_RELEASE_JOB = 'alert-release-sweep';

/**
 * Sweep cadence. Every 5 minutes rather than the 15 used by the digest sweep:
 * a deferred alert is something the operator asked to be woken for at the end
 * of quiet hours, and a quarter-hour of extra lateness on top of a window that
 * may already have held it for eight is the wrong trade. The scan is a partial
 * index probe over the handful of rows actually parked.
 */
export const ALERT_RELEASE_CRON = '*/5 * * * *';

/** Stable repeatable-job id, so a redeploy replaces the schedule rather than adding one. */
export const ALERT_RELEASE_REPEAT_JOB_ID = 'operator-alert-release';

/** Rows released per sweep tick. Bounds one tick's work and its outbound email. */
export const ALERT_RELEASE_BATCH_SIZE = 200;

/**
 * How long a DEFERRED alert may sit past its release time before the sweep
 * gives up on it.
 *
 * An alert deferred for last Tuesday's quiet hours is not worth sending on
 * Friday — it describes a conversation that has long since been handled or
 * abandoned, and delivering it teaches operators that alerts are noise. 24
 * hours is comfortably longer than the longest sane quiet window plus a queue
 * outage, and anything older is closed as expired rather than delivered.
 */
export const ALERT_RELEASE_MAX_LATENESS_MS = 24 * 60 * 60_000;

/** Upper bound on how many addresses one alert may fan out to. */
export const MAX_ALERT_RECIPIENTS = 20;

/** Cap on a stored `title`, matching the column. */
export const MAX_ALERT_TITLE_LENGTH = 300;

/** Cap on a stored `body`. Alert bodies are summaries, not transcripts. */
export const MAX_ALERT_BODY_LENGTH = 4000;

/** Cap on a stored `dedupe_key`, matching the column. */
export const MAX_DEDUPE_KEY_LENGTH = 200;

/** Cap on a stored `reason`, matching the column. */
export const MAX_ALERT_REASON_LENGTH = 200;

/** Reasons an alert can end up FAILED rather than SUPPRESSED. */
export const ALERT_FAILURE_REASONS = {
  /** The business wants the alert and no address could be resolved. */
  NO_RECIPIENT: 'No operator recipient could be resolved',
  /** Every resolved address threw on dispatch. */
  DISPATCH_FAILED: 'Every operator dispatch attempt failed',
  /** Held past ALERT_RELEASE_MAX_LATENESS_MS; too stale to be worth sending. */
  EXPIRED: 'Deferred past the point of being useful',
} as const;

/**
 * Roles an escalation `target` may name instead of a specific member.
 *
 * `SlaEscalationActionDto.target` is documented as "team-member UUID or role
 * name", so a policy may legitimately carry either. Matched case-insensitively.
 */
export const TARGETABLE_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'] as const;

/** Severity carried by each SLA-derived alert. */
export const SLA_ALERT_SEVERITY: Readonly<Record<'breach' | 'escalation', AlertSeverity>> = {
  /**
   * A missed target. WARNING rather than CRITICAL because it is the *expected*
   * loud event on a busy day; ranking it CRITICAL would make the severity floor
   * useless for anyone whose real emergencies are outages.
   */
  breach: 'WARNING',
  /**
   * A breach that matched a configured escalation action. The business wrote a
   * rule saying this specific case needs a human, which is the definition of
   * CRITICAL here — and it is what lets an operator set the floor to CRITICAL
   * and still be paged for the cases they chose.
   */
  escalation: 'CRITICAL',
};

/** Alert kind raised for each SLA event. */
export const SLA_ALERT_KIND: Readonly<Record<'breach' | 'escalation', AlertKind>> = {
  breach: 'SLA_BREACH',
  escalation: 'ESCALATION',
};

/** `entity_type` stored on alerts raised from an SLA breach. */
export const SLA_ALERT_ENTITY_TYPE = 'sla_policy';

/** Event type recorded on the notification rows an alert dispatches. */
export const ALERT_EVENT_TYPE = 'operator.alert';
