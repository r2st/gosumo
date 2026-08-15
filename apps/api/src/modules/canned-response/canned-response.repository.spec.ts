/**
 * CannedResponseRepository unit tests.
 *
 * `buildWhere` is the interesting part: five independent, optional filters that
 * compose, split across two mechanisms. `category`, `tag` and `isActive` set
 * fields directly on the WHERE; `search` and `channel` push OR-groups onto an
 * AND array that is only attached when non-empty. Getting that wrong is silent
 * — an ignored filter returns *more* rows, which looks like working software.
 *
 * Two cases carry real semantics rather than just branch counting:
 *   - `isActive: false` must filter to inactive responses, not be skipped as
 *     falsy;
 *   - a response with a null channel is usable on every channel, so filtering
 *     by channel must keep the channel-less rows.
 */
import { Test } from '@nestjs/testing';
import { ChannelType } from '@gosumo/shared';
import {
  CannedResponseRepository,
  type UpdateCannedResponseData,
} from './canned-response.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BIZ = '00000000-0000-4000-a000-000000000001';
const ID = '00000000-0000-4000-a000-0000000000r1';

describe('CannedResponseRepository', () => {
  let repository: CannedResponseRepository;
  let prisma: {
    canned_responses: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      canned_responses: {
        create: jest.fn().mockResolvedValue({ id: ID }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: ID }),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    const module = await Test.createTestingModule({
      providers: [CannedResponseRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(CannedResponseRepository);
  });

  /** The WHERE clause `findMany` was called with. */
  const listWhere = () =>
    prisma.canned_responses.findMany.mock.calls[0][0].where as Record<string, unknown>;

  describe('create', () => {
    it('defaults tags to empty and the response to active', async () => {
      await repository.create(BIZ, { title: 'Greeting', shortcut: '/hi', content: 'Hello!' });

      expect(prisma.canned_responses.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ business_id: BIZ, tags: [], is_active: true }),
      });
    });

    it('honours an explicit inactive flag', async () => {
      // `false` is falsy — a `||` default here would silently activate a
      // response the caller asked to create disabled.
      await repository.create(BIZ, {
        title: 'Greeting',
        shortcut: '/hi',
        content: 'Hello!',
        isActive: false,
      });

      expect(prisma.canned_responses.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ is_active: false }),
      });
    });

    it('keeps supplied tags', async () => {
      await repository.create(BIZ, {
        title: 'Greeting',
        shortcut: '/hi',
        content: 'Hello!',
        tags: ['sales', 'intro'],
      });

      expect(prisma.canned_responses.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ tags: ['sales', 'intro'] }),
      });
    });
  });

  describe('findMany filters', () => {
    it('lists the tenant’s live responses when unfiltered', async () => {
      await repository.findMany(BIZ, {});

      expect(listWhere()).toEqual({ business_id: BIZ, deleted_at: null });
    });

    it('searches title, content and shortcut case-insensitively', async () => {
      await repository.findMany(BIZ, { search: 'refund' });

      expect(listWhere()).toEqual({
        business_id: BIZ,
        deleted_at: null,
        AND: [
          {
            OR: [
              { title: { contains: 'refund', mode: 'insensitive' } },
              { content: { contains: 'refund', mode: 'insensitive' } },
              { shortcut: { contains: 'refund', mode: 'insensitive' } },
            ],
          },
        ],
      });
    });

    it('filters by category directly on the WHERE', async () => {
      await repository.findMany(BIZ, { category: 'billing' });

      expect(listWhere()).toMatchObject({ category: 'billing' });
      expect(listWhere()).not.toHaveProperty('AND');
    });

    it('keeps channel-less responses when filtering by channel', async () => {
      await repository.findMany(BIZ, { channel: ChannelType.WHATSAPP });

      expect(listWhere()).toMatchObject({
        AND: [{ OR: [{ channel: ChannelType.WHATSAPP }, { channel: null }] }],
      });
    });

    it('filters by tag membership', async () => {
      await repository.findMany(BIZ, { tag: 'sales' });

      expect(listWhere()).toMatchObject({ tags: { has: 'sales' } });
    });

    it('filters to active responses', async () => {
      await repository.findMany(BIZ, { isActive: true });

      expect(listWhere()).toMatchObject({ is_active: true });
    });

    it('filters to inactive responses when isActive is false', async () => {
      // The guard is `!== undefined`, not truthiness — otherwise there would be
      // no way to list the disabled ones.
      await repository.findMany(BIZ, { isActive: false });

      expect(listWhere()).toMatchObject({ is_active: false });
    });

    it('composes every filter at once', async () => {
      await repository.findMany(BIZ, {
        search: 'refund',
        category: 'billing',
        channel: ChannelType.WHATSAPP,
        tag: 'sales',
        isActive: true,
      });

      const where = listWhere();
      expect(where).toMatchObject({
        business_id: BIZ,
        deleted_at: null,
        category: 'billing',
        tags: { has: 'sales' },
        is_active: true,
      });
      // Both OR-groups land in AND, in filter order.
      expect((where.AND as unknown[]).length).toBe(2);
    });

    it('omits the AND array entirely when no OR-group filter is used', async () => {
      await repository.findMany(BIZ, { category: 'billing', isActive: true });

      expect(listWhere()).not.toHaveProperty('AND');
    });
  });

  describe('findMany pagination', () => {
    it('defaults to the first page of 20', async () => {
      const result = await repository.findMany(BIZ, {});

      expect(prisma.canned_responses.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(result).toMatchObject({ page: 1, limit: 20 });
    });

    it('defaults each pagination option independently', async () => {
      await repository.findMany(BIZ, { limit: 5 });
      expect(prisma.canned_responses.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 5 }),
      );

      await repository.findMany(BIZ, { page: 3 });
      expect(prisma.canned_responses.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 40, take: 20 }),
      );
    });

    it('reports at least one page even when there are no rows', async () => {
      // A zero here would make the UI render "page 1 of 0".
      const result = await repository.findMany(BIZ, {});

      expect(result.totalPages).toBe(1);
    });

    it('rounds a partial last page up', async () => {
      prisma.canned_responses.count.mockResolvedValue(21);

      const result = await repository.findMany(BIZ, { limit: 20 });

      expect(result.totalPages).toBe(2);
      expect(result.total).toBe(21);
    });

    it('counts against the same filter it lists with', async () => {
      await repository.findMany(BIZ, { category: 'billing' });

      expect(prisma.canned_responses.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ category: 'billing' }),
      });
    });

    it('surfaces the most-used responses first', async () => {
      await repository.findMany(BIZ, {});

      expect(prisma.canned_responses.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ usage_count: 'desc' }, { title: 'asc' }] }),
      );
    });
  });

  describe('update', () => {
    const updateData = () =>
      prisma.canned_responses.update.mock.calls[0][0].data as Record<string, unknown>;

    it('writes nothing when no field was supplied', async () => {
      await repository.update(BIZ, ID, {});

      expect(updateData()).toEqual({});
    });

    it.each<[keyof UpdateCannedResponseData, string, unknown]>([
      ['title', 'title', 'New title'],
      ['content', 'content', 'New content'],
      ['category', 'category', 'billing'],
      ['channel', 'channel', ChannelType.WHATSAPP],
      ['tags', 'tags', ['a', 'b']],
      ['isActive', 'is_active', false],
    ])('writes only %s when it alone is supplied', async (field, column, value) => {
      await repository.update(BIZ, ID, { [field]: value } as UpdateCannedResponseData);

      expect(updateData()).toEqual({ [column]: value });
    });

    it('clears a nullable field when explicitly set to null', async () => {
      // Un-scoping a response from a category or channel is a real edit; null
      // must survive the `!== undefined` guard.
      await repository.update(BIZ, ID, { category: null, channel: null });

      expect(updateData()).toEqual({ category: null, channel: null });
    });

    it('clears tags when set to an empty array', async () => {
      await repository.update(BIZ, ID, { tags: [] });

      expect(updateData()).toEqual({ tags: [] });
    });

    it('scopes the update by tenant', async () => {
      await repository.update(BIZ, ID, { title: 'New title' });

      expect(prisma.canned_responses.update.mock.calls[0][0].where).toEqual({
        id: ID,
        business_id: BIZ,
      });
    });
  });

  describe('point reads and writes', () => {
    it('scopes findById and excludes soft-deleted rows', async () => {
      await repository.findById(BIZ, ID);

      expect(prisma.canned_responses.findFirst).toHaveBeenCalledWith({
        where: { id: ID, business_id: BIZ, deleted_at: null },
      });
    });

    it('scopes the shortcut lookup', async () => {
      await repository.findByShortcut(BIZ, '/hi');

      expect(prisma.canned_responses.findFirst).toHaveBeenCalledWith({
        where: { business_id: BIZ, shortcut: '/hi', deleted_at: null },
      });
    });

    it('soft-deletes by stamping deleted_at', async () => {
      await repository.softDelete(BIZ, ID);

      const call = prisma.canned_responses.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: ID, business_id: BIZ });
      expect(call.data.deleted_at).toBeInstanceOf(Date);
    });

    it('increments usage atomically rather than reading then writing', async () => {
      await repository.incrementUsage(BIZ, ID);

      expect(prisma.canned_responses.update).toHaveBeenCalledWith({
        where: { id: ID, business_id: BIZ },
        data: { usage_count: { increment: 1 } },
      });
    });

    it('finds the soft-deleted row still holding a shortcut', async () => {
      await repository.findDeletedByShortcut(BIZ, '/hi');

      expect(prisma.canned_responses.findFirst).toHaveBeenCalledWith({
        where: { business_id: BIZ, shortcut: '/hi', deleted_at: { not: null } },
      });
    });
  });

  describe('restore', () => {
    it('clears deleted_at and resets usage so the row reads as brand new', async () => {
      await repository.restore(BIZ, ID, {
        title: 'New greeting',
        shortcut: '/hi',
        content: 'Hello again!',
      });

      expect(prisma.canned_responses.update).toHaveBeenCalledWith({
        where: { id: ID, business_id: BIZ },
        data: expect.objectContaining({
          title: 'New greeting',
          content: 'Hello again!',
          usage_count: 0,
          deleted_at: null,
        }),
      });
    });

    it('overwrites optional fields rather than inheriting the deleted row', async () => {
      // The revived row must not keep the old category/channel/tags — the
      // caller asked to create a new response, not to undelete the old one.
      await repository.restore(BIZ, ID, {
        title: 'x',
        shortcut: '/hi',
        content: 'x',
      });

      const { data } = prisma.canned_responses.update.mock.calls[0][0];
      expect(data).toMatchObject({
        category: null,
        channel: null,
        tags: [],
        is_active: true,
        created_by: null,
      });
    });

    it('applies the supplied optional fields when present', async () => {
      await repository.restore(BIZ, ID, {
        title: 'x',
        shortcut: '/hi',
        content: 'x',
        category: 'billing',
        channel: ChannelType.WHATSAPP,
        tags: ['refund'],
        isActive: false,
        createdBy: 'agent-1',
      });

      const { data } = prisma.canned_responses.update.mock.calls[0][0];
      expect(data).toMatchObject({
        category: 'billing',
        channel: ChannelType.WHATSAPP,
        tags: ['refund'],
        is_active: false,
        created_by: 'agent-1',
      });
    });
  });
});
