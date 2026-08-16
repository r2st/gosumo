import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  NotificationCategory,
  NotificationDigestFrequency,
  NotificationStatus,
  NotificationTemplateChannel,
} from '@prisma/client';
import { NotificationRepository } from '../notification.repository';
import { NotificationService } from '../notification.service';

/** Payload of `notification.digest.due`. */
export interface DigestDueEvent {
  businessId: string;
  windowStart: Date;
  windowEnd: Date;
  recipients: string[];
  frequency: NotificationDigestFrequency;
  skipWhenEmpty: boolean;
  timestamp: Date;
}

/** The counts one digest reports. */
export interface DigestSummary {
  total: number;
  sent: number;
  delivered: number;
  failed: number;
  skipped: number;
  byChannel: Array<{ channel: string; count: number }>;
}

/**
 * NotificationDigestListener — turns a due digest into an actual email.
 *
 * The settings service decides *when* a digest is cut and *who* it goes to; it
 * deliberately does not build content, because content assembly is a read over
 * this module's delivery history and belongs next to it. Splitting it this way
 * also means the schedule keeps working if the summary query fails — the claim
 * has already advanced, and one missing digest does not wedge the cadence.
 *
 * The digest is dispatched as SYSTEM/EMAIL. SYSTEM is deliberate: a digest is
 * an operational report to the business's own staff, not marketing to a
 * customer, so it must not be filtered by the client-facing opt-out rules in
 * `categoryHonoursOptOut`.
 */
@Injectable()
export class NotificationDigestListener {
  private readonly logger = new Logger(NotificationDigestListener.name);

  constructor(
    private readonly repository: NotificationRepository,
    private readonly service: NotificationService,
  ) {}

  @OnEvent('notification.digest.due')
  async handleDigestDue(event: DigestDueEvent): Promise<void> {
    try {
      const summary = await this.summarise(
        event.businessId,
        event.windowStart,
        event.windowEnd,
      );

      if (summary.total === 0 && event.skipWhenEmpty) {
        this.logger.debug(
          `Digest for business ${event.businessId} skipped — empty window`,
        );
        return;
      }

      // One dedupe key per business per window end, so a redelivered event or a
      // sweep that double-fires cannot send the same digest twice. The window
      // end is the cut instant, which is unique per digest by construction.
      const dedupeKey = `digest:${event.frequency}:${event.windowEnd.toISOString()}`;

      let delivered = 0;
      for (const recipient of event.recipients) {
        // Per-recipient, not around the loop: a bad address on one operator
        // must not withhold the digest from everyone listed after them, and
        // there is no retry for this — the claim has already advanced.
        try {
          await this.service.dispatch(event.businessId, {
            channel: NotificationTemplateChannel.EMAIL,
            category: NotificationCategory.SYSTEM,
            recipient,
            eventType: 'notification.digest.due',
            dedupeKey: `${dedupeKey}:${recipient}`,
            body: {
              subject: this.subject(event.frequency, summary),
              text: this.plainBody(event, summary),
            },
            data: {
              windowStart: event.windowStart.toISOString(),
              windowEnd: event.windowEnd.toISOString(),
              frequency: event.frequency,
              ...summary,
            },
          });
          delivered += 1;
        } catch (err) {
          this.logger.error(
            `Digest dispatch failed for ${recipient} (business ${event.businessId}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      this.logger.log(
        `Digest sent for business ${event.businessId} to ${delivered}/${event.recipients.length} recipient(s)`,
      );
    } catch (err) {
      // Never rethrow into the emitter: the digest claim is already committed,
      // and an exception here would surface as an unhandled rejection on a cron
      // tick rather than as anything actionable.
      this.logger.error(
        `Failed to build digest for business ${event.businessId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Delivery counts over the digest window, from this module's own rows. */
  private async summarise(
    businessId: string,
    from: Date,
    to: Date,
  ): Promise<DigestSummary> {
    const stats = await this.repository.aggregateStats(businessId, from, to);
    const byStatus = new Map(stats.byStatus.map((r) => [r.status, r.count]));
    const count = (status: NotificationStatus): number => byStatus.get(status) ?? 0;

    return {
      total: stats.byStatus.reduce((sum, r) => sum + r.count, 0),
      sent: count(NotificationStatus.SENT),
      delivered: count(NotificationStatus.DELIVERED),
      failed: count(NotificationStatus.FAILED),
      skipped: count(NotificationStatus.SKIPPED),
      byChannel: stats.byChannel.map((r) => ({ channel: r.channel, count: r.count })),
    };
  }

  private subject(frequency: NotificationDigestFrequency, summary: DigestSummary): string {
    const period =
      frequency === NotificationDigestFrequency.WEEKLY
        ? 'Weekly'
        : frequency === NotificationDigestFrequency.HOURLY
          ? 'Hourly'
          : 'Daily';
    return `${period} GoSumo digest — ${summary.total} notification${
      summary.total === 1 ? '' : 's'
    }`;
  }

  private plainBody(event: DigestDueEvent, summary: DigestSummary): string {
    const lines = [
      `Notification activity from ${event.windowStart.toISOString()} to ${event.windowEnd.toISOString()}.`,
      '',
      `Total:     ${summary.total}`,
      `Sent:      ${summary.sent}`,
      `Delivered: ${summary.delivered}`,
      `Failed:    ${summary.failed}`,
      `Skipped:   ${summary.skipped}`,
    ];
    if (summary.byChannel.length > 0) {
      lines.push('', 'By channel:');
      for (const row of summary.byChannel) {
        lines.push(`  ${row.channel}: ${row.count}`);
      }
    }
    return lines.join('\n');
  }
}
