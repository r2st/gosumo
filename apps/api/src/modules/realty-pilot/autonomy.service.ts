import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { realty_autonomy_events } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  AutonomyLevel,
  AutonomyDirection,
  AutonomyActorType,
} from '@gosumo/shared';
import type {
  AutonomyEvidence,
  AutonomyRecommendation,
  RealtyAutonomyChangedEvent,
} from '@gosumo/shared';
import { RealtyPilotRepository } from './realty-pilot.repository';
import { RealtyBrokerService } from '../realty-broker/realty-broker.service';
import { NoShipService } from './no-ship.service';
import { evaluateAutonomyLadder } from './autonomy-ladder.util';

export interface AutonomyEventDto {
  id: string;
  direction: string;
  fromLevel: string;
  toLevel: string;
  fromThreshold: number;
  toThreshold: number;
  reason: string;
  actorType: string;
  actorId: string | null;
  evidence: AutonomyEvidence;
  createdAt: Date;
}

export interface AutonomyEvaluation {
  current: { level: string; threshold: number };
  recommendation: AutonomyRecommendation;
}

export interface AutonomyAdvanceResult extends AutonomyEvaluation {
  applied: boolean;
  eventId: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * AutonomyService — the evidence-driven autonomy dial (Phase 8, blueprint §22).
 *
 * The static dial (level + auto-approve threshold) lives in `realty-broker`.
 * This service decides HOW it should move: it gathers evidence (resolved-draft
 * accuracy, days live, hot-alert responsiveness, no-ship incidents), runs the
 * pure ladder, and — on `advance` — applies an OPEN/CLOSE by updating the broker
 * settings and writing an immutable row to the autonomy-event ledger.
 */
@Injectable()
export class AutonomyService {
  private readonly logger = new Logger(AutonomyService.name);

  constructor(
    private readonly repository: RealtyPilotRepository,
    private readonly brokerService: RealtyBrokerService,
    private readonly noShipService: NoShipService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Gather the current evidence for a business's autonomy dial. */
  async gatherEvidence(businessId: string, now: Date = new Date()): Promise<AutonomyEvidence> {
    const [settings, approvalStats, hotRate, noShipIncidents] = await Promise.all([
      this.brokerService.getSettings(businessId),
      this.brokerService.getApprovalStats(businessId),
      this.brokerService.getHotAlertActionRate(businessId),
      this.noShipService.count(businessId),
    ]);

    const daysActive = Math.max(0, Math.floor((now.getTime() - settings.created_at.getTime()) / DAY_MS));
    const { resolved, approvedVerbatim } = approvalStats;
    const approvalAccuracy = resolved === 0 ? 0 : approvedVerbatim / resolved;

    return {
      daysActive,
      decisionsObserved: resolved,
      approvedVerbatim,
      approvalAccuracy,
      noShipIncidents,
      hotAlertActionRate: hotRate ?? 0,
    };
  }

  /** Preview the dial recommendation without changing anything. */
  async evaluate(businessId: string, now: Date = new Date()): Promise<AutonomyEvaluation> {
    const settings = await this.brokerService.getSettings(businessId);
    const current = { level: settings.autonomy_level, threshold: settings.auto_approve_threshold };
    const evidence = await this.gatherEvidence(businessId, now);
    return { current, recommendation: evaluateAutonomyLadder(current, evidence) };
  }

  /**
   * Evaluate and, when `apply` and the ladder recommends an actual change
   * (OPEN/CLOSE), move the dial: update the broker settings and append an
   * immutable ledger row. A HOLD never writes.
   */
  async advance(
    businessId: string,
    apply: boolean,
    actorId?: string,
    now: Date = new Date(),
  ): Promise<AutonomyAdvanceResult> {
    const { current, recommendation } = await this.evaluate(businessId, now);
    const changed = recommendation.direction !== AutonomyDirection.HOLD;

    if (!apply || !changed) {
      return { current, recommendation, applied: false, eventId: null };
    }

    const { to } = recommendation;
    await this.brokerService.updateSettings(businessId, {
      autonomyLevel: to.level as AutonomyLevel,
      autoApproveThreshold: to.threshold,
    });

    const actorType = actorId ? AutonomyActorType.HUMAN : AutonomyActorType.AI;
    const event = await this.repository.createAutonomyEvent({
      businessId,
      direction: recommendation.direction as realty_autonomy_events['direction'],
      fromLevel: recommendation.from.level as realty_autonomy_events['from_level'],
      toLevel: to.level as realty_autonomy_events['to_level'],
      fromThreshold: recommendation.from.threshold,
      toThreshold: to.threshold,
      evidence: recommendation.evidence as unknown as Prisma.InputJsonValue,
      reason: recommendation.reason,
      actorType: actorType as realty_autonomy_events['actor_type'],
      actorId: actorId ?? null,
    });

    const changeEvent: RealtyAutonomyChangedEvent = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      type: 'realty.autonomy.changed',
      autonomyEventId: event.id,
      direction: recommendation.direction,
      fromLevel: recommendation.from.level,
      toLevel: to.level,
      fromThreshold: recommendation.from.threshold,
      toThreshold: to.threshold,
      actorType,
    };
    this.eventEmitter.emit('realty.autonomy.changed', changeEvent);

    this.logger.log(
      `Autonomy ${recommendation.direction} for ${businessId}: ${recommendation.from.level}@${recommendation.from.threshold} → ${to.level}@${to.threshold}`,
    );

    return { current, recommendation, applied: true, eventId: event.id };
  }

  async listEvents(businessId: string): Promise<AutonomyEventDto[]> {
    const rows = await this.repository.listAutonomyEvents(businessId);
    return rows.map((r) => this.map(r));
  }

  private map(r: realty_autonomy_events): AutonomyEventDto {
    return {
      id: r.id,
      direction: r.direction,
      fromLevel: r.from_level,
      toLevel: r.to_level,
      fromThreshold: r.from_threshold,
      toThreshold: r.to_threshold,
      reason: r.reason,
      actorType: r.actor_type,
      actorId: r.actor_id,
      evidence: (r.evidence ?? {}) as unknown as AutonomyEvidence,
      createdAt: r.created_at,
    };
  }
}
