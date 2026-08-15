/**
 * Lead phone identity — the tombstone and the lost create race.
 *
 * `uq_realty_leads_business_phone` covers `(business_id, whatsapp_phone)` with
 * no `WHERE deleted_at IS NULL` predicate. Two consequences follow, and both
 * were live bugs:
 *
 *  1. **A soft-deleted lead keeps its phone number forever.** Every read filters
 *     `deleted_at: null`, so identity resolution reported the number free while
 *     Postgres still refused the insert. Nothing in the module cleared the
 *     tombstone, so the buyer was never capturable again — the message arrived,
 *     the create failed, and the error was swallowed by the listener.
 *
 *  2. **The documented race recovery never ran.** `createLead` raised
 *     `ConflictException` only from its own pre-check; a genuine concurrent
 *     insert surfaced as a raw Prisma P2002, which `instanceof ConflictException`
 *     does not match. The recovery branch was unreachable, and the API answered
 *     a duplicate phone with a 500.
 *
 * These tests pin both behaviours at the seam where they broke.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LeadSource } from '@gosumo/shared';
import type { MessageReceivedEvent } from '@gosumo/shared';

import { RealtyLeadsService } from './realty-leads.service';
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

/** A tombstone: the row still exists, and still owns the phone number. */
const deletedLead = () => makeLead({ deleted_at: new Date('2026-07-10T09:00:00Z') });

/** A P2002 exactly as Prisma reports the phone constraint failing. */
function phoneUniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.0.0',
    meta: { target: ['business_id', 'whatsapp_phone'] },
  });
}

describe('RealtyLeadsService — phone identity', () => {
  let service: RealtyLeadsService;
  let repository: jest.Mocked<RealtyLeadsRepository>;

  beforeEach(async () => {
    const mockRepository: Partial<Record<keyof RealtyLeadsRepository, jest.Mock>> = {
      create: jest.fn(),
      findById: jest.fn(),
      findByPhone: jest.fn(),
      findByPhoneIncludingDeleted: jest.fn(),
      revive: jest.fn(),
      update: jest.fn().mockResolvedValue(makeLead()),
      softDelete: jest.fn(),
      list: jest.fn(),
      listForAggregation: jest.fn().mockResolvedValue([]),
      countByStage: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyLeadsService,
        { provide: RealtyLeadsRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: TenantService,
          useValue: { assertTeamMember: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(RealtyLeadsService);
    repository = module.get(RealtyLeadsRepository);
  });

  // ── The tombstone ────────────────────────────────────────────────────────

  describe('a soft-deleted lead still owns its phone number', () => {
    it('resolves identity against deleted rows, not just live ones', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(null as never);
      repository.create.mockResolvedValue(makeLead() as never);

      await service.ensureLeadByPhone(BUSINESS_ID, PHONE, { conversationId: CONV_ID });

      // The lookup that decides whether to insert must be the one that can see
      // tombstones. `findByPhone` filters them out, so using it here is what
      // let the module walk into a constraint it had just been told was clear.
      expect(repository.findByPhoneIncludingDeleted).toHaveBeenCalledWith(BUSINESS_ID, PHONE);
      expect(repository.findByPhone).not.toHaveBeenCalled();
    });

    it('revives the tombstone instead of failing the capture forever', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(deletedLead() as never);
      repository.revive.mockResolvedValue(makeLead() as never);

      const result = await service.ensureLeadByPhone(BUSINESS_ID, PHONE, {
        conversationId: CONV_ID,
      });

      expect(repository.revive).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID);
      // Never a second insert — that is the one thing the constraint forbids.
      expect(repository.create).not.toHaveBeenCalled();
      expect(result?.id).toBe(LEAD_ID);
    });

    it('leaves a live lead alone rather than "reviving" it', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(makeLead() as never);

      await service.ensureLeadByPhone(BUSINESS_ID, PHONE, { conversationId: CONV_ID });

      expect(repository.revive).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('captures a buyer whose lead was deleted, end to end via message.received', async () => {
      // The regression in full: delete a lead, the buyer messages again, and
      // before this fix nothing could ever record them.
      repository.findByPhoneIncludingDeleted.mockResolvedValue(deletedLead() as never);
      repository.revive.mockResolvedValue(makeLead() as never);

      await service.handleMessageReceived({
        type: 'message.received',
        businessId: BUSINESS_ID,
        messageId: 'msg-1',
        conversationId: CONV_ID,
        clientId: null,
        senderExternalId: PHONE,
        senderPhone: PHONE,
      } as unknown as MessageReceivedEvent);

      expect(repository.revive).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID);
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.objectContaining({ conversationId: CONV_ID }),
      );
    });

    it('tells the operator the phone is held by a deleted lead, not a 500', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(deletedLead() as never);

      const err = await service
        .createLead(BUSINESS_ID, { whatsappPhone: PHONE, source: LeadSource.PORTAL })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).message).toContain('deleted lead');
      expect((err as ConflictException).message).toContain(LEAD_ID);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('merges an ingest into a revived lead rather than losing it', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(deletedLead() as never);
      repository.revive.mockResolvedValue(makeLead() as never);

      const result = await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: 'PORTAL',
        name: 'Rahul M',
      } as never);

      expect(result.merged).toBe(true);
      expect(result.leadId).toBe(LEAD_ID);
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  // ── The lost create race ─────────────────────────────────────────────────

  describe('losing the insert to a concurrent capture', () => {
    it('reports a P2002 on the phone as a conflict, not a raw driver error', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(null as never);
      repository.create.mockRejectedValue(phoneUniqueViolation());

      await expect(
        service.createLead(BUSINESS_ID, { whatsappPhone: PHONE, source: LeadSource.CTWA }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not disguise a P2002 on some other constraint as a duplicate phone', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(null as never);
      const elsewhere = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['business_id', 'email'] },
      });
      repository.create.mockRejectedValue(elsewhere);

      // Reporting this as "duplicate phone" would send whoever debugs it to the
      // wrong column entirely.
      await expect(
        service.createLead(BUSINESS_ID, { whatsappPhone: PHONE, source: LeadSource.CTWA }),
      ).rejects.not.toBeInstanceOf(ConflictException);
    });

    it('recovers a raw P2002 from the create, which the old guard could not match', async () => {
      repository.findByPhoneIncludingDeleted
        .mockResolvedValueOnce(null as never) // own claim: free
        .mockResolvedValueOnce(null as never) // createLead's pre-check: still free
        .mockResolvedValueOnce(makeLead() as never); // post-conflict: the winner
      repository.create.mockRejectedValue(phoneUniqueViolation());

      const result = await service.ensureLeadByPhone(BUSINESS_ID, PHONE, {
        conversationId: CONV_ID,
      });

      expect(result?.id).toBe(LEAD_ID);
    });

    it('merges the ingest into the winner instead of dropping its provenance', async () => {
      repository.findByPhoneIncludingDeleted
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(makeLead() as never);
      repository.create.mockRejectedValue(phoneUniqueViolation());

      const result = await service.ingestLead(BUSINESS_ID, {
        whatsappPhone: PHONE,
        source: 'META_LEADGEN',
        listingRef: 'LST-9',
      } as never);

      expect(result).toEqual({ leadId: LEAD_ID, merged: true });
      // The provenance the ingest carried is written onto the winning lead.
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        expect.objectContaining({
          metadata: expect.objectContaining({ lastListingRef: 'LST-9' }),
        }),
      );
    });

    it('still surfaces a conflict that genuinely cannot be healed', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(null as never);
      repository.create.mockRejectedValue(phoneUniqueViolation());

      // Nothing to re-claim means the violation was not this phone after all.
      // Returning a lead that is not there would be worse than the error.
      await expect(service.ensureLeadByPhone(BUSINESS_ID, PHONE)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rethrows a non-constraint failure without a recovery re-read', async () => {
      repository.findByPhoneIncludingDeleted
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(null as never);
      repository.create.mockRejectedValue(new Error('database is down'));

      await expect(service.ensureLeadByPhone(BUSINESS_ID, PHONE)).rejects.toThrow(
        'database is down',
      );
      expect(repository.findByPhoneIncludingDeleted).toHaveBeenCalledTimes(2);
    });
  });

  // ── A lead is keyed on a phone, not on a channel address ─────────────────

  describe('auto-capture uses the E.164 phone, not the channel id', () => {
    const event = (over: Record<string, unknown> = {}) =>
      ({
        type: 'message.received',
        businessId: BUSINESS_ID,
        messageId: 'msg-1',
        conversationId: CONV_ID,
        clientId: null,
        channel: 'WHATSAPP',
        senderExternalId: '919876543210', // wa_id: no '+'
        senderPhone: PHONE, // '+919876543210'
        ...over,
      }) as unknown as MessageReceivedEvent;

    it('captures under the normalized phone, not the raw wa_id', async () => {
      repository.findByPhoneIncludingDeleted.mockResolvedValue(null as never);
      repository.create.mockResolvedValue(makeLead() as never);

      await service.handleMessageReceived(event());

      // Capturing under `919876543210` made a second lead for a buyer the
      // portal had already ingested as `+919876543210` — one person, two
      // histories, which is the invariant this module exists to hold.
      expect(repository.findByPhoneIncludingDeleted).toHaveBeenCalledWith(BUSINESS_ID, PHONE);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ whatsappPhone: PHONE }),
      );
    });

    it('captures nothing from a channel with no phone identity', async () => {
      // Web Chat's sender id is a 36-character UUID and the column is
      // VARCHAR(20), so this used to throw on every inbound web-chat message —
      // swallowed by the listener, so it never surfaced as anything but noise.
      await service.handleMessageReceived(
        event({
          channel: 'WEB_CHAT',
          senderExternalId: 'a3f1c0de-1111-4222-8333-444455556666',
          senderPhone: undefined,
        }),
      );

      expect(repository.findByPhoneIncludingDeleted).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  // ── What must NOT become tombstone-aware ─────────────────────────────────

  describe('follow-up lookups still exclude deleted leads', () => {
    it('findLeadByPhone does not resurrect or return a tombstone', async () => {
      // Cadence, voice and compliance route off this. A deleted lead must not
      // receive follow-ups just because identity resolution can now see it.
      repository.findByPhone.mockResolvedValue(null as never);

      await expect(service.findLeadByPhone(BUSINESS_ID, PHONE)).resolves.toBeNull();
      expect(repository.findByPhoneIncludingDeleted).not.toHaveBeenCalled();
      expect(repository.revive).not.toHaveBeenCalled();
    });
  });
});
