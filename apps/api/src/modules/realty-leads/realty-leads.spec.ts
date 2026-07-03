/**
 * RealtyLeads module unit tests.
 *
 * Coverage:
 *  1. Capture — create (phone-merge conflict, attribution, event), get, list, board
 *  2. BLTC — merge fills slots, contradiction surfacing (not overwritten unless forced),
 *     re-scoring, auto-qualify at 4/4 + reachable, hot event on threshold crossing
 *  3. Stage transitions — event emission, no-op on same stage
 *  4. Memory — append facts/objections/promises
 *  5. Opt-out — halts automation + event
 *  6. Ingest — message.received creates a lead for an unseen phone, touches an existing one
 *  7. Multi-tenant — businessId threaded into every repository call
 *
 * The repository and EventEmitter2 are mocked; no database is touched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LeadSource,
  LeadStage,
  LeadPurpose,
  FinancingStatus,
} from '@gosumo/shared';
import type { MessageReceivedEvent } from '@gosumo/shared';

import { RealtyLeadsService } from './realty-leads.service';
import { RealtyLeadsRepository } from './realty-leads.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const LEAD_ID = '00000000-0000-4000-a000-000000000010';
const CONV_ID = '00000000-0000-4000-a000-000000000030';
const PHONE = '+919876543210';

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    id: LEAD_ID,
    business_id: BUSINESS_ID,
    assigned_agent_id: null,
    client_id: null,
    conversation_id: null,
    whatsapp_phone: PHONE,
    alt_phone: null,
    email: null,
    name: 'Rahul M',
    language_pref: 'hinglish',
    source: 'CTWA',
    sub_source: null,
    campaign_id: null,
    listing_ref: null,
    first_touch_at: new Date('2026-07-01T10:00:00Z'),
    budget_min: null as Prisma.Decimal | null,
    budget_max: null as Prisma.Decimal | null,
    localities: [] as string[],
    timeline_months: null as number | null,
    config: null as string | null,
    purpose: null,
    financing: null,
    qual_score: 0,
    temperature: 'COLD',
    stage: 'NEW',
    matched_unit_ids: [] as string[],
    extracted_facts: [],
    objections: [],
    promises: [],
    opt_out: false,
    consent_log: [],
    share_consent: false,
    exchange_status: 'NONE',
    cadence_id: null,
    cadence_step: 0,
    next_followup_at: null,
    last_activity_at: new Date('2026-07-01T10:00:00Z'),
    metadata: {},
    created_at: new Date('2026-07-01T10:00:00Z'),
    updated_at: new Date('2026-07-01T10:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

describe('RealtyLeadsService', () => {
  let service: RealtyLeadsService;
  let repository: jest.Mocked<RealtyLeadsRepository>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepository: Partial<Record<keyof RealtyLeadsRepository, jest.Mock>> = {
      create: jest.fn(),
      findById: jest.fn(),
      findByPhone: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      list: jest.fn(),
      countByStage: jest.fn(),
    };
    const mockEventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyLeadsService,
        { provide: RealtyLeadsRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get(RealtyLeadsService);
    repository = module.get(RealtyLeadsRepository) as jest.Mocked<RealtyLeadsRepository>;
    eventEmitter = module.get(EventEmitter2) as jest.Mocked<EventEmitter2>;
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── Capture ──
  describe('createLead', () => {
    it('captures a lead and emits realty.lead.created', async () => {
      repository.findByPhone.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeLead() as never);

      const result = await service.createLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.CTWA,
        name: 'Rahul M',
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, whatsappPhone: PHONE, source: 'CTWA' }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead.created',
        expect.objectContaining({ type: 'realty.lead.created', leadId: LEAD_ID, businessId: BUSINESS_ID }),
      );
      expect(result.whatsappPhone).toBe(PHONE);
    });

    it('rejects a duplicate phone (one buyer, one history)', async () => {
      repository.findByPhone.mockResolvedValue(makeLead() as never);
      await expect(
        service.createLead(BUSINESS_ID, { whatsappPhone: PHONE, source: LeadSource.PORTAL }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('getLead', () => {
    it('throws NotFound for a missing lead', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.getLead(BUSINESS_ID, LEAD_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps BLTC paise from stored Decimal rupees', async () => {
      repository.findById.mockResolvedValue(
        makeLead({ budget_min: new Prisma.Decimal('9000000'), budget_max: new Prisma.Decimal('9500000') }) as never,
      );
      const result = await service.getLead(BUSINESS_ID, LEAD_ID);
      expect(result.bltc.budgetMinPaise).toBe(900000000);
      expect(result.bltc.budgetMaxPaise).toBe(950000000);
    });
  });

  describe('getBoard', () => {
    it('returns all stages in canonical order with zero-filled counts', async () => {
      repository.countByStage.mockResolvedValue({ NEW: 3, QUALIFIED: 1 });
      const board = await service.getBoard(BUSINESS_ID);
      expect(board[0]).toEqual({ stage: 'NEW', count: 3 });
      expect(board.find((b) => b.stage === 'QUALIFIED')).toEqual({ stage: 'QUALIFIED', count: 1 });
      expect(board.find((b) => b.stage === 'DORMANT')).toEqual({ stage: 'DORMANT', count: 0 });
    });
  });

  // ── BLTC ──
  describe('applyBltcUpdate', () => {
    it('fills empty slots, rescores, and auto-qualifies at 4/4 + reachable', async () => {
      repository.findById.mockResolvedValue(makeLead() as never);
      repository.update.mockImplementation(async (_b, _id, data) =>
        makeLead({
          budget_min: new Prisma.Decimal('9000000'),
          budget_max: new Prisma.Decimal('9500000'),
          localities: ['Baner'],
          timeline_months: 6,
          config: '2BHK',
          stage: (data as { stage?: string }).stage ?? 'NEW',
          qual_score: (data as { qualScore?: number }).qualScore ?? 0,
        }) as never,
      );

      const result = await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, {
        budgetMinPaise: 900000000,
        budgetMaxPaise: 950000000,
        localities: ['Baner'],
        timelineMonths: 6,
        config: '2BHK',
        financing: FinancingStatus.NEEDS_LOAN,
        purpose: LeadPurpose.END_USE,
        engagementTurns: 5,
      });

      expect(result.qualified).toBe(true);
      expect(result.contradictions).toHaveLength(0);
      expect(result.score.score).toBeGreaterThanOrEqual(75);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead.qualified',
        expect.objectContaining({ leadId: LEAD_ID }),
      );
      // update called with QUALIFIED stage
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.objectContaining({ stage: LeadStage.QUALIFIED }),
      );
    });

    it('surfaces a contradiction instead of overwriting a filled slot', async () => {
      repository.findById.mockResolvedValue(
        makeLead({ budget_max: new Prisma.Decimal('9500000') }) as never, // 950000000 paise
      );
      repository.update.mockResolvedValue(makeLead({ budget_max: new Prisma.Decimal('9500000') }) as never);

      const result = await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, {
        budgetMaxPaise: 800000000, // different → contradiction
      });

      expect(result.contradictions).toEqual([
        { slot: 'budgetMaxPaise', existing: 950000000, incoming: 800000000 },
      ]);
      // The stored value should NOT be changed to the incoming one.
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.objectContaining({ budgetMax: expect.any(Prisma.Decimal) }),
      );
      const call = repository.update.mock.calls[0]![2] as { budgetMax: Prisma.Decimal };
      expect(call.budgetMax.mul(100).toNumber()).toBe(950000000);
    });

    it('overwrites a filled slot when force is set', async () => {
      repository.findById.mockResolvedValue(
        makeLead({ budget_max: new Prisma.Decimal('9500000') }) as never,
      );
      repository.update.mockResolvedValue(makeLead() as never);

      const result = await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, {
        budgetMaxPaise: 800000000,
        force: true,
      });

      expect(result.contradictions).toHaveLength(0);
      const call = repository.update.mock.calls[0]![2] as { budgetMax: Prisma.Decimal };
      expect(call.budgetMax.mul(100).toNumber()).toBe(800000000);
    });

    it('emits realty.lead.hot when the score first crosses the hot threshold', async () => {
      repository.findById.mockResolvedValue(makeLead({ qual_score: 40 }) as never);
      repository.update.mockResolvedValue(makeLead({ qual_score: 90 }) as never);

      await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, {
        budgetMinPaise: 900000000,
        budgetMaxPaise: 950000000,
        localities: ['Baner'],
        timelineMonths: 3,
        config: '2BHK',
        financing: FinancingStatus.PREAPPROVED,
        purpose: LeadPurpose.END_USE,
        engagementTurns: 5,
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead.hot',
        expect.objectContaining({ type: 'realty.lead.hot', leadId: LEAD_ID }),
      );
    });
  });

  // ── Stage ──
  describe('transitionStage', () => {
    it('emits stage_changed and persists the new stage', async () => {
      repository.findById.mockResolvedValue(makeLead({ stage: 'QUALIFIED' }) as never);
      repository.update.mockResolvedValue(makeLead({ stage: 'VISIT_BOOKED' }) as never);

      await service.transitionStage(BUSINESS_ID, LEAD_ID, { stage: LeadStage.VISIT_BOOKED });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead.stage_changed',
        expect.objectContaining({ fromStage: 'QUALIFIED', toStage: 'VISIT_BOOKED' }),
      );
    });

    it('is a no-op when the stage is unchanged', async () => {
      repository.findById.mockResolvedValue(makeLead({ stage: 'NEW' }) as never);
      await service.transitionStage(BUSINESS_ID, LEAD_ID, { stage: LeadStage.NEW });
      expect(repository.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ── Memory ──
  describe('captureMemory', () => {
    it('appends facts/objections/promises with timestamps', async () => {
      repository.findById.mockResolvedValue(
        makeLead({ extracted_facts: [{ text: 'existing', at: '2026-07-01T00:00:00Z' }] }) as never,
      );
      repository.update.mockResolvedValue(makeLead() as never);

      await service.captureMemory(BUSINESS_ID, LEAD_ID, {
        facts: ['wife wants east-facing'],
        objections: ['price too high'],
      });

      const data = repository.update.mock.calls[0]![2] as { extractedFacts: unknown[]; objections: unknown[] };
      expect(data.extractedFacts).toHaveLength(2);
      expect(data.objections).toHaveLength(1);
    });
  });

  // ── Opt-out ──
  describe('setOptOut', () => {
    it('sets opt_out, clears next_followup, and emits opted_out', async () => {
      repository.findById.mockResolvedValue(makeLead() as never);
      repository.update.mockResolvedValue(makeLead({ opt_out: true }) as never);

      await service.setOptOut(BUSINESS_ID, LEAD_ID);

      const data = repository.update.mock.calls[0]![2] as { optOut: boolean; nextFollowupAt: Date | null };
      expect(data.optOut).toBe(true);
      expect(data.nextFollowupAt).toBeNull();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead.opted_out',
        expect.objectContaining({ type: 'realty.lead.opted_out', whatsappPhone: PHONE }),
      );
    });
  });

  // ── Ingest ──
  describe('handleMessageReceived', () => {
    const event: MessageReceivedEvent = {
      id: 'evt-1',
      timestamp: '2026-07-02T10:00:00Z',
      businessId: BUSINESS_ID,
      correlationId: 'corr-1',
      type: 'message.received',
      messageId: 'msg-1',
      conversationId: CONV_ID,
      channelAccountId: 'ca-1',
      channel: 'WHATSAPP' as never,
      senderExternalId: PHONE,
      clientId: 'client-1',
    };

    it('creates a lead for an unseen phone', async () => {
      repository.findByPhone.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeLead() as never);

      await service.handleMessageReceived(event);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, whatsappPhone: PHONE, source: 'CTWA' }),
      );
    });

    it('only touches an existing lead (no duplicate create)', async () => {
      repository.findByPhone.mockResolvedValue(makeLead() as never);
      repository.update.mockResolvedValue(makeLead() as never);

      await service.handleMessageReceived(event);

      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.objectContaining({ conversationId: CONV_ID }),
      );
    });
  });

  // ── Find-or-create by phone (shared capture path) ──
  describe('ensureLeadByPhone', () => {
    it('creates the lead with the channel phone identifier as delivered', async () => {
      repository.findByPhone.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeLead() as never);

      const result = await service.ensureLeadByPhone(BUSINESS_ID, PHONE, {
        source: LeadSource.CTWA,
        conversationId: CONV_ID,
      });

      expect(repository.findByPhone).toHaveBeenCalledWith(BUSINESS_ID, PHONE);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ whatsappPhone: PHONE, source: 'CTWA' }),
      );
      expect(result?.id).toBe(LEAD_ID);
    });

    it('touches an existing lead instead of creating a duplicate', async () => {
      repository.findByPhone.mockResolvedValue(makeLead() as never);
      repository.update.mockResolvedValue(makeLead() as never);

      await service.ensureLeadByPhone(BUSINESS_ID, PHONE, { conversationId: CONV_ID });

      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.objectContaining({ conversationId: CONV_ID }),
      );
    });

    it('returns null (no lookup, no create) for a blank identifier', async () => {
      const result = await service.ensureLeadByPhone(BUSINESS_ID, '   ');

      expect(result).toBeNull();
      expect(repository.findByPhone).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('re-reads instead of failing when it loses a create race', async () => {
      // No lead on first look, but a concurrent capture wins the create.
      repository.findByPhone
        .mockResolvedValueOnce(null) // ensureLeadByPhone's own lookup
        .mockResolvedValueOnce(null) // createLead's internal dedup lookup
        .mockResolvedValueOnce(makeLead() as never); // post-conflict re-read
      repository.create.mockRejectedValue(
        new ConflictException('A lead with phone already exists'),
      );

      const result = await service.ensureLeadByPhone(BUSINESS_ID, PHONE);

      expect(result?.id).toBe(LEAD_ID);
    });
  });
});
