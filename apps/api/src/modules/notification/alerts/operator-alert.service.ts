import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, NotificationCategory, NotificationTemplateChannel } from '@prisma/client';
import type { operator_alerts, team_members } from '@prisma/client';
import { OperatorAlertStatus } from '@gosumo/database';

import { NotificationService } from '../notification.service';
import { NotificationSettingsService } from '../settings/notification-settings.service';
import {
  OperatorAlertRepository,
  type OperatorAlertListFilters,
  type PaginatedOperatorAlerts,
} from './operator-alert.repository';
import { TenantService } from '../../tenant/tenant.service';
import {
  ALERT_EVENT_TYPE,
  ALERT_FAILURE_REASONS,
  ALERT_RELEASE_BATCH_SIZE,
  ALERT_RELEASE_MAX_LATENESS_MS,
  MAX_ALERT_BODY_LENGTH,
  MAX_ALERT_RECIPIENTS,
  MAX_ALERT_REASON_LENGTH,
  MAX_ALERT_TITLE_LENGTH,
  MAX_DEDUPE_KEY_LENGTH,
  TARGETABLE_ROLES,
} from './operator-alert.constants';

/** One alert being raised. */
export interface RaiseAlertInput {
  /** One of ALERT_KINDS. Unknown kinds are stored and delivered, not rejected. */
  kind: string;
  /** One of ALERT_SEVERITIES. Unknown severities rank at the floor. */
  severity: string;
  title: string;
  body?: string;
  /** Conversation channel this came from, matched against `muted_channels`. */
  sourceChannel?: string | null;
  conversationId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  context?: Record<string, unknown>;
  /** Collapses repeats of the same underlying condition. */
  dedupeKey?: string | null;
  /**
   * Team-member UUID, role name, or email address the alert is aimed at. When
   * it resolves to nothing, delivery falls back to the business's configured
   * escalation address.
   */
  target?: string | null;
}

/** Outcome of one release sweep tick. */
export interface AlertReleaseResult {
  /** Rows found due. */
  found: number;
  /** Alerts actually delivered. */
  released: number;
  /** Claims lost to a concurrent tick, or rows closed as expired. */
  skipped: number;
}

/** Unread counters for the dashboard badge. */
export interface OperatorAlertUnreadCounts {
  total: number;
  bySeverity: Array<{ severity: string; count: number }>;
}

/**
 * OperatorAlertService — raises, routes, stores and delivers alerts to a
 * business's *own team*.
 *
 * This is the delivery half of the operator notification path. The rules half
 * already existed: `NotificationSettingsService.resolveAlert` decides whether a
 * business wants to hear about something now, later, or not at all. Nothing
 * called it — `sla.escalated` was emitted per configured escalation action and
 * had no listener, so a conversation could breach, escalate, and reach no
 * human. Everything here is downstream of that one decision.
 *
 * Three properties the callers depend on:
 *
 *  - **{@link raise} never throws.** Its callers are event listeners on the
 *    message and sweep paths. An alert that cannot be stored must not take down
 *    the flow that raised it, so failures are logged and reported as `null`.
 *  - **Withheld alerts are still stored.** A SUPPRESSED row is how an operator
 *    answers "why was I never told" after the fact — the rule that dropped it
 *    is named in `reason`. Deleting the evidence would make the settings page
 *    unauditable.
 *  - **Delivery is idempotent per alert.** The `dedupe_key` unique index
 *    collapses repeats at the row level, and each dispatch carries a dedupe key
 *    of its own, so a redelivered event cannot page the same person twice.
 */
@Injectable()
export class OperatorAlertService {
  private readonly logger = new Logger(OperatorAlertService.name);

  constructor(
    private readonly repository: OperatorAlertRepository,
    private readonly settingsService: NotificationSettingsService,
    private readonly notificationService: NotificationService,
    private readonly tenantService: TenantService,
  ) {}

  // ───────────────────────────────────────────────────────────────────
  // Raising
  // ───────────────────────────────────────────────────────────────────

  /**
   * Raise one operator alert: apply the business's routing rules, store the
   * outcome, and deliver it when the rules allow.
   *
   * Returns the stored row, or `null` when nothing could be stored. A duplicate
   * `dedupeKey` returns the *existing* row without re-delivering — the second
   * raise of the same condition is a repeat, not a new thing to be told about.
   */
  async raise(
    businessId: string,
    input: RaiseAlertInput,
    now: Date = new Date(),
  ): Promise<operator_alerts | null> {
    const dedupeKey = input.dedupeKey ? truncate(input.dedupeKey, MAX_DEDUPE_KEY_LENGTH) : null;

    try {
      const decision = await this.settingsService.resolveAlert(
        businessId,
        {
          kind: input.kind,
          severity: input.severity,
          sourceChannel: input.sourceChannel ?? null,
        },
        now,
      );

      const status = !decision.deliver
        ? OperatorAlertStatus.SUPPRESSED
        : decision.deferUntil
          ? OperatorAlertStatus.DEFERRED
          : OperatorAlertStatus.PENDING;

      const alert = await this.repository.create(businessId, {
        kind: input.kind,
        severity: input.severity,
        title: truncate(input.title, MAX_ALERT_TITLE_LENGTH),
        body: input.body ? truncate(input.body, MAX_ALERT_BODY_LENGTH) : null,
        sourceChannel: input.sourceChannel ?? null,
        conversationId: input.conversationId ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        // `target` is stored in context rather than as a column: it is only
        // meaningful while delivering, and `delivered_to` records where the
        // alert actually landed once that is settled.
        context: {
          ...(input.context ?? {}),
          ...(input.target ? { target: input.target } : {}),
        } as Prisma.InputJsonValue,
        status,
        reason: decision.reason ? truncate(decision.reason, MAX_ALERT_REASON_LENGTH) : null,
        deferredUntil: decision.deferUntil ?? null,
        dedupeKey,
      });

      if (status !== OperatorAlertStatus.PENDING) {
        return alert;
      }
      return this.deliver(businessId, alert, input.target ?? null);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && dedupeKey) {
        // Someone already raised this exact condition. Return their row rather
        // than a second alert about the same thing.
        const existing = await this.repository
          .findByDedupeKey(businessId, dedupeKey)
          .catch((findErr: unknown) => {
            this.logger.warn(
              `Could not look up deduped alert ${input.kind} for business ${businessId}: ` +
                `${findErr instanceof Error ? findErr.message : String(findErr)}`,
            );
            return null;
          });
        this.logger.debug(
          `Operator alert ${input.kind} deduped for business ${businessId} (${dedupeKey})`,
        );
        return existing;
      }
      this.logger.error(
        `Could not raise ${input.kind} alert for business ${businessId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Delivery
  // ───────────────────────────────────────────────────────────────────

  /**
   * Send one PENDING alert and record where it landed.
   *
   * A per-recipient try/catch, not one around the loop: a bad address on one
   * operator must not withhold a CRITICAL alert from everyone listed after
   * them. An alert that reaches at least one address is DELIVERED; one that
   * reaches none is FAILED, which is deliberately distinct from SUPPRESSED —
   * the business wanted this and could not be reached, which is a
   * misconfiguration to fix rather than a rule working as intended.
   */
  private async deliver(
    businessId: string,
    alert: operator_alerts,
    target: string | null,
  ): Promise<operator_alerts> {
    const recipients = await this.resolveRecipients(businessId, target);

    if (recipients.length === 0) {
      this.logger.warn(
        `Operator alert ${alert.id} (${alert.kind}) for business ${businessId} has no recipient`,
      );
      await this.recordOutcome(businessId, alert.id, {
        status: OperatorAlertStatus.FAILED,
        reason: ALERT_FAILURE_REASONS.NO_RECIPIENT,
      });
      return {
        ...alert,
        status: OperatorAlertStatus.FAILED,
        reason: ALERT_FAILURE_REASONS.NO_RECIPIENT,
      };
    }

    const delivered: string[] = [];
    for (const recipient of recipients) {
      try {
        await this.notificationService.dispatch(businessId, {
          channel: NotificationTemplateChannel.EMAIL,
          // SYSTEM, not TRANSACTIONAL: an operator alert goes to the business's
          // own staff and must not be filtered by the client-facing opt-out
          // rules that govern customer notifications.
          category: NotificationCategory.SYSTEM,
          recipient,
          eventType: ALERT_EVENT_TYPE,
          // Per alert per recipient, so a released deferral or a redelivered
          // event cannot page the same person about the same thing twice.
          dedupeKey: `alert:${alert.id}:${recipient}`,
          body: {
            subject: `[${alert.severity}] ${alert.title}`,
            text: this.plainBody(alert),
          },
          data: {
            alertId: alert.id,
            kind: alert.kind,
            severity: alert.severity,
            conversationId: alert.conversation_id,
          },
        });
        delivered.push(recipient);
      } catch (err) {
        this.logger.error(
          `Operator alert ${alert.id} dispatch to ${recipient} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const at = new Date();
    if (delivered.length === 0) {
      await this.recordOutcome(businessId, alert.id, {
        status: OperatorAlertStatus.FAILED,
        reason: ALERT_FAILURE_REASONS.DISPATCH_FAILED,
      });
      return {
        ...alert,
        status: OperatorAlertStatus.FAILED,
        reason: ALERT_FAILURE_REASONS.DISPATCH_FAILED,
      };
    }

    await this.recordOutcome(businessId, alert.id, {
      status: OperatorAlertStatus.DELIVERED,
      reason: null,
      deliveredAt: at,
      deliveredTo: delivered,
      deferredUntil: null,
    });
    return {
      ...alert,
      status: OperatorAlertStatus.DELIVERED,
      reason: null,
      delivered_at: at,
      delivered_to: delivered,
      deferred_until: null,
    };
  }

  /** Write an outcome back, never letting the bookkeeping fail the delivery. */
  private async recordOutcome(
    businessId: string,
    id: string,
    outcome: Parameters<OperatorAlertRepository['recordOutcome']>[2],
  ): Promise<void> {
    try {
      await this.repository.recordOutcome(businessId, id, outcome);
    } catch (err) {
      this.logger.error(
        `Could not record outcome for operator alert ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Who this alert goes to.
   *
   * `target` comes from an SLA policy's escalation action, documented as a
   * "team-member UUID or role name". An address is accepted too, because a
   * business whose on-call rota is an alias rather than a member should not
   * have to invent a member row for it.
   *
   * A target that resolves to nobody — a member since removed, a role with no
   * one in it — falls back rather than failing. An escalation aimed at a
   * departed manager must still reach the business.
   */
  async resolveRecipients(businessId: string, target: string | null): Promise<string[]> {
    const targeted = await this.resolveTargetedRecipients(businessId, target);
    if (targeted.length > 0) return targeted;
    return this.fallbackRecipients(businessId);
  }

  /** Addresses named by `target` itself, or `[]` when it names none. */
  private async resolveTargetedRecipients(
    businessId: string,
    target: string | null,
  ): Promise<string[]> {
    if (!target) return [];

    const trimmed = target.trim();
    if (trimmed.length === 0) return [];

    // An explicit address. Checked before the member lookup so an on-call alias
    // never has to exist as a member row.
    if (trimmed.includes('@')) return dedupeAddresses([trimmed]);

    let members: team_members[];
    try {
      members = await this.tenantService.getMembers(businessId);
    } catch (err) {
      this.logger.warn(
        `Could not read team members for business ${businessId}, falling back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }

    const upper = trimmed.toUpperCase();
    const matched = (TARGETABLE_ROLES as readonly string[]).includes(upper)
      ? members.filter((m) => m.role === upper)
      : members.filter((m) => m.id === trimmed);

    return dedupeAddresses(matched.filter(wantsEmailAlerts).map((m) => m.email));
  }

  /**
   * Where alerts go when nothing more specific applies. Shared with the digest
   * so one `fallback_email` covers both; see
   * {@link NotificationSettingsService.resolveFallbackRecipients}.
   */
  private async fallbackRecipients(businessId: string): Promise<string[]> {
    try {
      return dedupeAddresses(await this.settingsService.resolveFallbackRecipients(businessId));
    } catch (err) {
      this.logger.warn(
        `Could not resolve fallback recipients for business ${businessId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  /** The plain-text body of the alert email. */
  private plainBody(alert: operator_alerts): string {
    const lines = [alert.title, ''];
    if (alert.body) lines.push(alert.body, '');
    lines.push(`Severity: ${alert.severity}`, `Kind:     ${alert.kind}`);
    if (alert.conversation_id) lines.push(`Conversation: ${alert.conversation_id}`);
    lines.push('', `Raised at ${alert.created_at.toISOString()}.`);
    return lines.join('\n');
  }

  // ───────────────────────────────────────────────────────────────────
  // Deferred release
  // ───────────────────────────────────────────────────────────────────

  /**
   * Deliver every alert whose quiet-hours window has ended.
   *
   * Runs on a cron with no request tenant. Each row is claimed out of DEFERRED
   * *before* anything is sent — a claim lost to a concurrent tick costs one
   * skipped row, whereas sending first and claiming after would page the same
   * operator twice.
   *
   * A row held longer than {@link ALERT_RELEASE_MAX_LATENESS_MS} is closed as
   * FAILED rather than delivered: an alert about a conversation from two days
   * ago is noise, and noise is what teaches operators to ignore the channel.
   */
  async sweepDeferred(now: Date = new Date()): Promise<AlertReleaseResult> {
    const due = await this.repository.findDueDeferredGlobal(now, ALERT_RELEASE_BATCH_SIZE);
    let released = 0;
    let skipped = 0;

    for (const row of due) {
      try {
        const delivered = await this.releaseOne(row.business_id, row.id, now);
        if (delivered) released += 1;
        else skipped += 1;
      } catch (err) {
        skipped += 1;
        this.logger.error(
          `Releasing operator alert ${row.id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return { found: due.length, released, skipped };
  }

  /**
   * Claim and deliver one deferred alert. Returns whether it was delivered.
   *
   * Re-reads the row through the tenant-scoped path rather than trusting the
   * sweep's projection — which is also what re-checks that it has not already
   * been released by a concurrent tick.
   */
  private async releaseOne(businessId: string, id: string, now: Date): Promise<boolean> {
    const alert = await this.repository.findById(businessId, id);
    if (!alert) return false;
    if (alert.status !== OperatorAlertStatus.DEFERRED) return false;
    if (alert.deferred_until == null || alert.deferred_until > now) return false;

    if (now.getTime() - alert.deferred_until.getTime() > ALERT_RELEASE_MAX_LATENESS_MS) {
      await this.recordOutcome(businessId, id, {
        status: OperatorAlertStatus.FAILED,
        reason: ALERT_FAILURE_REASONS.EXPIRED,
      });
      return false;
    }

    if (!(await this.repository.claimDeferred(businessId, id))) return false;

    const target = readTarget(alert.context);
    await this.deliver(businessId, alert, target);
    return true;
  }

  // ───────────────────────────────────────────────────────────────────
  // Inbox reads
  // ───────────────────────────────────────────────────────────────────

  async list(
    businessId: string,
    filters: OperatorAlertListFilters,
  ): Promise<PaginatedOperatorAlerts> {
    return this.repository.list(businessId, filters);
  }

  async get(businessId: string, id: string): Promise<operator_alerts> {
    const alert = await this.repository.findById(businessId, id);
    if (!alert) throw new NotFoundException('Alert not found');
    return alert;
  }

  /**
   * Mark one alert read.
   *
   * A second click is not an error: the alert exists and is read, which is what
   * the caller wanted. Only an id that resolves to nothing in this tenant is a
   * 404, and that check is a scoped read rather than an inference from the
   * update count — a zero count also means "already read".
   */
  async markRead(businessId: string, id: string, readBy: string | null): Promise<operator_alerts> {
    await this.get(businessId, id);
    await this.repository.markRead(businessId, id, readBy, new Date());
    return this.get(businessId, id);
  }

  /** Mark every unread alert read. Returns how many were still unread. */
  async markAllRead(businessId: string, readBy: string | null): Promise<number> {
    return this.repository.markAllRead(businessId, readBy, new Date());
  }

  async unreadCounts(businessId: string): Promise<OperatorAlertUnreadCounts> {
    const [total, bySeverity] = await Promise.all([
      this.repository.countUnread(businessId),
      this.repository.countUnreadBySeverity(businessId),
    ]);
    return { total, bySeverity };
  }
}

/**
 * A member's own switch. `notification_prefs` is free-form JSON with a `{}`
 * default, so only an explicit `false` opts out — an absent key means the
 * member never touched the setting, not that they want silence.
 */
function wantsEmailAlerts(member: team_members): boolean {
  const prefs = member.notification_prefs as { email?: unknown } | null;
  return !(prefs != null && typeof prefs === 'object' && prefs.email === false);
}

/**
 * Trim, drop empties, collapse case-insensitive duplicates, and cap the fan-out.
 *
 * Case-insensitively, because the same operator listed as a member and as the
 * fallback address in different casing is one person, and paging them twice is
 * the thing the cap exists to prevent.
 */
function dedupeAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of addresses) {
    const trimmed = address?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_ALERT_RECIPIENTS) break;
  }
  return out;
}

/** The `target` stashed in an alert's context when it was raised. */
function readTarget(context: unknown): string | null {
  if (context == null || typeof context !== 'object') return null;
  const value = (context as { target?: unknown }).target;
  return typeof value === 'string' ? value : null;
}

/** Fit a value to its column rather than letting Postgres reject the insert. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
