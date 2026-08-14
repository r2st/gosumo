/**
 * ContactService — the null-shaped branches `contact.spec.ts` does not reach.
 *
 * Its fixture is a mature contact: every score populated, an interaction on
 * record. The uncovered branches are all the opposite case — a contact created
 * moments ago, before the scoring job has run. That is the *normal* state for a
 * fresh lead, so `toContactDto` has to map absent Decimals to null rather than
 * calling `.toNumber()` on undefined.
 *
 * Also covers the segment count fallback, which decides whether a segment whose
 * count could not be resolved renders as "0 members" or as NaN.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { ContactService } from './contact.service';
import { ContactRepository } from './contact.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CONTACT_ID = '00000000-0000-4000-a000-000000000020';

/** A contact the scoring job has not touched yet — every score null. */
function makeUnscoredClient(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT_ID,
    business_id: BUSINESS_ID,
    name: 'New Lead',
    email: null,
    phone: '+919876543210',
    avatar_url: null,
    consumer_user_id: null,
    profile: {},
    opt_outs: {},
    tags: [],
    ltv_score: null,
    churn_risk: null,
    engagement_score: null,
    scores_updated_at: null,
    total_orders: 0,
    total_spent: new Prisma.Decimal(0),
    last_interaction_at: null,
    first_seen_at: new Date('2026-06-27T00:00:00Z'),
    created_at: new Date('2026-06-27T00:00:00Z'),
    updated_at: new Date('2026-06-27T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

describe('ContactService — unscored contacts and segment count fallbacks', () => {
  let service: ContactService;
  let repo: jest.Mocked<ContactRepository>;

  beforeEach(async () => {
    repo = {
      findMany: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      setTags: jest.fn(),
      segmentFilterToWhere: jest.fn(),
      findBySegmentFilter: jest.fn(),
      countBySegmentFilter: jest.fn().mockResolvedValue(0),
      createSegment: jest.fn(),
      findSegments: jest.fn().mockResolvedValue([]),
      findSegmentById: jest.fn(),
      findSegmentByName: jest.fn(),
      updateSegment: jest.fn(),
      softDeleteSegment: jest.fn(),
    } as unknown as jest.Mocked<ContactRepository>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactService,
        { provide: ContactRepository, useValue: repo },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(ContactService);
  });

  describe('a contact with no scores yet', () => {
    it('maps every absent score to null instead of throwing on .toNumber()', async () => {
      repo.findById.mockResolvedValue(makeUnscoredClient() as never);

      const dto = await service.getContact(BUSINESS_ID, CONTACT_ID);

      expect(dto.ltvScore).toBeNull();
      expect(dto.churnRisk).toBeNull();
      expect(dto.engagementScore).toBeNull();
    });

    it('maps an absent last interaction to null', async () => {
      repo.findById.mockResolvedValue(makeUnscoredClient() as never);

      const dto = await service.getContact(BUSINESS_ID, CONTACT_ID);

      expect(dto.lastInteractionAt).toBeNull();
    });

    it('still reports the timestamps that are never null', async () => {
      repo.findById.mockResolvedValue(makeUnscoredClient() as never);

      const dto = await service.getContact(BUSINESS_ID, CONTACT_ID);

      expect(dto.firstSeenAt).toBe('2026-06-27T00:00:00.000Z');
      expect(dto.createdAt).toBe('2026-06-27T00:00:00.000Z');
    });

    it('converts spend to paise, including zero', async () => {
      repo.findById.mockResolvedValue(makeUnscoredClient() as never);

      const dto = await service.getContact(BUSINESS_ID, CONTACT_ID);

      expect(dto.totalSpentPaise).toBe(0);
      expect(dto.totalOrders).toBe(0);
    });

    it('rounds a fractional rupee spend to whole paise', async () => {
      // total_spent is stored in rupees as a Decimal; the DTO is paise, and the
      // column can hold more precision than paise can represent.
      repo.findById.mockResolvedValue(
        makeUnscoredClient({ total_spent: new Prisma.Decimal('1500.505') }) as never,
      );

      const dto = await service.getContact(BUSINESS_ID, CONTACT_ID);

      expect(dto.totalSpentPaise).toBe(150_051);
      expect(Number.isInteger(dto.totalSpentPaise)).toBe(true);
    });

    it('maps a score of exactly zero to 0, not null', async () => {
      // 0 is falsy — `?.toNumber() ?? null` is required so a genuinely-zero
      // churn risk is not reported as "not scored".
      repo.findById.mockResolvedValue(
        makeUnscoredClient({
          ltv_score: new Prisma.Decimal(0),
          churn_risk: new Prisma.Decimal(0),
          engagement_score: new Prisma.Decimal(0),
        }) as never,
      );

      const dto = await service.getContact(BUSINESS_ID, CONTACT_ID);

      expect(dto.ltvScore).toBe(0);
      expect(dto.churnRisk).toBe(0);
      expect(dto.engagementScore).toBe(0);
    });

    it('maps a partially-scored contact field by field', async () => {
      repo.findById.mockResolvedValue(
        makeUnscoredClient({ ltv_score: new Prisma.Decimal(2500) }) as never,
      );

      const dto = await service.getContact(BUSINESS_ID, CONTACT_ID);

      expect(dto.ltvScore).toBe(2500);
      expect(dto.churnRisk).toBeNull();
      expect(dto.engagementScore).toBeNull();
    });
  });

  describe('segment member counts', () => {
    function makeSegment(overrides: Record<string, unknown> = {}) {
      return {
        id: '00000000-0000-4000-a000-000000000030',
        business_id: BUSINESS_ID,
        name: 'High LTV',
        description: null,
        filter: { minLtv: 1000 },
        is_active: true,
        created_at: new Date('2026-06-01T00:00:00Z'),
        updated_at: new Date('2026-06-01T00:00:00Z'),
        deleted_at: null,
        ...overrides,
      };
    }

    it('reports 0 members for a segment whose filter is null', async () => {
      // A null filter has no count to look up; the list must still render.
      repo.findSegments.mockResolvedValue([makeSegment({ filter: null })] as never);
      repo.countBySegmentFilter.mockResolvedValue(0);

      const segments = await service.listSegments(BUSINESS_ID);

      expect(segments).toHaveLength(1);
      expect(segments[0]?.memberCount).toBe(0);
    });

    it('counts each distinct filter once and reuses it across duplicates', async () => {
      // Two segments with an identical filter collapse to one count query.
      repo.findSegments.mockResolvedValue([
        makeSegment({ id: 'seg-1', name: 'A' }),
        makeSegment({ id: 'seg-2', name: 'B' }),
      ] as never);
      repo.countBySegmentFilter.mockResolvedValue(7);

      const segments = await service.listSegments(BUSINESS_ID);

      expect(repo.countBySegmentFilter).toHaveBeenCalledTimes(1);
      expect(segments.map((s) => s.memberCount)).toEqual([7, 7]);
    });

    it('counts distinct filters separately', async () => {
      repo.findSegments.mockResolvedValue([
        makeSegment({ id: 'seg-1', name: 'A', filter: { minLtv: 1000 } }),
        makeSegment({ id: 'seg-2', name: 'B', filter: { minLtv: 5000 } }),
      ] as never);
      repo.countBySegmentFilter.mockResolvedValueOnce(7).mockResolvedValueOnce(2);

      const segments = await service.listSegments(BUSINESS_ID);

      expect(repo.countBySegmentFilter).toHaveBeenCalledTimes(2);
      expect(segments.map((s) => s.memberCount)).toEqual([7, 2]);
    });

    it('returns an empty list when the tenant has no segments', async () => {
      repo.findSegments.mockResolvedValue([] as never);

      await expect(service.listSegments(BUSINESS_ID)).resolves.toEqual([]);
      expect(repo.countBySegmentFilter).not.toHaveBeenCalled();
    });
  });
});
