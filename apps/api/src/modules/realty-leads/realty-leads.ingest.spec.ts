/**
 * RealtyLeadsService — ingest and partial-update branch coverage.
 *
 * `realty-leads.spec.ts` covers the capture/BLTC/stage surface. Two methods it
 * does not reach carry most of this service's remaining branches, and both are
 * branch-dense for the same reason: they are written as long runs of
 * "fill this field only if it is missing / only if it was supplied".
 *
 *   - `ingestLead` is the cross-source identity merge. Every lead arriving from
 *     a portal, a CSV, an IVR missed call or a Meta lead form lands here, and
 *     the whole point of it is *not* creating a second row for a buyer we
 *     already know. The merge path fills blank identity fields without ever
 *     clobbering a known value, appends provenance, and leaves attribution
 *     alone — five independent conditionals whose interesting cases are the
 *     ones that *don't* fire.
 *
 *   - `updateLead` is the PATCH surface. Its conditionals are `!== undefined`,
 *     which is the difference between "the caller omitted this field" and "the
 *     caller explicitly cleared it". Getting that wrong silently erases data on
 *     every partial update, and the two cases are indistinguishable unless a
 *     test passes `null` on purpose.
 *
 * Repository and EventEmitter2 are mocked; no database is touched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LeadSource } from '@gosumo/shared';

import { RealtyLeadsService } from './realty-leads.service';
import { RealtyLeadsRepository } from './realty-leads.repository';
import { TenantService } from '../tenant/tenant.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const LEAD_ID = '00000000-0000-4000-a000-000000000010';
const OTHER_LEAD_ID = '00000000-0000-4000-a000-000000000011';
const AGENT_ID = '00000000-0000-4000-a000-000000000020';
const CONV_ID = '00000000-0000-4000-a000-000000000030';
const CLIENT_ID = '00000000-0000-4000-a000-000000000040';
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
    name: null,
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

describe('RealtyLeadsService — ingest and partial update', () => {
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyLeadsService,
        { provide: RealtyLeadsRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
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

  /** The update payload the service handed the repository, for assertions. */
  const updateArg = (call = 0) => repository.update.mock.calls[call]?.[2] as Record<string, unknown>;

  // ─────────────────────────────────────────────
  // ingestLead — the phone is the identity
  // ─────────────────────────────────────────────

  describe('ingestLead — phone normalization', () => {
    it('rejects a candidate whose phone cannot be normalized', async () => {
      // The E.164 phone is the join key across every source. A candidate
      // without one cannot be merged or deduped, so it is refused rather than
      // written as an orphan row nothing will ever match again.
      await expect(
        service.ingestLead(BUSINESS_ID, {
          whatsappPhone: 'not-a-number',
          source: LeadSource.PORTAL,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.findByPhone).not.toHaveBeenCalled();
    });

    it('normalizes a local 10-digit number before looking for a match', async () => {
      // A portal sends "9876543210", WhatsApp sends "+919876543210". Without
      // normalization on the lookup they are two different buyers.
      repository.findByPhone.mockResolvedValue(makeLead() as never);
      repository.update.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: '9876543210',
        source: LeadSource.PORTAL,
      });

      expect(repository.findByPhone).toHaveBeenCalledWith(BUSINESS_ID, PHONE);
    });
  });

  describe('ingestLead — merging into a known buyer', () => {
    it('updates rather than creates when the phone is already known', async () => {
      repository.findByPhone.mockResolvedValue(makeLead() as never);
      repository.update.mockResolvedValue(makeLead() as never);

      const result = await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.PORTAL,
      });

      expect(result).toEqual({ leadId: LEAD_ID, merged: true });
      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, expect.anything());
    });

    it('fills identity fields that are blank on the existing lead', async () => {
      repository.findByPhone.mockResolvedValue(makeLead() as never);
      repository.update.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.PORTAL,
        name: 'Rahul M',
        email: 'rahul@example.com',
        altPhone: '+919000000000',
        conversationId: CONV_ID,
        clientId: CLIENT_ID,
      });

      expect(updateArg()).toMatchObject({
        name: 'Rahul M',
        email: 'rahul@example.com',
        altPhone: '+919000000000',
        conversationId: CONV_ID,
        clientId: CLIENT_ID,
      });
    });

    it('never clobbers an identity field the lead already has', async () => {
      // The merge is additive by design: a portal enquiry that spells the name
      // differently must not overwrite what the buyer told us directly.
      repository.findByPhone.mockResolvedValue(
        makeLead({
          name: 'Rahul Mehta',
          email: 'known@example.com',
          alt_phone: '+919111111111',
          conversation_id: CONV_ID,
          client_id: CLIENT_ID,
        }) as never,
      );
      repository.update.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.PORTAL,
        name: 'R. M.',
        email: 'portal-alias@example.com',
        altPhone: '+919222222222',
        conversationId: OTHER_LEAD_ID,
        clientId: OTHER_LEAD_ID,
      });

      const data = updateArg();
      expect(data).not.toHaveProperty('name');
      expect(data).not.toHaveProperty('email');
      expect(data).not.toHaveProperty('altPhone');
      expect(data).not.toHaveProperty('conversationId');
      expect(data).not.toHaveProperty('clientId');
    });

    it('leaves blank fields alone when the candidate has nothing to offer', async () => {
      // The other half of each conditional: a candidate missing a field must
      // not write `undefined` over a column.
      repository.findByPhone.mockResolvedValue(makeLead() as never);
      repository.update.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.IVR,
      });

      const data = updateArg();
      expect(data).not.toHaveProperty('name');
      expect(data).not.toHaveProperty('email');
      expect(data).not.toHaveProperty('altPhone');
      expect(Object.keys(data)).toEqual(
        expect.arrayContaining(['lastActivityAt', 'metadata']),
      );
    });

    it('appends provenance to the existing ingest history', async () => {
      repository.findByPhone.mockResolvedValue(
        makeLead({
          metadata: {
            ingestHistory: [{ source: 'CTWA', at: '2026-07-01T10:00:00.000Z' }],
            somethingElse: 'preserved',
          },
        }) as never,
      );
      repository.update.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.PORTAL,
        subSource: '99acres',
        listingRef: 'LST-1',
      });

      const metadata = updateArg()['metadata'] as Record<string, unknown>;
      const history = metadata['ingestHistory'] as Record<string, unknown>[];
      expect(history).toHaveLength(2);
      expect(history[1]).toMatchObject({
        source: 'PORTAL',
        subSource: '99acres',
        listingRef: 'LST-1',
      });
      // Unrelated metadata keys survive the merge.
      expect(metadata['somethingElse']).toBe('preserved');
      expect(metadata['lastListingRef']).toBe('LST-1');
    });

    it('starts a fresh history when the stored metadata has none', async () => {
      // `readIngestHistory` has to cope with metadata that is `{}`, or holds a
      // non-array under `ingestHistory` — both are real states for rows written
      // before ingest provenance existed.
      repository.findByPhone.mockResolvedValue(
        makeLead({ metadata: { ingestHistory: 'not-an-array' } }) as never,
      );
      repository.update.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.CSV,
      });

      const metadata = updateArg()['metadata'] as Record<string, unknown>;
      expect(metadata['ingestHistory']).toHaveLength(1);
    });

    it('omits lastListingRef when the candidate carries no listing', async () => {
      repository.findByPhone.mockResolvedValue(makeLead() as never);
      repository.update.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.IVR,
      });

      expect(updateArg()['metadata']).not.toHaveProperty('lastListingRef');
    });

    it('carries the raw provider payload into the provenance entry', async () => {
      repository.findByPhone.mockResolvedValue(makeLead() as never);
      repository.update.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.META_LEAD_AD,
        raw: { form_id: 'f1', field_data: [] },
      });

      const metadata = updateArg()['metadata'] as Record<string, unknown>;
      const history = metadata['ingestHistory'] as Record<string, unknown>[];
      expect(history[0]).toMatchObject({ raw: { form_id: 'f1', field_data: [] } });
    });

    it('omits the raw key entirely when the candidate has no payload', async () => {
      repository.findByPhone.mockResolvedValue(makeLead() as never);
      repository.update.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.CSV,
      });

      const metadata = updateArg()['metadata'] as Record<string, unknown>;
      const history = metadata['ingestHistory'] as Record<string, unknown>[];
      expect(history[0]).not.toHaveProperty('raw');
    });
  });

  describe('ingestLead — capturing an unseen buyer', () => {
    it('creates the lead and reports merged: false', async () => {
      repository.findByPhone.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeLead() as never);

      const result = await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.PORTAL,
        subSource: 'magicbricks',
        listingRef: 'LST-9',
      });

      expect(result).toEqual({ leadId: LEAD_ID, merged: false });
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          whatsappPhone: PHONE,
          source: 'PORTAL',
          subSource: 'magicbricks',
          listingRef: 'LST-9',
        }),
      );
    });

    it('writes a first provenance entry only when a raw payload came with it', async () => {
      repository.findByPhone.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.META_LEAD_AD,
        raw: { leadgen_id: 'lg-1' },
      });

      const metadata = updateArg()['metadata'] as Record<string, unknown>;
      const history = metadata['ingestHistory'] as Record<string, unknown>[];
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ source: 'META_LEAD_AD', raw: { leadgen_id: 'lg-1' } });
    });

    it('skips the follow-up write when there is no raw payload to store', async () => {
      // A second round-trip per CSV row would be pure cost — the created row
      // already carries source/subSource/listingRef.
      repository.findByPhone.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.CSV,
      });

      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('ingestLead — the ingested event', () => {
    it('reports merged: true with the normalized phone', async () => {
      repository.findByPhone.mockResolvedValue(makeLead() as never);
      repository.update.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: '09876543210',
        source: LeadSource.PORTAL,
        subSource: '99acres',
        listingRef: 'LST-3',
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead.ingested',
        expect.objectContaining({
          type: 'realty.lead.ingested',
          businessId: BUSINESS_ID,
          leadId: LEAD_ID,
          source: 'PORTAL',
          subSource: '99acres',
          listingRef: 'LST-3',
          whatsappPhone: PHONE,
          merged: true,
        }),
      );
    });

    it('reports merged: false on a fresh capture', async () => {
      repository.findByPhone.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeLead() as never);

      await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: LeadSource.IVR,
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead.ingested',
        expect.objectContaining({ merged: false }),
      );
    });
  });

  // ─────────────────────────────────────────────
  // updateLead — omitted is not the same as cleared
  // ─────────────────────────────────────────────

  describe('updateLead', () => {
    beforeEach(() => {
      repository.findById.mockResolvedValue(makeLead() as never);
      repository.update.mockResolvedValue(makeLead({ name: 'Updated' }) as never);
    });

    it('404s before writing anything when the lead is not this tenant\'s', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.updateLead(BUSINESS_ID, LEAD_ID, { name: 'Rahul' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(repository.update).not.toHaveBeenCalled();
    });

    it('forwards only the fields the caller supplied', async () => {
      await service.updateLead(BUSINESS_ID, LEAD_ID, { name: 'Rahul M' });

      const data = updateArg();
      expect(data).toMatchObject({ name: 'Rahul M' });
      expect(data).not.toHaveProperty('email');
      expect(data).not.toHaveProperty('altPhone');
      expect(data).not.toHaveProperty('languagePref');
      expect(data).not.toHaveProperty('assignedAgentId');
    });

    it('treats an explicit null as a clear, not as an omission', async () => {
      // The conditionals are `!== undefined` precisely so this works. A
      // truthiness check here would make "unassign this lead" a silent no-op.
      await service.updateLead(BUSINESS_ID, LEAD_ID, {
        assignedAgentId: null as unknown as string,
        email: null as unknown as string,
      });

      const data = updateArg();
      expect(data).toHaveProperty('assignedAgentId', null);
      expect(data).toHaveProperty('email', null);
    });

    it('forwards every field when all are supplied', async () => {
      await service.updateLead(BUSINESS_ID, LEAD_ID, {
        name: 'Rahul M',
        email: 'rahul@example.com',
        altPhone: '+919000000000',
        languagePref: 'english',
        assignedAgentId: AGENT_ID,
      });

      expect(updateArg()).toMatchObject({
        name: 'Rahul M',
        email: 'rahul@example.com',
        altPhone: '+919000000000',
        languagePref: 'english',
        assignedAgentId: AGENT_ID,
      });
    });

    it('always touches lastActivityAt', async () => {
      await service.updateLead(BUSINESS_ID, LEAD_ID, {});
      expect(updateArg()['lastActivityAt']).toBeInstanceOf(Date);
    });

    it('scopes both the existence check and the write to the caller\'s tenant', async () => {
      await service.updateLead(BUSINESS_ID, LEAD_ID, { name: 'Rahul' });

      expect(repository.findById).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID);
      expect(repository.update).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, expect.anything());
    });
  });

  // ─────────────────────────────────────────────
  // findLeadByPhone — the cadence engine's stop-on-reply lookup
  // ─────────────────────────────────────────────

  describe('findLeadByPhone', () => {
    it('maps the lead when one exists', async () => {
      repository.findByPhone.mockResolvedValue(makeLead() as never);

      const result = await service.findLeadByPhone(BUSINESS_ID, PHONE);

      expect(result).toMatchObject({ id: LEAD_ID, whatsappPhone: PHONE });
    });

    it('returns null for an unseen phone rather than throwing', async () => {
      // The cadence engine calls this on every inbound message; an unknown
      // phone is the ordinary case, not an error.
      repository.findByPhone.mockResolvedValue(null);

      await expect(service.findLeadByPhone(BUSINESS_ID, PHONE)).resolves.toBeNull();
    });
  });
});
