/**
 * CadenceEngineService unit tests (blueprint §17).
 *
 * Coverage:
 *  1. Enrolment — picks the active cadence, schedules step 0, emits started;
 *     no-ops on no cadence / no steps / an already-active enrolment.
 *  2. Stop signals — OPTOUT halts everything; REPLY/STAGE_CHANGE halt only
 *     enrolments whose current step declares that signal.
 *  3. Scheduled execution — compliant send emits step_sent + advances; opt-out
 *     stops; blocked compliance / unmet condition skips; last step completes.
 *  4. Event listeners — created → NO_RESPONSE, visit.completed → POST_VISIT,
 *     stage→DORMANT enrols, opted_out stops all, inbound reply stops on reply.
 *
 * The repository, RealtyLeadsService and EventEmitter2 are mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
    lastActivityAt: new Date(NOW.getTime() - 60_000), // window open
    source: 'CTWA',
    conversationId: null,
    assignedAgentId: null,
    matchedUnitIds: [],
    bltc: { config: '2BHK', localities: ['Baner'], budgetMinPaise: null, budgetMaxPaise: null, timelineMonths: null, purpose: null, financing: null },
    ...overrides,
  } as never;
}

describe('CadenceEngineService', () => {
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
    };
    const mockLeads = {
      getLead: jest.fn(),
      getLeadsByIds: jest.fn(async () => new Map()),
      findLeadByPhone: jest.fn(),
    };
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

  // ── Enrolment ──
  describe('enroll', () => {
    it('creates an enrolment, schedules step 0, and emits started', async () => {
      repository.findActiveCadenceByTrigger.mockResolvedValue({ id: CADENCE_ID } as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep({ day_offset: 1 })] as never);
      repository.findActiveEnrollmentsForLead.mockResolvedValue([]);
      repository.createEnrollment.mockResolvedValue(makeEnrollment() as never);

      const result = await engine.enroll(BUSINESS_ID, LEAD_ID, CadenceTrigger.NO_RESPONSE);

      expect(result).not.toBeNull();
      expect(repository.createEnrollment).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, leadId: LEAD_ID, cadenceId: CADENCE_ID }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.cadence.started',
        expect.objectContaining({ type: 'realty.cadence.started', leadId: LEAD_ID }),
      );
    });

    it('no-ops when there is no active cadence for the trigger', async () => {
      repository.findActiveCadenceByTrigger.mockResolvedValue(null);
      const result = await engine.enroll(BUSINESS_ID, LEAD_ID, CadenceTrigger.DORMANT);
      expect(result).toBeNull();
      expect(repository.createEnrollment).not.toHaveBeenCalled();
    });

    it('no-ops when the lead already has an active enrolment', async () => {
      repository.findActiveCadenceByTrigger.mockResolvedValue({ id: CADENCE_ID } as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep()] as never);
      repository.findActiveEnrollmentsForLead.mockResolvedValue([makeEnrollment()] as never);
      const result = await engine.enroll(BUSINESS_ID, LEAD_ID, CadenceTrigger.NO_RESPONSE);
      expect(result).toBeNull();
      expect(repository.createEnrollment).not.toHaveBeenCalled();
    });
  });

  // ── Stop signals ──
  describe('stopForLead', () => {
    it('OPTOUT stops every active enrolment regardless of stop_on', async () => {
      repository.findActiveEnrollmentsForLead.mockResolvedValue([makeEnrollment()] as never);
      repository.updateEnrollment.mockResolvedValue(makeEnrollment() as never);

      const stopped = await engine.stopForLead(BUSINESS_ID, LEAD_ID, CadenceStopOn.OPTOUT, 'opted_out');

      expect(stopped).toBe(1);
      expect(repository.updateEnrollment).toHaveBeenCalledWith(
        BUSINESS_ID,
        'enr-1',
        expect.objectContaining({ status: 'STOPPED', stopReason: 'opted_out' }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.cadence.completed',
        expect.objectContaining({ outcome: 'STOPPED' }),
      );
    });

    it('REPLY only stops enrolments whose current step lists REPLY', async () => {
      repository.findActiveEnrollmentsForLead.mockResolvedValue([makeEnrollment()] as never);
      // current step declares only OPTOUT — a REPLY must NOT stop it
      repository.listStepsByCadence.mockResolvedValue([makeStep({ stop_on: [CadenceStopOn.OPTOUT] })] as never);

      const stopped = await engine.stopForLead(BUSINESS_ID, LEAD_ID, CadenceStopOn.REPLY, 'buyer_replied');

      expect(stopped).toBe(0);
      expect(repository.updateEnrollment).not.toHaveBeenCalled();
    });
  });

  // ── Scheduled execution ──
  describe('processDueEnrollments', () => {
    it('sends a compliant step, emits step_sent, and advances', async () => {
      repository.findDueEnrollments.mockResolvedValue([makeEnrollment({ current_step: 0 })] as never);
      repository.listStepsByCadence.mockResolvedValue([
        makeStep({ step_order: 0, day_offset: 1 }),
        makeStep({ step_order: 1, day_offset: 3 }),
      ] as never);
      leadsService.getLead.mockResolvedValue(makeLead());
      repository.updateEnrollment.mockResolvedValue(makeEnrollment() as never);

      const result = await engine.processDueEnrollments(NOW, BUSINESS_ID);

      expect(result.sent).toBe(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.cadence.step_sent',
        expect.objectContaining({ type: 'realty.cadence.step_sent', stepOrder: 0 }),
      );
      expect(repository.updateEnrollment).toHaveBeenCalledWith(
        BUSINESS_ID,
        'enr-1',
        expect.objectContaining({ currentStep: 1 }),
      );
    });

    it('completes the enrolment after the last step', async () => {
      repository.findDueEnrollments.mockResolvedValue([makeEnrollment({ current_step: 0 })] as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep({ step_order: 0 })] as never); // single step
      leadsService.getLead.mockResolvedValue(makeLead());
      repository.updateEnrollment.mockResolvedValue(makeEnrollment() as never);

      const result = await engine.processDueEnrollments(NOW, BUSINESS_ID);

      expect(result.completed).toBe(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.cadence.completed',
        expect.objectContaining({ outcome: 'COMPLETED' }),
      );
    });

    it('stops the enrolment when the lead has opted out', async () => {
      repository.findDueEnrollments.mockResolvedValue([makeEnrollment()] as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep()] as never);
      leadsService.getLead.mockResolvedValue(makeLead({ optOut: true }));
      repository.updateEnrollment.mockResolvedValue(makeEnrollment() as never);

      const result = await engine.processDueEnrollments(NOW, BUSINESS_ID);

      expect(result.stopped).toBe(1);
      expect(repository.updateEnrollment).toHaveBeenCalledWith(
        BUSINESS_ID,
        'enr-1',
        expect.objectContaining({ status: 'STOPPED', stopReason: 'opted_out' }),
      );
    });

    it('skips (does not send) a MARKETING step outside the service window', async () => {
      repository.findDueEnrollments.mockResolvedValue([makeEnrollment({ current_step: 0 })] as never);
      const marketingStep = makeStep({ step_order: 0 });
      marketingStep.template.category = 'MARKETING';
      repository.listStepsByCadence.mockResolvedValue([
        marketingStep,
        makeStep({ step_order: 1 }),
      ] as never);
      // window closed
      leadsService.getLead.mockResolvedValue(
        makeLead({ lastActivityAt: new Date(NOW.getTime() - 2 * DAY) }),
      );
      repository.updateEnrollment.mockResolvedValue(makeEnrollment() as never);

      const result = await engine.processDueEnrollments(NOW, BUSINESS_ID);

      expect(result.skipped).toBe(1);
      expect(result.sent).toBe(0);
      expect(eventEmitter.emit).not.toHaveBeenCalledWith('realty.cadence.step_sent', expect.anything());
    });

    it('skips a step whose condition is unmet', async () => {
      repository.findDueEnrollments.mockResolvedValue([makeEnrollment({ current_step: 0 })] as never);
      repository.listStepsByCadence.mockResolvedValue([
        makeStep({ step_order: 0, condition: { stageIn: [LeadStage.QUALIFIED] } }),
        makeStep({ step_order: 1 }),
      ] as never);
      leadsService.getLead.mockResolvedValue(makeLead({ stage: LeadStage.CONTACTED }));
      repository.updateEnrollment.mockResolvedValue(makeEnrollment() as never);

      const result = await engine.processDueEnrollments(NOW, BUSINESS_ID);

      expect(result.skipped).toBe(1);
      expect(eventEmitter.emit).not.toHaveBeenCalledWith('realty.cadence.step_sent', expect.anything());
    });

    it('reads each cadence’s steps once per tick, not once per enrolment', async () => {
      const OTHER_CADENCE = '00000000-0000-4000-a000-000000000021';
      repository.findDueEnrollments.mockResolvedValue([
        makeEnrollment({ id: 'enr-1', lead_id: 'lead-1' }),
        makeEnrollment({ id: 'enr-2', lead_id: 'lead-2' }),
        makeEnrollment({ id: 'enr-3', lead_id: 'lead-3' }),
        makeEnrollment({ id: 'enr-4', lead_id: 'lead-4', cadence_id: OTHER_CADENCE }),
      ] as never);
      repository.listStepsByCadence.mockResolvedValue([
        makeStep({ step_order: 0, day_offset: 1 }),
        makeStep({ step_order: 1, day_offset: 3 }),
      ] as never);
      leadsService.getLead.mockResolvedValue(makeLead());
      repository.updateEnrollment.mockResolvedValue(makeEnrollment() as never);

      const result = await engine.processDueEnrollments(NOW, BUSINESS_ID);

      expect(result.processed).toBe(4);
      // Two distinct cadences → two queries, not four.
      expect(repository.listStepsByCadence).toHaveBeenCalledTimes(2);
      expect(repository.listStepsByCadence).toHaveBeenCalledWith(BUSINESS_ID, CADENCE_ID);
      expect(repository.listStepsByCadence).toHaveBeenCalledWith(BUSINESS_ID, OTHER_CADENCE);
    });
  });

  // ── Event listeners ──
  describe('event listeners', () => {
    it('onLeadCreated enrols the NO_RESPONSE cadence', async () => {
      const spy = jest.spyOn(engine, 'enroll').mockResolvedValue(null);
      await engine.onLeadCreated({ businessId: BUSINESS_ID, leadId: LEAD_ID } as never);
      expect(spy).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, CadenceTrigger.NO_RESPONSE);
    });

    it('onVisitCompleted enrols the POST_VISIT cadence', async () => {
      const spy = jest.spyOn(engine, 'enroll').mockResolvedValue(null);
      await engine.onVisitCompleted({ businessId: BUSINESS_ID, leadId: LEAD_ID });
      expect(spy).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, CadenceTrigger.POST_VISIT);
    });

    it('onStageChanged to DORMANT stops stage-change steps then enrols DORMANT', async () => {
      const stopSpy = jest.spyOn(engine, 'stopForLead').mockResolvedValue(0);
      const enrollSpy = jest.spyOn(engine, 'enroll').mockResolvedValue(null);
      await engine.onStageChanged({
        businessId: BUSINESS_ID,
        leadId: LEAD_ID,
        fromStage: LeadStage.CONTACTED,
        toStage: LeadStage.DORMANT,
      } as never);
      expect(stopSpy).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, CadenceStopOn.STAGE_CHANGE, 'stage_change');
      expect(enrollSpy).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, CadenceTrigger.DORMANT);
    });

    it.each([LeadStage.CLOSED_WON, LeadStage.CLOSED_LOST])(
      'onStageChanged to %s stops every enrolment unconditionally and enrols nothing',
      async (toStage) => {
        const pauseSpy = jest.spyOn(engine, 'pauseForLead').mockResolvedValue(2);
        const stopSpy = jest.spyOn(engine, 'stopForLead').mockResolvedValue(0);
        const enrollSpy = jest.spyOn(engine, 'enroll').mockResolvedValue(null);
        await engine.onStageChanged({
          businessId: BUSINESS_ID,
          leadId: LEAD_ID,
          fromStage: LeadStage.NEGOTIATING,
          toStage,
        } as never);
        expect(pauseSpy).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, 'lead_closed');
        // Per-step stop_on must not get a say — a closed lead is closed.
        expect(stopSpy).not.toHaveBeenCalled();
        expect(enrollSpy).not.toHaveBeenCalled();
      },
    );

    it('onOptedOut stops all cadences', async () => {
      const stopSpy = jest.spyOn(engine, 'stopForLead').mockResolvedValue(1);
      await engine.onOptedOut({ businessId: BUSINESS_ID, leadId: LEAD_ID } as never);
      expect(stopSpy).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, CadenceStopOn.OPTOUT, 'opted_out');
    });

    it('onInboundReply resolves the lead by phone and stops reply-sensitive steps', async () => {
      leadsService.findLeadByPhone.mockResolvedValue(makeLead());
      const stopSpy = jest.spyOn(engine, 'stopForLead').mockResolvedValue(1);
      await engine.onInboundReply({ businessId: BUSINESS_ID, senderExternalId: PHONE, senderPhone: PHONE } as never);
      expect(leadsService.findLeadByPhone).toHaveBeenCalledWith(BUSINESS_ID, PHONE);
      expect(stopSpy).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, CadenceStopOn.REPLY, 'buyer_replied');
    });

    it('onInboundReply no-ops for an unseen phone', async () => {
      leadsService.findLeadByPhone.mockResolvedValue(null);
      const stopSpy = jest.spyOn(engine, 'stopForLead').mockResolvedValue(0);
      await engine.onInboundReply({ businessId: BUSINESS_ID, senderExternalId: PHONE, senderPhone: PHONE } as never);
      expect(stopSpy).not.toHaveBeenCalled();
    });

    it('onInboundReply looks up the E.164 phone, not the raw channel address', async () => {
      leadsService.findLeadByPhone.mockResolvedValue(makeLead());
      const stopSpy = jest.spyOn(engine, 'stopForLead').mockResolvedValue(1);

      // WhatsApp delivers `919876543210`; the lead is stored `+919876543210`.
      // Looking up the raw form found nothing, so the stop never fired and the
      // buyer kept receiving follow-ups after they had already replied.
      await engine.onInboundReply({
        businessId: BUSINESS_ID,
        senderExternalId: '919876543210',
        senderPhone: PHONE,
      } as never);

      expect(leadsService.findLeadByPhone).toHaveBeenCalledWith(BUSINESS_ID, PHONE);
      expect(stopSpy).toHaveBeenCalled();
    });

    it('onInboundReply ignores a channel with no phone identity', async () => {
      const stopSpy = jest.spyOn(engine, 'stopForLead').mockResolvedValue(0);

      await engine.onInboundReply({
        businessId: BUSINESS_ID,
        senderExternalId: 'a3f1c0de-1111-4222-8333-444455556666',
        senderPhone: undefined,
      } as never);

      expect(leadsService.findLeadByPhone).not.toHaveBeenCalled();
      expect(stopSpy).not.toHaveBeenCalled();
    });
  });

  // ── Lead prefetch ──

  /**
   * `findDueEnrollments` returns up to 500 rows and `runStep` read each row's
   * lead on its own, so a busy tick was up to 500 sequential single-row queries
   * before the first follow-up went out — the classic N+1, on the one path in
   * this module that fans out over every tenant at once.
   */
  describe('processDueEnrollments — lead loading', () => {
    /** Three enrolments across two tenants, each on its own lead. */
    function seedTwoTenants() {
      const other = '00000000-0000-4000-a000-0000000000ff';
      repository.findDueEnrollments.mockResolvedValue([
        makeEnrollment({ id: 'enr-1', lead_id: 'lead-a' }),
        makeEnrollment({ id: 'enr-2', lead_id: 'lead-b' }),
        makeEnrollment({ id: 'enr-3', lead_id: 'lead-c', business_id: other }),
      ] as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep({ step_order: 0 })] as never);
      repository.updateEnrollment.mockResolvedValue(makeEnrollment() as never);
      leadsService.getLeadsByIds.mockImplementation(
        async (_businessId: string, ids: string[]) =>
          new Map(ids.map((id) => [id, makeLead({ id })])) as never,
      );
      return { other };
    }

    it('loads every due enrolment\'s lead in one query per tenant, not one per enrolment', async () => {
      const { other } = seedTwoTenants();

      const result = await engine.processDueEnrollments(NOW);

      expect(result.processed).toBe(3);
      expect(leadsService.getLeadsByIds).toHaveBeenCalledTimes(2);
      expect(leadsService.getLeadsByIds).toHaveBeenCalledWith(BUSINESS_ID, [
        'lead-a',
        'lead-b',
      ]);
      expect(leadsService.getLeadsByIds).toHaveBeenCalledWith(other, ['lead-c']);
      // Nothing fell through to the per-enrolment read.
      expect(leadsService.getLead).not.toHaveBeenCalled();
    });

    it('groups by tenant, so a lead id is never read against another business', async () => {
      seedTwoTenants();

      await engine.processDueEnrollments(NOW);

      for (const [businessId, ids] of leadsService.getLeadsByIds.mock.calls) {
        const expected = businessId === BUSINESS_ID ? ['lead-a', 'lead-b'] : ['lead-c'];
        expect(ids).toEqual(expected);
      }
    });

    it('reads through to the per-enrolment lookup when the prefetch fails', async () => {
      seedTwoTenants();
      leadsService.getLeadsByIds.mockRejectedValue(new Error('db hiccup'));
      leadsService.getLead.mockResolvedValue(makeLead());

      const result = await engine.processDueEnrollments(NOW);

      // A failed prefetch costs speed, never correctness — every enrolment
      // still ran, just the slow way.
      expect(result.processed).toBe(3);
      expect(leadsService.getLead).toHaveBeenCalledTimes(3);
    });

    it('stops the enrolment when a prefetched tenant simply has no such lead', async () => {
      repository.findDueEnrollments.mockResolvedValue([
        makeEnrollment({ lead_id: 'lead-gone' }),
      ] as never);
      repository.listStepsByCadence.mockResolvedValue([makeStep({ step_order: 0 })] as never);
      repository.updateEnrollment.mockResolvedValue(makeEnrollment() as never);
      // Deleted between the enrolment query and the lead query: absent from the
      // prefetch, and the read-through finds nothing either.
      leadsService.getLeadsByIds.mockResolvedValue(new Map() as never);
      leadsService.getLead.mockRejectedValue(new Error('Lead not found'));

      const result = await engine.processDueEnrollments(NOW);

      expect(result.stopped).toBe(1);
      expect(repository.updateEnrollment).toHaveBeenCalledWith(
        BUSINESS_ID,
        'enr-1',
        expect.objectContaining({ status: 'STOPPED', stopReason: 'lead_missing' }),
      );
    });

    it('asks for nothing when no enrolment is due', async () => {
      repository.findDueEnrollments.mockResolvedValue([]);

      await engine.processDueEnrollments(NOW);

      expect(leadsService.getLeadsByIds).not.toHaveBeenCalled();
    });
  });
});
