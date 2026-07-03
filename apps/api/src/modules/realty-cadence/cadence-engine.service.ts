import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { realty_cadence_enrollments } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  CadenceTrigger,
  CadenceStopOn,
  LeadStage,
} from '@gosumo/shared';
import type {
  CadenceStepCondition,
  ComplianceDecision,
  RealtyCadenceStartedEvent,
  RealtyCadenceStepSentEvent,
  RealtyCadenceCompletedEvent,
  RealtyLeadCreatedEvent,
  RealtyLeadStageChangedEvent,
  RealtyLeadOptedOutEvent,
  MessageReceivedEvent,
} from '@gosumo/shared';
import { RealtyCadenceRepository } from './realty-cadence.repository';
import type { StepWithTemplate } from './realty-cadence.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import type { LeadResponseDto } from '../realty-leads/realty-leads.service';
import { evaluateCompliance } from './compliance.util';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProcessResult {
  processed: number;
  sent: number;
  skipped: number;
  stopped: number;
  completed: number;
}

/**
 * CadenceEngineService — the declarative follow-up engine (blueprint §17).
 *
 * Auto-enrols leads when a trigger fires (new-enquiry → NO_RESPONSE, completed
 * visit → POST_VISIT, gone-dormant → DORMANT), executes each step on schedule
 * through the WhatsApp compliance gate, and halts the instant a stop signal
 * (reply / opt-out / stage change) arrives. Opt-out is absolute — it stops every
 * cadence regardless of a step's declared stop_on.
 */
@Injectable()
export class CadenceEngineService {
  private readonly logger = new Logger(CadenceEngineService.name);

  constructor(
    private readonly repository: RealtyCadenceRepository,
    private readonly leadsService: RealtyLeadsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // ENROLMENT
  // ─────────────────────────────────────────────

  /**
   * Enrol a lead into the active cadence for `trigger`. No-op when there is no
   * active cadence for the trigger, the cadence has no steps, or the lead
   * already has an ACTIVE enrolment (one cadence at a time — no overlap).
   */
  async enroll(
    businessId: string,
    leadId: string,
    trigger: CadenceTrigger,
  ): Promise<realty_cadence_enrollments | null> {
    const cadence = await this.repository.findActiveCadenceByTrigger(businessId, trigger);
    if (!cadence) return null;

    const steps = await this.repository.listStepsByCadence(businessId, cadence.id);
    if (steps.length === 0) return null;

    const active = await this.repository.findActiveEnrollmentsForLead(businessId, leadId);
    if (active.length > 0) return null;

    const startedAt = new Date();
    const firstStep = steps[0]!;
    const enrollment = await this.repository.createEnrollment({
      businessId,
      cadenceId: cadence.id,
      leadId,
      trigger,
      nextRunAt: new Date(startedAt.getTime() + firstStep.day_offset * DAY_MS),
    });

    this.emit<RealtyCadenceStartedEvent>('realty.cadence.started', {
      ...this.baseEvent(businessId),
      type: 'realty.cadence.started',
      enrollmentId: enrollment.id,
      leadId,
      cadenceId: cadence.id,
      trigger,
    });
    this.logger.log(`Enrolled lead ${leadId} into cadence ${cadence.id} (${trigger})`);
    return enrollment;
  }

  /**
   * Stop a lead's active cadence(s) on a signal. OPTOUT always stops; REPLY and
   * STAGE_CHANGE stop only enrolments whose current step declares that signal.
   */
  async stopForLead(
    businessId: string,
    leadId: string,
    signal: CadenceStopOn,
    reason: string,
  ): Promise<number> {
    const active = await this.repository.findActiveEnrollmentsForLead(businessId, leadId);
    let stopped = 0;
    for (const enrollment of active) {
      if (signal !== CadenceStopOn.OPTOUT) {
        const steps = await this.repository.listStepsByCadence(businessId, enrollment.cadence_id);
        const currentStep = steps[enrollment.current_step];
        const stopOn = currentStep?.stop_on ?? [];
        if (!stopOn.includes(signal)) continue;
      }
      await this.finish(businessId, enrollment, 'STOPPED', reason);
      stopped++;
    }
    return stopped;
  }

  // ─────────────────────────────────────────────
  // SCHEDULED EXECUTION
  // ─────────────────────────────────────────────

  /**
   * Process every enrolment whose next step is due. Intended to be driven by a
   * scheduler (BullMQ repeat job / cron) but callable directly and per-tenant.
   */
  async processDueEnrollments(now: Date = new Date(), businessId?: string): Promise<ProcessResult> {
    const due = await this.repository.findDueEnrollments(now, businessId);
    const result: ProcessResult = { processed: 0, sent: 0, skipped: 0, stopped: 0, completed: 0 };

    for (const enrollment of due) {
      result.processed++;
      const outcome = await this.runStep(enrollment.business_id, enrollment, now);
      result[outcome]++;
    }
    if (result.processed > 0) {
      this.logger.log(
        `Cadence tick: ${result.processed} due — ${result.sent} sent, ${result.skipped} skipped, ` +
          `${result.stopped} stopped, ${result.completed} completed`,
      );
    }
    return result;
  }

  /** Run a single due enrolment's current step; returns the outcome bucket. */
  private async runStep(
    businessId: string,
    enrollment: realty_cadence_enrollments,
    now: Date,
  ): Promise<'sent' | 'skipped' | 'stopped' | 'completed'> {
    const steps = await this.repository.listStepsByCadence(businessId, enrollment.cadence_id);
    const step = steps[enrollment.current_step];
    if (!step) {
      await this.finish(businessId, enrollment, 'COMPLETED');
      return 'completed';
    }

    let lead: LeadResponseDto | null = null;
    try {
      lead = await this.leadsService.getLead(businessId, enrollment.lead_id);
    } catch {
      // Lead vanished (deleted) — stop the cadence.
      await this.finish(businessId, enrollment, 'STOPPED', 'lead_missing');
      return 'stopped';
    }

    // Opt-out is absolute — halt immediately.
    if (lead.optOut) {
      await this.finish(businessId, enrollment, 'STOPPED', 'opted_out');
      return 'stopped';
    }

    // Condition guard: an unmet condition skips the step (advance, no send).
    const condition = (step.condition ?? {}) as CadenceStepCondition;
    if (!this.conditionMet(condition, lead)) {
      return this.advance(businessId, enrollment, steps, now, 'skipped');
    }

    const decision = this.checkCompliance(step, lead, now);
    if (!decision.allowed) {
      if (decision.code === 'OPTED_OUT') {
        await this.finish(businessId, enrollment, 'STOPPED', 'opted_out');
        return 'stopped';
      }
      // Non-fatal block (window/template) — skip this send, move on.
      this.logger.debug(
        `Skipping step ${step.step_order} for lead ${lead.id}: ${decision.code}`,
      );
      return this.advance(businessId, enrollment, steps, now, 'skipped');
    }

    // Compliant — dispatch the templated send (emitted for the sender to pick up).
    this.emit<RealtyCadenceStepSentEvent>('realty.cadence.step_sent', {
      ...this.baseEvent(businessId),
      type: 'realty.cadence.step_sent',
      enrollmentId: enrollment.id,
      leadId: enrollment.lead_id,
      cadenceId: enrollment.cadence_id,
      stepOrder: step.step_order,
      templateId: step.template_id,
    });
    await this.repository.updateEnrollment(businessId, enrollment.id, { lastStepSentAt: now });
    return this.advance(businessId, enrollment, steps, now, 'sent');
  }

  private checkCompliance(step: StepWithTemplate, lead: LeadResponseDto, now: Date): ComplianceDecision {
    return evaluateCompliance({
      optOut: lead.optOut,
      lastInboundAt: lead.lastActivityAt ? new Date(lead.lastActivityAt) : null,
      now,
      template: { approvalStatus: step.template.approval_status, category: step.template.category },
    });
  }

  /** Advance the enrolment to the next step or complete it. */
  private async advance(
    businessId: string,
    enrollment: realty_cadence_enrollments,
    steps: StepWithTemplate[],
    now: Date,
    outcome: 'sent' | 'skipped',
  ): Promise<'sent' | 'skipped' | 'completed'> {
    const nextIndex = enrollment.current_step + 1;
    if (nextIndex >= steps.length) {
      await this.finish(businessId, enrollment, 'COMPLETED');
      return 'completed';
    }
    const nextStep = steps[nextIndex]!;
    // Absolute schedule from enrolment start keeps the D1/D3/D7 cadence honest.
    const nextRunAt = new Date(enrollment.started_at.getTime() + nextStep.day_offset * DAY_MS);
    await this.repository.updateEnrollment(businessId, enrollment.id, {
      currentStep: nextIndex,
      nextRunAt: nextRunAt.getTime() <= now.getTime() ? now : nextRunAt,
    });
    return outcome;
  }

  /** Terminate an enrolment (COMPLETED or STOPPED) and emit the completed event. */
  private async finish(
    businessId: string,
    enrollment: realty_cadence_enrollments,
    outcome: 'COMPLETED' | 'STOPPED',
    stopReason?: string,
  ): Promise<void> {
    await this.repository.updateEnrollment(businessId, enrollment.id, {
      status: outcome,
      nextRunAt: null,
      completedAt: new Date(),
      stopReason: stopReason ?? null,
    });
    this.emit<RealtyCadenceCompletedEvent>('realty.cadence.completed', {
      ...this.baseEvent(businessId),
      type: 'realty.cadence.completed',
      enrollmentId: enrollment.id,
      leadId: enrollment.lead_id,
      cadenceId: enrollment.cadence_id,
      outcome,
      stopReason,
    });
  }

  /** True when the lead still satisfies the step's optional guard. */
  private conditionMet(condition: CadenceStepCondition, lead: LeadResponseDto): boolean {
    if (condition.stageIn && condition.stageIn.length && !condition.stageIn.includes(lead.stage)) {
      return false;
    }
    if (
      condition.temperatureIn &&
      condition.temperatureIn.length &&
      !condition.temperatureIn.includes(lead.temperature)
    ) {
      return false;
    }
    if (condition.minQualScore != null && lead.qualScore < condition.minQualScore) return false;
    if (condition.maxQualScore != null && lead.qualScore > condition.maxQualScore) return false;
    return true;
  }

  // ─────────────────────────────────────────────
  // EVENT LISTENERS — auto-enrol / auto-stop
  // ─────────────────────────────────────────────

  /** A fresh enquiry that has not yet been engaged → NO_RESPONSE cadence. */
  @OnEvent('realty.lead.created')
  async onLeadCreated(event: RealtyLeadCreatedEvent): Promise<void> {
    await this.safe(() => this.enroll(event.businessId, event.leadId, CadenceTrigger.NO_RESPONSE));
  }

  /** A completed site visit → POST_VISIT nurture. */
  @OnEvent('realty.visit.completed')
  async onVisitCompleted(event: { businessId: string; leadId: string }): Promise<void> {
    if (!event.leadId) return;
    await this.safe(() => this.enroll(event.businessId, event.leadId, CadenceTrigger.POST_VISIT));
  }

  /**
   * Stage changes: a move to DORMANT enrols the reactivation cadence; any other
   * move stops enrolments whose current step declares STAGE_CHANGE.
   */
  @OnEvent('realty.lead.stage_changed')
  async onStageChanged(event: RealtyLeadStageChangedEvent): Promise<void> {
    await this.safe(async () => {
      await this.stopForLead(event.businessId, event.leadId, CadenceStopOn.STAGE_CHANGE, 'stage_change');
      if (event.toStage === LeadStage.DORMANT) {
        await this.enroll(event.businessId, event.leadId, CadenceTrigger.DORMANT);
      }
    });
  }

  /** Opt-out — the absolute stop across every cadence. */
  @OnEvent('realty.lead.opted_out')
  async onOptedOut(event: RealtyLeadOptedOutEvent): Promise<void> {
    await this.safe(() =>
      this.stopForLead(event.businessId, event.leadId, CadenceStopOn.OPTOUT, 'opted_out'),
    );
  }

  /** An inbound reply hands the conversation back — stop reply-sensitive steps. */
  @OnEvent('message.received')
  async onInboundReply(event: MessageReceivedEvent): Promise<void> {
    const phone = event.senderExternalId;
    if (!phone) return;
    await this.safe(async () => {
      const lead = await this.leadsService.findLeadByPhone(event.businessId, phone);
      if (!lead) return;
      await this.stopForLead(event.businessId, lead.id, CadenceStopOn.REPLY, 'buyer_replied');
    });
  }

  // ─────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────

  private async safe(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Cadence engine listener failed: ${message}`);
    }
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
