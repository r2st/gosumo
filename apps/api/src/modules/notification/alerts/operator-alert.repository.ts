import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { operator_alerts } from '@prisma/client';
import { OperatorAlertStatus } from '@gosumo/database';

import { PrismaService } from '../../../common/services/prisma.service';
import { ALERT_RELEASE_BATCH_SIZE } from './operator-alert.constants';

/** Everything needed to write one alert row. */
export interface CreateOperatorAlertData {
  kind: string;
  severity: string;
  title: string;
  body?: string | null;
  sourceChannel?: string | null;
  conversationId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  context?: Prisma.InputJsonValue;
  status: OperatorAlertStatus;
  reason?: string | null;
  deferredUntil?: Date | null;
  dedupeKey?: string | null;
}

/** The columns a delivery attempt writes back. */
export interface OperatorAlertOutcome {
  status: OperatorAlertStatus;
  reason?: string | null;
  deliveredAt?: Date | null;
  deliveredTo?: string[];
  deferredUntil?: Date | null;
}

export interface OperatorAlertListFilters {
  kind?: string;
  severity?: string;
  status?: OperatorAlertStatus;
  /** true = unread only, false = read only, undefined = both. */
  unreadOnly?: boolean;
  conversationId?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedOperatorAlerts {
  data: operator_alerts[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** One row the release sweep has found due. */
export interface DueAlertRow {
  id: string;
  business_id: string;
}

/**
 * OperatorAlertRepository — all Prisma access for `operator_alerts`.
 *
 * Every query carries `business_id` except {@link findDueDeferredGlobal}, which
 * is the sweep's discriminator scan and is registered in
 * repository-contract.spec's GLOBAL_SWEEPS.
 */
@Injectable()
export class OperatorAlertRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insert one alert.
   *
   * Left to throw P2002 on a duplicate `dedupe_key` rather than upserting: the
   * caller wants to know whether *this* raise created the row, because that is
   * what gates delivery. Silently updating an existing row would re-send an
   * alert the operator has already read.
   */
  async create(
    businessId: string,
    data: CreateOperatorAlertData,
  ): Promise<operator_alerts> {
    return this.prisma.operator_alerts.create({
      data: {
        business_id: businessId,
        kind: data.kind,
        severity: data.severity,
        title: data.title,
        body: data.body ?? null,
        source_channel: data.sourceChannel ?? null,
        conversation_id: data.conversationId ?? null,
        entity_type: data.entityType ?? null,
        entity_id: data.entityId ?? null,
        context: data.context ?? {},
        status: data.status,
        reason: data.reason ?? null,
        deferred_until: data.deferredUntil ?? null,
        dedupe_key: data.dedupeKey ?? null,
      },
    });
  }

  /** The alert already holding `dedupeKey` for this business, if any. */
  async findByDedupeKey(
    businessId: string,
    dedupeKey: string,
  ): Promise<operator_alerts | null> {
    return this.prisma.operator_alerts.findFirst({
      where: { business_id: businessId, dedupe_key: dedupeKey },
    });
  }

  async findById(businessId: string, id: string): Promise<operator_alerts | null> {
    return this.prisma.operator_alerts.findFirst({
      where: { business_id: businessId, id },
    });
  }

  /**
   * Record what happened to a delivery attempt.
   *
   * `updateMany` with the tenant in its own `where` rather than
   * `update({ where: { id } })`: the id came from a scoped read, but the write
   * must not depend on that having happened.
   */
  async recordOutcome(
    businessId: string,
    id: string,
    outcome: OperatorAlertOutcome,
  ): Promise<number> {
    const data: Prisma.operator_alertsUpdateManyMutationInput = {
      status: outcome.status,
    };
    if (outcome.reason !== undefined) data.reason = outcome.reason;
    if (outcome.deliveredAt !== undefined) data.delivered_at = outcome.deliveredAt;
    if (outcome.deliveredTo !== undefined) data.delivered_to = outcome.deliveredTo;
    if (outcome.deferredUntil !== undefined) data.deferred_until = outcome.deferredUntil;

    const result = await this.prisma.operator_alerts.updateMany({
      where: { business_id: businessId, id },
      data,
    });
    return result.count;
  }

  /**
   * Claim a deferred alert for delivery by moving it out of DEFERRED.
   *
   * `status: DEFERRED` in the `where` is what makes two overlapping sweep ticks
   * — or two API instances running the same cron — deliver one alert rather
   * than two. Reading the row and then writing it would leave exactly that
   * race, and a duplicated 3am page is the failure operators actually notice.
   */
  async claimDeferred(businessId: string, id: string): Promise<boolean> {
    const result = await this.prisma.operator_alerts.updateMany({
      where: { business_id: businessId, id, status: OperatorAlertStatus.DEFERRED },
      data: { status: OperatorAlertStatus.PENDING },
    });
    return result.count === 1;
  }

  /**
   * Alerts whose quiet-hours window has ended.
   *
   * Global by necessity — the sweep runs on a cron with no request tenant, and
   * the question it asks is *which* tenants are holding released alerts.
   * Selects only the row id and its `business_id`; every read and write that
   * follows re-enters the scoped path with that id. Registered in
   * repository-contract.spec's GLOBAL_SWEEPS.
   */
  async findDueDeferredGlobal(
    now: Date,
    limit: number = ALERT_RELEASE_BATCH_SIZE,
  ): Promise<DueAlertRow[]> {
    return this.prisma.operator_alerts.findMany({
      where: {
        status: OperatorAlertStatus.DEFERRED,
        deferred_until: { not: null, lte: now },
      },
      select: { id: true, business_id: true },
      orderBy: { deferred_until: 'asc' },
      take: limit,
    });
  }

  /** The operator inbox, newest first. */
  async list(
    businessId: string,
    filters: OperatorAlertListFilters,
  ): Promise<PaginatedOperatorAlerts> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;

    const where: Prisma.operator_alertsWhereInput = { business_id: businessId };
    if (filters.kind) where.kind = filters.kind;
    if (filters.severity) where.severity = filters.severity;
    if (filters.status) where.status = filters.status;
    if (filters.conversationId) where.conversation_id = filters.conversationId;
    if (filters.unreadOnly === true) where.read_at = null;
    if (filters.unreadOnly === false) where.read_at = { not: null };

    const [data, total] = await Promise.all([
      this.prisma.operator_alerts.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.operator_alerts.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Mark one alert read. Returns the number of rows changed, so a second
   * click — or another operator getting there first — is distinguishable from
   * an id that belongs to another tenant.
   *
   * `read_at: null` in the `where` keeps the *first* reader's timestamp, which
   * is the one that answers "how long did this sit unread".
   */
  async markRead(
    businessId: string,
    id: string,
    readBy: string | null,
    at: Date,
  ): Promise<number> {
    const result = await this.prisma.operator_alerts.updateMany({
      where: { business_id: businessId, id, read_at: null },
      data: { read_at: at, read_by: readBy },
    });
    return result.count;
  }

  /** Mark every unread alert read. Returns how many were still unread. */
  async markAllRead(
    businessId: string,
    readBy: string | null,
    at: Date,
  ): Promise<number> {
    const result = await this.prisma.operator_alerts.updateMany({
      where: { business_id: businessId, read_at: null },
      data: { read_at: at, read_by: readBy },
    });
    return result.count;
  }

  /** Unread count for the dashboard badge. */
  async countUnread(businessId: string): Promise<number> {
    return this.prisma.operator_alerts.count({
      where: { business_id: businessId, read_at: null },
    });
  }

  /** Unread counts split by severity, so the badge can be coloured. */
  async countUnreadBySeverity(
    businessId: string,
  ): Promise<Array<{ severity: string; count: number }>> {
    const rows = await this.prisma.operator_alerts.groupBy({
      by: ['severity'],
      where: { business_id: businessId, read_at: null },
      _count: { _all: true },
    });
    return rows.map((row) => ({ severity: row.severity, count: row._count._all }));
  }
}
