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

import { RealtyLeadsService, canAdvanceStage, isTerminalStage } from './realty-leads.service';
import { RealtyLeadsRepository } from './realty-leads.repository';
import { TenantService } from '../tenant/tenant.service';

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
      findByPhoneIncludingDeleted: jest.fn(),
      revive: jest.fn(),
      update: jest.fn(),
      transitionStage: jest.fn(),
      softDelete: jest.fn(),
      list: jest.fn(),
      listForAggregation: jest.fn().mockResolvedValue([]),
      countByStage: jest.fn(),
    };
    const mockEventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyLeadsService,
        { provide: RealtyLeadsRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        // Assignment guard: every assignee is a member of this tenant by
        // default, so the existing cases run unchanged.
        {
          provide: TenantService,
          useValue: { assertTeamMember: jest.fn().mockResolvedValue(undefined) },
        },
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
      repository.findByPhoneIncludingDeleted.mockResolvedValue(null);
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
      repository.findByPhoneIncludingDeleted.mockResolvedValue(makeLead() as never);
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

  // ── Aggregation feed (consumed by realty-intelligence) ──

  /**
   * `listLeadsForAggregation` is the nightly intelligence run's only door into
   * this table. It owns the keyset walk and the row→projection widening, so the
   * cases here are the ones that would silently corrupt a year of corridor
   * statistics: a cursor that fails to advance, a cap that truncates without
   * saying so, and budgets crossing the rupee/paise boundary.
   */
  describe('listLeadsForAggregation', () => {
    const SINCE = new Date('2025-07-03T00:00:00Z');

    /** A projection row as the repository returns it (raw columns). */
    function aggRow(overrides: Record<string, unknown> = {}) {
      return {
        id: LEAD_ID,
        source: 'PORTAL',
        stage: 'NEW',
        qual_score: 70,
        localities: ['Whitefield'],
        budget_min: null as Prisma.Decimal | null,
        budget_max: null as Prisma.Decimal | null,
        config: '2BHK',
        objections: [],
        first_touch_at: new Date('2026-01-05T09:00:00Z'),
        last_activity_at: new Date('2026-01-06T09:00:00Z'),
        ...overrides,
      };
    }

    it('returns a single short page without asking for another', async () => {
      repository.listForAggregation.mockResolvedValueOnce([aggRow(), aggRow()] as never);

      const { leads, truncated } = await service.listLeadsForAggregation(
        BUSINESS_ID,
        SINCE,
        1000,
        500,
      );

      expect(leads).toHaveLength(2);
      expect(truncated).toBe(false);
      expect(repository.listForAggregation).toHaveBeenCalledTimes(1);
      expect(repository.listForAggregation).toHaveBeenCalledWith(BUSINESS_ID, SINCE, 500, undefined);
    });

    it('walks pages until a short one arrives, carrying the keyset cursor', async () => {
      const full = Array.from({ length: 500 }, (_, i) =>
        aggRow({ id: `lead-${i}`, first_touch_at: new Date(2026, 0, 1, 0, 0, i) }),
      );
      const last = full[full.length - 1]!;
      repository.listForAggregation
        .mockResolvedValueOnce(full as never)
        .mockResolvedValueOnce([aggRow()] as never);

      const { leads, truncated } = await service.listLeadsForAggregation(
        BUSINESS_ID,
        SINCE,
        100_000,
        500,
      );

      expect(leads).toHaveLength(501);
      expect(truncated).toBe(false);
      expect(repository.listForAggregation).toHaveBeenCalledTimes(2);
      // Page 2 resumes from the last row of page 1 — both halves of the key.
      expect(repository.listForAggregation).toHaveBeenNthCalledWith(2, BUSINESS_ID, SINCE, 500, {
        firstTouchAt: last.first_touch_at,
        id: last.id,
      });
    });

    /**
     * A page that is exactly full is indistinguishable from a page with more
     * behind it, so the walk has to probe once more and stop on the empty
     * result rather than assuming.
     */
    it('stops on an empty page after an exactly-full one', async () => {
      const full = Array.from({ length: 500 }, () => aggRow());
      repository.listForAggregation
        .mockResolvedValueOnce(full as never)
        .mockResolvedValueOnce([] as never);

      const { leads, truncated } = await service.listLeadsForAggregation(
        BUSINESS_ID,
        SINCE,
        100_000,
        500,
      );

      expect(leads).toHaveLength(500);
      expect(truncated).toBe(false);
      expect(repository.listForAggregation).toHaveBeenCalledTimes(2);
    });

    it('stops at the cap and reports the truncation', async () => {
      const full = Array.from({ length: 500 }, () => aggRow());
      repository.listForAggregation.mockResolvedValue(full as never);

      const { leads, truncated } = await service.listLeadsForAggregation(
        BUSINESS_ID,
        SINCE,
        1000,
        500,
      );

      expect(leads).toHaveLength(1000);
      expect(truncated).toBe(true);
      // Exactly two pages — the cap stops the walk, it does not keep reading.
      expect(repository.listForAggregation).toHaveBeenCalledTimes(2);
    });

    /** The last page must not overshoot the cap just because pageSize is bigger. */
    it('shrinks the final page so the cap is never exceeded', async () => {
      // A tenant with more leads than the cap: every page comes back full.
      repository.listForAggregation.mockImplementation(
        (_b: string, _s: Date, take: number) =>
          Promise.resolve(Array.from({ length: take }, () => aggRow())) as never,
      );

      const { leads, truncated } = await service.listLeadsForAggregation(
        BUSINESS_ID,
        SINCE,
        600,
        500,
      );

      expect(leads).toHaveLength(600);
      expect(truncated).toBe(true);
      // 500 asked for first, then only the 100 that still fit under the cap.
      expect(repository.listForAggregation.mock.calls[0]![2]).toBe(500);
      expect(repository.listForAggregation.mock.calls[1]![2]).toBe(100);
    });

    it('reports no truncation when the walk ends exactly on the cap boundary', async () => {
      repository.listForAggregation
        .mockResolvedValueOnce(Array.from({ length: 500 }, () => aggRow()) as never)
        .mockResolvedValueOnce([] as never);

      const { leads, truncated } = await service.listLeadsForAggregation(
        BUSINESS_ID,
        SINCE,
        1000,
        500,
      );

      expect(leads).toHaveLength(500);
      expect(truncated).toBe(false);
    });

    it('converts stored Decimal rupees to integer paise', async () => {
      repository.listForAggregation.mockResolvedValueOnce([
        aggRow({
          budget_min: new Prisma.Decimal('9000000'),
          budget_max: new Prisma.Decimal('9500000.50'),
        }),
      ] as never);

      const { leads } = await service.listLeadsForAggregation(BUSINESS_ID, SINCE, 1000, 500);

      expect(leads[0]!.budgetMinPaise).toBe(900_000_000);
      expect(leads[0]!.budgetMaxPaise).toBe(950_000_050);
    });

    it('leaves an absent budget null rather than zero', async () => {
      repository.listForAggregation.mockResolvedValueOnce([aggRow()] as never);

      const { leads } = await service.listLeadsForAggregation(BUSINESS_ID, SINCE, 1000, 500);

      // Zero would read as "this buyer has no money" to the price-band maths.
      expect(leads[0]!.budgetMinPaise).toBeNull();
      expect(leads[0]!.budgetMaxPaise).toBeNull();
    });

    it('flattens objections to text and drops the empty ones', async () => {
      repository.listForAggregation.mockResolvedValueOnce([
        aggRow({
          objections: [
            { text: 'too expensive', at: '2026-01-05T09:00:00Z' },
            { text: '', at: '2026-01-05T09:00:00Z' },
            { at: '2026-01-05T09:00:00Z' },
          ],
        }),
      ] as never);

      const { leads } = await service.listLeadsForAggregation(BUSINESS_ID, SINCE, 1000, 500);

      expect(leads[0]!.objections).toEqual(['too expensive']);
    });

    it('normalises a non-array objections column to an empty list', async () => {
      repository.listForAggregation.mockResolvedValueOnce([
        aggRow({ objections: null, localities: null, config: null, last_activity_at: null }),
      ] as never);

      const { leads } = await service.listLeadsForAggregation(BUSINESS_ID, SINCE, 1000, 500);

      expect(leads[0]!.objections).toEqual([]);
      expect(leads[0]!.localities).toEqual([]);
      expect(leads[0]!.config).toBeNull();
      expect(leads[0]!.lastActivityAt).toBeNull();
    });

    it('returns nothing for a tenant with no leads in the window', async () => {
      repository.listForAggregation.mockResolvedValueOnce([] as never);

      await expect(
        service.listLeadsForAggregation(BUSINESS_ID, SINCE, 1000, 500),
      ).resolves.toEqual({ leads: [], truncated: false });
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
          stage: 'NEW',
          qual_score: (data as { qualScore?: number }).qualScore ?? 0,
        }) as never,
      );
      repository.transitionStage.mockResolvedValue(
        makeLead({ stage: LeadStage.QUALIFIED }) as never,
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
      // stage change goes through CAS, not the unconditional update
      expect(repository.transitionStage).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        'NEW',
        LeadStage.QUALIFIED,
        expect.objectContaining({ lastActivityAt: expect.any(Date) }),
      );
    });

    it.each([
      ['DORMANT', true], // a parked buyer who comes back with a full profile is active again
      ['CLOSED_LOST', false], // a lost deal never silently reopens on a BLTC fill
      ['CLOSED_WON', false],
      ['NEGOTIATING', false], // already past QUALIFIED
    ])('auto-qualify from %s → %s', async (stage, expectQualify) => {
      repository.findById.mockResolvedValue(makeLead({ stage }) as never);
      repository.update.mockResolvedValue(makeLead({ stage }) as never);
      if (expectQualify) {
        repository.transitionStage.mockResolvedValue(
          makeLead({ stage: LeadStage.QUALIFIED }) as never,
        );
      }

      const result = await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, {
        budgetMinPaise: 900000000,
        budgetMaxPaise: 950000000,
        localities: ['Baner'],
        timelineMonths: 6,
        config: '2BHK',
        engagementTurns: 5,
      });

      expect(result.qualified).toBe(expectQualify);
      if (expectQualify) {
        expect(repository.transitionStage).toHaveBeenCalledWith(
          BUSINESS_ID, LEAD_ID, stage, LeadStage.QUALIFIED,
          expect.objectContaining({ lastActivityAt: expect.any(Date) }),
        );
      } else {
        expect(repository.transitionStage).not.toHaveBeenCalled();
      }
      const stageEvents = eventEmitter.emit.mock.calls.filter(
        ([name]) => name === 'realty.lead.stage_changed' || name === 'realty.lead.qualified',
      );
      expect(stageEvents).toHaveLength(expectQualify ? 2 : 0);
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
    it('compare-and-sets from the observed stage, records the note, emits stage_changed', async () => {
      repository.findById.mockResolvedValue(makeLead({ stage: 'QUALIFIED' }) as never);
      repository.transitionStage.mockResolvedValue(makeLead({ stage: 'VISIT_BOOKED' }) as never);

      await service.transitionStage(BUSINESS_ID, LEAD_ID, {
        stage: LeadStage.VISIT_BOOKED,
        note: 'booked on the phone',
      });

      expect(repository.transitionStage).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        'QUALIFIED',
        'VISIT_BOOKED',
        expect.objectContaining({
          lastActivityAt: expect.any(Date),
          metadata: expect.objectContaining({
            stageHistory: [
              expect.objectContaining({
                from: 'QUALIFIED',
                to: 'VISIT_BOOKED',
                actor: 'operator',
                note: 'booked on the phone',
              }),
            ],
          }),
        }),
      );
      expect(repository.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead.stage_changed',
        expect.objectContaining({
          fromStage: 'QUALIFIED',
          toStage: 'VISIT_BOOKED',
          note: 'booked on the phone',
        }),
      );
    });

    it('is a no-op when the stage is unchanged', async () => {
      repository.findById.mockResolvedValue(makeLead({ stage: 'NEW' }) as never);
      await service.transitionStage(BUSINESS_ID, LEAD_ID, { stage: LeadStage.NEW });
      expect(repository.transitionStage).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('lets an operator reopen a closed lead (terminal stages bind only system advances)', async () => {
      repository.findById.mockResolvedValue(makeLead({ stage: 'CLOSED_LOST' }) as never);
      repository.transitionStage.mockResolvedValue(makeLead({ stage: 'NEGOTIATING' }) as never);

      const res = await service.transitionStage(BUSINESS_ID, LEAD_ID, { stage: LeadStage.NEGOTIATING });

      expect(res.stage).toBe('NEGOTIATING');
      expect(repository.transitionStage).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        'CLOSED_LOST',
        'NEGOTIATING',
        expect.anything(),
      );
    });

    it('appends to an existing stageHistory and caps it at 50 entries', async () => {
      const history = Array.from({ length: 50 }, (_, i) => ({
        from: 'NEW',
        to: 'CONTACTED',
        at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
        actor: 'system',
      }));
      repository.findById.mockResolvedValue(
        makeLead({ stage: 'CONTACTED', metadata: { engagementTurns: 3, stageHistory: history } }) as never,
      );
      repository.transitionStage.mockResolvedValue(makeLead({ stage: 'QUALIFIED' }) as never);

      await service.transitionStage(BUSINESS_ID, LEAD_ID, { stage: LeadStage.QUALIFIED });

      const metadata = repository.transitionStage.mock.calls[0]![4]!.metadata as {
        engagementTurns: number;
        stageHistory: Array<{ to: string }>;
      };
      expect(metadata.engagementTurns).toBe(3); // sibling keys survive the merge
      expect(metadata.stageHistory).toHaveLength(50);
      expect(metadata.stageHistory[49]!.to).toBe('QUALIFIED');
    });

    it('throws 409 when the row moved between the read and the write, and emits nothing', async () => {
      repository.findById.mockResolvedValue(makeLead({ stage: 'QUALIFIED' }) as never);
      repository.transitionStage.mockResolvedValue(null);

      await expect(
        service.transitionStage(BUSINESS_ID, LEAD_ID, { stage: LeadStage.CLOSED_LOST }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('advanceStage (system-driven, forward-only)', () => {
    it('advances a lead forward along the pipeline and tags the history entry as system', async () => {
      repository.findById.mockResolvedValue(makeLead({ stage: 'QUALIFIED' }) as never);
      repository.transitionStage.mockResolvedValue(makeLead({ stage: 'VISIT_BOOKED' }) as never);

      const res = await service.advanceStage(BUSINESS_ID, LEAD_ID, LeadStage.VISIT_BOOKED);

      expect(res.stage).toBe('VISIT_BOOKED');
      expect(repository.transitionStage).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        'QUALIFIED',
        'VISIT_BOOKED',
        expect.objectContaining({
          metadata: expect.objectContaining({
            stageHistory: [expect.objectContaining({ actor: 'system', to: 'VISIT_BOOKED' })],
          }),
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead.stage_changed',
        expect.objectContaining({ fromStage: 'QUALIFIED', toStage: 'VISIT_BOOKED' }),
      );
    });

    it.each([
      ['NEGOTIATING', LeadStage.VISIT_BOOKED], // second visit for a lead already negotiating
      ['VISITED', LeadStage.VISIT_BOOKED], // re-booking after a visit
      ['CLOSED_WON', LeadStage.VISITED], // late completion of a visit on a won deal
      ['CLOSED_WON', LeadStage.NEGOTIATING], // Razorpay webhook replay after close
      ['CLOSED_LOST', LeadStage.VISIT_BOOKED], // visit booked on a lost lead
    ])('never regresses %s to %s — returns the lead untouched and emits nothing', async (from, to) => {
      repository.findById.mockResolvedValue(makeLead({ stage: from }) as never);

      const res = await service.advanceStage(BUSINESS_ID, LEAD_ID, to);

      expect(res.stage).toBe(from);
      expect(repository.transitionStage).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('reactivates a DORMANT lead on a forward signal', async () => {
      repository.findById.mockResolvedValue(makeLead({ stage: 'DORMANT' }) as never);
      repository.transitionStage.mockResolvedValue(makeLead({ stage: 'VISIT_BOOKED' }) as never);

      const res = await service.advanceStage(BUSINESS_ID, LEAD_ID, LeadStage.VISIT_BOOKED);

      expect(res.stage).toBe('VISIT_BOOKED');
      expect(repository.transitionStage).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        'DORMANT',
        'VISIT_BOOKED',
        expect.anything(),
      );
    });

    it('re-reads after a lost race and re-evaluates against the winner', async () => {
      // First read: QUALIFIED → try VISIT_BOOKED; the CAS loses because an
      // operator closed the lead meanwhile. Second read sees CLOSED_LOST and
      // the advance is (correctly) suppressed instead of overwriting it.
      repository.findById
        .mockResolvedValueOnce(makeLead({ stage: 'QUALIFIED' }) as never)
        .mockResolvedValueOnce(makeLead({ stage: 'CLOSED_LOST' }) as never);
      repository.transitionStage.mockResolvedValueOnce(null);

      const res = await service.advanceStage(BUSINESS_ID, LEAD_ID, LeadStage.VISIT_BOOKED);

      expect(res.stage).toBe('CLOSED_LOST');
      expect(repository.transitionStage).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('gives up with 409 when the row keeps moving', async () => {
      repository.findById.mockResolvedValue(makeLead({ stage: 'QUALIFIED' }) as never);
      repository.transitionStage.mockResolvedValue(null);

      await expect(
        service.advanceStage(BUSINESS_ID, LEAD_ID, LeadStage.VISIT_BOOKED),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.transitionStage).toHaveBeenCalledTimes(2);
    });
  });

  describe('stage policy', () => {
    it('marks only CLOSED_WON / CLOSED_LOST as terminal', () => {
      const terminal = Object.values(LeadStage).filter((s) => isTerminalStage(s));
      expect(terminal.sort()).toEqual(['CLOSED_LOST', 'CLOSED_WON']);
    });

    it('allows every forward pipeline hop and refuses every backward or terminal-exit hop', () => {
      const pipeline = ['NEW', 'CONTACTED', 'QUALIFIED', 'VISIT_BOOKED', 'VISITED', 'NEGOTIATING'];
      for (let i = 0; i < pipeline.length; i++) {
        for (let j = 0; j < pipeline.length; j++) {
          expect(canAdvanceStage(pipeline[i]!, pipeline[j] as LeadStage)).toBe(j > i);
        }
      }
      for (const stage of pipeline) {
        expect(canAdvanceStage('CLOSED_WON', stage as LeadStage)).toBe(false);
        expect(canAdvanceStage('CLOSED_LOST', stage as LeadStage)).toBe(false);
        expect(canAdvanceStage('DORMANT', stage as LeadStage)).toBe(true);
      }
    });

    it('never lets a system advance close or park a lead', () => {
      for (const to of [LeadStage.CLOSED_WON, LeadStage.CLOSED_LOST, LeadStage.DORMANT]) {
        expect(canAdvanceStage('NEGOTIATING', to)).toBe(false);
        expect(canAdvanceStage('DORMANT', to)).toBe(false);
      }
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

    it('records who opted the buyer out on the consent log', async () => {
      repository.findById.mockResolvedValue(
        makeLead({ consent_log: [{ text: 'dpdpa_notice_sent', at: '2026-07-01T00:00:00Z' }] }) as never,
      );
      repository.update.mockResolvedValue(makeLead({ opt_out: true }) as never);

      await service.setOptOut(BUSINESS_ID, LEAD_ID, 'buyer_reply');

      const data = repository.update.mock.calls[0]![2] as { consentLog: Array<{ text: string }> };
      expect(data.consentLog.map((e) => e.text)).toEqual(['dpdpa_notice_sent', 'opted_out:buyer_reply']);
    });

    it('is idempotent — an already opted-out lead is returned untouched, no write, no event', async () => {
      repository.findById.mockResolvedValue(makeLead({ opt_out: true }) as never);

      const res = await service.setOptOut(BUSINESS_ID, LEAD_ID, 'buyer_reply');

      expect(res.optOut).toBe(true);
      expect(repository.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
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
      senderPhone: PHONE,
      clientId: 'client-1',
    };

    it('creates a lead for an unseen phone', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeLead() as never);

      await service.handleMessageReceived(event);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, whatsappPhone: PHONE, source: 'CTWA' }),
      );
    });

    it('only touches an existing lead (no duplicate create)', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(makeLead() as never);
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
      repository.findByPhoneIncludingDeleted.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeLead() as never);

      const result = await service.ensureLeadByPhone(BUSINESS_ID, PHONE, {
        source: LeadSource.CTWA,
        conversationId: CONV_ID,
      });

      expect(repository.findByPhoneIncludingDeleted).toHaveBeenCalledWith(BUSINESS_ID, PHONE);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ whatsappPhone: PHONE, source: 'CTWA' }),
      );
      expect(result?.id).toBe(LEAD_ID);
    });

    it('touches an existing lead instead of creating a duplicate', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(makeLead() as never);
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
      expect(repository.findByPhoneIncludingDeleted).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('re-reads instead of failing when it loses a create race', async () => {
      // No lead on first look, but a concurrent capture wins the create.
      repository.findByPhoneIncludingDeleted
        .mockResolvedValueOnce(null) // ensureLeadByPhone's own lookup
        .mockResolvedValueOnce(null) // createLead's internal dedup lookup
        .mockResolvedValueOnce(makeLead() as never); // post-conflict re-read
      repository.create.mockRejectedValue(
        new ConflictException('A lead with phone already exists'),
      );
      repository.update.mockResolvedValue(makeLead() as never);

      const result = await service.ensureLeadByPhone(BUSINESS_ID, PHONE);

      expect(result?.id).toBe(LEAD_ID);
      // The recovered lead is touched like any other reuse — losing the race is
      // not a reason to drop this message's activity from the lead.
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.objectContaining({ lastActivityAt: expect.any(Date) }),
      );
    });
  });
});
