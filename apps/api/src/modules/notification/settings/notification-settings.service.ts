import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotificationDigestFrequency,
  business_notification_settings,
} from '@prisma/client';
import {
  NotificationSettingsRepository,
  type SettingsPatch,
} from './notification-settings.repository';
import {
  DEFAULT_DIGEST_DAY_OF_WEEK,
  DEFAULT_DIGEST_HOUR,
  DEFAULT_MIN_SEVERITY,
  DEFAULT_SETTINGS_TIMEZONE,
  DIGEST_SWEEP_BATCH_SIZE,
} from './notification-settings.constants';
import {
  isValidTimeZone,
  nextDigestAt,
  resolveAlertDelivery,
  type AlertCandidate,
  type AlertDecision,
} from './notification-settings.util';
import {
  AlertPreviewDto,
  NotificationSettingsDto,
  PreviewAlertDto,
  UpdateNotificationSettingsDto,
} from './dto';

/** Outcome of one digest sweep tick. */
export interface DigestSweepResult {
  /** Rows found due. */
  found: number;
  /** Digests actually cut (claim won and content produced). */
  sent: number;
  /** Claims lost to a concurrent tick, or windows skipped as empty. */
  skipped: number;
}

/**
 * NotificationSettingsService — the operator-facing notification rules.
 *
 * Two jobs, and they are deliberately separate from the client-facing
 * preferences in `NotificationService`:
 *
 *  - **Realtime alert routing.** {@link resolveAlert} is the one place that
 *    answers "should this business be told about this, now?". Callers that
 *    raise operator alerts (SLA escalation, channel outages) ask it rather than
 *    reimplementing the switches, which is what keeps quiet hours from being
 *    honoured by three callers and ignored by a fourth.
 *  - **Digest scheduling.** `next_digest_at` is a stored column so the sweep can
 *    select on it, which means every write that could move the next cut has to
 *    recompute it. {@link updateSettings} is the only writer.
 */
@Injectable()
export class NotificationSettingsService {
  private readonly logger = new Logger(NotificationSettingsService.name);

  constructor(
    private readonly repository: NotificationSettingsRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * The business's settings, creating the defaults row on first read.
   *
   * Read-shaped endpoints that write are usually a smell, but the alternative
   * is returning defaults that are not persisted, and then having the digest
   * sweep — which selects on `next_digest_at` — never see the business at all.
   * The row has to exist for the schedule to exist.
   */
  async getSettings(businessId: string): Promise<NotificationSettingsDto> {
    const row = await this.ensureRow(businessId);
    return this.toDto(row);
  }

  /** The raw row, for callers inside the module that need the columns. */
  async getRaw(businessId: string): Promise<business_notification_settings> {
    return this.ensureRow(businessId);
  }

  private async ensureRow(businessId: string): Promise<business_notification_settings> {
    const existing = await this.repository.findByBusiness(businessId);
    if (existing) return existing;

    const now = new Date();
    return this.repository.ensureForBusiness(businessId, {
      next_digest_at: nextDigestAt(
        now,
        NotificationDigestFrequency.DAILY,
        DEFAULT_DIGEST_HOUR,
        DEFAULT_DIGEST_DAY_OF_WEEK,
        DEFAULT_SETTINGS_TIMEZONE,
      ),
    });
  }

  /**
   * Apply a partial update.
   *
   * Validation that the column types cannot express happens here: the quiet
   * window needs both ends or neither, and the timezone has to be one this
   * runtime can actually resolve — an unresolvable zone would not error, it
   * would silently reschedule every digest into the product default and be
   * invisible until someone noticed their digest arriving 5½ hours early.
   */
  async updateSettings(
    businessId: string,
    dto: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettingsDto> {
    const current = await this.ensureRow(businessId);

    if (dto.timezone !== undefined && !isValidTimeZone(dto.timezone)) {
      throw new BadRequestException('The provided timezone is not recognised — please use a valid IANA timezone (e.g. "Asia/Kolkata")');
    }

    const patch = this.buildPatch(dto);
    const merged = { ...current, ...patch };

    // Both ends together, on the merged row rather than the patch: clearing one
    // end of an existing window is just as broken as setting one of two.
    const startSet = merged.quiet_hours_start != null;
    const endSet = merged.quiet_hours_end != null;
    if (startSet !== endSet) {
      throw new BadRequestException(
        'quietHoursStart and quietHoursEnd must be set together, or both cleared',
      );
    }

    // Any of these four moves the next cut, so the stored column has to follow.
    // Recomputed from now rather than adjusted from the old value: an operator
    // moving the digest from 09:00 to 08:00 means the next one, not a retroactive
    // cut of a window that already passed.
    if (
      dto.digestFrequency !== undefined ||
      dto.digestHour !== undefined ||
      dto.digestDayOfWeek !== undefined ||
      dto.timezone !== undefined
    ) {
      patch.next_digest_at = nextDigestAt(
        new Date(),
        merged.digest_frequency,
        merged.digest_hour,
        merged.digest_day_of_week,
        merged.timezone,
      );
    }

    const count = await this.repository.updateForBusiness(businessId, patch);
    if (count === 0) {
      // ensureRow created or found it a moment ago, so a zero count means the
      // business was deleted underneath this request. Nothing to report but the
      // fresh read, which will recreate it.
      this.logger.warn(`Settings update matched no row for business ${businessId}`);
    }

    const updated = await this.repository.findByBusiness(businessId);
    return this.toDto(updated ?? { ...current, ...patch });
  }

  /** Translate the camelCase DTO into the snake_case column patch. */
  private buildPatch(dto: UpdateNotificationSettingsDto): SettingsPatch {
    const patch: SettingsPatch = {};
    if (dto.realtimeEnabled !== undefined) patch.realtime_enabled = dto.realtimeEnabled;
    if (dto.realtimeAlerts !== undefined) patch.realtime_alerts = dto.realtimeAlerts;
    if (dto.realtimeMinSeverity !== undefined) {
      patch.realtime_min_severity = dto.realtimeMinSeverity;
    }
    if (dto.mutedChannels !== undefined) patch.muted_channels = dto.mutedChannels;
    if (dto.digestFrequency !== undefined) patch.digest_frequency = dto.digestFrequency;
    if (dto.digestHour !== undefined) patch.digest_hour = dto.digestHour;
    if (dto.digestDayOfWeek !== undefined) patch.digest_day_of_week = dto.digestDayOfWeek;
    if (dto.digestRecipients !== undefined) patch.digest_recipients = dto.digestRecipients;
    if (dto.digestSkipWhenEmpty !== undefined) {
      patch.digest_skip_when_empty = dto.digestSkipWhenEmpty;
    }
    if (dto.quietHoursStart !== undefined) patch.quiet_hours_start = dto.quietHoursStart;
    if (dto.quietHoursEnd !== undefined) patch.quiet_hours_end = dto.quietHoursEnd;
    if (dto.quietHoursOverrideSeverity !== undefined) {
      patch.quiet_hours_override_severity = dto.quietHoursOverrideSeverity;
    }
    if (dto.timezone !== undefined) patch.timezone = dto.timezone;
    if (dto.fallbackEmail !== undefined) patch.fallback_email = dto.fallbackEmail;
    return patch;
  }

  /**
   * Whether one operator alert may go out now, later, or not at all.
   *
   * Never throws: a caller raising an SLA breach alert must not lose the alert
   * because the settings row could not be read. A failed lookup delivers.
   */
  async resolveAlert(
    businessId: string,
    alert: AlertCandidate,
    now: Date = new Date(),
  ): Promise<AlertDecision> {
    let row: business_notification_settings;
    try {
      row = await this.ensureRow(businessId);
    } catch (err) {
      this.logger.warn(
        `Alert settings unreadable for business ${businessId}, delivering: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { deliver: true, deferUntil: null, reason: null };
    }
    return resolveAlertDelivery(row, alert, now);
  }

  /** {@link resolveAlert} as an endpoint, so operators can debug their own rules. */
  async previewAlert(businessId: string, dto: PreviewAlertDto): Promise<AlertPreviewDto> {
    const at = dto.at ? new Date(dto.at) : new Date();
    if (Number.isNaN(at.getTime())) {
      throw new BadRequestException('`at` must be an ISO 8601 timestamp');
    }
    const decision = await this.resolveAlert(
      businessId,
      { kind: dto.kind, severity: dto.severity, sourceChannel: dto.sourceChannel ?? null },
      at,
    );
    return {
      deliver: decision.deliver,
      deferUntil: decision.deferUntil?.toISOString() ?? null,
      reason: decision.reason,
    };
  }

  /**
   * Who this business's digest goes to.
   *
   * Explicit recipients first, then the escalation fallback, then the business's
   * own address. A business that has cleared all three gets no digest — the
   * sweep records that as skipped rather than inventing a recipient.
   */
  async resolveDigestRecipients(
    businessId: string,
    row: business_notification_settings,
  ): Promise<string[]> {
    if (row.digest_recipients.length > 0) return [...row.digest_recipients];
    return this.resolveFallbackRecipients(businessId, row);
  }

  /**
   * Where operator mail goes when nothing more specific applies: the configured
   * escalation address, then the business's own.
   *
   * Shared by the digest and by `OperatorAlertService`, so an operator who sets
   * `fallback_email` gets both. `row` is optional only to save a read on the
   * digest path, which has already loaded it — passing `null` re-reads.
   *
   * Deliberately *not* "every team member": an alert fanned out to a
   * twenty-person team is how operators learn to filter alerts into a folder.
   */
  async resolveFallbackRecipients(
    businessId: string,
    row?: business_notification_settings | null,
  ): Promise<string[]> {
    const settings = row ?? (await this.repository.findByBusiness(businessId));
    if (settings?.fallback_email) return [settings.fallback_email];
    const businessEmail = await this.repository.findBusinessEmail(businessId);
    return businessEmail ? [businessEmail] : [];
  }

  /**
   * Cut every digest that has come due.
   *
   * Runs on a cron with no request tenant. Each row is claimed by moving
   * `next_digest_at` forward *before* any content is built — a claim lost to a
   * concurrent tick costs one skipped row, whereas building first and claiming
   * after would send the same digest twice.
   *
   * The claim advances the schedule even when the digest is then skipped as
   * empty. A row whose window produced nothing must still move on; leaving
   * `next_digest_at` in the past would make the sweep re-find it every tick
   * forever.
   */
  async sweepDueDigests(now: Date = new Date()): Promise<DigestSweepResult> {
    const due = await this.repository.findDueDigestsGlobal(now, DIGEST_SWEEP_BATCH_SIZE);
    let sent = 0;
    let skipped = 0;

    for (const row of due) {
      try {
        const cut = await this.cutDigestFor(row.business_id, now);
        if (cut) sent += 1;
        else skipped += 1;
      } catch (err) {
        skipped += 1;
        this.logger.error(
          `Digest sweep failed for business ${row.business_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return { found: due.length, sent, skipped };
  }

  /**
   * Claim and cut one business's digest. Returns whether a digest was emitted.
   *
   * Re-reads the row through the tenant-scoped path rather than trusting the
   * sweep's projection — which is also what re-checks that the row has not been
   * switched to OFF since the scan.
   */
  private async cutDigestFor(businessId: string, now: Date): Promise<boolean> {
    const row = await this.repository.findByBusiness(businessId);
    if (!row) return false;
    if (row.digest_frequency === NotificationDigestFrequency.OFF) return false;
    if (row.next_digest_at == null || row.next_digest_at > now) return false;

    const dueAt = row.next_digest_at;
    const upcoming = nextDigestAt(
      now,
      row.digest_frequency,
      row.digest_hour,
      row.digest_day_of_week,
      row.timezone,
    );

    const claimed = await this.repository.claimDigest(businessId, dueAt, upcoming, now);
    if (!claimed) {
      this.logger.debug(`Digest claim lost for business ${businessId}`);
      return false;
    }

    const recipients = await this.resolveDigestRecipients(businessId, row);
    if (recipients.length === 0) {
      this.logger.warn(
        `Digest due for business ${businessId} but no recipient is configured`,
      );
      return false;
    }

    // The window is the span the digest covers: from the previous cut, or from
    // the due time itself the first time round.
    const windowStart = row.last_digest_sent_at ?? dueAt;

    this.eventEmitter.emit('notification.digest.due', {
      businessId,
      windowStart,
      windowEnd: now,
      recipients,
      frequency: row.digest_frequency,
      skipWhenEmpty: row.digest_skip_when_empty,
      timestamp: now,
    });

    return true;
  }

  /** Row → API shape. */
  private toDto(row: business_notification_settings): NotificationSettingsDto {
    return {
      id: row.id,
      businessId: row.business_id,
      realtimeEnabled: row.realtime_enabled,
      realtimeAlerts: row.realtime_alerts,
      realtimeMinSeverity: row.realtime_min_severity,
      mutedChannels: row.muted_channels,
      digestFrequency: row.digest_frequency,
      digestHour: row.digest_hour,
      digestDayOfWeek: row.digest_day_of_week,
      digestRecipients: row.digest_recipients,
      digestSkipWhenEmpty: row.digest_skip_when_empty,
      quietHoursStart: row.quiet_hours_start,
      quietHoursEnd: row.quiet_hours_end,
      quietHoursOverrideSeverity: row.quiet_hours_override_severity,
      timezone: row.timezone,
      fallbackEmail: row.fallback_email,
      lastDigestSentAt: row.last_digest_sent_at?.toISOString() ?? null,
      nextDigestAt: row.next_digest_at?.toISOString() ?? null,
      updatedAt: row.updated_at.toISOString(),
    };
  }
}

/** Defaults a freshly-created row carries, mirrored from the schema defaults. */
export const SETTINGS_DEFAULTS = {
  realtimeMinSeverity: DEFAULT_MIN_SEVERITY,
  digestHour: DEFAULT_DIGEST_HOUR,
  digestDayOfWeek: DEFAULT_DIGEST_DAY_OF_WEEK,
  timezone: DEFAULT_SETTINGS_TIMEZONE,
} as const;
