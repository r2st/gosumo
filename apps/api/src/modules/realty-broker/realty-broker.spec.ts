/**
 * RealtyBrokerService unit tests (blueprint §16).
 *
 * Coverage:
 *  1. Settings / autonomy dial — lazy-create, update, and the evaluateAutonomy
 *     decision (kill switch, human takeover, SUGGEST, threshold).
 *  2. Approval queue — create emits + alerts; resolve (approve/edit/reject) with
 *     validation; double-resolve rejected.
 *  3. Takeover — sets HUMAN owner + emits; release returns to AI; default AI.
 *  4. Hot-lead listener — builds a dossier alert from the lead.
 *  5. Briefing + console metrics assemble from leads/board/approvals.
 *
 * The repository, RealtyLeadsService, RealtyCadenceService and EventEmitter2 are mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ApprovalStatus, AutonomyLevel, ConversationOwner, LeadStage, LeadTemperature } from '@gosumo/shared';

import { RealtyBrokerService } from './realty-broker.service';
import { RealtyBrokerRepository } from './realty-broker.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { RealtyCadenceService } from '../realty-cadence/realty-cadence.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const LEAD_ID = '00000000-0000-4000-a000-000000000010';
const CONV_ID = '00000000-0000-4000-a000-000000000050';
const APPROVAL_ID = '00000000-0000-4000-a000-000000000060';
const USER_ID = '00000000-0000-4000-a000-000000000070';

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'set-1',
    business_id: BUSINESS_ID,
    autonomy_level: 'SUGGEST',
    auto_approve_threshold: 90,
    kill_switch: false,
    briefing_enabled: true,
    briefing_hour: 7,
    briefing_minute: 30,
    hot_alert_whatsapp: null,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: APPROVAL_ID,
    business_id: BUSINESS_ID,
    lead_id: LEAD_ID,
    conversation_id: CONV_ID,
    draft_text: 'Hi, here are 3 options...',
    edited_text: null,
    confidence: 80,
    intent: 'PRICE_INQUIRY',
    status: 'PENDING',
    reviewed_by: null,
    reviewed_at: null,
    reason: null,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    id: LEAD_ID,
    businessId: BUSINESS_ID,
    whatsappPhone: '+919876543210',
    name: 'Rahul',
    optOut: false,
    stage: LeadStage.QUALIFIED,
    temperature: LeadTemperature.HOT,
    qualScore: 88,
    lastActivityAt: new Date(),
    nextFollowupAt: null,
    source: 'CTWA',
    conversationId: CONV_ID,
    assignedAgentId: null,
    matchedUnitIds: ['u1'],
    bltc: { config: '2BHK', localities: ['Baner'], budgetMinPaise: 900000000, budgetMaxPaise: 950000000, timelineMonths: 6, purpose: null, financing: null },
    ...overrides,
  } as never;
}

describe('RealtyBrokerService', () => {
  let service: RealtyBrokerService;
  let repository: jest.Mocked<RealtyBrokerRepository>;
  let leadsService: jest.Mocked<RealtyLeadsService>;
  let cadenceService: jest.Mocked<RealtyCadenceService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepo: Partial<Record<keyof RealtyBrokerRepository, jest.Mock>> = {
      createApproval: jest.fn(),
      findApprovalById: jest.fn(),
      listApprovals: jest.fn(),
      updateApproval: jest.fn(),
      countApprovals: jest.fn().mockResolvedValue(0),
      findSettings: jest.fn(),
      createSettings: jest.fn(),
      updateSettings: jest.fn(),
      createAlert: jest.fn().mockResolvedValue({ id: 'al-1', type: 'HOT_LEAD', business_id: BUSINESS_ID, lead_id: LEAD_ID, title: 't', body: null, payload: {}, is_read: false, read_at: null, created_at: new Date(), updated_at: new Date() }),
      listAlerts: jest.fn().mockResolvedValue([]),
      findAlertById: jest.fn(),
      markAlertRead: jest.fn(),
      markAllAlertsRead: jest.fn().mockResolvedValue(0),
      countUnreadAlerts: jest.fn().mockResolvedValue(0),
      findControl: jest.fn(),
      upsertControl: jest.fn(),
      countControlByOwner: jest.fn().mockResolvedValue({ ai: 0, human: 0 }),
    };
    const mockLeads = {
      getLead: jest.fn(),
      getBoard: jest.fn().mockResolvedValue([{ stage: 'NEW', count: 2 }, { stage: 'CLOSED_WON', count: 1 }]),
      listLeads: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 100, totalPages: 0 }),
    };
    const mockCadence = { listEnrollments: jest.fn().mockResolvedValue([]) };
    const mockEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyBrokerService,
        { provide: RealtyBrokerRepository, useValue: mockRepo },
        { provide: RealtyLeadsService, useValue: mockLeads },
        { provide: RealtyCadenceService, useValue: mockCadence },
        { provide: EventEmitter2, useValue: mockEmitter },
      ],
    }).compile();

    service = module.get(RealtyBrokerService);
    repository = module.get(RealtyBrokerRepository) as jest.Mocked<RealtyBrokerRepository>;
    leadsService = module.get(RealtyLeadsService) as jest.Mocked<RealtyLeadsService>;
    cadenceService = module.get(RealtyCadenceService) as jest.Mocked<RealtyCadenceService>;
    eventEmitter = module.get(EventEmitter2) as jest.Mocked<EventEmitter2>;
    jest.clearAllMocks();
  });

  // ── Settings / autonomy dial ──
  describe('getSettings', () => {
    it('lazily creates the settings row on first read', async () => {
      repository.findSettings.mockResolvedValue(null);
      repository.createSettings.mockResolvedValue(makeSettings() as never);
      await service.getSettings(BUSINESS_ID);
      expect(repository.createSettings).toHaveBeenCalledWith(BUSINESS_ID);
    });
  });

  describe('evaluateAutonomy', () => {
    it('blocks when the kill switch is on', async () => {
      repository.findSettings.mockResolvedValue(makeSettings({ kill_switch: true, autonomy_level: 'AUTONOMOUS' }) as never);
      const d = await service.evaluateAutonomy(BUSINESS_ID, 99);
      expect(d).toEqual({ autoSend: false, reason: 'kill_switch' });
    });

    it('blocks when a human owns the conversation', async () => {
      repository.findSettings.mockResolvedValue(makeSettings({ autonomy_level: 'AUTONOMOUS' }) as never);
      repository.findControl.mockResolvedValue({ owner: ConversationOwner.HUMAN } as never);
      const d = await service.evaluateAutonomy(BUSINESS_ID, 99, CONV_ID);
      expect(d).toEqual({ autoSend: false, reason: 'human_owned' });
    });

    it('never auto-sends in SUGGEST mode', async () => {
      repository.findSettings.mockResolvedValue(makeSettings({ autonomy_level: 'SUGGEST' }) as never);
      const d = await service.evaluateAutonomy(BUSINESS_ID, 100);
      expect(d.autoSend).toBe(false);
      expect(d.reason).toBe('suggest_mode');
    });

    it('auto-sends at/above threshold in ASSISTED mode', async () => {
      repository.findSettings.mockResolvedValue(makeSettings({ autonomy_level: 'ASSISTED', auto_approve_threshold: 90 }) as never);
      expect((await service.evaluateAutonomy(BUSINESS_ID, 90)).autoSend).toBe(true);
      expect((await service.evaluateAutonomy(BUSINESS_ID, 89)).autoSend).toBe(false);
    });
  });

  describe('updateSettings', () => {
    it('maps camelCase dto to snake_case columns', async () => {
      repository.findSettings.mockResolvedValue(makeSettings() as never);
      repository.updateSettings.mockResolvedValue(makeSettings({ autonomy_level: 'ASSISTED' }) as never);
      await service.updateSettings(BUSINESS_ID, { autonomyLevel: AutonomyLevel.ASSISTED, killSwitch: true });
      const data = repository.updateSettings.mock.calls[0]![1] as Record<string, unknown>;
      expect(data['autonomy_level']).toBe('ASSISTED');
      expect(data['kill_switch']).toBe(true);
    });
  });

  // ── Approval queue ──
  describe('createApproval', () => {
    it('creates the draft, emits approval.created, and pushes an alert', async () => {
      repository.createApproval.mockResolvedValue(makeApproval() as never);
      const result = await service.createApproval(BUSINESS_ID, {
        leadId: LEAD_ID,
        conversationId: CONV_ID,
        draftText: 'draft',
        confidence: 80,
      });
      expect(result.status).toBe('PENDING');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.approval.created',
        expect.objectContaining({ type: 'realty.approval.created', leadId: LEAD_ID }),
      );
      expect(repository.createAlert).toHaveBeenCalled();
    });
  });

  describe('resolveApproval', () => {
    it('approves a pending draft and emits resolved', async () => {
      repository.findApprovalById.mockResolvedValue(makeApproval() as never);
      repository.updateApproval.mockResolvedValue(makeApproval({ status: 'APPROVED' }) as never);
      const result = await service.resolveApproval(BUSINESS_ID, APPROVAL_ID, { status: ApprovalStatus.APPROVED }, USER_ID);
      expect(result.status).toBe('APPROVED');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.approval.resolved',
        expect.objectContaining({ outcome: 'APPROVED', reviewedBy: USER_ID }),
      );
    });

    it('requires editedText when status is EDITED', async () => {
      repository.findApprovalById.mockResolvedValue(makeApproval() as never);
      await expect(
        service.resolveApproval(BUSINESS_ID, APPROVAL_ID, { status: ApprovalStatus.EDITED }, USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects resolving an already-resolved draft', async () => {
      repository.findApprovalById.mockResolvedValue(makeApproval({ status: 'APPROVED' }) as never);
      await expect(
        service.resolveApproval(BUSINESS_ID, APPROVAL_ID, { status: ApprovalStatus.REJECTED }, USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFound for a missing approval', async () => {
      repository.findApprovalById.mockResolvedValue(null);
      await expect(
        service.resolveApproval(BUSINESS_ID, APPROVAL_ID, { status: ApprovalStatus.APPROVED }, USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── Takeover ──
  describe('takeOver / release / getControl', () => {
    it('sets HUMAN owner and emits taken_over', async () => {
      repository.upsertControl.mockResolvedValue({ conversation_id: CONV_ID, owner: 'HUMAN', taken_over_by: USER_ID, taken_over_at: new Date(), released_at: null } as never);
      const result = await service.takeOver(BUSINESS_ID, CONV_ID, USER_ID, LEAD_ID);
      expect(result.owner).toBe('HUMAN');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.conversation.taken_over',
        expect.objectContaining({ owner: ConversationOwner.HUMAN, takenOverBy: USER_ID }),
      );
    });

    it('release returns the conversation to the AI', async () => {
      repository.upsertControl.mockResolvedValue({ conversation_id: CONV_ID, owner: 'AI', taken_over_by: null, taken_over_at: null, released_at: new Date() } as never);
      const result = await service.release(BUSINESS_ID, CONV_ID);
      expect(result.owner).toBe('AI');
    });

    it('defaults to AI ownership when no control row exists', async () => {
      repository.findControl.mockResolvedValue(null);
      const result = await service.getControl(BUSINESS_ID, CONV_ID);
      expect(result.owner).toBe('AI');
    });
  });

  // ── Hot-lead listener ──
  describe('onLeadHot', () => {
    it('builds a dossier alert from the lead', async () => {
      leadsService.getLead.mockResolvedValue(makeLead());
      await service.onLeadHot({ businessId: BUSINESS_ID, leadId: LEAD_ID } as never);
      expect(repository.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'HOT_LEAD', leadId: LEAD_ID }),
      );
      const payload = (repository.createAlert.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload;
      expect(payload).toEqual(expect.objectContaining({ leadId: LEAD_ID, qualScore: 88 }));
    });
  });

  // ── Briefing + console ──
  describe('buildBriefing', () => {
    it('buckets hot leads, visits, and due follow-ups', async () => {
      const due = makeLead({ id: 'l2', temperature: 'WARM', stage: LeadStage.CONTACTED, nextFollowupAt: new Date('2026-07-03T06:00:00Z') });
      const visit = makeLead({ id: 'l3', temperature: 'WARM', stage: LeadStage.VISIT_BOOKED, nextFollowupAt: null });
      leadsService.listLeads.mockResolvedValue({ data: [makeLead(), due, visit], total: 3, page: 1, limit: 100, totalPages: 1 } as never);

      const briefing = await service.buildBriefing(BUSINESS_ID, new Date('2026-07-03T12:00:00Z'));

      expect(briefing.hotLeads).toHaveLength(1);
      expect(briefing.visitsToday).toHaveLength(1);
      expect(briefing.followupsDue).toHaveLength(1);
    });
  });

  describe('getConsoleMetrics', () => {
    it('sums active (non-closed) leads and reports autonomy', async () => {
      repository.findSettings.mockResolvedValue(makeSettings({ autonomy_level: 'ASSISTED' }) as never);
      leadsService.listLeads.mockResolvedValue({ data: [], total: 4, page: 1, limit: 1, totalPages: 4 } as never);
      cadenceService.listEnrollments.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }] as never);

      const metrics = await service.getConsoleMetrics(BUSINESS_ID);

      // board = NEW:2 + CLOSED_WON:1 → active excludes closed = 2
      expect(metrics.activeLeads).toBe(2);
      expect(metrics.activeCadences).toBe(2);
      expect(metrics.autonomyLevel).toBe('ASSISTED');
      expect(metrics.aiHandledPct).toBe(100); // no controlled conversations yet
    });
  });
});
