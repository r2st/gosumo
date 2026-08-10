import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  generateId,
  generateCorrelationId,
  LeadStage,
} from '@gosumo/shared';
import type {
  LaunchMetrics,
  LaunchGateReport,
  RealtyLaunchGateEvaluatedEvent,
} from '@gosumo/shared';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { RealtyVisitsService } from '../realty-sitevisits/realty-sitevisits.service';
import { RealtyBrokerService } from '../realty-broker/realty-broker.service';
import { NoShipService } from './no-ship.service';
import { evaluateLaunchGate } from './launch-gate.util';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stages a lead reaches only after being qualified (funnel-forward of QUALIFIED). */
const QUALIFIED_STAGES = new Set<string>([
  LeadStage.QUALIFIED,
  LeadStage.VISIT_BOOKED,
  LeadStage.VISITED,
  LeadStage.NEGOTIATING,
  LeadStage.CLOSED_WON,
]);

/**
 * LaunchGateService — the launch-readiness gate (Phase 8, blueprint §24).
 *
 * Assembles the pilot KPIs from the realty modules (leads pipeline, site visits,
 * broker autonomy + hot-alert responsiveness) plus the no-ship ledger, then runs
 * the pure gate to produce a GO / NO-GO / NOT_READY verdict. Response-P95 has no
 * first-class source in the realty tables, so it is supplied from observability
 * via `manual.responseP95Seconds`; when absent that check reads INSUFFICIENT_DATA.
 */
@Injectable()
export class LaunchGateService {
  private readonly logger = new Logger(LaunchGateService.name);

  constructor(
    private readonly leadsService: RealtyLeadsService,
    private readonly visitsService: RealtyVisitsService,
    private readonly brokerService: RealtyBrokerService,
    private readonly noShipService: NoShipService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async assembleMetrics(
    businessId: string,
    manual: { responseP95Seconds?: number } = {},
    windowDays?: number,
    now: Date = new Date(),
  ): Promise<LaunchMetrics> {
    const since = windowDays ? new Date(now.getTime() - windowDays * DAY_MS) : undefined;

    const [board, visitStats, aiAutonomyPct, hotRate, noShipIncidents, noShipByKind] =
      await Promise.all([
        this.leadsService.getBoard(businessId),
        this.visitsService.getVisitStats(businessId),
        this.brokerService.getAiHandledPct(businessId),
        this.brokerService.getHotAlertActionRate(businessId, since),
        this.noShipService.count(businessId, since),
        this.noShipService.countByKind(businessId, since),
      ]);

    const totalLeads = board.reduce((sum, b) => sum + b.count, 0);
    const stageCount = (stage: string): number => board.find((b) => b.stage === stage)?.count ?? 0;
    const qualified = board.filter((b) => QUALIFIED_STAGES.has(b.stage)).reduce((s, b) => s + b.count, 0);
    const engaged = totalLeads - stageCount(LeadStage.NEW);

    const pct = (num: number, den: number): number | null =>
      den === 0 ? null : Math.round((num / den) * 1000) / 10;

    const showUpDen = visitStats.completed + visitStats.noShow;

    return {
      responseP95Seconds: manual.responseP95Seconds ?? null,
      engagementRatePct: pct(engaged, totalLeads),
      qualificationRatePct: pct(qualified, totalLeads),
      visitsPer100Leads: totalLeads === 0 ? null : Math.round((visitStats.total / totalLeads) * 1000) / 10,
      showUpRatePct: pct(visitStats.completed, showUpDen),
      aiAutonomyPct,
      hotAlertActionRatePct: hotRate == null ? null : Math.round(hotRate * 1000) / 10,
      noShipIncidents,
      noShipByKind,
      totalLeads,
    };
  }

  /** Evaluate the full gate and emit the outcome. */
  async evaluate(
    businessId: string,
    manual: { responseP95Seconds?: number } = {},
    windowDays?: number,
    now: Date = new Date(),
  ): Promise<LaunchGateReport> {
    const metrics = await this.assembleMetrics(businessId, manual, windowDays, now);
    const report = evaluateLaunchGate(metrics, now.toISOString(), windowDays ?? null);

    const event: RealtyLaunchGateEvaluatedEvent = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      type: 'realty.launch_gate.evaluated',
      status: report.status,
      passed: report.passed,
      failed: report.failed,
      insufficient: report.insufficient,
    };
    this.eventEmitter.emit('realty.launch_gate.evaluated', event);

    this.logger.log(
      `Launch gate for ${businessId}: ${report.status} ` +
        `(${report.passed} pass · ${report.failed} fail · ${report.insufficient} insufficient)`,
    );
    return report;
  }
}
