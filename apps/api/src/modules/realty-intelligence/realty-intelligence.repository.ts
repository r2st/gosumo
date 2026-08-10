import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { realty_intelligence_aggregates } from '@prisma/client';
import { IntelligenceMetricType } from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface UpsertAggregateData {
  businessId: string;
  corridor: string;
  metricType: IntelligenceMetricType;
  metricValue: Prisma.InputJsonValue;
  sampleSize: number;
  minNThreshold: number;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * RealtyIntelligenceRepository — all Prisma access for the L1 intelligence layer.
 *
 * Owns `realty_intelligence_aggregates` (reads + upserts, every query scoped by
 * business_id). Also reads/writes the single `intelligence_opt_in` consent flag
 * on the tenant `businesses` row, and lists opted-in tenants for the nightly run
 * — the only cross-cutting reads this module performs.
 */
@Injectable()
export class RealtyIntelligenceRepository {
  private readonly logger = new Logger(RealtyIntelligenceRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Aggregates ──────────────────────────────

  /**
   * Insert or refresh one corridor aggregate for its (business, corridor, metric,
   * period_start) window. Re-running the nightly job over the same window updates
   * in place rather than duplicating.
   */
  async upsertAggregate(
    data: UpsertAggregateData,
  ): Promise<realty_intelligence_aggregates> {
    return this.prisma.realty_intelligence_aggregates.upsert({
      where: {
        business_id_corridor_metric_type_period_start: {
          business_id: data.businessId,
          corridor: data.corridor,
          metric_type: data.metricType,
          period_start: data.periodStart,
        },
      },
      create: {
        business_id: data.businessId,
        corridor: data.corridor,
        metric_type: data.metricType,
        metric_value: data.metricValue,
        sample_size: data.sampleSize,
        min_n_threshold: data.minNThreshold,
        period_start: data.periodStart,
        period_end: data.periodEnd,
      },
      update: {
        metric_value: data.metricValue,
        sample_size: data.sampleSize,
        min_n_threshold: data.minNThreshold,
        period_end: data.periodEnd,
      },
    });
  }

  /** Most-recent aggregate per metric for a corridor (one row per metric_type). */
  async findLatestByCorridor(
    businessId: string,
    corridor: string,
    metricTypes?: IntelligenceMetricType[],
  ): Promise<realty_intelligence_aggregates[]> {
    const where: Prisma.realty_intelligence_aggregatesWhereInput = {
      business_id: businessId,
      corridor,
    };
    if (metricTypes && metricTypes.length) where.metric_type = { in: metricTypes };

    const rows = await this.prisma.realty_intelligence_aggregates.findMany({
      where,
      orderBy: [{ metric_type: 'asc' }, { period_end: 'desc' }],
    });

    // Keep only the newest row per metric_type.
    const latest = new Map<string, realty_intelligence_aggregates>();
    for (const row of rows) {
      if (!latest.has(row.metric_type)) latest.set(row.metric_type, row);
    }
    return [...latest.values()];
  }

  /** All aggregates for a business, newest first — powers the dashboard. */
  async listByBusiness(
    businessId: string,
    filters: { corridor?: string; metricType?: IntelligenceMetricType } = {},
  ): Promise<realty_intelligence_aggregates[]> {
    const where: Prisma.realty_intelligence_aggregatesWhereInput = {
      business_id: businessId,
    };
    if (filters.corridor) where.corridor = filters.corridor;
    if (filters.metricType) where.metric_type = filters.metricType;

    return this.prisma.realty_intelligence_aggregates.findMany({
      where,
      orderBy: [{ corridor: 'asc' }, { metric_type: 'asc' }],
    });
  }

  /** Distinct corridors that currently have aggregates for a business. */
  async listCorridors(businessId: string): Promise<string[]> {
    const rows = await this.prisma.realty_intelligence_aggregates.findMany({
      where: { business_id: businessId },
      distinct: ['corridor'],
      select: { corridor: true },
      orderBy: { corridor: 'asc' },
    });
    return rows.map((r) => r.corridor);
  }

  // ── Consent (businesses.intelligence_opt_in) ────

  async getOptInStatus(businessId: string): Promise<boolean> {
    const row = await this.prisma.businesses.findFirst({
      where: { id: businessId, deleted_at: null },
      select: { intelligence_opt_in: true },
    });
    return row?.intelligence_opt_in ?? false;
  }

  async setOptIn(businessId: string, optIn: boolean): Promise<void> {
    await this.prisma.businesses.update({
      where: { id: businessId },
      data: { intelligence_opt_in: optIn },
    });
  }

  /** Ids of every active business that has consented to contribute (nightly run). */
  async listOptInBusinessIds(): Promise<string[]> {
    const rows = await this.prisma.businesses.findMany({
      where: { intelligence_opt_in: true, deleted_at: null, is_active: true },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
