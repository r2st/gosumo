/**
 * RealtyLeadsRepository unit tests.
 *
 * The lead row is the widest partial update in the codebase — 30 optional
 * fields, several of which are booleans (`optOut`, `shareConsent`) or numbers
 * that are meaningful at zero (`qualScore`, `cadenceStep`). Each is guarded by
 * `!== undefined`; a truthiness check there would make "un-opt-out this lead"
 * or "reset the cadence to step 0" silently do nothing.
 *
 * PrismaService is mocked; assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { RealtyLeadsRepository } from './realty-leads.repository';
import type { LeadListFilters } from './realty-leads.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const LEAD_ID = '00000000-0000-4000-b000-000000000001';
const AGENT_ID = '00000000-0000-4000-c000-000000000001';

describe('RealtyLeadsRepository', () => {
  let repository: RealtyLeadsRepository;
  let prisma: {
    realty_leads: Record<
      'findFirst' | 'findMany' | 'count' | 'groupBy' | 'create' | 'update',
      jest.Mock
    >;
  };

  beforeEach(async () => {
    prisma = {
      realty_leads: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: LEAD_ID }),
        update: jest.fn().mockResolvedValue({ id: LEAD_ID }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RealtyLeadsRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(RealtyLeadsRepository);
  });

  describe('create', () => {
    it('defaults the optional identity columns and the language preference', async () => {
      await repository.create({
        businessId: BUSINESS_ID,
        whatsappPhone: '+919812345678',
        source: 'META_LEAD_AD',
      });

      expect(prisma.realty_leads.create.mock.calls[0]![0].data).toEqual({
        business_id: BUSINESS_ID,
        whatsapp_phone: '+919812345678',
        source: 'META_LEAD_AD',
        name: null,
        email: null,
        alt_phone: null,
        language_pref: 'hinglish',
        sub_source: null,
        listing_ref: null,
        assigned_agent_id: null,
        conversation_id: null,
        client_id: null,
        last_activity_at: expect.any(Date),
      });
    });

    it('carries the attribution and linkage columns through', async () => {
      await repository.create({
        businessId: BUSINESS_ID,
        whatsappPhone: '+919812345678',
        source: 'PORTAL',
        name: 'Asha',
        email: 'asha@example.invalid',
        altPhone: '+919876543210',
        languagePref: 'mr',
        subSource: '99ACRES',
        listingRef: 'LST-9',
        assignedAgentId: AGENT_ID,
        conversationId: 'conv_1',
        clientId: 'client_1',
      });

      expect(prisma.realty_leads.create.mock.calls[0]![0].data).toMatchObject({
        sub_source: '99ACRES',
        listing_ref: 'LST-9',
        language_pref: 'mr',
        assigned_agent_id: AGENT_ID,
      });
    });
  });

  it.each([
    ['findById', 'id', LEAD_ID],
    ['findByPhone', 'whatsapp_phone', '+919812345678'],
  ] as const)('%s scopes to the business and skips deleted rows', async (method, column, value) => {
    await repository[method](BUSINESS_ID, value);

    expect(prisma.realty_leads.findFirst.mock.calls[0]![0].where).toMatchObject({
      business_id: BUSINESS_ID,
      [column]: value,
      deleted_at: null,
    });
  });

  describe('update', () => {
    it('writes nothing for an empty patch', async () => {
      await repository.update(BUSINESS_ID, LEAD_ID, {});

      expect(prisma.realty_leads.update.mock.calls[0]![0]).toEqual({
        where: { id: LEAD_ID, business_id: BUSINESS_ID },
        data: {},
      });
    });

    it('maps every field onto its column', async () => {
      const money = new Prisma.Decimal(9500000);
      const when = new Date('2026-08-10T00:00:00Z');

      await repository.update(BUSINESS_ID, LEAD_ID, {
        name: 'Asha',
        email: 'asha@example.invalid',
        altPhone: '+919876543210',
        languagePref: 'hi',
        assignedAgentId: AGENT_ID,
        conversationId: 'conv_1',
        clientId: 'client_1',
        budgetMin: money,
        budgetMax: money,
        localities: ['Baner'],
        timelineMonths: 3,
        config: '3BHK',
        purpose: 'END_USE',
        financing: 'NEEDS_LOAN',
        qualScore: 72,
        temperature: 'HOT',
        stage: 'QUALIFIED',
        matchedUnitIds: ['unit_1'],
        extractedFacts: { budget: '95L' },
        objections: [{ kind: 'price' }],
        promises: [{ what: 'callback' }],
        optOut: true,
        consentLog: [{ at: '2026-08-10' }],
        shareConsent: true,
        exchangeStatus: 'SYNDICATED',
        cadenceId: 'cad_1',
        cadenceStep: 2,
        nextFollowupAt: when,
        lastActivityAt: when,
        metadata: { k: 'v' },
      });

      expect(prisma.realty_leads.update.mock.calls[0]![0].data).toMatchObject({
        name: 'Asha',
        alt_phone: '+919876543210',
        language_pref: 'hi',
        assigned_agent_id: AGENT_ID,
        conversation_id: 'conv_1',
        client_id: 'client_1',
        budget_min: money,
        budget_max: money,
        localities: ['Baner'],
        timeline_months: 3,
        config: '3BHK',
        purpose: 'END_USE',
        financing: 'NEEDS_LOAN',
        qual_score: 72,
        temperature: 'HOT',
        stage: 'QUALIFIED',
        matched_unit_ids: ['unit_1'],
        extracted_facts: { budget: '95L' },
        opt_out: true,
        share_consent: true,
        exchange_status: 'SYNDICATED',
        cadence_id: 'cad_1',
        cadence_step: 2,
        next_followup_at: when,
        last_activity_at: when,
        metadata: { k: 'v' },
      });
    });

    it('writes falsey values rather than skipping them', async () => {
      // `optOut: false` is "this lead may be contacted again" — dropping it
      // leaves the lead permanently suppressed.
      await repository.update(BUSINESS_ID, LEAD_ID, {
        optOut: false,
        shareConsent: false,
        qualScore: 0,
        cadenceStep: 0,
      });

      expect(prisma.realty_leads.update.mock.calls[0]![0].data).toEqual({
        opt_out: false,
        share_consent: false,
        qual_score: 0,
        cadence_step: 0,
      });
    });

    it('clears nullable columns when passed null', async () => {
      await repository.update(BUSINESS_ID, LEAD_ID, {
        assignedAgentId: null,
        cadenceId: null,
        nextFollowupAt: null,
        budgetMax: null,
      });

      expect(prisma.realty_leads.update.mock.calls[0]![0].data).toEqual({
        assigned_agent_id: null,
        cadence_id: null,
        next_followup_at: null,
        budget_max: null,
      });
    });
  });

  it('soft-deletes within the business scope', async () => {
    await repository.softDelete(BUSINESS_ID, LEAD_ID);

    expect(prisma.realty_leads.update.mock.calls[0]![0]).toEqual({
      where: { id: LEAD_ID, business_id: BUSINESS_ID },
      data: { deleted_at: expect.any(Date) },
    });
  });

  describe('list', () => {
    async function whereFor(filters: LeadListFilters) {
      await repository.list(BUSINESS_ID, filters);
      return prisma.realty_leads.findMany.mock.calls[0]![0].where;
    }

    it('applies no optional predicate when nothing is filtered', async () => {
      expect(await whereFor({})).toEqual({ business_id: BUSINESS_ID, deleted_at: null });
    });

    it('orders by score then recency, defaulting to page 1 / limit 20', async () => {
      prisma.realty_leads.count.mockResolvedValue(31);

      const result = await repository.list(BUSINESS_ID, {});

      expect(prisma.realty_leads.findMany.mock.calls[0]![0]).toMatchObject({
        orderBy: [{ qual_score: 'desc' }, { last_activity_at: 'desc' }],
        skip: 0,
        take: 20,
      });
      expect(result).toMatchObject({ page: 1, limit: 20, total: 31, totalPages: 2 });
    });

    it('turns page/limit into a skip', async () => {
      await repository.list(BUSINESS_ID, { page: 3, limit: 15 });

      expect(prisma.realty_leads.findMany.mock.calls[0]![0]).toMatchObject({
        skip: 30,
        take: 15,
      });
    });

    it('applies the pipeline filters', async () => {
      expect(
        await whereFor({
          stage: 'QUALIFIED',
          temperature: 'HOT',
          source: 'CTWA',
          assignedAgentId: AGENT_ID,
        }),
      ).toMatchObject({
        stage: 'QUALIFIED',
        temperature: 'HOT',
        source: 'CTWA',
        assigned_agent_id: AGENT_ID,
      });
    });

    it('searches name, phone and email', async () => {
      expect((await whereFor({ search: 'asha' })).OR).toEqual([
        { name: { contains: 'asha', mode: 'insensitive' } },
        { whatsapp_phone: { contains: 'asha', mode: 'insensitive' } },
        { email: { contains: 'asha', mode: 'insensitive' } },
      ]);
    });

    it('ignores an empty search string', async () => {
      expect(await whereFor({ search: '' })).not.toHaveProperty('OR');
    });

    it('counts with the same where as the page query', async () => {
      await repository.list(BUSINESS_ID, { stage: 'NEW' });

      expect(prisma.realty_leads.count.mock.calls[0]![0].where).toEqual(
        prisma.realty_leads.findMany.mock.calls[0]![0].where,
      );
    });
  });

  describe('countByStage', () => {
    it('flattens the grouping into a stage → count map', async () => {
      prisma.realty_leads.groupBy.mockResolvedValue([
        { stage: 'NEW', _count: { _all: 12 } },
        { stage: 'QUALIFIED', _count: { _all: 5 } },
      ]);

      await expect(repository.countByStage(BUSINESS_ID)).resolves.toEqual({
        NEW: 12,
        QUALIFIED: 5,
      });
    });

    it('returns an empty map for a business with no leads', async () => {
      await expect(repository.countByStage(BUSINESS_ID)).resolves.toEqual({});
    });

    it('counts live leads only', async () => {
      await repository.countByStage(BUSINESS_ID);

      expect(prisma.realty_leads.groupBy.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
    });
  });
});
