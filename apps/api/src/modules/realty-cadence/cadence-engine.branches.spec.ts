/**
 * CadenceEngineService — branch coverage for the paths the main spec leaves out.
 *
 * The sibling `cadence-engine.spec.ts` covers the happy paths of enrolment,
 * stop signals, execution and the event listeners. What is left is where the
 * engine's real risk sits:
 *
 *  1. **Broker overrides** — `pauseForLead` stops unconditionally (unlike
 *     `stopForLead`, which honours per-step stop signals) and `resumeForLead`
 *     re-enrols. Getting pause wrong leaves a lead being messaged after a
 *     broker explicitly silenced them.
 *  2. **Condition guards** — `conditionMet` has four independent predicates
 *     (stage, temperature, min/max qual score). Each must be able to fail on
 *     its own, and an empty list must not be read as "matches nothing".
 *  3. **Degenerate enrolment state** — a cadence emptied mid-flight, a lead
 *     deleted mid-flight, a `current_step` past the end of the step list.
 *  4. **Listener resilience** — every `@OnEvent` handler runs inside `safe()`,
 *     because a throw out of an event listener is unhandled. A repository
 *     failure must be swallowed and logged, not propagated.
 *
 * The repository, RealtyLeadsService and EventEmitter2 are mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger, NotFoundException } from '@nestjs/common';
import { CadenceTrigger, CadenceStopOn, LeadStage } from '@gosumo/shared';

import { CadenceEngineService } from './cadence-engine.service';
import { RealtyCadenceRepository } from './realty-cadence.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const LEAD_ID = '00000000-0000-4000-a000-000000000010';
const CADENCE_ID = '00000000-0000-4000-a000-000000000020';
const PHONE = '+919876543210';
const NOW = new Date('2026-07-10T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function makeStep(overrides: Record<string, unknown> = {}) {
  return {
    id: 'step-' + (overrides['step_order'] ?? 0),
    business_id: BUSINESS_ID,
    cadence_id: CADENCE_ID,
    template_id: 'tpl-1',
    step_order: 0,
    day_offset: 1,
    condition: {},
    stop_on: [CadenceStopOn.REPLY, CadenceStopOn.OPTOUT],
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    template: {
      id: 'tpl-1',
      business_id: BUSINESS_ID,
      name: 'followup_d1',
      category: 'UTILITY',
      language: 'en',
      body: 'hi',
      variables: [],
      approval_status: 'APPROVED',
      approved_at: NOW,
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    },
    ...overrides,
  };
}

function makeEnrollment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'enr-1',
    business_id: BUSINESS_ID,
    cadence_id: CADENCE_ID,
    lead_id: LEAD_ID,
    status: 'ACTIVE',
    current_step: 0,
    next_run_at: NOW,
    trigger: CadenceTrigger.NO_RESPONSE,
    stop_reason: null,
    last_step_sent_at: null,
    started_at: new Date(NOW.getTime() - DAY),
    completed_at: null,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    id: LEAD_ID,
    businessId: BUSINESS_ID,
    whatsappPhone: PHONE,
    name: 'Rahul',
    optOut: false,
    stage: LeadStage.CONTACTED,
    temperature: 'WARM',
    qualScore: 55,
    lastActivityAt: new Date(NOW.getTime() - 60_000), // service window open
    source: 'CTWA',
    conversationId: null,
    assignedAgentId: null,
    matchedUnitIds: [],
    bltc: {
      config: '2BHK',
      localities: ['Baner'],
      budgetMinPaise: null,
      budgetMaxPaise: null,
      timelineMonths: null,
      purpose: null,
      financing: null,
    },
    ...overrides,
  } as never;
}

describe('CadenceEngineService (branches)', () => {
  let engine: CadenceEngineService;
  let repository: jest.Mocked<RealtyCadenceRepository>;
  let leadsService: jest.Mocked<RealtyLeadsService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepo: Partial<Record<keyof RealtyCadenceRepository, jest.Mock>> = {
      findActiveCadenceByTrigger: jest.fn(),
      listStepsByCadence: jest.fn(),
      findActiveEnrollmentsForLead: jest.fn(),
      createEnrollment: jest.fn(),
      findDueEnrollments: jest.fn(),
      updateEnrollment: jest.fn(),
      transitionEnrollment: jest.fn(),
    };
    // `enroll` resolves its lead first; default to a live, contactable one so
    // the branches below exercise what they name rather than the lead guard.
    const mockLeads = { getLead: jest.fn(async () => makeLead()), findLeadByPhone: jest.fn() };
    const mockEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CadenceEngineService,
        { provide: RealtyCadenceRepository, useValue: mockRepo },
        { provide: RealtyLeadsService, useValue: mockLeads },
        { provide: EventEmitter2, useValue: mockEmitter },
      ],
    }).compile();

    engine = module.get(CadenceEngineService);
    repository = module.get(RealtyCadenceRepository) as jest.Mocked<RealtyCadenceRepository>;
    leadsService = module.get(RealtyLeadsService) as jest.Mocked<RealtyLeadsService>;
    eventEmitter = module.get(EventEmitter2) as jest.Mocked<EventEmitter2>;
    jest.clearAllMocks();
  });

  /** The payload of the first emitted event with this name. */
  function emitted(name: string): Record<string, unknown> | undefined {
    const call = eventEmitter.emit.mock.calls.find((c) => c[0] === name);
    return call?.[1] as Record<string, unknown> | undefined;
  }

  // ─────────────────────────────────────────────
  // Broker overrides
  // ─────────────────────────────────────────────

  describe('pauseForLead', () => {
    it('stops every active enrolment regardless of the step’s stop signals', async () => {
      // The distinction from stopForLead: a broker saying "pause follow-ups"
      // must win even when the current step declares no stop signals at all.
      repository.findActiveEnrollmentsForLead.mockResolvedValue([
        makeEnrollment({ id: 'enr-1' }),
        makeEnrollment({ id: 'enr-2', cadence_id: 'cad-2' }),
      ] as never);
      repository.transitionEnrollment.mockResolvedValue(makeEnrollment() as never);

      const stopped = await engine.pauseForLead(BUSINESS_ID, LEAD_ID);

      expect(stopped).toBe(2);
      expect(repository.transitionEnrollment).toHaveBeenCalledTimes(2);
      // Never consults the step list — the pause is unconditional.
      expect(repository.listStepsByCadence).not.toHaveBeenCalled();
    });

    it('records the default broker_paused reason and unschedules the enrolment', async () => {
      repository.findActiveEnrollmentsForLead.mockResolvedValue([makeEnrollment()] as never);
      repository.transitionEnrollment.mockResolvedValue(makeEnrollment() as never);

      await engine.pauseForLead(BUSINESS_ID, LEAD_ID);

      expect(repository.transitionEnrollment).toHaveBeenCalledWith(
        BUSINESS_ID,
        'enr-1',
        expect.objectContaining({
          status: 'STOPPED',
          stopReason: 'broker_paused',
          nextRunAt: null,
        }),
      );
    });

    it('records a caller-supplied reason', async () => {
      repository.findActiveEnrollmentsForLead.mockResolvedValue([makeEnrollment()] as never);
      repository.transitionEnrollment.mockResolvedValue(makeEnrollment() as never);

      await engine.pauseForLead(BUSINESS_ID, LEAD_ID, 'deal_closed');

      expect(repository.transitionEnrollment).toHaveBeenCalledWith(
        BUSINESS_ID,
        'enr-1',
        expect.objectContaining({ stopReason: 'deal_closed' }),
      );
    });

    it('emits completed with the STOPPED outcome for each paused enrolment', async () => {
      repository.findActiveEnrollmentsForLead.mockResolvedValue([makeEnrollment()] as never);
      repository.transitionEnrollment.mockResolvedValue(makeEnrollment() as never);

      await engine.pauseForLead(BUSINESS_ID, LEAD_ID);

      expect(emitted('realty.cadence.completed')).toMatchObject({
        enrollmentId: 'enr-1',
        leadId: LEAD_ID,
        cadenceId: CADENCE_ID,
        outcome: 'STOPPED',
        stopReason: 'broker_paused',
      });
    });

    it('reports zero when the lead has nothing running', async () => {
      repository.findActiveEnrollmentsForLead.mockResolvedValue([] as never);

      await expect(engine.pauseForLead(BUSINESS_ID, LEAD_ID)).resolves.toBe(0);
      expect(repository.transitionEnrollment).not.toHaveBeenCalled();
    });
  });

  describe('resumeForLead', () => {
    it('re-enrols the lead into the default NO_RESPONSE chase', async () => {
      repository.findActiveCadenceByTrigger.mockResolvedValue({ id: CADENCE_ID } as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep()] as never);
      repository.findActiveEnrollmentsForLead.mockResolvedValue([] as never);
      repository.createEnrollment.mockResolvedValue(makeEnrollment() as never);

      const enrollment = await engine.resumeForLead(BUSINESS_ID, LEAD_ID);

      expect(repository.findActiveCadenceByTrigger).toHaveBeenCalledWith(
        BUSINESS_ID,
        CadenceTrigger.NO_RESPONSE,
      );
      expect(enrollment).toMatchObject({ id: 'enr-1' });
    });

    it('returns null when no active NO_RESPONSE cadence exists', async () => {
      repository.findActiveCadenceByTrigger.mockResolvedValue(null as never);

      await expect(engine.resumeForLead(BUSINESS_ID, LEAD_ID)).resolves.toBeNull();
      expect(repository.createEnrollment).not.toHaveBeenCalled();
    });

    it('returns null when the lead is already enrolled (no overlap)', async () => {
      repository.findActiveCadenceByTrigger.mockResolvedValue({ id: CADENCE_ID } as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep()] as never);
      repository.findActiveEnrollmentsForLead.mockResolvedValue([makeEnrollment()] as never);

      await expect(engine.resumeForLead(BUSINESS_ID, LEAD_ID)).resolves.toBeNull();
      expect(repository.createEnrollment).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // Degenerate enrolment state
  // ─────────────────────────────────────────────

  describe('enroll with an emptied cadence', () => {
    it('returns null when the matched cadence has no steps', async () => {
      leadsService.getLead.mockResolvedValue(makeLead());
      repository.findActiveCadenceByTrigger.mockResolvedValue({ id: CADENCE_ID } as never);
      repository.listStepsByCadence.mockResolvedValue([] as never);

      await expect(
        engine.enroll(BUSINESS_ID, LEAD_ID, CadenceTrigger.POST_VISIT),
      ).resolves.toBeNull();
      // Bailing before the overlap check keeps a no-op enrolment out of the table.
      expect(repository.findActiveEnrollmentsForLead).not.toHaveBeenCalled();
    });
  });

  describe('stopForLead with a step list that no longer reaches current_step', () => {
    it('leaves the enrolment alone on a non-OPTOUT signal', async () => {
      // A cadence edited down to fewer steps leaves current_step past the end;
      // `stop_on` defaults to [] and the signal must simply not match.
      repository.findActiveEnrollmentsForLead.mockResolvedValue([
        makeEnrollment({ current_step: 5 }),
      ] as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep()] as never);

      const stopped = await engine.stopForLead(
        BUSINESS_ID,
        LEAD_ID,
        CadenceStopOn.REPLY,
        'buyer_replied',
      );

      expect(stopped).toBe(0);
      expect(repository.transitionEnrollment).not.toHaveBeenCalled();
    });

    it('still stops on OPTOUT, which never consults the step list', async () => {
      repository.findActiveEnrollmentsForLead.mockResolvedValue([
        makeEnrollment({ current_step: 5 }),
      ] as never);
      repository.transitionEnrollment.mockResolvedValue(makeEnrollment() as never);

      const stopped = await engine.stopForLead(
        BUSINESS_ID,
        LEAD_ID,
        CadenceStopOn.OPTOUT,
        'opted_out',
      );

      expect(stopped).toBe(1);
      expect(repository.listStepsByCadence).not.toHaveBeenCalled();
    });

    it('reads a cadence’s steps once across a multi-enrolment sweep', async () => {
      repository.findActiveEnrollmentsForLead.mockResolvedValue([
        makeEnrollment({ id: 'enr-1' }),
        makeEnrollment({ id: 'enr-2' }),
      ] as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep()] as never);
      repository.transitionEnrollment.mockResolvedValue(makeEnrollment() as never);

      await engine.stopForLead(BUSINESS_ID, LEAD_ID, CadenceStopOn.REPLY, 'buyer_replied');

      // Both enrolments share a cadence — the sweep-scoped memo collapses them.
      expect(repository.listStepsByCadence).toHaveBeenCalledTimes(1);
    });
  });

  describe('processDueEnrollments with a vanished lead', () => {
    it('stops the enrolment with lead_missing when the lead is not found', async () => {
      repository.findDueEnrollments.mockResolvedValue([makeEnrollment()] as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep()] as never);
      leadsService.getLead.mockRejectedValue(new NotFoundException('Lead not found'));
      repository.transitionEnrollment.mockResolvedValue(makeEnrollment() as never);

      const result = await engine.processDueEnrollments(NOW);

      expect(result).toMatchObject({ processed: 1, stopped: 1 });
      expect(repository.transitionEnrollment).toHaveBeenCalledWith(
        BUSINESS_ID,
        'enr-1',
        expect.objectContaining({ status: 'STOPPED', stopReason: 'lead_missing' }),
      );
    });

    it('propagates a transient error instead of stopping the cadence (G003)', async () => {
      repository.findDueEnrollments.mockResolvedValue([makeEnrollment()] as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep()] as never);
      leadsService.getLead.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(engine.processDueEnrollments(NOW)).rejects.toThrow('ECONNREFUSED');
      expect(repository.transitionEnrollment).not.toHaveBeenCalledWith(
        BUSINESS_ID,
        'enr-1',
        expect.objectContaining({ stopReason: 'lead_missing' }),
      );
    });

    it('completes an enrolment whose current_step is past the end of the list', async () => {
      repository.findDueEnrollments.mockResolvedValue([
        makeEnrollment({ current_step: 3 }),
      ] as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep()] as never);
      repository.transitionEnrollment.mockResolvedValue(makeEnrollment() as never);

      const result = await engine.processDueEnrollments(NOW);

      expect(result).toMatchObject({ processed: 1, completed: 1 });
      expect(leadsService.getLead).not.toHaveBeenCalled();
    });

    it('reports an all-zero result and stays quiet on an empty tick', async () => {
      repository.findDueEnrollments.mockResolvedValue([] as never);
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

      const result = await engine.processDueEnrollments(NOW);

      expect(result).toEqual({ processed: 0, sent: 0, skipped: 0, stopped: 0, completed: 0 });
      // An idle tick every minute must not write a log line each time.
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it('defaults `now` to the current time when the caller omits it', async () => {
      repository.findDueEnrollments.mockResolvedValue([] as never);

      await engine.processDueEnrollments();

      expect(repository.findDueEnrollments).toHaveBeenCalledWith(expect.any(Date), undefined);
    });

    it('clamps a next run that is already in the past up to now', async () => {
      // Step 1 is D1 but the enrolment started 10 days ago — scheduling the
      // absolute date would leave next_run_at permanently overdue.
      repository.findDueEnrollments.mockResolvedValue([
        makeEnrollment({ started_at: new Date(NOW.getTime() - 10 * DAY) }),
      ] as never);
      repository.listStepsByCadence.mockResolvedValue([
        makeStep({ step_order: 0, day_offset: 1 }),
        makeStep({ step_order: 1, day_offset: 3 }),
      ] as never);
      leadsService.getLead.mockResolvedValue(makeLead());
      repository.transitionEnrollment.mockResolvedValue(makeEnrollment() as never);

      await engine.processDueEnrollments(NOW);

      expect(repository.transitionEnrollment).toHaveBeenCalledWith(
        BUSINESS_ID,
        'enr-1',
        expect.objectContaining({ currentStep: 1, nextRunAt: NOW }),
      );
    });

    it('schedules a future step absolutely from the enrolment start', async () => {
      const startedAt = new Date(NOW.getTime() - DAY);
      repository.findDueEnrollments.mockResolvedValue([makeEnrollment({ started_at: startedAt })] as never);
      repository.listStepsByCadence.mockResolvedValue([
        makeStep({ step_order: 0, day_offset: 1 }),
        makeStep({ step_order: 1, day_offset: 3 }),
      ] as never);
      leadsService.getLead.mockResolvedValue(makeLead());
      repository.transitionEnrollment.mockResolvedValue(makeEnrollment() as never);

      await engine.processDueEnrollments(NOW);

      expect(repository.transitionEnrollment).toHaveBeenCalledWith(
        BUSINESS_ID,
        'enr-1',
        expect.objectContaining({ nextRunAt: new Date(startedAt.getTime() + 3 * DAY) }),
      );
    });
  });

  // ─────────────────────────────────────────────
  // Condition guards
  // ─────────────────────────────────────────────

  describe('step conditions', () => {
    /** Run one due step under `condition` and report whether it sent. */
    async function outcomeFor(
      condition: Record<string, unknown>,
      leadOverrides: Record<string, unknown> = {},
    ): Promise<'sent' | 'skipped'> {
      jest.clearAllMocks();
      repository.findDueEnrollments.mockResolvedValue([makeEnrollment()] as never);
      repository.listStepsByCadence.mockResolvedValue([
        makeStep({ condition }),
        makeStep({ step_order: 1, day_offset: 3 }),
      ] as never);
      leadsService.getLead.mockResolvedValue(makeLead(leadOverrides));
      repository.transitionEnrollment.mockResolvedValue(makeEnrollment() as never);

      const result = await engine.processDueEnrollments(NOW);
      return result.sent === 1 ? 'sent' : 'skipped';
    }

    it('sends when the guard is empty', async () => {
      await expect(outcomeFor({})).resolves.toBe('sent');
    });

    it('sends when the lead’s stage is in the allowed list', async () => {
      await expect(
        outcomeFor({ stageIn: [LeadStage.CONTACTED, LeadStage.QUALIFIED] }),
      ).resolves.toBe('sent');
    });

    it('skips when the lead’s stage is outside the allowed list', async () => {
      await expect(outcomeFor({ stageIn: [LeadStage.QUALIFIED] })).resolves.toBe('skipped');
    });

    it('treats an empty stage list as no constraint, not as "matches nothing"', async () => {
      await expect(outcomeFor({ stageIn: [] })).resolves.toBe('sent');
    });

    it('sends when the temperature is in the allowed list', async () => {
      await expect(outcomeFor({ temperatureIn: ['WARM', 'HOT'] })).resolves.toBe('sent');
    });

    it('skips when the temperature is outside the allowed list', async () => {
      await expect(outcomeFor({ temperatureIn: ['HOT'] })).resolves.toBe('skipped');
    });

    it('treats an empty temperature list as no constraint', async () => {
      await expect(outcomeFor({ temperatureIn: [] })).resolves.toBe('sent');
    });

    it('skips a lead below the minimum qualification score', async () => {
      await expect(outcomeFor({ minQualScore: 80 })).resolves.toBe('skipped');
    });

    it('sends a lead at exactly the minimum score (inclusive bound)', async () => {
      await expect(outcomeFor({ minQualScore: 55 })).resolves.toBe('sent');
    });

    it('skips a lead above the maximum qualification score', async () => {
      await expect(outcomeFor({ maxQualScore: 30 })).resolves.toBe('skipped');
    });

    it('sends a lead at exactly the maximum score (inclusive bound)', async () => {
      await expect(outcomeFor({ maxQualScore: 55 })).resolves.toBe('sent');
    });

    it('applies a zero minimum rather than treating it as unset', async () => {
      await expect(outcomeFor({ minQualScore: 0 })).resolves.toBe('sent');
      await expect(outcomeFor({ maxQualScore: 0 })).resolves.toBe('skipped');
    });

    it('requires every predicate to pass, not just one', async () => {
      await expect(
        outcomeFor({ stageIn: [LeadStage.CONTACTED], minQualScore: 90 }),
      ).resolves.toBe('skipped');
    });

    it('treats a null condition column as no constraint', async () => {
      await expect(outcomeFor(null as never)).resolves.toBe('sent');
    });
  });

  // ─────────────────────────────────────────────
  // Service window
  // ─────────────────────────────────────────────

  describe('a lead who has never messaged in', () => {
    /** Run one due step against a lead with no recorded inbound activity. */
    async function runWithTemplateCategory(category: string): Promise<'sent' | 'skipped'> {
      jest.clearAllMocks();
      repository.findDueEnrollments.mockResolvedValue([makeEnrollment()] as never);
      repository.listStepsByCadence.mockResolvedValue([
        makeStep({ template: { ...makeStep().template, category } }),
        makeStep({ step_order: 1, day_offset: 3 }),
      ] as never);
      // A CTWA lead can be enrolled before it has ever replied — the 24h
      // service window is closed, not open, when there is no inbound at all.
      leadsService.getLead.mockResolvedValue(makeLead({ lastActivityAt: null }));
      repository.transitionEnrollment.mockResolvedValue(makeEnrollment() as never);

      const result = await engine.processDueEnrollments(NOW);
      return result.sent === 1 ? 'sent' : 'skipped';
    }

    it('still sends a UTILITY template outside the service window', async () => {
      await expect(runWithTemplateCategory('UTILITY')).resolves.toBe('sent');
    });

    it('blocks a MARKETING template outside the service window', async () => {
      await expect(runWithTemplateCategory('MARKETING')).resolves.toBe('skipped');
    });
  });

  // ─────────────────────────────────────────────
  // Listener resilience
  // ─────────────────────────────────────────────

  describe('event listener error handling', () => {
    it('swallows and logs a repository failure in onLeadCreated', async () => {
      // A throw out of an @OnEvent handler is unhandled — safe() is the guard.
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      repository.findActiveCadenceByTrigger.mockRejectedValue(new Error('db down'));

      await expect(
        engine.onLeadCreated({ businessId: BUSINESS_ID, leadId: LEAD_ID } as never),
      ).resolves.toBeUndefined();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
      error.mockRestore();
    });

    it('logs a non-Error rejection by stringifying it', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      repository.findActiveEnrollmentsForLead.mockRejectedValue('socket hang up');

      await engine.onOptedOut({ businessId: BUSINESS_ID, leadId: LEAD_ID } as never);

      expect(error).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
      error.mockRestore();
    });

    it('ignores a visit.completed event that carries no lead', async () => {
      await engine.onVisitCompleted({ businessId: BUSINESS_ID, leadId: '' });

      expect(repository.findActiveCadenceByTrigger).not.toHaveBeenCalled();
    });

    it('ignores an inbound message with no sender id', async () => {
      await engine.onInboundReply({ businessId: BUSINESS_ID, senderExternalId: '' } as never);

      expect(leadsService.findLeadByPhone).not.toHaveBeenCalled();
    });

    it('stops stage-change steps without enrolling when the move is not to DORMANT', async () => {
      repository.findActiveEnrollmentsForLead.mockResolvedValue([] as never);

      await engine.onStageChanged({
        businessId: BUSINESS_ID,
        leadId: LEAD_ID,
        toStage: LeadStage.QUALIFIED,
      } as never);

      expect(repository.findActiveCadenceByTrigger).not.toHaveBeenCalled();
    });
  });
});
