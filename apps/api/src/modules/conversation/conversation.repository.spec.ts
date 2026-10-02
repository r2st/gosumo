/**
 * ConversationRepository unit tests.
 *
 * The repository is where the inbox's filter language becomes SQL. `buildWhere`
 * composes nine independent filters — three of which are not simple equality:
 * `unassigned` shadows `assigneeId`, `tags` is an any-of match that must ignore
 * an empty array, and the date bounds share one `created_at` filter that has to
 * survive either end being absent. Those are the branches worth pinning, along
 * with the status transition that stamps and clears `resolved_at`.
 *
 * PrismaService is mocked; assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ChannelType, ConversationStatus, ResourceNotFoundError } from '@gosumo/shared';

import { ConversationRepository } from './conversation.repository';
import type { ConversationListFilters } from './conversation.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { SNOOZE_WAKE_BATCH_SIZE } from './conversation.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-b000-000000000001';
const CLIENT_ID = '00000000-0000-4000-c000-000000000001';
const AGENT_A = '00000000-0000-4000-d000-000000000001';
const AGENT_B = '00000000-0000-4000-d000-000000000002';

describe('ConversationRepository', () => {
  let repository: ConversationRepository;
  let prisma: {
    conversations: Record<
      'findFirst' | 'findMany' | 'count' | 'groupBy' | 'create' | 'update' | 'updateMany',
      jest.Mock
    >;
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      conversations: {
        findFirst: jest.fn().mockResolvedValue({ id: CONVERSATION_ID }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: CONVERSATION_ID }),
        update: jest.fn().mockResolvedValue({ id: CONVERSATION_ID }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ resolved_count: 0, avg_resolution_seconds: null }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ConversationRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(ConversationRepository);
  });

  // ── Reads ────────────────────────────────────

  it('finds by id within the business, excluding soft-deleted rows', async () => {
    await repository.findById(BUSINESS_ID, CONVERSATION_ID);

    expect(prisma.conversations.findFirst.mock.calls[0]![0].where).toEqual({
      id: CONVERSATION_ID,
      business_id: BUSINESS_ID,
      deleted_at: null,
    });
  });

  it('resolves a client thread by status-blind lookup, so a RESOLVED one is reused', async () => {
    await repository.findLatestByClientAndChannel(BUSINESS_ID, CLIENT_ID, 'acc_1');

    expect(prisma.conversations.findFirst.mock.calls[0]![0].where).toEqual({
      business_id: BUSINESS_ID,
      client_id: CLIENT_ID,
      channel_account_id: 'acc_1',
      deleted_at: null,
    });
  });

  it('picks the most recently active thread when duplicates already exist', async () => {
    await repository.findLatestByClientAndChannel(BUSINESS_ID, CLIENT_ID, 'acc_1');

    expect(prisma.conversations.findFirst.mock.calls[0]![0].orderBy).toEqual([
      { last_message_at: 'desc' },
      { created_at: 'desc' },
    ]);
  });

  it('creates an OPEN conversation with zeroed counters', async () => {
    await repository.create({
      businessId: BUSINESS_ID,
      clientId: CLIENT_ID,
      channelAccountId: 'acc_1',
      channel: ChannelType.WHATSAPP,
    });

    expect(prisma.conversations.create.mock.calls[0]![0].data).toMatchObject({
      business_id: BUSINESS_ID,
      status: ConversationStatus.OPEN,
      message_count: 0,
      unread_count: 0,
      human_message_count: 0,
      tags: [],
    });
  });

  // ── updateStatus ─────────────────────────────

  describe('updateStatus', () => {
    const dataFor = async (status: ConversationStatus) => {
      await repository.updateStatus(BUSINESS_ID, CONVERSATION_ID, status);
      return prisma.conversations.update.mock.calls[0]![0].data;
    };

    it('stamps resolved_at on resolution', async () => {
      expect(await dataFor(ConversationStatus.RESOLVED)).toMatchObject({
        status: ConversationStatus.RESOLVED,
        resolved_at: expect.any(Date),
      });
    });

    it('clears resolved_at on reopen', async () => {
      expect(await dataFor(ConversationStatus.OPEN)).toEqual({
        status: ConversationStatus.OPEN,
        resolved_at: null,
      });
    });

    it.each([
      ConversationStatus.PENDING_HUMAN,
      ConversationStatus.ESCALATED,
      ConversationStatus.SNOOZED,
    ])('leaves resolved_at untouched for %s', async (status) => {
      expect(await dataFor(status)).toEqual({ status });
    });

    it('scopes the write to the business', async () => {
      await repository.updateStatus(BUSINESS_ID, CONVERSATION_ID, ConversationStatus.OPEN);

      expect(prisma.conversations.update.mock.calls[0]![0].where).toEqual({
        id: CONVERSATION_ID,
        business_id: BUSINESS_ID,
      });
    });
  });

  // ── update ───────────────────────────────────

  describe('update', () => {
    it('refuses to write to a conversation outside the business', async () => {
      prisma.conversations.findFirst.mockResolvedValue(null);

      const error = await repository.update(BUSINESS_ID, CONVERSATION_ID, { subject: 'x' }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).message).toBe('Conversation not found');
      expect((error as ResourceNotFoundError).context).toEqual({
        resource: 'Conversation',
        resourceId: CONVERSATION_ID,
        businessId: BUSINESS_ID,
      });
      expect(prisma.conversations.update).not.toHaveBeenCalled();
    });

    it('writes nothing when given an empty patch', async () => {
      await repository.update(BUSINESS_ID, CONVERSATION_ID, {});

      expect(prisma.conversations.update.mock.calls[0]![0].data).toEqual({});
    });

    it('maps every field onto its column', async () => {
      const when = new Date('2026-08-10T00:00:00Z');

      await repository.update(BUSINESS_ID, CONVERSATION_ID, {
        status: ConversationStatus.ESCALATED,
        assignedTo: AGENT_A,
        resolvedAt: when,
        snoozedUntil: when,
        subject: 'Site visit',
        currentTopic: 'pricing',
        tags: ['hot'],
        csatScore: 5,
        csatSubmittedAt: when,
        metadata: { source: 'inbox' },
      });

      expect(prisma.conversations.update.mock.calls[0]![0].data).toEqual({
        status: ConversationStatus.ESCALATED,
        assigned_to: AGENT_A,
        resolved_at: when,
        snoozed_until: when,
        subject: 'Site visit',
        current_topic: 'pricing',
        tags: ['hot'],
        csat_score: 5,
        csat_submitted_at: when,
        metadata: { source: 'inbox' },
      });
    });

    it('writes an explicit null to clear a nullable column', async () => {
      // The guard is `!== undefined`, so clearing must reach the update.
      await repository.update(BUSINESS_ID, CONVERSATION_ID, {
        assignedTo: null,
        snoozedUntil: null,
        csatScore: null,
      });

      expect(prisma.conversations.update.mock.calls[0]![0].data).toEqual({
        assigned_to: null,
        snoozed_until: null,
        csat_score: null,
      });
    });
  });

  // ── buildWhere, via list ─────────────────────

  describe('list filters', () => {
    async function whereFor(filters: ConversationListFilters) {
      await repository.list(BUSINESS_ID, filters);
      return prisma.conversations.findMany.mock.calls[0]![0].where;
    }

    it('scopes to the business and excludes deleted rows with no filters', async () => {
      expect(await whereFor({})).toEqual({ business_id: BUSINESS_ID, deleted_at: null });
    });

    it('defaults to page 1 / limit 20 and reports the page count', async () => {
      prisma.conversations.count.mockResolvedValue(21);

      const result = await repository.list(BUSINESS_ID, {});

      expect(prisma.conversations.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20, orderBy: { last_message_at: 'desc' } }),
      );
      expect(result).toMatchObject({ page: 1, limit: 20, total: 21, totalPages: 2 });
    });

    it('turns page/limit into a skip', async () => {
      await repository.list(BUSINESS_ID, { page: 4, limit: 25 });

      expect(prisma.conversations.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 75, take: 25 }),
      );
    });

    it('applies the simple equality filters', async () => {
      const where = await whereFor({
        status: ConversationStatus.OPEN,
        channel: ChannelType.WHATSAPP,
        clientId: CLIENT_ID,
      });

      expect(where).toMatchObject({
        status: ConversationStatus.OPEN,
        channel: ChannelType.WHATSAPP,
        client_id: CLIENT_ID,
      });
    });

    it('filters to unassigned threads', async () => {
      expect((await whereFor({ unassigned: true })).assigned_to).toBeNull();
    });

    it('filters to one assignee', async () => {
      expect((await whereFor({ assigneeId: AGENT_A })).assigned_to).toBe(AGENT_A);
    });

    it('lets unassigned win over an assignee id sent alongside it', async () => {
      // Both can arrive from a stale UI; "no assignee" is the narrower request.
      expect((await whereFor({ unassigned: true, assigneeId: AGENT_A })).assigned_to).toBeNull();
    });

    it('falls through to the assignee when unassigned is explicitly false', async () => {
      expect(
        (await whereFor({ unassigned: false, assigneeId: AGENT_A })).assigned_to,
      ).toBe(AGENT_A);
    });

    it('matches any of the given tags', async () => {
      expect((await whereFor({ tags: ['hot', 'nri'] })).tags).toEqual({
        hasSome: ['hot', 'nri'],
      });
    });

    it('ignores an empty tag list rather than matching nothing', async () => {
      expect(await whereFor({ tags: [] })).not.toHaveProperty('tags');
    });

    it('searches subject and topic case-insensitively', async () => {
      expect((await whereFor({ search: 'baner' })).OR).toEqual([
        { subject: { contains: 'baner', mode: 'insensitive' } },
        { current_topic: { contains: 'baner', mode: 'insensitive' } },
      ]);
    });

    it('ignores an empty search string', async () => {
      expect(await whereFor({ search: '' })).not.toHaveProperty('OR');
    });

    it('builds a two-sided created_at range', async () => {
      expect(
        (await whereFor({ dateFrom: '2026-08-01', dateTo: '2026-08-31' })).created_at,
      ).toEqual({ gte: new Date('2026-08-01'), lte: new Date('2026-08-31') });
    });

    it('builds a lower-bound-only range', async () => {
      expect((await whereFor({ dateFrom: '2026-08-01' })).created_at).toEqual({
        gte: new Date('2026-08-01'),
      });
    });

    it('builds an upper-bound-only range', async () => {
      expect((await whereFor({ dateTo: '2026-08-31' })).created_at).toEqual({
        lte: new Date('2026-08-31'),
      });
    });

    it('omits created_at when neither bound is given', async () => {
      expect(await whereFor({})).not.toHaveProperty('created_at');
    });

    it('counts with the same where as the page query', async () => {
      await repository.list(BUSINESS_ID, { status: ConversationStatus.OPEN, search: 'x' });

      expect(prisma.conversations.count.mock.calls[0]![0].where).toEqual(
        prisma.conversations.findMany.mock.calls[0]![0].where,
      );
    });
  });

  // ── Counters and assignment ──────────────────

  it('bumps last_message_at and the message counter together', async () => {
    const when = new Date('2026-08-10T10:00:00Z');

    await repository.updateLastMessageAt(BUSINESS_ID, CONVERSATION_ID, when);

    expect(prisma.conversations.update.mock.calls[0]![0]).toMatchObject({
      where: { id: CONVERSATION_ID, business_id: BUSINESS_ID },
      data: { last_message_at: when, message_count: { increment: 1 } },
    });
  });

  it('raises the unread count in the same statement as last_message_at', async () => {
    // An inbound message that bumps the timestamp but not the badge is how the
    // inbox ends up showing "0 unread" on a thread with a waiting customer.
    // Two statements would also let a crash between them leave the two apart.
    await repository.updateLastMessageAt(
      BUSINESS_ID,
      CONVERSATION_ID,
      new Date('2026-08-10T10:00:00Z'),
    );

    expect(prisma.conversations.update).toHaveBeenCalledTimes(1);
    expect(prisma.conversations.update.mock.calls[0]![0].data).toMatchObject({
      unread_count: { increment: 1 },
    });
  });

  it('increments rather than assigns the unread count', async () => {
    // A read-then-write would drop one of two messages arriving at once.
    await repository.updateLastMessageAt(BUSINESS_ID, CONVERSATION_ID, new Date());

    const { data } = prisma.conversations.update.mock.calls[0]![0];
    expect(typeof data.unread_count).toBe('object');
    expect(data.unread_count).toEqual({ increment: 1 });
  });

  // ── Unread counter: mark-read ────────────────

  describe('markRead', () => {
    it('subtracts exactly what it observed, guarded against going negative', async () => {
      prisma.conversations.findFirst.mockResolvedValue({ unread_count: 3 });

      await expect(repository.markRead(BUSINESS_ID, CONVERSATION_ID)).resolves.toBe(3);

      expect(prisma.conversations.updateMany.mock.calls[0]![0]).toEqual({
        where: {
          id: CONVERSATION_ID,
          business_id: BUSINESS_ID,
          unread_count: { gte: 3 },
        },
        data: { unread_count: { decrement: 3 } },
      });
    });

    it('does not assign zero, so a message arriving mid-read stays unread', async () => {
      prisma.conversations.findFirst.mockResolvedValue({ unread_count: 2 });

      await repository.markRead(BUSINESS_ID, CONVERSATION_ID);

      // `set: 0` here would mark a third message seen by an operator who never
      // saw it; `decrement: 2` against a counter that has since become 3
      // leaves it at 1.
      const { data } = prisma.conversations.updateMany.mock.calls[0]![0];
      expect(data.unread_count).toEqual({ decrement: 2 });
      expect(data.unread_count).not.toHaveProperty('set');
    });

    it('reports nothing cleared when a concurrent reader got there first', async () => {
      // The guard matched no rows: the counter had already dropped below the
      // observed value, so this call cleared nothing and must not claim it did.
      prisma.conversations.findFirst.mockResolvedValue({ unread_count: 4 });
      prisma.conversations.updateMany.mockResolvedValue({ count: 0 });

      await expect(repository.markRead(BUSINESS_ID, CONVERSATION_ID)).resolves.toBe(0);
    });

    it('skips the write entirely on an already-read conversation', async () => {
      prisma.conversations.findFirst.mockResolvedValue({ unread_count: 0 });

      await expect(repository.markRead(BUSINESS_ID, CONVERSATION_ID)).resolves.toBe(0);
      expect(prisma.conversations.updateMany).not.toHaveBeenCalled();
    });

    it('scopes the lookup to the tenant and skips soft-deleted rows', async () => {
      prisma.conversations.findFirst.mockResolvedValue({ unread_count: 1 });

      await repository.markRead(BUSINESS_ID, CONVERSATION_ID);

      expect(prisma.conversations.findFirst.mock.calls[0]![0].where).toEqual({
        id: CONVERSATION_ID,
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
    });

    it('refuses to clear a conversation belonging to another business', async () => {
      prisma.conversations.findFirst.mockResolvedValue(null);

      await expect(repository.markRead(BUSINESS_ID, CONVERSATION_ID)).rejects.toThrow(
        ResourceNotFoundError,
      );
      expect(prisma.conversations.updateMany).not.toHaveBeenCalled();
    });
  });

  it('increments the human message counter', async () => {
    await repository.incrementHumanMessageCount(BUSINESS_ID, CONVERSATION_ID);

    expect(prisma.conversations.update.mock.calls[0]![0].data).toEqual({
      human_message_count: { increment: 1 },
    });
  });

  it('unassigns by writing null', async () => {
    await repository.assign(BUSINESS_ID, CONVERSATION_ID, null);

    expect(prisma.conversations.update.mock.calls[0]![0].data).toEqual({ assigned_to: null });
  });

  // ── Aggregates ───────────────────────────────

  describe('countActiveByAssignees', () => {
    it('returns an empty map and issues no query for an empty agent list', async () => {
      await expect(repository.countActiveByAssignees(BUSINESS_ID, [])).resolves.toEqual({});
      expect(prisma.conversations.groupBy).not.toHaveBeenCalled();
    });

    it('reports zero for agents with no active threads', async () => {
      prisma.conversations.groupBy.mockResolvedValue([
        { assigned_to: AGENT_A, _count: { assigned_to: 3 } },
      ]);

      await expect(
        repository.countActiveByAssignees(BUSINESS_ID, [AGENT_A, AGENT_B]),
      ).resolves.toEqual({ [AGENT_A]: 3, [AGENT_B]: 0 });
    });

    it('drops the null-assignee bucket Prisma may return', async () => {
      prisma.conversations.groupBy.mockResolvedValue([
        { assigned_to: null, _count: { assigned_to: 7 } },
        { assigned_to: AGENT_A, _count: { assigned_to: 1 } },
      ]);

      await expect(
        repository.countActiveByAssignees(BUSINESS_ID, [AGENT_A]),
      ).resolves.toEqual({ [AGENT_A]: 1 });
    });
  });

  it('flattens the status grouping into a map', async () => {
    prisma.conversations.groupBy.mockResolvedValue([
      { status: 'OPEN', _count: { status: 4 } },
      { status: 'RESOLVED', _count: { status: 9 } },
    ]);

    await expect(repository.countByStatus(BUSINESS_ID)).resolves.toEqual({
      OPEN: 4,
      RESOLVED: 9,
    });
  });

  describe('getResolutionStats', () => {
    it('reports zeroes when nothing has been resolved', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { resolved_count: 0, avg_resolution_seconds: null },
      ]);

      await expect(repository.getResolutionStats(BUSINESS_ID)).resolves.toEqual({
        resolvedCount: 0,
        avgResolutionSeconds: 0,
      });
    });

    it('reports zeroes when the aggregate returns no row at all', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(repository.getResolutionStats(BUSINESS_ID)).resolves.toEqual({
        resolvedCount: 0,
        avgResolutionSeconds: 0,
      });
    });

    it('returns the database-computed count and average', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { resolved_count: 2, avg_resolution_seconds: 1200 },
      ]);

      await expect(repository.getResolutionStats(BUSINESS_ID)).resolves.toEqual({
        resolvedCount: 2,
        avgResolutionSeconds: 1200,
      });
    });

    it('rounds a fractional average to whole seconds', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { resolved_count: 3, avg_resolution_seconds: 1200.6 },
      ]);

      const stats = await repository.getResolutionStats(BUSINESS_ID);

      expect(stats.avgResolutionSeconds).toBe(1201);
    });

    it('aggregates in the database rather than reading the resolved rows', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { resolved_count: 1, avg_resolution_seconds: 60 },
      ]);

      await repository.getResolutionStats(BUSINESS_ID);

      expect(prisma.conversations.findMany).not.toHaveBeenCalled();
      // The tenant and the status are bound parameters, never interpolated
      // into the SQL text.
      expect(prisma.$queryRaw.mock.calls[0]?.slice(1)).toEqual([
        BUSINESS_ID,
        ConversationStatus.RESOLVED,
      ]);
      const sql = (prisma.$queryRaw.mock.calls[0]?.[0] as string[]).join('?');
      expect(sql).toContain('business_id =');
      expect(sql).not.toContain(BUSINESS_ID);
    });
  });

  describe('findSnoozedDue', () => {
    it('finds snoozed conversations whose wake time has passed', async () => {
      const now = new Date('2026-08-10T12:00:00Z');

      await repository.findSnoozedDue(BUSINESS_ID, now);

      expect(prisma.conversations.findMany.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
        status: ConversationStatus.SNOOZED,
        snoozed_until: { not: null, lte: now },
        deleted_at: null,
      });
    });

    it('claims a bounded batch, oldest wake time first', async () => {
      await repository.findSnoozedDue(BUSINESS_ID, new Date());

      const call = prisma.conversations.findMany.mock.calls[0]![0];
      expect(call.take).toBe(SNOOZE_WAKE_BATCH_SIZE);
      expect(call.orderBy).toEqual({ snoozed_until: 'asc' });
    });

    it('honours a caller-supplied batch size', async () => {
      await repository.findSnoozedDue(BUSINESS_ID, new Date(), 25);

      expect(prisma.conversations.findMany.mock.calls[0]![0].take).toBe(25);
    });
  });
});

// ─────────────────────────────────────────────
// releaseAssignments
// ─────────────────────────────────────────────

describe('ConversationRepository.releaseAssignments', () => {
  let repository: ConversationRepository;
  let conversations: Record<'findMany' | 'updateMany', jest.Mock>;

  beforeEach(async () => {
    conversations = {
      findMany: jest.fn().mockResolvedValue([{ id: CONVERSATION_ID }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationRepository,
        { provide: PrismaService, useValue: { conversations } },
      ],
    }).compile();
    repository = module.get(ConversationRepository);
  });

  it('clears the assignee on the live conversations that member held', async () => {
    const released = await repository.releaseAssignments(BUSINESS_ID, AGENT_A);

    expect(released).toEqual([CONVERSATION_ID]);
    expect(conversations.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assigned_to: null } }),
    );
  });

  it('scopes the release to the tenant and to that one assignee', async () => {
    // Without `assigned_to` in the WHERE this unassigns the entire business.
    await repository.releaseAssignments(BUSINESS_ID, AGENT_A);

    const { where } = conversations.updateMany.mock.calls[0]![0];
    expect(where).toMatchObject({
      business_id: BUSINESS_ID,
      assigned_to: AGENT_A,
      deleted_at: null,
    });
  });

  it('leaves RESOLVED conversations assigned, because that field is now history', async () => {
    // On a closed conversation `assigned_to` records who handled it. Clearing
    // it would rewrite the record and skew per-agent resolution stats.
    await repository.releaseAssignments(BUSINESS_ID, AGENT_A);

    const { where } = conversations.updateMany.mock.calls[0]![0];
    expect(where.status).toEqual({ not: ConversationStatus.RESOLVED });
  });

  it('reads and writes over the same predicate, so the log matches what moved', async () => {
    await repository.releaseAssignments(BUSINESS_ID, AGENT_A);

    expect(conversations.findMany.mock.calls[0]![0].where).toEqual(
      conversations.updateMany.mock.calls[0]![0].where,
    );
  });

  it('writes nothing at all when the member held no live conversations', async () => {
    conversations.findMany.mockResolvedValue([]);

    await expect(repository.releaseAssignments(BUSINESS_ID, AGENT_A)).resolves.toEqual([]);
    expect(conversations.updateMany).not.toHaveBeenCalled();
  });

  it('caps the findMany to avoid unbounded reads', async () => {
    await repository.releaseAssignments(BUSINESS_ID, AGENT_A);

    const { take } = conversations.findMany.mock.calls[0]![0];
    expect(take).toBe(500);
  });
});
