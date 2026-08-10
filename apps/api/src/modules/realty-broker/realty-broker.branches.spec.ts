/**
 * Branch coverage for RealtyBrokerService.
 *
 * `realty-broker.spec.ts` establishes that each surface works. This file drives
 * the decisions inside them: the autonomy dial's remaining arms, the evidence
 * reads used by the launch gate (which return sentinel values on empty data and
 * are easy to get backwards), the briefing's follow-up filter, and the BLTC
 * one-liner every alert and card is built from.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import {
  ApprovalStatus,
  AutonomyLevel,
  ConversationOwner,
  BrokerAlertType,
  LeadStage,
  LeadTemperature,
} from '@gosumo/shared';

import { RealtyBrokerService } from './realty-broker.service';
import { RealtyBrokerRepository } from './realty-broker.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { RealtyCadenceService } from '../realty-cadence/realty-cadence.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const LEAD_ID = '00000000-0000-4000-a000-000000000010';
const CONV_ID = '00000000-0000-4000-a000-000000000050';
const APPROVAL_ID = '00000000-0000-4000-a000-000000000060';
const ALERT_ID = '00000000-0000-4000-a000-000000000080';

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'set-1',
    business_id: BUSINESS_ID,
    autonomy_level: AutonomyLevel.ASSISTED,
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
    status: ApprovalStatus.PENDING,
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

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: ALERT_ID,
    business_id: BUSINESS_ID,
    type: BrokerAlertType.HOT_LEAD,
    lead_id: LEAD_ID,
    title: 'Hot lead',
    body: null,
    payload: {},
    is_read: false,
    read_at: null,
    created_at: new Date('2026-06-01T10:00:00Z'),
    updated_at: new Date(),
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
    bltc: {
      config: '2BHK',
      localities: ['Baner'],
      budgetMinPaise: 900000000,
      budgetMaxPaise: 950000000,
      timelineMonths: 6,
      purpose: null,
      financing: null,
    },
    ...overrides,
  } as never;
}

function makeControl(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ctl-1',
    business_id: BUSINESS_ID,
    conversation_id: CONV_ID,
    lead_id: null,
    owner: ConversationOwner.AI,
    taken_over_by: null,
    taken_over_at: null,
    released_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('RealtyBrokerService — branches', () => {
  let service: RealtyBrokerService;
  let repository: jest.Mocked<RealtyBrokerRepository>;
  let leadsService: jest.Mocked<RealtyLeadsService>;
  let cadenceService: jest.Mocked<RealtyCadenceService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepo: Partial<Record<keyof RealtyBrokerRepository, jest.Mock>> = {
      createApproval: jest.fn().mockResolvedValue(makeApproval()),
      findApprovalById: jest.fn().mockResolvedValue(makeApproval()),
      listApprovals: jest.fn().mockResolvedValue([]),
      updateApproval: jest.fn().mockResolvedValue(makeApproval()),
      countApprovals: jest.fn().mockResolvedValue(0),
      approvalStatusCounts: jest.fn().mockResolvedValue({}),
      findSettings: jest.fn().mockResolvedValue(makeSettings()),
      createSettings: jest.fn().mockResolvedValue(makeSettings()),
      updateSettings: jest.fn().mockResolvedValue(makeSettings()),
      createAlert: jest.fn().mockResolvedValue(makeAlert()),
      listAlerts: jest.fn().mockResolvedValue([]),
      findAlertById: jest.fn().mockResolvedValue(makeAlert()),
      markAlertRead: jest.fn().mockResolvedValue(makeAlert({ is_read: true })),
      markAllAlertsRead: jest.fn().mockResolvedValue(3),
      countUnreadAlerts: jest.fn().mockResolvedValue(0),
      findHotAlerts: jest.fn().mockResolvedValue([]),
      findControl: jest.fn().mockResolvedValue(null),
      upsertControl: jest.fn().mockResolvedValue(makeControl()),
      countControlByOwner: jest.fn().mockResolvedValue({ ai: 0, human: 0 }),
    };
    const mockLeads = {
      getLead: jest.fn().mockResolvedValue(makeLead()),
      getBoard: jest.fn().mockResolvedValue([]),
      listLeads: jest.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 100,
        totalPages: 0,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyBrokerService,
        { provide: RealtyBrokerRepository, useValue: mockRepo },
        { provide: RealtyLeadsService, useValue: mockLeads },
        {
          provide: RealtyCadenceService,
          useValue: { listEnrollments: jest.fn().mockResolvedValue([]) },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(RealtyBrokerService);
    repository = module.get(RealtyBrokerRepository);
    leadsService = module.get(RealtyLeadsService);
    cadenceService = module.get(RealtyCadenceService);
    eventEmitter = module.get(EventEmitter2);
  });

  // ───────────────────────────────────────────────────────────────────
  // Settings
  // ───────────────────────────────────────────────────────────────────

  describe('settings', () => {
    it('reuses the existing row rather than creating a second', async () => {
      const settings = await service.getSettingsDto(BUSINESS_ID);

      expect(repository.createSettings).not.toHaveBeenCalled();
      expect(settings).toEqual({
        autonomyLevel: AutonomyLevel.ASSISTED,
        autoApproveThreshold: 90,
        killSwitch: false,
        briefingEnabled: true,
        briefingHour: 7,
        briefingMinute: 30,
        hotAlertWhatsapp: null,
      });
    });

    it('sends no columns when the update dto is empty', async () => {
      await service.updateSettings(BUSINESS_ID, {});

      expect(repository.updateSettings).toHaveBeenCalledWith(BUSINESS_ID, {});
    });

    it('maps every settable field to its column', async () => {
      await service.updateSettings(BUSINESS_ID, {
        autonomyLevel: AutonomyLevel.AUTONOMOUS,
        autoApproveThreshold: 75,
        killSwitch: true,
        briefingEnabled: false,
        briefingHour: 8,
        briefingMinute: 15,
        hotAlertWhatsapp: '+919999999999',
      } as Parameters<RealtyBrokerService['updateSettings']>[1]);

      expect(repository.updateSettings).toHaveBeenCalledWith(BUSINESS_ID, {
        autonomy_level: AutonomyLevel.AUTONOMOUS,
        auto_approve_threshold: 75,
        kill_switch: true,
        briefing_enabled: false,
        briefing_hour: 8,
        briefing_minute: 15,
        hot_alert_whatsapp: '+919999999999',
      });
    });

    it('sends only the fields the dto actually names', async () => {
      await service.updateSettings(BUSINESS_ID, { killSwitch: true });

      expect(repository.updateSettings).toHaveBeenCalledWith(BUSINESS_ID, {
        kill_switch: true,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Autonomy dial
  // ───────────────────────────────────────────────────────────────────

  describe('evaluateAutonomy', () => {
    it('does not consult control when no conversation is named', async () => {
      const decision = await service.evaluateAutonomy(BUSINESS_ID, 95);

      expect(repository.findControl).not.toHaveBeenCalled();
      expect(decision).toEqual({ autoSend: true, reason: 'confidence_ok' });
    });

    it('proceeds when a control row exists but the AI still owns it', async () => {
      repository.findControl.mockResolvedValue(
        makeControl({ owner: ConversationOwner.AI }) as never,
      );

      const decision = await service.evaluateAutonomy(BUSINESS_ID, 95, CONV_ID);

      expect(decision).toEqual({ autoSend: true, reason: 'confidence_ok' });
    });

    it('proceeds when the conversation has no control row at all', async () => {
      repository.findControl.mockResolvedValue(null);

      const decision = await service.evaluateAutonomy(BUSINESS_ID, 95, CONV_ID);

      expect(decision.autoSend).toBe(true);
    });

    it('refuses below the threshold', async () => {
      const decision = await service.evaluateAutonomy(BUSINESS_ID, 89);

      expect(decision).toEqual({ autoSend: false, reason: 'below_threshold' });
    });

    it('auto-sends exactly at the threshold', async () => {
      const decision = await service.evaluateAutonomy(BUSINESS_ID, 90);

      expect(decision.autoSend).toBe(true);
    });

    it('auto-sends in AUTONOMOUS mode', async () => {
      repository.findSettings.mockResolvedValue(
        makeSettings({ autonomy_level: AutonomyLevel.AUTONOMOUS }) as never,
      );

      const decision = await service.evaluateAutonomy(BUSINESS_ID, 91);

      expect(decision.autoSend).toBe(true);
    });

    it('lets the kill switch win over a high confidence score', async () => {
      repository.findSettings.mockResolvedValue(
        makeSettings({ kill_switch: true }) as never,
      );

      const decision = await service.evaluateAutonomy(BUSINESS_ID, 100, CONV_ID);

      expect(decision).toEqual({ autoSend: false, reason: 'kill_switch' });
      // The kill switch short-circuits before any control lookup.
      expect(repository.findControl).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Evidence reads
  // ───────────────────────────────────────────────────────────────────

  describe('getApprovalStats', () => {
    it('reports zeroes when nothing has been resolved', async () => {
      repository.approvalStatusCounts.mockResolvedValue({});

      expect(await service.getApprovalStats(BUSINESS_ID)).toEqual({
        resolved: 0,
        approvedVerbatim: 0,
      });
    });

    it('counts edits and rejections as resolved but not verbatim', async () => {
      repository.approvalStatusCounts.mockResolvedValue({
        [ApprovalStatus.APPROVED]: 6,
        [ApprovalStatus.EDITED]: 3,
        [ApprovalStatus.REJECTED]: 1,
        [ApprovalStatus.PENDING]: 20,
      });

      expect(await service.getApprovalStats(BUSINESS_ID)).toEqual({
        resolved: 10,
        approvedVerbatim: 6,
      });
    });
  });

  describe('getHotAlertActionRate', () => {
    it('returns null when there are no hot alerts to judge', async () => {
      repository.findHotAlerts.mockResolvedValue([]);

      expect(await service.getHotAlertActionRate(BUSINESS_ID)).toBeNull();
    });

    it('counts only alerts read inside thirty minutes', async () => {
      const created = new Date('2026-06-01T10:00:00Z');
      repository.findHotAlerts.mockResolvedValue([
        // Read after 10 minutes — counts.
        makeAlert({ created_at: created, read_at: new Date('2026-06-01T10:10:00Z') }),
        // Read at exactly 30 minutes — the boundary is inclusive, so counts.
        makeAlert({ created_at: created, read_at: new Date('2026-06-01T10:30:00Z') }),
        // Read after 31 minutes — too late.
        makeAlert({ created_at: created, read_at: new Date('2026-06-01T10:31:00Z') }),
        // Never read.
        makeAlert({ created_at: created, read_at: null }),
      ] as never);

      expect(await service.getHotAlertActionRate(BUSINESS_ID)).toBe(0.5);
    });

    it('passes the since filter through to the repository', async () => {
      const since = new Date('2026-05-01T00:00:00Z');
      repository.findHotAlerts.mockResolvedValue([]);

      await service.getHotAlertActionRate(BUSINESS_ID, since);

      expect(repository.findHotAlerts).toHaveBeenCalledWith(BUSINESS_ID, since);
    });
  });

  describe('getAiHandledPct', () => {
    it('reports 100% when nothing has been asserted either way', async () => {
      repository.countControlByOwner.mockResolvedValue({ ai: 0, human: 0 });

      expect(await service.getAiHandledPct(BUSINESS_ID)).toBe(100);
    });

    it('rounds the AI share of asserted conversations', async () => {
      repository.countControlByOwner.mockResolvedValue({ ai: 2, human: 1 });

      expect(await service.getAiHandledPct(BUSINESS_ID)).toBe(67);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Approval queue
  // ───────────────────────────────────────────────────────────────────

  describe('approvals', () => {
    it('maps a listed approval onto the response shape', async () => {
      repository.listApprovals.mockResolvedValue([
        makeApproval({ edited_text: 'edited', reason: 'tone', status: ApprovalStatus.EDITED }),
      ] as never);

      const [dto] = await service.listApprovals(BUSINESS_ID, {
        status: ApprovalStatus.EDITED,
      });

      expect(dto).toMatchObject({
        id: APPROVAL_ID,
        leadId: LEAD_ID,
        conversationId: CONV_ID,
        editedText: 'edited',
        reason: 'tone',
        status: ApprovalStatus.EDITED,
      });
      expect(repository.listApprovals).toHaveBeenCalledWith(BUSINESS_ID, {
        status: ApprovalStatus.EDITED,
      });
    });

    it('throws NotFoundException when fetching a missing approval', async () => {
      repository.findApprovalById.mockResolvedValue(null);

      await expect(service.getApproval(BUSINESS_ID, APPROVAL_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('stores the edited text when resolving as EDITED', async () => {
      await service.resolveApproval(
        BUSINESS_ID,
        APPROVAL_ID,
        { status: ApprovalStatus.EDITED, editedText: 'Better wording' },
        'user-1',
      );

      expect(repository.updateApproval).toHaveBeenCalledWith(
        BUSINESS_ID,
        APPROVAL_ID,
        expect.objectContaining({
          status: ApprovalStatus.EDITED,
          edited_text: 'Better wording',
          reviewed_by: 'user-1',
        }),
      );
    });

    it('clears the edited text when resolving as REJECTED', async () => {
      await service.resolveApproval(BUSINESS_ID, APPROVAL_ID, {
        status: ApprovalStatus.REJECTED,
        reason: 'off-brand',
      });

      expect(repository.updateApproval).toHaveBeenCalledWith(
        BUSINESS_ID,
        APPROVAL_ID,
        expect.objectContaining({
          edited_text: null,
          reason: 'off-brand',
          reviewed_by: null,
        }),
      );
    });

    it('defaults the reason to null when none is given', async () => {
      await service.resolveApproval(BUSINESS_ID, APPROVAL_ID, {
        status: ApprovalStatus.APPROVED,
      });

      expect(repository.updateApproval).toHaveBeenCalledWith(
        BUSINESS_ID,
        APPROVAL_ID,
        expect.objectContaining({ reason: null }),
      );
    });

    it('rejects a status outside the three terminal outcomes', async () => {
      await expect(
        service.resolveApproval(BUSINESS_ID, APPROVAL_ID, {
          status: ApprovalStatus.PENDING,
        } as Parameters<RealtyBrokerService['resolveApproval']>[2]),
      ).rejects.toThrow(/must be APPROVED, EDITED, or REJECTED/);
    });

    it('treats whitespace-only edited text as missing', async () => {
      await expect(
        service.resolveApproval(BUSINESS_ID, APPROVAL_ID, {
          status: ApprovalStatus.EDITED,
          editedText: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('truncates a long draft in the pending-approval alert body', async () => {
      const draft = 'x'.repeat(400);

      await service.createApproval(BUSINESS_ID, {
        leadId: LEAD_ID,
        draftText: draft,
        confidence: 80,
      } as Parameters<RealtyBrokerService['createApproval']>[1]);

      expect(repository.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'x'.repeat(160) }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Alerts
  // ───────────────────────────────────────────────────────────────────

  describe('alerts', () => {
    it('returns the mapped feed alongside the unread count', async () => {
      repository.listAlerts.mockResolvedValue([
        makeAlert({ payload: { approvalId: 'a-1' }, body: 'text' }),
      ] as never);
      repository.countUnreadAlerts.mockResolvedValue(4);

      const result = await service.listAlerts(BUSINESS_ID, { unreadOnly: true });

      expect(result.unread).toBe(4);
      expect(result.alerts[0]).toMatchObject({
        id: ALERT_ID,
        leadId: LEAD_ID,
        body: 'text',
        payload: { approvalId: 'a-1' },
        isRead: false,
      });
    });

    it('defaults a null payload to an empty object', async () => {
      repository.listAlerts.mockResolvedValue([makeAlert({ payload: null })] as never);

      const result = await service.listAlerts(BUSINESS_ID, {});

      expect(result.alerts[0]?.payload).toEqual({});
    });

    it('throws NotFoundException when marking an unknown alert read', async () => {
      repository.findAlertById.mockResolvedValue(null);

      await expect(service.markAlertRead(BUSINESS_ID, ALERT_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.markAlertRead).not.toHaveBeenCalled();
    });

    it('marks a known alert read', async () => {
      const result = await service.markAlertRead(BUSINESS_ID, ALERT_ID);

      expect(result.isRead).toBe(true);
    });

    it('reports how many alerts a bulk read touched', async () => {
      expect(await service.markAllAlertsRead(BUSINESS_ID)).toEqual({ marked: 3 });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Takeover
  // ───────────────────────────────────────────────────────────────────

  describe('takeOver', () => {
    it('nulls the actor and lead when neither is supplied', async () => {
      await service.takeOver(BUSINESS_ID, CONV_ID);

      expect(repository.upsertControl).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONV_ID,
        expect.objectContaining({
          owner: ConversationOwner.HUMAN,
          leadId: null,
          takenOverBy: null,
          releasedAt: null,
        }),
      );
      expect(repository.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({ leadId: null }),
      );
    });

    it('carries the lead id into the takeover alert', async () => {
      await service.takeOver(BUSINESS_ID, CONV_ID, 'user-1', LEAD_ID);

      expect(repository.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({ leadId: LEAD_ID, type: BrokerAlertType.TAKEOVER }),
      );
    });

    it('clears the takeover fields on release', async () => {
      repository.upsertControl.mockResolvedValue(
        makeControl({ released_at: new Date('2026-06-01T12:00:00Z') }) as never,
      );

      const result = await service.release(BUSINESS_ID, CONV_ID);

      expect(repository.upsertControl).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONV_ID,
        expect.objectContaining({
          owner: ConversationOwner.AI,
          takenOverBy: null,
          takenOverAt: null,
        }),
      );
      expect(result.owner).toBe(ConversationOwner.AI);
      // Releasing is not alert-worthy — only takeover is.
      expect(repository.createAlert).not.toHaveBeenCalled();
    });

    it('maps a stored control row rather than the AI default', async () => {
      repository.findControl.mockResolvedValue(
        makeControl({
          owner: ConversationOwner.HUMAN,
          taken_over_by: 'user-1',
          taken_over_at: new Date('2026-06-01T09:00:00Z'),
        }) as never,
      );

      const result = await service.getControl(BUSINESS_ID, CONV_ID);

      expect(result).toMatchObject({
        owner: ConversationOwner.HUMAN,
        takenOverBy: 'user-1',
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Briefing
  // ───────────────────────────────────────────────────────────────────

  describe('buildBriefing', () => {
    const NOW = new Date('2026-06-15T04:00:00Z');

    it('excludes opted-out leads and follow-ups beyond today', async () => {
      leadsService.listLeads.mockResolvedValue({
        data: [
          makeLead({
            id: 'due',
            temperature: LeadTemperature.WARM,
            nextFollowupAt: new Date('2026-06-15T09:00:00Z'),
          }),
          makeLead({
            id: 'opted-out',
            temperature: LeadTemperature.WARM,
            nextFollowupAt: new Date('2026-06-15T09:00:00Z'),
            optOut: true,
          }),
          makeLead({
            id: 'later',
            temperature: LeadTemperature.WARM,
            nextFollowupAt: new Date('2026-07-01T09:00:00Z'),
          }),
          makeLead({ id: 'none', temperature: LeadTemperature.WARM, nextFollowupAt: null }),
        ],
        total: 4,
        page: 1,
        limit: 100,
        totalPages: 1,
      } as never);

      const briefing = await service.buildBriefing(BUSINESS_ID, NOW);

      expect(briefing.followupsDue.map((f) => f.leadId)).toEqual(['due']);
    });

    it('keys the date to IST, not UTC', async () => {
      // 20:00 UTC on 14 June is already 15 June in IST.
      const briefing = await service.buildBriefing(
        BUSINESS_ID,
        new Date('2026-06-14T20:00:00Z'),
      );

      expect(briefing.date).toBe('2026-06-15');
    });

    it('caps hot leads at ten and booked visits at twenty', async () => {
      const many = Array.from({ length: 25 }, (_, i) =>
        makeLead({
          id: `l${i}`,
          temperature: LeadTemperature.HOT,
          stage: LeadStage.VISIT_BOOKED,
        }),
      );
      leadsService.listLeads.mockResolvedValue({
        data: many,
        total: 25,
        page: 1,
        limit: 100,
        totalPages: 1,
      } as never);

      const briefing = await service.buildBriefing(BUSINESS_ID, NOW);

      expect(briefing.hotLeads).toHaveLength(10);
      expect(briefing.visitsToday).toHaveLength(20);
    });

    it('pushes no alert when briefings are disabled', async () => {
      repository.findSettings.mockResolvedValue(
        makeSettings({ briefing_enabled: false }) as never,
      );

      await service.generateAndPushBriefing(BUSINESS_ID, NOW);

      expect(repository.createAlert).not.toHaveBeenCalled();
    });

    it('pushes a summary alert when briefings are enabled', async () => {
      await service.generateAndPushBriefing(BUSINESS_ID, NOW);

      expect(repository.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: BrokerAlertType.MORNING_BRIEFING,
          body: '0 hot · 0 visits · 0 follow-ups · 0 to approve',
        }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Console metrics
  // ───────────────────────────────────────────────────────────────────

  describe('getConsoleMetrics', () => {
    it('rounds the AI-handled share once conversations are asserted', async () => {
      repository.countControlByOwner.mockResolvedValue({ ai: 7, human: 3 });
      cadenceService.listEnrollments.mockResolvedValue([{}, {}] as never);
      leadsService.getBoard.mockResolvedValue([
        { stage: LeadStage.NEW, count: 4 },
        { stage: LeadStage.CLOSED_WON, count: 2 },
        { stage: LeadStage.CLOSED_LOST, count: 5 },
      ] as never);

      const metrics = await service.getConsoleMetrics(BUSINESS_ID);

      expect(metrics.activeLeads).toBe(4);
      expect(metrics.aiHandledPct).toBe(70);
      expect(metrics.activeCadences).toBe(2);
      expect(metrics.autonomyLevel).toBe(AutonomyLevel.ASSISTED);
    });

    it('reports 100% AI-handled on a fresh account', async () => {
      const metrics = await service.getConsoleMetrics(BUSINESS_ID);

      expect(metrics.aiHandledPct).toBe(100);
      expect(metrics.activeLeads).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Hot-lead listener + BLTC summary
  // ───────────────────────────────────────────────────────────────────

  describe('onLeadHot', () => {
    it('falls back to the phone number when the lead is unnamed', async () => {
      leadsService.getLead.mockResolvedValue(makeLead({ name: null }));

      await service.onLeadHot({
        businessId: BUSINESS_ID,
        leadId: LEAD_ID,
      } as Parameters<RealtyBrokerService['onLeadHot']>[0]);

      expect(repository.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({ title: '🔥 Hot lead: +919876543210 (score 88)' }),
      );
    });

    it('defaults matchedUnitIds to an empty list in the dossier', async () => {
      leadsService.getLead.mockResolvedValue(makeLead({ matchedUnitIds: undefined }));

      await service.onLeadHot({
        businessId: BUSINESS_ID,
        leadId: LEAD_ID,
      } as Parameters<RealtyBrokerService['onLeadHot']>[0]);

      const [payload] = repository.createAlert.mock.calls[0]!;
      const dossier = (payload as unknown as { payload: { matchedUnitIds: string[] } })
        .payload;
      expect(dossier.matchedUnitIds).toEqual([]);
    });

    it('swallows a lead-lookup failure rather than breaking the emitter', async () => {
      leadsService.getLead.mockRejectedValue(new Error('lead gone'));

      await expect(
        service.onLeadHot({
          businessId: BUSINESS_ID,
          leadId: LEAD_ID,
        } as Parameters<RealtyBrokerService['onLeadHot']>[0]),
      ).resolves.toBeUndefined();

      expect(repository.createAlert).not.toHaveBeenCalled();
    });

    it('swallows a non-Error rejection', async () => {
      leadsService.getLead.mockRejectedValue('lead gone');

      await expect(
        service.onLeadHot({
          businessId: BUSINESS_ID,
          leadId: LEAD_ID,
        } as Parameters<RealtyBrokerService['onLeadHot']>[0]),
      ).resolves.toBeUndefined();
    });

    it.each([
      [
        'a full requirement',
        {
          config: '3BHK',
          localities: ['Wakad', 'Baner'],
          budgetMinPaise: 900000000,
          budgetMaxPaise: 950000000,
          timelineMonths: 3,
        },
        '3BHK · Wakad · ₹90.0L–₹95.0L · 3mo',
      ],
      [
        'only a maximum budget',
        { config: null, localities: [], budgetMinPaise: null, budgetMaxPaise: 950000000, timelineMonths: null },
        '₹95.0L',
      ],
      [
        'only a minimum budget',
        { config: null, localities: null, budgetMinPaise: 900000000, budgetMaxPaise: null, timelineMonths: null },
        '₹90.0L',
      ],
      [
        'only a timeline',
        { config: null, localities: [], budgetMinPaise: null, budgetMaxPaise: null, timelineMonths: 12 },
        '12mo',
      ],
      [
        'nothing at all',
        { config: null, localities: [], budgetMinPaise: null, budgetMaxPaise: null, timelineMonths: null },
        'No requirement captured yet',
      ],
    ])('summarises %s', async (_label, bltc, expected) => {
      leadsService.getLead.mockResolvedValue(
        makeLead({ bltc: { ...bltc, purpose: null, financing: null } }),
      );

      await service.onLeadHot({
        businessId: BUSINESS_ID,
        leadId: LEAD_ID,
      } as Parameters<RealtyBrokerService['onLeadHot']>[0]);

      expect(repository.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({ body: expected }),
      );
    });
  });

  it('emits the alert event alongside every pushed alert', async () => {
    await service.takeOver(BUSINESS_ID, CONV_ID);

    const alertEvents = eventEmitter.emit.mock.calls.filter(
      ([name]) => name === 'realty.broker.alert',
    );
    expect(alertEvents).toHaveLength(1);
    expect(alertEvents[0]![1]).toMatchObject({
      alertType: BrokerAlertType.TAKEOVER,
      businessId: BUSINESS_ID,
    });
  });
});
