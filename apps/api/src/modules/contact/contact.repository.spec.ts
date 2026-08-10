/**
 * ContactRepository unit tests.
 *
 * The repository is a thin Prisma layer, so the behaviour worth pinning is the
 * two filter builders: `buildWhere` (list endpoint) and `segmentFilterToWhere`
 * (stored segment JSON). Both translate an optional-field DTO into a Prisma
 * `where`, and both have the same failure mode — an omitted filter must not
 * appear in the clause at all, while a *falsy but present* filter (0, false,
 * empty string) must. Getting that wrong silently widens or narrows a tenant's
 * result set, so each optional field is asserted present-and-absent.
 *
 * Every query must also carry `business_id` and exclude soft-deleted rows;
 * that is asserted on every emitted query.
 *
 * PrismaService is mocked — assertions are on the query the repository builds.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ChannelType } from '@gosumo/shared';

import {
  ContactRepository,
  type ContactListFilters,
  type SegmentFilter,
} from './contact.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS = '00000000-0000-4000-a000-000000000002';
const CONTACT_ID = '00000000-0000-4000-b000-000000000001';
const SEGMENT_ID = '00000000-0000-4000-c000-000000000001';

describe('ContactRepository', () => {
  let repository: ContactRepository;
  let prisma: {
    clients: { findMany: jest.Mock; count: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
    segments: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      clients: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: CONTACT_ID }),
      },
      segments: {
        create: jest.fn().mockResolvedValue({ id: SEGMENT_ID }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: SEGMENT_ID }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ContactRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get<ContactRepository>(ContactRepository);
  });

  /** The `where` from the most recent `clients.findMany` — tests may query twice. */
  function emittedClientsWhere(): Record<string, unknown> {
    const calls = prisma.clients.findMany.mock.calls;
    return calls[calls.length - 1]![0].where;
  }

  // ─────────────────────────────────────────────
  // findMany — pagination
  // ─────────────────────────────────────────────

  describe('findMany', () => {
    it('defaults to page 1 / limit 20 when the caller omits pagination', async () => {
      const result = await repository.findMany(BUSINESS_ID, {});

      expect(prisma.clients.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20, orderBy: { last_interaction_at: 'desc' } }),
      );
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('translates page/limit into skip/take', async () => {
      await repository.findMany(BUSINESS_ID, { page: 3, limit: 25 });

      expect(prisma.clients.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50, take: 25 }),
      );
    });

    it('scopes to the tenant and excludes soft-deleted rows', async () => {
      await repository.findMany(BUSINESS_ID, {});

      expect(emittedClientsWhere()).toEqual({ business_id: BUSINESS_ID, deleted_at: null });
      // The count must share the same clause or the totals disagree with the page.
      expect(prisma.clients.count).toHaveBeenCalledWith({ where: emittedClientsWhere() });
    });

    it('reports at least one page even when there are no matches', async () => {
      prisma.clients.count.mockResolvedValue(0);

      const result = await repository.findMany(BUSINESS_ID, {});

      // Math.ceil(0/20) is 0; a zero-page response breaks pagination UIs.
      expect(result.totalPages).toBe(1);
      expect(result.total).toBe(0);
    });

    it('rounds a partial final page up', async () => {
      prisma.clients.count.mockResolvedValue(41);

      const result = await repository.findMany(BUSINESS_ID, { limit: 20 });

      expect(result.totalPages).toBe(3);
    });

    it('returns the rows Prisma produced', async () => {
      const rows = [{ id: CONTACT_ID }];
      prisma.clients.findMany.mockResolvedValue(rows);
      prisma.clients.count.mockResolvedValue(1);

      const result = await repository.findMany(BUSINESS_ID, {});

      expect(result.data).toBe(rows);
    });
  });

  // ─────────────────────────────────────────────
  // findMany — filter translation (buildWhere)
  // ─────────────────────────────────────────────

  describe('findMany filters', () => {
    async function whereFor(filters: ContactListFilters): Promise<Record<string, unknown>> {
      await repository.findMany(BUSINESS_ID, filters);
      return emittedClientsWhere();
    }

    it('searches name, email and phone case-insensitively', async () => {
      const where = await whereFor({ search: 'Priya' });

      expect(where.OR).toEqual([
        { name: { contains: 'Priya', mode: 'insensitive' } },
        { email: { contains: 'Priya', mode: 'insensitive' } },
        { phone: { contains: 'Priya', mode: 'insensitive' } },
      ]);
    });

    it('omits the search clause for an empty search string', async () => {
      const where = await whereFor({ search: '' });

      expect(where).not.toHaveProperty('OR');
    });

    it('matches any of the supplied tags', async () => {
      const where = await whereFor({ tags: ['vip', 'repeat'] });

      expect(where.tags).toEqual({ hasSome: ['vip', 'repeat'] });
    });

    it('omits the tag clause for an empty tag list', async () => {
      // An empty `hasSome` matches nothing in Prisma — it must not be emitted.
      const where = await whereFor({ tags: [] });

      expect(where).not.toHaveProperty('tags');
    });

    it('applies minLtv as a lower bound', async () => {
      expect(await whereFor({ minLtv: 500 })).toMatchObject({ ltv_score: { gte: 500 } });
    });

    it('keeps a zero minLtv rather than treating it as absent', async () => {
      expect(await whereFor({ minLtv: 0 })).toMatchObject({ ltv_score: { gte: 0 } });
    });

    it('applies maxChurnRisk as an upper bound, including zero', async () => {
      expect(await whereFor({ maxChurnRisk: 0.4 })).toMatchObject({ churn_risk: { lte: 0.4 } });
      expect(await whereFor({ maxChurnRisk: 0 })).toMatchObject({ churn_risk: { lte: 0 } });
    });

    it('applies minEngagement as a lower bound, including zero', async () => {
      expect(await whereFor({ minEngagement: 10 })).toMatchObject({
        engagement_score: { gte: 10 },
      });
      expect(await whereFor({ minEngagement: 0 })).toMatchObject({ engagement_score: { gte: 0 } });
    });

    it('splits hasOrders into a positive and a zero-order clause', async () => {
      expect(await whereFor({ hasOrders: true })).toMatchObject({ total_orders: { gt: 0 } });
      expect(await whereFor({ hasOrders: false })).toMatchObject({ total_orders: { equals: 0 } });
    });

    it('omits the order clause when hasOrders is not supplied', async () => {
      expect(await whereFor({})).not.toHaveProperty('total_orders');
    });

    it('filters by channel through the channel_contacts relation', async () => {
      const where = await whereFor({ channel: ChannelType.WHATSAPP });

      expect(where.channel_contacts).toEqual({ some: { channel: ChannelType.WHATSAPP } });
    });

    it('combines every filter into one clause without dropping tenant scoping', async () => {
      const where = await whereFor({
        search: 'raj',
        tags: ['vip'],
        minLtv: 100,
        maxChurnRisk: 0.5,
        minEngagement: 5,
        hasOrders: true,
        channel: ChannelType.INSTAGRAM,
      });

      expect(where).toMatchObject({
        business_id: BUSINESS_ID,
        deleted_at: null,
        tags: { hasSome: ['vip'] },
        ltv_score: { gte: 100 },
        churn_risk: { lte: 0.5 },
        engagement_score: { gte: 5 },
        total_orders: { gt: 0 },
        channel_contacts: { some: { channel: ChannelType.INSTAGRAM } },
      });
      expect(where.OR).toHaveLength(3);
    });
  });

  // ─────────────────────────────────────────────
  // Single-contact reads and writes
  // ─────────────────────────────────────────────

  describe('findById', () => {
    it('scopes the lookup to the tenant and skips soft-deleted rows', async () => {
      await repository.findById(BUSINESS_ID, CONTACT_ID);

      expect(prisma.clients.findFirst).toHaveBeenCalledWith({
        where: { id: CONTACT_ID, business_id: BUSINESS_ID, deleted_at: null },
      });
    });

    it('returns null when the id belongs to another tenant', async () => {
      prisma.clients.findFirst.mockResolvedValue(null);

      await expect(repository.findById(OTHER_BUSINESS, CONTACT_ID)).resolves.toBeNull();
    });
  });

  describe('update', () => {
    it('writes only the fields the caller supplied', async () => {
      await repository.update(BUSINESS_ID, CONTACT_ID, { name: 'Priya' });

      expect(prisma.clients.update).toHaveBeenCalledWith({
        where: { id: CONTACT_ID, business_id: BUSINESS_ID },
        data: { name: 'Priya' },
      });
    });

    it('writes an explicit null to clear a field', async () => {
      // `null` clears; `undefined` means "leave alone" — they must not collapse.
      await repository.update(BUSINESS_ID, CONTACT_ID, { email: null });

      expect(prisma.clients.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { email: null } }),
      );
    });

    it('writes every supplied field together', async () => {
      await repository.update(BUSINESS_ID, CONTACT_ID, {
        name: 'Priya',
        email: 'priya@example.com',
        phone: '+919812345678',
      });

      expect(prisma.clients.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { name: 'Priya', email: 'priya@example.com', phone: '+919812345678' },
        }),
      );
    });

    it('sends an empty patch when nothing was supplied', async () => {
      await repository.update(BUSINESS_ID, CONTACT_ID, {});

      expect(prisma.clients.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: {} }),
      );
    });
  });

  describe('setTags', () => {
    it('replaces the tag list wholesale within the tenant scope', async () => {
      await repository.setTags(BUSINESS_ID, CONTACT_ID, ['vip']);

      expect(prisma.clients.update).toHaveBeenCalledWith({
        where: { id: CONTACT_ID, business_id: BUSINESS_ID },
        data: { tags: ['vip'] },
      });
    });

    it('accepts an empty list as "clear all tags"', async () => {
      await repository.setTags(BUSINESS_ID, CONTACT_ID, []);

      expect(prisma.clients.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { tags: [] } }),
      );
    });
  });

  // ─────────────────────────────────────────────
  // Segment filter translation
  // ─────────────────────────────────────────────

  describe('segmentFilterToWhere', () => {
    it('scopes to the tenant and excludes soft-deleted rows for an empty filter', () => {
      expect(repository.segmentFilterToWhere(BUSINESS_ID, {})).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
    });

    it('matches any of the segment tags', () => {
      expect(repository.segmentFilterToWhere(BUSINESS_ID, { tags: ['vip'] })).toMatchObject({
        tags: { hasSome: ['vip'] },
      });
    });

    it('omits the tag clause for an empty tag list', () => {
      expect(repository.segmentFilterToWhere(BUSINESS_ID, { tags: [] })).not.toHaveProperty('tags');
    });

    it('applies the numeric bounds, keeping zero values', () => {
      const where = repository.segmentFilterToWhere(BUSINESS_ID, {
        minLtv: 0,
        maxChurnRisk: 0,
        minEngagement: 0,
      });

      expect(where).toMatchObject({
        ltv_score: { gte: 0 },
        churn_risk: { lte: 0 },
        engagement_score: { gte: 0 },
      });
    });

    it('omits numeric bounds that were not set', () => {
      const where = repository.segmentFilterToWhere(BUSINESS_ID, {});

      expect(where).not.toHaveProperty('ltv_score');
      expect(where).not.toHaveProperty('churn_risk');
      expect(where).not.toHaveProperty('engagement_score');
    });

    it('splits hasOrders into a positive and a zero-order clause', () => {
      expect(
        repository.segmentFilterToWhere(BUSINESS_ID, { hasOrders: true }),
      ).toMatchObject({ total_orders: { gt: 0 } });
      expect(
        repository.segmentFilterToWhere(BUSINESS_ID, { hasOrders: false }),
      ).toMatchObject({ total_orders: { equals: 0 } });
    });

    it('matches any of several channels', () => {
      const where = repository.segmentFilterToWhere(BUSINESS_ID, {
        channels: [ChannelType.WHATSAPP, ChannelType.EMAIL],
      });

      expect(where.channel_contacts).toEqual({
        some: { channel: { in: [ChannelType.WHATSAPP, ChannelType.EMAIL] } },
      });
    });

    it('omits the channel clause for an empty channel list', () => {
      expect(
        repository.segmentFilterToWhere(BUSINESS_ID, { channels: [] }),
      ).not.toHaveProperty('channel_contacts');
    });

    it('never lets a segment filter widen past its tenant', () => {
      const filter: SegmentFilter = { tags: ['vip'], hasOrders: true };

      expect(repository.segmentFilterToWhere(BUSINESS_ID, filter)).toMatchObject({
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
    });
  });

  // ─────────────────────────────────────────────
  // Segment evaluation
  // ─────────────────────────────────────────────

  describe('findBySegmentFilter', () => {
    it('paginates using the caller-supplied page and limit', async () => {
      await repository.findBySegmentFilter(BUSINESS_ID, { tags: ['vip'] }, 2, 10);

      expect(prisma.clients.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10, orderBy: { last_interaction_at: 'desc' } }),
      );
    });

    it('evaluates the stored filter and reports at least one page', async () => {
      prisma.clients.count.mockResolvedValue(0);

      const result = await repository.findBySegmentFilter(BUSINESS_ID, {}, 1, 20);

      expect(emittedClientsWhere()).toMatchObject({
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
      expect(result.totalPages).toBe(1);
    });

    it('rounds a partial final page up', async () => {
      prisma.clients.count.mockResolvedValue(21);

      const result = await repository.findBySegmentFilter(BUSINESS_ID, {}, 1, 20);

      expect(result.totalPages).toBe(2);
    });
  });

  describe('countBySegmentFilter', () => {
    it('counts through the same translated filter', async () => {
      prisma.clients.count.mockResolvedValue(7);

      const count = await repository.countBySegmentFilter(BUSINESS_ID, { hasOrders: true });

      expect(count).toBe(7);
      expect(prisma.clients.count).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          deleted_at: null,
          total_orders: { gt: 0 },
        },
      });
    });
  });

  // ─────────────────────────────────────────────
  // Segment CRUD
  // ─────────────────────────────────────────────

  describe('createSegment', () => {
    it('defaults a new segment to active', async () => {
      await repository.createSegment(BUSINESS_ID, { name: 'VIPs', filter: { tags: ['vip'] } });

      expect(prisma.segments.create).toHaveBeenCalledWith({
        data: {
          business_id: BUSINESS_ID,
          name: 'VIPs',
          description: undefined,
          filter: { tags: ['vip'] },
          is_active: true,
        },
      });
    });

    it('honours an explicit inactive flag', async () => {
      await repository.createSegment(BUSINESS_ID, {
        name: 'Draft',
        filter: {},
        isActive: false,
      });

      expect(prisma.segments.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ is_active: false }) }),
      );
    });

    it('stores the supplied description', async () => {
      await repository.createSegment(BUSINESS_ID, {
        name: 'VIPs',
        description: 'High LTV buyers',
        filter: {},
      });

      expect(prisma.segments.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ description: 'High LTV buyers' }),
        }),
      );
    });
  });

  describe('segment reads', () => {
    it('lists a tenant’s live segments newest first', async () => {
      await repository.findSegments(BUSINESS_ID);

      expect(prisma.segments.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, deleted_at: null },
        orderBy: { created_at: 'desc' },
      });
    });

    it('looks a segment up by id within the tenant', async () => {
      await repository.findSegmentById(BUSINESS_ID, SEGMENT_ID);

      expect(prisma.segments.findFirst).toHaveBeenCalledWith({
        where: { id: SEGMENT_ID, business_id: BUSINESS_ID, deleted_at: null },
      });
    });

    it('looks a segment up by name within the tenant (uniqueness check)', async () => {
      await repository.findSegmentByName(BUSINESS_ID, 'VIPs');

      expect(prisma.segments.findFirst).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, name: 'VIPs', deleted_at: null },
      });
    });

    it('returns null when the segment name is free', async () => {
      prisma.segments.findFirst.mockResolvedValue(null);

      await expect(repository.findSegmentByName(BUSINESS_ID, 'Unused')).resolves.toBeNull();
    });
  });

  describe('updateSegment', () => {
    it('writes only the supplied fields', async () => {
      await repository.updateSegment(BUSINESS_ID, SEGMENT_ID, { name: 'Renamed' });

      expect(prisma.segments.update).toHaveBeenCalledWith({
        where: { id: SEGMENT_ID, business_id: BUSINESS_ID },
        data: { name: 'Renamed' },
      });
    });

    it('clears the description when passed null', async () => {
      await repository.updateSegment(BUSINESS_ID, SEGMENT_ID, { description: null });

      expect(prisma.segments.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { description: null } }),
      );
    });

    it('replaces the stored filter JSON', async () => {
      await repository.updateSegment(BUSINESS_ID, SEGMENT_ID, { filter: { minLtv: 1000 } });

      expect(prisma.segments.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { filter: { minLtv: 1000 } } }),
      );
    });

    it('deactivates without touching the other fields', async () => {
      await repository.updateSegment(BUSINESS_ID, SEGMENT_ID, { isActive: false });

      expect(prisma.segments.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { is_active: false } }),
      );
    });

    it('writes every supplied field together', async () => {
      await repository.updateSegment(BUSINESS_ID, SEGMENT_ID, {
        name: 'Renamed',
        description: 'desc',
        filter: { tags: ['vip'] },
        isActive: true,
      });

      expect(prisma.segments.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            name: 'Renamed',
            description: 'desc',
            filter: { tags: ['vip'] },
            is_active: true,
          },
        }),
      );
    });

    it('sends an empty patch when nothing was supplied', async () => {
      await repository.updateSegment(BUSINESS_ID, SEGMENT_ID, {});

      expect(prisma.segments.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: {} }),
      );
    });
  });

  describe('softDeleteSegment', () => {
    it('stamps deleted_at rather than removing the row', async () => {
      await repository.softDeleteSegment(BUSINESS_ID, SEGMENT_ID);

      const call = prisma.segments.update.mock.calls[0]![0];
      expect(call.where).toEqual({ id: SEGMENT_ID, business_id: BUSINESS_ID });
      expect(call.data.deleted_at).toBeInstanceOf(Date);
    });
  });
});
