import { Injectable } from '@nestjs/common';
import {
  NotificationDigestFrequency,
  Prisma,
  business_notification_settings,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma.service';
import { DIGEST_SWEEP_BATCH_SIZE } from './notification-settings.constants';

/** The columns an update may set. Snake-cased — this is the storage boundary. */
export interface SettingsPatch {
  realtime_enabled?: boolean;
  realtime_alerts?: string[];
  realtime_min_severity?: string;
  muted_channels?: string[];
  digest_frequency?: NotificationDigestFrequency;
  digest_hour?: number;
  digest_day_of_week?: number;
  digest_recipients?: string[];
  digest_skip_when_empty?: boolean;
  quiet_hours_start?: number | null;
  quiet_hours_end?: number | null;
  quiet_hours_override_severity?: string | null;
  timezone?: string;
  fallback_email?: string | null;
  next_digest_at?: Date | null;
  last_digest_sent_at?: Date | null;
}

/** One row the digest sweep has found due. */
export interface DueDigestRow {
  id: string;
  business_id: string;
}

/**
 * NotificationSettingsRepository — all Prisma access for
 * `business_notification_settings`.
 *
 * One row per business, enforced by `uq_business_notification_settings`. Every
 * query here carries `business_id` except {@link findDueDigestsGlobal}, which
 * is the module's second registered global sweep (see repository-contract.spec).
 */
@Injectable()
export class NotificationSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The business's settings row, or null when it has never been written. */
  async findByBusiness(businessId: string): Promise<business_notification_settings | null> {
    return this.prisma.business_notification_settings.findFirst({
      where: { business_id: businessId },
    });
  }

  /**
   * Create the row for a business, or return the existing one.
   *
   * `upsert` on the unique `business_id` rather than a read-then-create: two
   * concurrent first-time requests would both see no row and both insert, and
   * the loser would surface a P2002 from what is a read-shaped endpoint.
   */
  async ensureForBusiness(
    businessId: string,
    defaults: SettingsPatch,
  ): Promise<business_notification_settings> {
    return this.prisma.business_notification_settings.upsert({
      where: { business_id: businessId },
      create: { business_id: businessId, ...defaults },
      update: {},
    });
  }

  /**
   * Apply a patch to the business's row.
   *
   * `updateMany` with the tenant in its own `where`, not `update({ where: { id } })`:
   * the id was resolved through a scoped read, but the write must not depend on
   * that having happened. A zero count means the row belongs to another tenant
   * or is gone, and the caller turns it into a 404.
   */
  async updateForBusiness(businessId: string, patch: SettingsPatch): Promise<number> {
    const result = await this.prisma.business_notification_settings.updateMany({
      where: { business_id: businessId },
      data: patch as Prisma.business_notification_settingsUpdateManyMutationInput,
    });
    return result.count;
  }

  /**
   * Businesses whose digest is due at or before `now`.
   *
   * Global by necessity — the sweep runs on a cron with no request tenant, and
   * the question it asks is *which* tenants are due. Selects only the row id and
   * its `business_id`; every read and write that follows re-enters the scoped
   * path with that id. Registered in repository-contract.spec's GLOBAL_SWEEPS.
   */
  async findDueDigestsGlobal(
    now: Date,
    limit: number = DIGEST_SWEEP_BATCH_SIZE,
  ): Promise<DueDigestRow[]> {
    return this.prisma.business_notification_settings.findMany({
      where: {
        digest_frequency: { not: NotificationDigestFrequency.OFF },
        next_digest_at: { not: null, lte: now },
      },
      select: { id: true, business_id: true },
      orderBy: { next_digest_at: 'asc' },
      take: limit,
    });
  }

  /**
   * Claim a due digest by moving its `next_digest_at` forward, returning
   * whether this caller won the claim.
   *
   * The `next_digest_at` in the `where` is what makes two overlapping sweep
   * ticks — or two API instances running the same cron — cut one digest rather
   * than two. Reading the row and then writing it would leave exactly that race,
   * and a duplicated digest is the failure operators actually notice.
   */
  async claimDigest(
    businessId: string,
    dueAt: Date,
    nextAt: Date | null,
    sentAt: Date,
  ): Promise<boolean> {
    const result = await this.prisma.business_notification_settings.updateMany({
      where: { business_id: businessId, next_digest_at: dueAt },
      data: { next_digest_at: nextAt, last_digest_sent_at: sentAt },
    });
    return result.count > 0;
  }

  /**
   * The business's own contact address, used as the last-resort digest
   * recipient.
   *
   * `businesses` is the tenant root rather than another module's table, and
   * this reads one column of the row the tenant *is* — the same latitude the
   * module already takes with `clients` for recipient resolution. It is keyed by
   * the id, which is the tenant predicate.
   */
  async findBusinessEmail(businessId: string): Promise<string | null> {
    const row = await this.prisma.businesses.findFirst({
      where: { id: businessId },
      select: { email: true },
    });
    return row?.email ?? null;
  }

  /** The `next_digest_at` currently stored, used to build a claim predicate. */
  async findDigestDueAt(businessId: string): Promise<Date | null> {
    const row = await this.prisma.business_notification_settings.findFirst({
      where: { business_id: businessId },
      select: { next_digest_at: true },
    });
    return row?.next_digest_at ?? null;
  }
}
