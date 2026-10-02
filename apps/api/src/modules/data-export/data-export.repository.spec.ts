/**
 * Tenant scoping for the export reads.
 *
 * This module reads across eight tables that other modules own, which is the
 * one place the "never query another module's tables" rule bends. The price of
 * that is that the isolation cannot be inherited from anybody else's
 * repository — every WHERE clause here is on its own. And it is the worst
 * surface in the API to get wrong: one missing `business_id` returns a
 * stranger's entire message history to whoever guessed a UUID.
 *
 * So this spec asserts the shape of the queries rather than their results.
 */
import { DataExportRepository } from './data-export.repository';
import type { PrismaService } from '../../common/services/prisma.service';
import {
  MAX_EXPORT_CONVERSATIONS,
  MAX_EXPORT_MESSAGES,
  MAX_EXPORT_RECORDS_PER_SECTION,
} from './data-export.constants';

/** Only the three fields the repository actually reads off a client. */
const clientRow = (phone: string | null = '+919876543210') =>
  ({ id: 'client-1', business_id: 'b1', phone }) as unknown as Parameters<
    DataExportRepository['collect']
  >[1];

const CLIENT = clientRow();

/** Every model the repository touches, each recording the args it was given. */
function makePrisma() {
  const model = () => ({
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    findFirst: jest.fn().mockResolvedValue(null),
  });
  return {
    clients: model(),
    channel_contacts: model(),
    conversations: model(),
    messages: model(),
    orders: model(),
    payments: model(),
    bookings: model(),
    notifications: model(),
    consent_logs: model(),
    ai_decisions: model(),
  };
}

type MockPrisma = ReturnType<typeof makePrisma>;

/** Every `where` this repository built during one call, flattened. */
function allWheres(prisma: MockPrisma): Array<Record<string, unknown>> {
  return Object.values(prisma).flatMap((m) =>
    [...m.findMany.mock.calls, ...m.count.mock.calls, ...m.findFirst.mock.calls]
      .map((call) => (call[0] as { where?: Record<string, unknown> })?.where)
      .filter((w): w is Record<string, unknown> => Boolean(w)),
  );
}

describe('DataExportRepository — tenant scoping', () => {
  let prisma: MockPrisma;
  let repository: DataExportRepository;

  beforeEach(() => {
    prisma = makePrisma();
    repository = new DataExportRepository(prisma as unknown as PrismaService);
  });

  it('names business_id in every single query it makes', async () => {
    await repository.collect('b1', CLIENT);

    const wheres = allWheres(prisma);
    expect(wheres.length).toBeGreaterThan(8);
    for (const where of wheres) {
      expect(where['business_id']).toBe('b1');
    }
  });

  it('scopes the client lookup to the tenant, so a foreign UUID finds nothing', async () => {
    await repository.findClient('b1', 'client-1');

    expect(prisma.clients.findFirst).toHaveBeenCalledWith({
      where: { id: 'client-1', business_id: 'b1', deleted_at: null },
    });
  });

  it('scopes an identifier lookup to the tenant', async () => {
    // Otherwise a phone number is a platform-wide search: the same person is a
    // customer of several businesses on this deployment.
    await repository.findClientByIdentifier('b1', { phone: '+919876543210' });

    const args = prisma.clients.findFirst.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(args.where['business_id']).toBe('b1');
  });

  it('refuses to search when neither identifier is given', async () => {
    // An empty OR array matches every row in the tenant, and `findFirst` would
    // return an arbitrary customer as if it were the one asked for.
    const found = await repository.findClientByIdentifier('b1', {});

    expect(found).toBeNull();
    expect(prisma.clients.findFirst).not.toHaveBeenCalled();
  });

  it('case-folds the email, since addresses are stored lowercased', async () => {
    await repository.findClientByIdentifier('b1', { email: 'Asha@Example.IN' });

    const args = prisma.clients.findFirst.mock.calls[0]?.[0] as {
      where: { OR: Array<Record<string, string>> };
    };
    expect(args.where.OR).toContainEqual({ email: 'asha@example.in' });
  });
});

describe('DataExportRepository — bounds', () => {
  let prisma: MockPrisma;
  let repository: DataExportRepository;

  beforeEach(() => {
    prisma = makePrisma();
    repository = new DataExportRepository(prisma as unknown as PrismaService);
  });

  const takeOf = (model: { findMany: jest.Mock }): number | undefined =>
    (model.findMany.mock.calls[0]?.[0] as { take?: number })?.take;

  it('caps every collection it returns', async () => {
    // Nothing else in this API returns an unbounded set, and a five-year
    // WhatsApp thread is tens of thousands of rows.
    await repository.collect('b1', CLIENT);

    expect(takeOf(prisma.conversations)).toBe(MAX_EXPORT_CONVERSATIONS);
    expect(takeOf(prisma.orders)).toBe(MAX_EXPORT_RECORDS_PER_SECTION);
    expect(takeOf(prisma.payments)).toBe(MAX_EXPORT_RECORDS_PER_SECTION);
    expect(takeOf(prisma.bookings)).toBe(MAX_EXPORT_RECORDS_PER_SECTION);
    expect(takeOf(prisma.notifications)).toBe(MAX_EXPORT_RECORDS_PER_SECTION);
    expect(takeOf(prisma.channel_contacts)).toBe(MAX_EXPORT_RECORDS_PER_SECTION);
  });

  it('keeps the newest records when a section is truncated', async () => {
    // An access request is nearly always about something recent, and the
    // oldest messages are the ones the retention sweep may already have
    // anonymized.
    prisma.conversations.findMany.mockResolvedValue([{ id: 'c-1' }]);

    await repository.collect('b1', CLIENT);

    const args = prisma.messages.findMany.mock.calls[0]?.[0] as {
      orderBy: Record<string, string>;
      take: number;
    };
    expect(args.orderBy).toEqual({ created_at: 'desc' });
    expect(args.take).toBe(MAX_EXPORT_MESSAGES);
  });

  it('does not query messages at all when there are no conversations', async () => {
    // `conversation_id: { in: [] }` matches nothing, so the query is pure cost.
    await repository.collect('b1', CLIENT);

    expect(prisma.messages.findMany).not.toHaveBeenCalled();
  });

  it('excludes soft-deleted rows from every table that has the column', async () => {
    await repository.collect('b1', CLIENT);

    for (const model of [prisma.conversations, prisma.orders, prisma.bookings]) {
      const where = (model.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> })
        .where;
      expect(where['deleted_at']).toBeNull();
    }
  });
});

describe('DataExportRepository — counts', () => {
  let prisma: MockPrisma;
  let repository: DataExportRepository;

  beforeEach(() => {
    prisma = makePrisma();
    repository = new DataExportRepository(prisma as unknown as PrismaService);
  });

  it('uses raw SQL subqueries for message and AI-decision counts', async () => {
    // The old approach loaded every conversation id into a JS array and
    // passed it back as an IN list — unbounded for a long-tenured client.
    // The replacement pushes both counts into the database.
    prisma.conversations.count.mockResolvedValue(1);
    (prisma as Record<string, unknown>).$queryRaw = jest
      .fn()
      .mockResolvedValue([{ message_count: 42, ai_decision_count: 7 }]);

    const counts = await repository.countAll('b1', CLIENT);

    expect(counts.messages).toBe(42);
    expect(counts.aiDecisions).toBe(7);
    expect((prisma as Record<string, unknown>).$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.messages.count).not.toHaveBeenCalled();
    expect(prisma.ai_decisions.count).not.toHaveBeenCalled();
  });

  it('skips the raw query when conversation count is zero', async () => {
    (prisma as Record<string, unknown>).$queryRaw = jest.fn();

    const counts = await repository.countAll('b1', CLIENT);

    expect(counts.messages).toBe(0);
    expect(counts.aiDecisions).toBe(0);
    expect((prisma as Record<string, unknown>).$queryRaw).not.toHaveBeenCalled();
  });

  it('reports no consents for a client with no phone on file', async () => {
    // `consent_logs` identifies the data principal by E.164 phone — it is
    // shared with the realty lead ledger. No phone means no consent trail to
    // find, which is correct rather than a gap.
    const counts = await repository.countAll('b1', clientRow(null));

    expect(counts.consents).toBe(0);
    expect(prisma.consent_logs.count).not.toHaveBeenCalled();
  });
});
