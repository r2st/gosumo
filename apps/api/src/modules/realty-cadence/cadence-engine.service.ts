import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { RealtyLeadsService, isTerminalStage } from '../realty-leads/realty-leads.service';
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
    // Resolve the lead inside this tenant first. That is what makes a
    // cross-tenant lead id from the manual endpoint a 404 instead of an
    // orphan enrolment, and it is the only place to refuse a buyer who has
    // opted out or a deal that is already closed — `realty.visit.completed`
    // fires for a CLOSED_WON lead's last visit too, and a "how did the visit
    // go?" chase to someone who just paid is exactly what the stage machine
    // exists to prevent.
    const lead = await this.leadsService.getLead(businessId, leadId);
    if (lead.optOut) {
      this.logger.log(`Lead ${leadId} has opted out — not enrolling in ${trigger}`);
      return null;
    }
    if (isTerminalStage(lead.stage)) {
      this.logger.log(`Lead ${leadId} is ${lead.stage} — not enrolling in ${trigger}`);
      return null;
    }

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
    const stepCache = new Map<string, Promise<StepWithTemplate[]>>();
    let stopped = 0;
    for (const enrollment of active) {
      if (signal !== CadenceStopOn.OPTOUT) {
        const steps = await this.loadSteps(businessId, enrollment.cadence_id, stepCache);
        const currentStep = steps[enrollment.current_step];
        const stopOn = currentStep?.stop_on ?? [];
        if (!stopOn.includes(signal)) continue;
      }
      const ok = await this.finish(businessId, enrollment, 'STOPPED', reason);
      if (ok) stopped++;
    }
    return stopped;
  }

  /**
   * Broker override — pause every active cadence for a lead unconditionally
   * (unlike `stopForLead`, which honours per-step stop signals). Used by the
   * broker voice command "pause follow-ups for <name>". Returns how many
   * enrolments were stopped.
   */
  async pauseForLead(businessId: string, leadId: string, reason = 'broker_paused'): Promise<number> {
    const active = await this.repository.findActiveEnrollmentsForLead(businessId, leadId);
    let stopped = 0;
    for (const enrollment of active) {
      const ok = await this.finish(businessId, enrollment, 'STOPPED', reason);
      if (ok) stopped++;
    }
    return stopped;
  }

  /**
   * Broker override — resume follow-ups for a lead by re-enrolling the default
   * NO_RESPONSE chase. Returns the new enrolment, or null when there is no
   * active cadence for the trigger or the lead is already enrolled.
   */
  async resumeForLead(
    businessId: string,
    leadId: string,
  ): Promise<realty_cadence_enrollments | null> {
    return this.enroll(businessId, leadId, CadenceTrigger.NO_RESPONSE);
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

    // A tick fans out over every due enrolment across every tenant, but the
    // step list only varies per cadence — share one lookup per cadence.
    const stepCache = new Map<string, Promise<StepWithTemplate[]>>();

    // Every enrolment needs its lead, and `runStep` read them one at a time:
    // `findDueEnrollments` returns up to 500 rows, so a busy tick was up to 500
    // sequential single-row queries before the first send went out. Load them
    // in one query per tenant instead. Prefetched here rather than memoized
    // inside `runStep` because the ids are all known up front — a memo would
    // still issue 500 queries, just without repeats.
    const leadCache = await this.prefetchLeads(due);

    for (const enrollment of due) {
      result.processed++;
      const outcome = await this.runStep(
        enrollment.business_id,
        enrollment,
        now,
        stepCache,
        leadCache,
      );
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

  /**
   * Load every due enrolment's lead, one query per tenant.
   *
   * Tenant-scoped on purpose even though the tick is cross-tenant: the ids are
   * grouped by `business_id` and each group is read with its own tenant filter,
   * so a lead id cannot resolve against another business's row. Falls back to
   * an empty cache on failure — `runStep` reads through to `getLead` for
   * anything the cache does not hold, so a failed prefetch costs speed, never
   * correctness.
   */
  private async prefetchLeads(
    due: realty_cadence_enrollments[],
  ): Promise<Map<string, LeadResponseDto>> {
    const byBusiness = new Map<string, string[]>();
    for (const enrollment of due) {
      const ids = byBusiness.get(enrollment.business_id);
      if (ids) ids.push(enrollment.lead_id);
      else byBusiness.set(enrollment.business_id, [enrollment.lead_id]);
    }

    const cache = new Map<string, LeadResponseDto>();
    const results = await Promise.allSettled(
      [...byBusiness.entries()].map(async ([businessId, leadIds]) => {
        const leads = await this.leadsService.getLeadsByIds(businessId, leadIds);
        return { businessId, leads };
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const [leadId, lead] of r.value.leads) {
          cache.set(`${r.value.businessId}:${leadId}`, lead);
        }
      } else {
        this.logger.warn(
          `Cadence tick: could not prefetch leads for a tenant: ${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          }`,
        );
      }
    }
    return cache;
  }

  /** Run a single due enrolment's current step; returns the outcome bucket. */
  private async runStep(
    businessId: string,
    enrollment: realty_cadence_enrollments,
    now: Date,
    stepCache: Map<string, Promise<StepWithTemplate[]>>,
    leadCache?: Map<string, LeadResponseDto>,
  ): Promise<'sent' | 'skipped' | 'stopped' | 'completed'> {
    const steps = await this.loadSteps(businessId, enrollment.cadence_id, stepCache);
    const step = steps[enrollment.current_step];
    if (!step) {
      await this.finish(businessId, enrollment, 'COMPLETED');
      return 'completed';
    }

    // A cache miss reads through rather than treating the lead as missing: the
    // prefetch is an optimization, and the callers that run one enrolment at a
    // time pass no cache at all.
    let lead: LeadResponseDto | null =
      leadCache?.get(`${businessId}:${enrollment.lead_id}`) ?? null;
    if (!lead) {
      try {
        lead = await this.leadsService.getLead(businessId, enrollment.lead_id);
      } catch (err) {
        if (err instanceof NotFoundException) {
          await this.finish(businessId, enrollment, 'STOPPED', 'lead_missing');
          return 'stopped';
        }
        this.logger.error(
          `Cadence step deferred: could not load lead ${enrollment.lead_id} ` +
            `(business ${businessId}): ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    }

    // Opt-out is absolute — halt immediately.
    if (lead.optOut) {
      await this.finish(businessId, enrollment, 'STOPPED', 'opted_out');
      return 'stopped';
    }
    // So is a closed deal. The stage_changed listener stops enrolments when the
    // close happens; this catches a close that never emitted (a direct DB edit,
    // an event lost to a restart) before the next chase goes out.
    if (isTerminalStage(lead.stage)) {
      await this.finish(businessId, enrollment, 'STOPPED', 'lead_closed');
      return 'stopped';
    }

    // Condition guard: an unmet condition skips the step (advance, no send).
    const condition = (step.condition ?? {}) as CadenceStepCondition;
    if (!this.conditionMet(condition, lead)) {
      return this.advance(businessId, enrollment, steps, now, 'skipped');
    }

    // Opt-out is already handled above, so every block reaching here is
    // non-fatal (closed service window / unapproved template) — skip the send
    // and move on rather than terminating the enrolment.
    const decision = this.checkCompliance(step, lead, now);
    if (!decision.allowed) {
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
    const updated = await this.repository.transitionEnrollment(businessId, enrollment.id, { lastStepSentAt: now });
    if (!updated) return 'stopped';
    return this.advance(businessId, enrollment, steps, now, 'sent');
  }

  /**
   * Load a cadence's steps, optionally through a caller-supplied memo.
   *
   * Every enrolment on the same cadence needs the identical (template-joined)
   * step list, so a loop over enrolments would otherwise re-issue the same
   * query once per row. The memo is always caller-scoped — one tick, one
   * stop-signal sweep — so an edited cadence is picked up on the next call
   * rather than being cached across invocations.
   */
  private async loadSteps(
    businessId: string,
    cadenceId: string,
    cache: Map<string, Promise<StepWithTemplate[]>>,
  ): Promise<StepWithTemplate[]> {
    const key = `${businessId}:${cadenceId}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = this.repository.listStepsByCadence(businessId, cadenceId);
      cache.set(key, pending);
    }
    return pending;
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
  ): Promise<'sent' | 'skipped' | 'stopped' | 'completed'> {
    const nextIndex = enrollment.current_step + 1;
    if (nextIndex >= steps.length) {
      const ok = await this.finish(businessId, enrollment, 'COMPLETED');
      return ok ? 'completed' : 'stopped';
    }
    const nextStep = steps[nextIndex]!;
    // Absolute schedule from enrolment start keeps the D1/D3/D7 cadence honest.
    const nextRunAt = new Date(enrollment.started_at.getTime() + nextStep.day_offset * DAY_MS);
    const updated = await this.repository.transitionEnrollment(businessId, enrollment.id, {
      currentStep: nextIndex,
      nextRunAt: nextRunAt.getTime() <= now.getTime() ? now : nextRunAt,
    });
    if (!updated) return 'stopped';
    return outcome;
  }

  /** Terminate an enrolment (COMPLETED or STOPPED) and emit the completed event. */
  private async finish(
    businessId: string,
    enrollment: realty_cadence_enrollments,
    outcome: 'COMPLETED' | 'STOPPED',
    stopReason?: string,
  ): Promise<boolean> {
    const row = await this.repository.transitionEnrollment(businessId, enrollment.id, {
      status: outcome,
      nextRunAt: null,
      completedAt: new Date(),
      stopReason: stopReason ?? null,
    });
    if (!row) {
      this.logger.debug(`Enrollment ${enrollment.id} already terminated — skipping ${outcome}`);
      return false;
    }
    this.emit<RealtyCadenceCompletedEvent>('realty.cadence.completed', {
      ...this.baseEvent(businessId),
      type: 'realty.cadence.completed',
      enrollmentId: enrollment.id,
      leadId: enrollment.lead_id,
      cadenceId: enrollment.cadence_id,
      outcome,
      stopReason,
    });
    return true;
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
   * Stage changes: a move to DORMANT enrols the reactivation cadence; a move to
   * CLOSED_WON / CLOSED_LOST stops every enrolment unconditionally (there is
   * nothing left to nurture, and a chase message to a buyer who just paid is
   * the worst kind of noise); any other move stops enrolments whose current
   * step declares STAGE_CHANGE.
   */
  @OnEvent('realty.lead.stage_changed')
  async onStageChanged(event: RealtyLeadStageChangedEvent): Promise<void> {
    await this.safe(async () => {
      if (isTerminalStage(event.toStage)) {
        await this.pauseForLead(event.businessId, event.leadId, 'lead_closed');
        return;
      }
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
    // E.164, not the channel id: leads are stored `+91…` and WhatsApp delivers
    // `91…`, so matching on the raw id found no lead and the cadence kept
    // sending follow-ups to a buyer who had already replied.
    const phone = event.senderPhone;
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
