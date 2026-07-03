import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { realty_intelligence_aggregates } from '@prisma/client';
import {
  IntelligenceMetricType,
  generateId,
  generateCorrelationId,
} from '@gosumo/shared';
import type {
  RealtyIntelligenceAggregatesGeneratedEvent,
  RealtyIntelligenceOptedInEvent,
  RealtyIntelligenceOptedOutEvent,
} from '@gosumo/shared';
import { LlmClientService, LlmUnavailableError } from '../ai-engine/pipeline/llm-client.service';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import type { LeadResponseDto } from '../realty-leads/realty-leads.service';
import { RealtyIntelligenceRepository } from './realty-intelligence.repository';
import {
  computeAggregatesForBusiness,
  sourceQuality,
  IntelLead,
} from './intelligence-aggregation.util';
import { buildCorridorContext } from './corridor-context.util';
import type { CorridorAggregate } from './corridor-context.util';
import {
  DEFAULT_MIN_N_THRESHOLD,
  AGGREGATION_LOOKBACK_DAYS,
  LEAD_FETCH_PAGE_SIZE,
  INTELLIGENCE_SUMMARY_MODEL,
} from './realty-intelligence.constants';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AggregateDto {
  id: string;
  corridor: string;
  metricType: IntelligenceMetricType;
  metricValue: unknown;
  sampleSize: number;
  minNThreshold: number;
  periodStart: string;
  periodEnd: string;
  updatedAt: string;
}

export interface SourceQualityReport {
  businessId: string;
  totalLeads: number;
  generatedAt: string;
  sources: Array<{
    source: string;
    leads: number;
    qualifiedRate: number;
    visitRate: number;
    avgQualScore: number;
  }>;
}

export interface NightlyRunResult {
  businessCount: number;
  aggregateCount: number;
  corridorCount: number;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * RealtyIntelligenceService — the micro-market intelligence layer (L1, §18).
 *
 * Builds consented, anonymized corridor aggregates nightly, exposes them as
 * priors for the grounded AI prompt, reports per-business source ROI, and manages
 * the tenant's opt-in consent. All corridor aggregation runs ONLY over businesses
 * with `intelligence_opt_in = true`, and only emits a corridor when it clears the
 * minimum-n threshold so no individual lead can be reconstructed.
 */
@Injectable()
export class RealtyIntelligenceService {
  private readonly logger = new Logger(RealtyIntelligenceService.name);

  constructor(
    private readonly repository: RealtyIntelligenceRepository,
    private readonly leads: RealtyLeadsService,
    private readonly llm: LlmClientService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // NIGHTLY AGGREGATION
  // ─────────────────────────────────────────────

  /**
   * Build corridor aggregates for opted-in businesses. Runs nightly via the Bull
   * processor, but is callable directly and per-tenant. Businesses that have not
   * opted in are never touched.
   */
  async generateNightlyAggregates(
    now: Date = new Date(),
    businessId?: string,
  ): Promise<NightlyRunResult> {
    const periodEnd = now;
    const periodStart = new Date(now.getTime() - AGGREGATION_LOOKBACK_DAYS * DAY_MS);

    const businessIds = businessId
      ? (await this.repository.getOptInStatus(businessId))
        ? [businessId]
        : []
      : await this.repository.listOptInBusinessIds();

    let aggregateCount = 0;
    const corridors = new Set<string>();

    for (const bId of businessIds) {
      const leads = await this.fetchIntelLeads(bId, periodStart);
      const aggregates = computeAggregatesForBusiness(leads, DEFAULT_MIN_N_THRESHOLD);
      for (const agg of aggregates) {
        await this.repository.upsertAggregate({
          businessId: bId,
          corridor: agg.corridor,
          metricType: agg.metricType,
          metricValue: agg.metricValue as unknown as Prisma.InputJsonValue,
          sampleSize: agg.sampleSize,
          minNThreshold: DEFAULT_MIN_N_THRESHOLD,
          periodStart,
          periodEnd,
        });
        aggregateCount++;
        corridors.add(`${bId}:${agg.corridor}`);
      }
    }

    const result: NightlyRunResult = {
      businessCount: businessIds.length,
      aggregateCount,
      corridorCount: corridors.size,
      periodStart,
      periodEnd,
    };

    this.emit<RealtyIntelligenceAggregatesGeneratedEvent>(
      'realty.intelligence.aggregates_generated',
      {
        ...this.baseEvent(businessId ?? 'system'),
        type: 'realty.intelligence.aggregates_generated',
        businessCount: result.businessCount,
        aggregateCount: result.aggregateCount,
        corridorCount: result.corridorCount,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      },
    );
    this.logger.log(
      `Nightly aggregates: ${aggregateCount} rows across ${corridors.size} corridors ` +
        `for ${businessIds.length} opted-in business(es)`,
    );
    return result;
  }

  /** Page a business's recent leads into the minimal aggregation projection. */
  private async fetchIntelLeads(businessId: string, since: Date): Promise<IntelLead[]> {
    const out: IntelLead[] = [];
    let page = 1;
    // Guard against an unbounded loop; 200 pages × 500 = 100k leads is ample.
    for (let guard = 0; guard < 200; guard++) {
      const res = await this.leads.listLeads(businessId, {
        page,
        limit: LEAD_FETCH_PAGE_SIZE,
      });
      for (const lead of res.data) {
        if (lead.firstTouchAt && new Date(lead.firstTouchAt) < since) continue;
        out.push(this.toIntelLead(lead));
      }
      if (res.data.length < LEAD_FETCH_PAGE_SIZE || page >= res.totalPages) break;
      page++;
    }
    return out;
  }

  private toIntelLead(lead: LeadResponseDto): IntelLead {
    return {
      source: lead.source,
      stage: lead.stage,
      qualScore: lead.qualScore,
      localities: lead.bltc.localities ?? [],
      budgetMinPaise: lead.bltc.budgetMinPaise ?? null,
      budgetMaxPaise: lead.bltc.budgetMaxPaise ?? null,
      config: lead.bltc.config ?? null,
      objections: (lead.objections ?? []).map((o) => o.text).filter(Boolean),
      firstTouchAt: new Date(lead.firstTouchAt),
      lastActivityAt: lead.lastActivityAt ? new Date(lead.lastActivityAt) : null,
    };
  }

  // ─────────────────────────────────────────────
  // AI PROMPT INJECTION
  // ─────────────────────────────────────────────

  /**
   * Retrieve the latest aggregates for a corridor, restricted to `metricTypes`
   * when given. This is the read the AI loop uses to ground its priors.
   */
  async getCorridorPriors(
    businessId: string,
    corridor: string,
    metricTypes?: IntelligenceMetricType[],
  ): Promise<AggregateDto[]> {
    const rows = await this.repository.findLatestByCorridor(businessId, corridor, metricTypes);
    return rows.map((r) => this.toAggregateDto(r));
  }

  /**
   * Build the `<micro_market_intelligence>` prompt section for a corridor, or
   * null when there are no aggregates. Formats the priors as guidance only —
   * never as quotable facts (the fact sheets remain the sole ground truth).
   */
  async buildCorridorContext(businessId: string, corridor: string): Promise<string | null> {
    if (!corridor) return null;
    const rows = await this.repository.findLatestByCorridor(businessId, corridor);
    if (!rows.length) return null;
    const aggregates: CorridorAggregate[] = rows.map((r) => ({
      metricType: r.metric_type as IntelligenceMetricType,
      metricValue: r.metric_value,
      sampleSize: r.sample_size,
    }));
    return buildCorridorContext(corridor, aggregates);
  }

  /**
   * Best-effort one-line natural-language narration of a corridor's priors via a
   * free OpenRouter model. Falls back to the deterministic context string if the
   * LLM is unavailable — summarization is a nicety, never on the critical path.
   */
  async getCorridorNarrative(businessId: string, corridor: string): Promise<string | null> {
    const context = await this.buildCorridorContext(businessId, corridor);
    if (!context) return null;
    try {
      const completion = await this.llm.complete({
        system:
          'You compress real-estate micro-market statistics into ONE concise sentence of ' +
          'advice for a broker. Do not invent numbers; only use what is given.',
        user: `Summarize these corridor priors in one sentence:\n\n${context}`,
        model: INTELLIGENCE_SUMMARY_MODEL,
        maxTokens: 120,
        temperature: 0.2,
      });
      const text = completion.text.trim();
      return text || context;
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) {
        this.logger.warn(
          `Corridor narration failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return context;
    }
  }

  // ─────────────────────────────────────────────
  // REPORTS
  // ─────────────────────────────────────────────

  /**
   * Per-business source ROI: how each lead source performs downstream (qualified
   * rate, site-visit rate, average score). Computed over the business's own leads
   * only, so no minimum-n suppression applies (a broker sees their own data).
   */
  async getSourceQualityReport(businessId: string): Promise<SourceQualityReport> {
    const periodStart = new Date(Date.now() - AGGREGATION_LOOKBACK_DAYS * DAY_MS);
    const leads = await this.fetchIntelLeads(businessId, periodStart);
    const { sources } = sourceQuality(leads, 1);
    return {
      businessId,
      totalLeads: leads.length,
      generatedAt: new Date().toISOString(),
      sources,
    };
  }

  /** All stored aggregates for a business (dashboard feed). */
  async listAggregates(
    businessId: string,
    filters: { corridor?: string; metricType?: IntelligenceMetricType } = {},
  ): Promise<AggregateDto[]> {
    const rows = await this.repository.listByBusiness(businessId, filters);
    return rows.map((r) => this.toAggregateDto(r));
  }

  /** Distinct corridors with aggregates for a business. */
  async listCorridors(businessId: string): Promise<string[]> {
    return this.repository.listCorridors(businessId);
  }

  // ─────────────────────────────────────────────
  // CONSENT
  // ─────────────────────────────────────────────

  async getOptInStatus(businessId: string): Promise<boolean> {
    return this.repository.getOptInStatus(businessId);
  }

  async optIn(businessId: string): Promise<{ optIn: boolean }> {
    await this.repository.setOptIn(businessId, true);
    this.emit<RealtyIntelligenceOptedInEvent>('realty.intelligence.opted_in', {
      ...this.baseEvent(businessId),
      type: 'realty.intelligence.opted_in',
    });
    this.logger.log(`Business ${businessId} opted IN to micro-market intelligence`);
    return { optIn: true };
  }

  async optOut(businessId: string): Promise<{ optIn: boolean }> {
    await this.repository.setOptIn(businessId, false);
    this.emit<RealtyIntelligenceOptedOutEvent>('realty.intelligence.opted_out', {
      ...this.baseEvent(businessId),
      type: 'realty.intelligence.opted_out',
    });
    this.logger.log(`Business ${businessId} opted OUT of micro-market intelligence`);
    return { optIn: false };
  }

  // ─────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────

  private toAggregateDto(row: realty_intelligence_aggregates): AggregateDto {
    return {
      id: row.id,
      corridor: row.corridor,
      metricType: row.metric_type as IntelligenceMetricType,
      metricValue: row.metric_value,
      sampleSize: row.sample_size,
      minNThreshold: row.min_n_threshold,
      periodStart: row.period_start.toISOString(),
      periodEnd: row.period_end.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private baseEvent(businessId: string) {
    return {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
    };
  }

  private emit<T>(name: string, payload: T): void {
    this.eventEmitter.emit(name, payload);
  }
}
