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

  beforeEach(async () => {
    const mockRepository: Partial<Record<keyof RealtyLeadsRepository, jest.Mock>> = {
      create: jest.fn(),
      findById: jest.fn().mockResolvedValue(makeLead()),
      findByPhone: jest.fn(),
      update: jest.fn().mockResolvedValue(makeLead()),
      softDelete: jest.fn().mockResolvedValue(undefined),
      list: jest.fn(),
      listForAggregation: jest.fn().mockResolvedValue([]),
      countByStage: jest.fn(),
    };
    tenant = { assertTeamMember: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyLeadsService,
        { provide: RealtyLeadsRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
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

  // ── ensureLeadByPhone: the losing side of a create race ───────────────────

  describe('ensureLeadByPhone', () => {
    it('rethrows the conflict when the re-read still finds nothing', async () => {
      repository.findByPhone
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
      repository.findByPhone
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(null as never);
      repository.create.mockRejectedValue(new Error('database is down'));

      await expect(service.ensureLeadByPhone(BUSINESS_ID, PHONE)).rejects.toThrow(
        'database is down',
      );
      // Only the two lookups that precede the create — no recovery re-read.
      expect(repository.findByPhone).toHaveBeenCalledTimes(2);
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
    } as unknown as MessageReceivedEvent;

    it('captures a lead for a phone the desk has not seen', async () => {
      repository.findByPhone.mockResolvedValue(null as never);
      repository.create.mockResolvedValue(makeLead() as never);

      await service.handleMessageReceived(event);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, whatsappPhone: PHONE }),
      );
    });

    it('swallows an ingest failure so the message pipeline keeps running', async () => {
      repository.findByPhone.mockRejectedValue(new Error('database is down'));

      // A lead we failed to capture is bad; a message we failed to *deliver*
      // because lead capture threw is worse — this listener must never
      // propagate.
      await expect(service.handleMessageReceived(event)).resolves.toBeUndefined();
    });

    it('ignores a message with no sender identifier', async () => {
      await service.handleMessageReceived({
        ...event,
        senderExternalId: '',
      } as unknown as MessageReceivedEvent);

      expect(repository.findByPhone).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    });
  });
});
