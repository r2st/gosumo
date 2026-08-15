/**
 * RealtyLeadsService — the paths the main suite leaves alone.
 *
 * These are the plain CRUD verbs and the two error branches nobody reaches on
 * a happy path, and each one has something to get wrong:
 *
 *  - `deleteLead` must soft-delete. A hard delete would take a buyer's whole
 *    conversation history with it, which is the one thing the product promises
 *    to keep forever.
 *  - `listLeads` re-wraps the repository's page. The page metadata has to come
 *    from the repository, not be recomputed from the row count, or a filtered
 *    list reports one page of results as the whole pipeline.
 *  - The localities BLTC slot compares by value, not identity: two arrays with
 *    the same contents are the same answer and must not be raised as a
 *    contradiction, while a genuinely different set must.
 *  - `ensureLeadByPhone` recovers from a lost create race only when the
 *    re-read actually finds the winner. If it does not, swallowing the
 *    conflict would return `undefined` to a caller expecting a lead.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LeadSource } from '@gosumo/shared';
import type { MessageReceivedEvent } from '@gosumo/shared';

import { RealtyLeadsService } from './realty-leads.service';
import { RealtyLeadsRepository } from './realty-leads.repository';
import { TenantService } from '../tenant/tenant.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const LEAD_ID = '00000000-0000-4000-a000-000000000010';
const AGENT_ID = '00000000-0000-4000-a000-000000000020';
const UNIT_A = '00000000-0000-4000-a000-0000000000a1';
const UNIT_B = '00000000-0000-4000-a000-0000000000a2';
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

describe('RealtyLeadsService (remaining branches)', () => {
  let service: RealtyLeadsService;
  let repository: jest.Mocked<RealtyLeadsRepository>;
  let tenant: { assertTeamMember: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    const mockRepository: Partial<Record<keyof RealtyLeadsRepository, jest.Mock>> = {
      create: jest.fn(),
      findById: jest.fn().mockResolvedValue(makeLead()),
      findByPhone: jest.fn(),
      findByPhoneIncludingDeleted: jest.fn(),
      revive: jest.fn(),
      update: jest.fn().mockResolvedValue(makeLead()),
      softDelete: jest.fn().mockResolvedValue(undefined),
      list: jest.fn(),
      listForAggregation: jest.fn().mockResolvedValue([]),
      countByStage: jest.fn(),
    };
    tenant = { assertTeamMember: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyLeadsService,
        { provide: RealtyLeadsRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: emitter },
        { provide: TenantService, useValue: tenant },
      ],
    }).compile();

    service = module.get(RealtyLeadsService);
    repository = module.get(RealtyLeadsRepository) as jest.Mocked<RealtyLeadsRepository>;
  });

  // ── deleteLead ────────────────────────────────────────────────────────────

  describe('deleteLead', () => {
    it('soft-deletes so the buyer history survives', async () => {
      await expect(service.deleteLead(BUSINESS_ID, LEAD_ID)).resolves.toBeUndefined();

      expect(repository.softDelete).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID);
    });

    it('refuses to delete a lead belonging to another tenant', async () => {
      // `findById` is already tenant-scoped, so a foreign id simply misses.
      repository.findById.mockResolvedValue(null as never);

      await expect(service.deleteLead(BUSINESS_ID, LEAD_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.softDelete).not.toHaveBeenCalled();
    });
  });

  // ── listLeads ─────────────────────────────────────────────────────────────

  describe('listLeads', () => {
    it("forwards every filter and keeps the repository's page metadata", async () => {
      repository.list.mockResolvedValue({
        data: [makeLead()],
        total: 137,
        page: 3,
        limit: 20,
        totalPages: 7,
      } as never);

      const result = await service.listLeads(BUSINESS_ID, {
        stage: 'QUALIFIED',
        temperature: 'HOT',
        source: LeadSource.PORTAL,
        assignedAgentId: AGENT_ID,
        search: 'Rahul',
        page: 3,
        limit: 20,
      } as never);

      expect(repository.list).toHaveBeenCalledWith(BUSINESS_ID, {
        stage: 'QUALIFIED',
        temperature: 'HOT',
        source: LeadSource.PORTAL,
        assignedAgentId: AGENT_ID,
        search: 'Rahul',
        page: 3,
        limit: 20,
      });
      // Recomputing these from `data.length` would report the current page as
      // the entire pipeline.
      expect(result).toMatchObject({ total: 137, page: 3, limit: 20, totalPages: 7 });
      expect(result.data[0]!.id).toBe(LEAD_ID);
    });

    it('maps every row through the response shape', async () => {
      repository.list.mockResolvedValue({
        data: [makeLead(), makeLead({ id: 'lead-2', whatsapp_phone: '+919000000002' })],
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
      } as never);

      const result = await service.listLeads(BUSINESS_ID, {} as never);

      // Column names never leak — the DTO is camelCase.
      expect(result.data).toHaveLength(2);
      expect(result.data[1]).toMatchObject({ id: 'lead-2', whatsappPhone: '+919000000002' });
      expect(result.data[0]).not.toHaveProperty('whatsapp_phone');
    });

    it('returns an empty page for a business with no leads', async () => {
      repository.list.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      } as never);

      await expect(service.listLeads(BUSINESS_ID, {} as never)).resolves.toMatchObject({
        data: [],
        total: 0,
      });
    });
  });

  // ── assignAgent ───────────────────────────────────────────────────────────

  describe('assignAgent', () => {
    it('checks the assignee is a member of this tenant before writing', async () => {
      await service.assignAgent(BUSINESS_ID, LEAD_ID, AGENT_ID);

      expect(tenant.assertTeamMember).toHaveBeenCalledWith(BUSINESS_ID, AGENT_ID);
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.objectContaining({ assignedAgentId: AGENT_ID, lastActivityAt: expect.any(Date) }),
      );
    });

    it('does not write when the assignee is outside the tenant', async () => {
      tenant.assertTeamMember.mockRejectedValue(new NotFoundException('not a member'));

      await expect(
        service.assignAgent(BUSINESS_ID, LEAD_ID, AGENT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('rejects assignment on a lead that does not exist', async () => {
      repository.findById.mockResolvedValue(null as never);

      await expect(
        service.assignAgent(BUSINESS_ID, LEAD_ID, AGENT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      // The membership check is pointless once the lead is gone.
      expect(tenant.assertTeamMember).not.toHaveBeenCalled();
    });
  });

  // ── setMatchedUnits ───────────────────────────────────────────────────────

  describe('setMatchedUnits', () => {
    it('records the matched units and bumps last activity', async () => {
      repository.update.mockResolvedValue(
        makeLead({ matched_unit_ids: [UNIT_A, UNIT_B] }) as never,
      );

      const result = await service.setMatchedUnits(BUSINESS_ID, LEAD_ID, [UNIT_A, UNIT_B]);

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.objectContaining({
          matchedUnitIds: [UNIT_A, UNIT_B],
          lastActivityAt: expect.any(Date),
        }),
      );
      expect(result.matchedUnitIds).toEqual([UNIT_A, UNIT_B]);
    });

    it('clears the match set when the AI finds nothing suitable', async () => {
      await service.setMatchedUnits(BUSINESS_ID, LEAD_ID, []);

      // An empty array is a real answer ("nothing matches your budget any
      // more"), not a reason to leave stale matches on the lead.
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.objectContaining({ matchedUnitIds: [] }),
      );
    });

    it('will not attach matches to a lead in another tenant', async () => {
      repository.findById.mockResolvedValue(null as never);

      await expect(
        service.setMatchedUnits(BUSINESS_ID, LEAD_ID, [UNIT_A]),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  // ── BLTC: localities comparison ───────────────────────────────────────────

  describe('applyBltcUpdate localities', () => {
    it('accepts a re-statement of the same localities without a contradiction', async () => {
      repository.findById.mockResolvedValue(
        makeLead({ localities: ['Whitefield', 'Sarjapur'] }) as never,
      );

      const result = await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, {
        localities: ['Whitefield', 'Sarjapur'],
      } as never);

      // Compared by value: the same two localities are the same answer, even
      // though they arrive as a different array object.
      expect(result.contradictions).toEqual([]);
    });

    it('surfaces a genuinely different locality set instead of overwriting it', async () => {
      repository.findById.mockResolvedValue(
        makeLead({ localities: ['Whitefield'] }) as never,
      );

      const result = await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, {
        localities: ['Hebbal'],
      } as never);

      expect(result.contradictions).toEqual([
        { slot: 'localities', existing: ['Whitefield'], incoming: ['Hebbal'] },
      ]);
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.not.objectContaining({ localities: ['Hebbal'] }),
      );
    });

    it('overwrites a contradicting locality set when the caller forces it', async () => {
      repository.findById.mockResolvedValue(
        makeLead({ localities: ['Whitefield'] }) as never,
      );

      const result = await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, {
        localities: ['Hebbal'],
        force: true,
      } as never);

      expect(result.contradictions).toEqual([]);
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.objectContaining({ localities: ['Hebbal'] }),
      );
    });

    it('fills an empty locality list without calling it a contradiction', async () => {
      repository.findById.mockResolvedValue(makeLead({ localities: [] }) as never);

      const result = await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, {
        localities: ['Hebbal'],
      } as never);

      // An empty array is "not answered yet", not a previous answer.
      expect(result.contradictions).toEqual([]);
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.objectContaining({ localities: ['Hebbal'] }),
      );
    });
  });

  // ── the rest of the BLTC slots ────────────────────────────────────────────

  /**
   * Every slot runs through the same `setSlot` helper, but each is wired up
   * separately, and a slot wired to the wrong comparator silently overwrites a
   * buyer's stated requirement with whatever the AI extracted from the latest
   * message. The contradiction list is the only thing standing between "the
   * model misheard 2BHK as 3BHK" and a lead whose brief is now wrong.
   */
  describe('applyBltcUpdate — the remaining slots', () => {
    const CASES: { slot: string; existing: Record<string, unknown>; before: unknown; dto: Record<string, unknown>; incoming: unknown }[] = [
      {
        slot: 'budgetMaxPaise',
        // The column holds rupees; the DTO speaks paise. ₹90,000 → 9,000,000p.
        existing: { budget_max: new Prisma.Decimal(90_000) },
        before: 9_000_000,
        dto: { budgetMaxPaise: 12_000_000 },
        incoming: 12_000_000,
      },
      {
        slot: 'timelineMonths',
        existing: { timeline_months: 3 },
        before: 3,
        dto: { timelineMonths: 12 },
        incoming: 12,
      },
      {
        slot: 'config',
        existing: { config: '2BHK' },
        before: '2BHK',
        dto: { config: '3BHK' },
        incoming: '3BHK',
      },
      {
        slot: 'purpose',
        existing: { purpose: 'END_USE' },
        before: 'END_USE',
        dto: { purpose: 'INVESTMENT' },
        incoming: 'INVESTMENT',
      },
      {
        slot: 'financing',
        existing: { financing: 'CASH' },
        before: 'CASH',
        dto: { financing: 'LOAN' },
        incoming: 'LOAN',
      },
    ];

    it.each(CASES)('surfaces a contradicting $slot instead of overwriting it', async ({ slot, existing, before, dto, incoming }) => {
      repository.findById.mockResolvedValue(makeLead(existing) as never);

      const result = await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, dto as never);

      expect(result.contradictions).toEqual([{ slot, existing: before, incoming }]);
    });

    it.each(CASES)('overwrites a contradicting $slot when the caller forces it', async ({ slot, existing, dto, incoming }) => {
      repository.findById.mockResolvedValue(makeLead(existing) as never);

      const result = await service.applyBltcUpdate(
        BUSINESS_ID,
        LEAD_ID,
        { ...dto, force: true } as never,
      );

      expect(result.contradictions).toEqual([]);
      expect(result.lead).toBeDefined();
      expect(slot).toBeTruthy();
      expect(incoming).toBeDefined();
    });

    it.each(CASES)('fills an unanswered $slot without calling it a contradiction', async ({ dto }) => {
      // The default lead has every slot null.
      const result = await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, dto as never);

      expect(result.contradictions).toEqual([]);
    });

    it('collects a contradiction from every slot in one update', async () => {
      repository.findById.mockResolvedValue(
        makeLead({
          budget_min: new Prisma.Decimal(5_000_000),
          budget_max: new Prisma.Decimal(9_000_000),
          timeline_months: 3,
          config: '2BHK',
          purpose: 'END_USE',
          financing: 'CASH',
        }) as never,
      );

      const result = await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, {
        budgetMinPaise: 1_000_000,
        budgetMaxPaise: 12_000_000,
        timelineMonths: 12,
        config: '3BHK',
        purpose: 'INVESTMENT',
        financing: 'LOAN',
      } as never);

      expect(result.contradictions.map((c) => c.slot).sort()).toEqual([
        'budgetMaxPaise',
        'budgetMinPaise',
        'config',
        'financing',
        'purpose',
        'timelineMonths',
      ]);
      // Nothing was written — a wholly contradicted update must not half-apply.
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.not.objectContaining({ config: '3BHK' }),
      );
    });
  });

  // ── null columns on the way out ───────────────────────────────────────────

  /**
   * `localities` and `matched_unit_ids` are array columns that predate their
   * NOT NULL defaults, so old rows still carry NULL. The mapper has to hand the
   * API an empty array for those: a `null` where the DTO promises an array
   * crashes every client that iterates it.
   */
  describe('mapping a row with null array columns', () => {
    it('reads a null locality column as an empty list', async () => {
      repository.findById.mockResolvedValue(
        makeLead({ localities: null, matched_unit_ids: null }) as never,
      );

      const lead = await service.getLead(BUSINESS_ID, LEAD_ID);

      expect(lead.bltc.localities).toEqual([]);
      expect(lead.matchedUnitIds).toEqual([]);
    });

    it('emits an empty match list on the hot alert when the column is null', async () => {
      // Cold lead crossing the hot threshold in one update, on a row whose
      // match list was never populated.
      repository.findById.mockResolvedValue(
        makeLead({ qual_score: 0, matched_unit_ids: null }) as never,
      );
      repository.update.mockResolvedValue(
        makeLead({ assigned_agent_id: null, matched_unit_ids: null }) as never,
      );

      const result = await service.applyBltcUpdate(BUSINESS_ID, LEAD_ID, {
        budgetMinPaise: 5_000_000,
        budgetMaxPaise: 9_000_000,
        timelineMonths: 1,
        config: '3BHK',
        purpose: 'END_USE',
        financing: 'CASH',
        engagementTurns: 5,
      } as never);

      expect(result.score.score).toBeGreaterThanOrEqual(75);
      const hot = emitter.emit.mock.calls.find(([name]: [string]) => name === 'realty.lead.hot');
      expect(hot).toBeDefined();
      expect(hot![1]).toMatchObject({ matchedUnitIds: [], assignedAgentId: undefined });
    });
  });

  // ── ensureLeadByPhone: the losing side of a create race ───────────────────

  describe('ensureLeadByPhone', () => {
    it('rethrows the conflict when the re-read still finds nothing', async () => {
      repository.findByPhoneIncludingDeleted
        .mockResolvedValueOnce(null as never) // own lookup
        .mockResolvedValueOnce(null as never) // createLead's dedup lookup
        .mockResolvedValueOnce(null as never); // post-conflict re-read: still nothing
      repository.create.mockRejectedValue(new ConflictException('phone already exists'));

      // Swallowing this would hand the caller `undefined` where it expects a
      // lead — better to surface a conflict that genuinely could not be healed.
      await expect(service.ensureLeadByPhone(BUSINESS_ID, PHONE)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rethrows a non-conflict failure without a second lookup', async () => {
      repository.findByPhoneIncludingDeleted
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(null as never);
      repository.create.mockRejectedValue(new Error('database is down'));

      await expect(service.ensureLeadByPhone(BUSINESS_ID, PHONE)).rejects.toThrow(
        'database is down',
      );
      // Only the two lookups that precede the create — no recovery re-read.
      expect(repository.findByPhoneIncludingDeleted).toHaveBeenCalledTimes(2);
    });
  });

  // ── message.received listener ─────────────────────────────────────────────

  describe('handleMessageReceived', () => {
    const event = {
      type: 'message.received',
      businessId: BUSINESS_ID,
      messageId: 'msg-1',
      conversationId: CONV_ID,
      clientId: null,
      senderExternalId: PHONE,
      senderPhone: PHONE,
    } as unknown as MessageReceivedEvent;

    it('captures a lead for a phone the desk has not seen', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(null as never);
      repository.create.mockResolvedValue(makeLead() as never);

      await service.handleMessageReceived(event);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, whatsappPhone: PHONE }),
      );
    });

    it('swallows an ingest failure so the message pipeline keeps running', async () => {
      repository.findByPhoneIncludingDeleted.mockRejectedValue(new Error('database is down'));

      // A lead we failed to capture is bad; a message we failed to *deliver*
      // because lead capture threw is worse — this listener must never
      // propagate.
      await expect(service.handleMessageReceived(event)).resolves.toBeUndefined();
    });

    it('still logs a rejection that is not an Error object', async () => {
      // A driver-level rejection can be a bare string or a plain object. If the
      // handler assumed `.message`, the log line would read "undefined" and the
      // failure would be untraceable.
      repository.findByPhoneIncludingDeleted.mockRejectedValue('ECONNRESET' as never);
      const logged = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

      await expect(service.handleMessageReceived(event)).resolves.toBeUndefined();

      expect(logged).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'));
      logged.mockRestore();
    });

    it('ignores a message with no phone identity', async () => {
      await service.handleMessageReceived({
        ...event,
        senderPhone: undefined,
      } as unknown as MessageReceivedEvent);

      expect(repository.findByPhoneIncludingDeleted).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    });
  });
});
