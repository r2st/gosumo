/**
 * MessageRepository unit tests.
 *
 * The repository is a thin Prisma layer, so what is worth pinning here is the
 * three places it *builds* a query rather than forwarding one:
 *
 *  - `findByConversation`'s keyset cursor. The conversation view pages through
 *    this on every scroll, and the `(created_at, id)` tuple comparison has to
 *    be spelled out as an OR because Prisma has no row-value syntax. Getting
 *    the tie-break arm wrong silently drops or repeats messages that share a
 *    timestamp — which same-second bursts routinely do.
 *  - `updateStatus`'s timestamp ternaries. A delivery webhook carries only the
 *    one timestamp it knows about; the others must resolve to `undefined` so
 *    Prisma leaves the column untouched instead of nulling a prior receipt.
 *  - `search`'s optional filters. An omitted filter must not appear in the
 *    clause at all, and a one-sided date range must stay one-sided.
 *
 * Every query must also carry `business_id`; that is asserted throughout.
 * PrismaService is mocked — assertions are on the query the repository builds.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MessageType } from '@prisma/client';
import { MessageDirection, MessageStatus } from '@gosumo/shared';

import { MessageRepository } from './message.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { MAX_SEARCH_RESULTS } from './message.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-b000-000000000001';
const MESSAGE_ID = '00000000-0000-4000-c000-000000000001';

describe('MessageRepository', () => {
  let repository: MessageRepository;
  let prisma: {
    messages: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
    file_uploads: { create: jest.Mock; findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      messages: {
        create: jest.fn().mockResolvedValue({ id: MESSAGE_ID }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: MESSAGE_ID }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      file_uploads: {
        create: jest.fn().mockResolvedValue({ id: 'file-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [MessageRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get<MessageRepository>(MessageRepository);
  });

  /** The args of the most recent `messages.findMany`. */
  function lastFindMany(): { where: Record<string, unknown>; [k: string]: unknown } {
    const calls = prisma.messages.findMany.mock.calls;
    return calls[calls.length - 1]![0];
  }

  // ─────────────────────────────────────────────
  // findByConversation — keyset pagination
  // ─────────────────────────────────────────────

  describe('findByConversation', () => {
    it('scopes to the tenant and conversation, newest first, without a cursor', async () => {
      await repository.findByConversation(BUSINESS_ID, CONVERSATION_ID, { limit: 20 });

      const args = lastFindMany();
      expect(args.where).toEqual({
        business_id: BUSINESS_ID,
        conversation_id: CONVERSATION_ID,
      });
      expect(args.orderBy).toEqual([{ created_at: 'desc' }, { id: 'desc' }]);
      // limit + 1 so the caller can detect a further page without a count query.
      expect(args.take).toBe(21);
    });

    it('expands a cursor into a (created_at, id) tuple comparison', async () => {
      const cursorCreatedAt = '2026-08-01T10:00:00.000Z';

      await repository.findByConversation(BUSINESS_ID, CONVERSATION_ID, {
        limit: 10,
        cursor: { createdAt: cursorCreatedAt, id: 'msg-50' },
      });

      const where = lastFindMany().where as { OR: Record<string, unknown>[] };
      expect(where.OR).toEqual([
        { created_at: { lt: new Date(cursorCreatedAt) } },
        // The tie-break arm: same timestamp, lower id. Without it, messages
        // stored in the same millisecond are skipped across the page boundary.
        { created_at: new Date(cursorCreatedAt), id: { lt: 'msg-50' } },
      ]);
    });
  });

  describe('getLastN', () => {
    it('reads the newest N for the AI context window', async () => {
      await repository.getLastN(BUSINESS_ID, CONVERSATION_ID, 20);

      const args = lastFindMany();
      expect(args.where).toEqual({
        business_id: BUSINESS_ID,
        conversation_id: CONVERSATION_ID,
      });
      expect(args.orderBy).toEqual({ created_at: 'desc' });
      expect(args.take).toBe(20);
    });
  });

  describe('findByExternalId', () => {
    it('looks up the channel-assigned id within the tenant for dedupe', async () => {
      await repository.findByExternalId(BUSINESS_ID, 'wamid.abc123');

      expect(prisma.messages.findFirst).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, external_id: 'wamid.abc123' },
      });
    });
  });

  // ─────────────────────────────────────────────
  // updateStatus — partial timestamp writes
  // ─────────────────────────────────────────────

  describe('updateStatus', () => {
    it('writes only the timestamp the webhook actually carried', async () => {
      await repository.updateStatus(BUSINESS_ID, MESSAGE_ID, MessageStatus.DELIVERED, {
        deliveredAt: '2026-08-01T10:00:00.000Z',
      });

      const args = prisma.messages.update.mock.calls[0]![0];
      expect(args.where).toEqual({ id: MESSAGE_ID, business_id: BUSINESS_ID });
      expect(args.data.delivered_at).toEqual(new Date('2026-08-01T10:00:00.000Z'));
      // undefined, not null — a later read receipt must not be erased by a
      // re-delivered "delivered" callback.
      expect(args.data.read_at).toBeUndefined();
      expect(args.data.failed_at).toBeUndefined();
      expect(args.data.failure_reason).toBeUndefined();
    });

    it('records a read receipt without disturbing the delivery timestamp', async () => {
      await repository.updateStatus(BUSINESS_ID, MESSAGE_ID, MessageStatus.READ, {
        readAt: '2026-08-01T10:05:00.000Z',
      });

      const { data } = prisma.messages.update.mock.calls[0]![0];
      expect(data.read_at).toEqual(new Date('2026-08-01T10:05:00.000Z'));
      expect(data.delivered_at).toBeUndefined();
    });

    it('records a failure with its reason', async () => {
      await repository.updateStatus(BUSINESS_ID, MESSAGE_ID, MessageStatus.FAILED, {
        failedAt: '2026-08-01T10:01:00.000Z',
        failureReason: 'Recipient opted out',
      });

      const { data } = prisma.messages.update.mock.calls[0]![0];
      expect(data.failed_at).toEqual(new Date('2026-08-01T10:01:00.000Z'));
      expect(data.failure_reason).toBe('Recipient opted out');
    });

    it('leaves every timestamp untouched for a status-only transition', async () => {
      await repository.updateStatus(BUSINESS_ID, MESSAGE_ID, MessageStatus.SENT, {});

      const { data } = prisma.messages.update.mock.calls[0]![0];
      expect(data.status).toBe(MessageStatus.SENT);
      expect(data.delivered_at).toBeUndefined();
      expect(data.read_at).toBeUndefined();
      expect(data.failed_at).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────
  // search — optional filters
  // ─────────────────────────────────────────────

  describe('search', () => {
    it('restricts to text-bearing types and caps the result set', async () => {
      await repository.search(BUSINESS_ID, 'invoice', {});

      const args = lastFindMany();
      expect(args.where).toEqual({
        business_id: BUSINESS_ID,
        type: { in: [MessageType.TEXT] },
        text_content: { contains: 'invoice', mode: 'insensitive' },
      });
      expect(args.orderBy).toEqual({ created_at: 'desc' });
      expect(args.take).toBe(MAX_SEARCH_RESULTS);
    });

    it('omits conversation_id and created_at entirely when unfiltered', async () => {
      await repository.search(BUSINESS_ID, 'invoice', {});

      const where = lastFindMany().where;
      expect(where).not.toHaveProperty('conversation_id');
      expect(where).not.toHaveProperty('created_at');
    });

    it('narrows to a single conversation when asked', async () => {
      await repository.search(BUSINESS_ID, 'invoice', { conversationId: CONVERSATION_ID });

      expect(lastFindMany().where.conversation_id).toBe(CONVERSATION_ID);
    });

    it('builds a closed date range from both bounds', async () => {
      await repository.search(BUSINESS_ID, 'invoice', {
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-08-31T23:59:59.000Z',
      });

      expect(lastFindMany().where.created_at).toEqual({
        gte: new Date('2026-08-01T00:00:00.000Z'),
        lte: new Date('2026-08-31T23:59:59.000Z'),
      });
    });

    it('keeps a from-only range open-ended', async () => {
      await repository.search(BUSINESS_ID, 'invoice', { dateFrom: '2026-08-01T00:00:00.000Z' });

      expect(lastFindMany().where.created_at).toEqual({
        gte: new Date('2026-08-01T00:00:00.000Z'),
      });
    });

    it('keeps a to-only range open-ended', async () => {
      await repository.search(BUSINESS_ID, 'invoice', { dateTo: '2026-08-31T23:59:59.000Z' });

      expect(lastFindMany().where.created_at).toEqual({
        lte: new Date('2026-08-31T23:59:59.000Z'),
      });
    });
  });

  // ─────────────────────────────────────────────
  // Writes, attachments, threading, stats
  // ─────────────────────────────────────────────

  describe('create', () => {
    it('applies the TEXT/PENDING defaults and empty metadata', async () => {
      await repository.create({
        business_id: BUSINESS_ID,
        conversation_id: CONVERSATION_ID,
        channel_account_id: 'chan-1',
        direction: MessageDirection.INBOUND,
        sender_type: 'CLIENT',
        content: { type: 'TEXT', text: 'Hello' },
      });

      const { data } = prisma.messages.create.mock.calls[0]![0];
      expect(data).toMatchObject({
        type: MessageType.TEXT,
        status: MessageStatus.PENDING,
        sender_id: null,
        text_content: null,
        external_id: null,
        is_ai_generated: false,
        confidence_score: null,
        ai_decision_id: null,
        metadata: {},
      });
    });

    it('honours explicitly supplied type, status, and AI attribution', async () => {
      await repository.create({
        business_id: BUSINESS_ID,
        conversation_id: CONVERSATION_ID,
        channel_account_id: 'chan-1',
        direction: MessageDirection.OUTBOUND,
        type: MessageType.IMAGE,
        status: MessageStatus.SENT,
        sender_type: 'AI',
        sender_id: 'ai-1',
        content: { type: 'IMAGE', url: 'https://cdn/x.png' },
        text_content: 'a photo',
        external_id: 'wamid.xyz',
        is_ai_generated: true,
        confidence_score: 0.93,
        ai_decision_id: 'dec-1',
        metadata: { source: 'draft' },
      });

      const { data } = prisma.messages.create.mock.calls[0]![0];
      expect(data).toMatchObject({
        type: MessageType.IMAGE,
        status: MessageStatus.SENT,
        is_ai_generated: true,
        confidence_score: 0.93,
        ai_decision_id: 'dec-1',
        metadata: { source: 'draft' },
      });
    });
  });

  describe('attachAIMetadata', () => {
    it('leaves the optional AI fields undefined when only the flag is set', async () => {
      await repository.attachAIMetadata(BUSINESS_ID, MESSAGE_ID, { is_ai_generated: true });

      const { where, data } = prisma.messages.update.mock.calls[0]![0];
      expect(where).toEqual({ id: MESSAGE_ID, business_id: BUSINESS_ID });
      expect(data.is_ai_generated).toBe(true);
      expect(data.confidence_score).toBeUndefined();
      expect(data.ai_decision_id).toBeUndefined();
      // Content is never part of the update — messages are append-only.
      expect(data).not.toHaveProperty('content');
    });
  });

  describe('findFileUploadsByMessage', () => {
    it('excludes soft-deleted attachments and returns them oldest-first', async () => {
      await repository.findFileUploadsByMessage(BUSINESS_ID, MESSAGE_ID);

      expect(prisma.file_uploads.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, message_id: MESSAGE_ID, deleted_at: null },
        orderBy: { created_at: 'asc' },
      });
    });
  });

  describe('findReplies', () => {
    it('matches the reply pointer inside the metadata document', async () => {
      await repository.findReplies(BUSINESS_ID, MESSAGE_ID);

      expect(lastFindMany().where).toEqual({
        business_id: BUSINESS_ID,
        metadata: { path: ['reply_to_message_id'], equals: MESSAGE_ID },
      });
    });
  });

  describe('getStats', () => {
    it('derives outbound from total minus inbound and folds the status groups', async () => {
      prisma.messages.count
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(4) // inbound
        .mockResolvedValueOnce(3); // ai-generated
      prisma.messages.groupBy.mockResolvedValue([
        { status: 'SENT', _count: { status: 7 } },
        { status: 'FAILED', _count: { status: 3 } },
      ]);

      const stats = await repository.getStats(BUSINESS_ID, CONVERSATION_ID);

      expect(stats).toEqual({
        total: 10,
        inbound: 4,
        outbound: 6,
        aiGenerated: 3,
        byStatus: { SENT: 7, FAILED: 3 },
      });
    });

    it('reports zeroes for a conversation with no messages', async () => {
      const stats = await repository.getStats(BUSINESS_ID, CONVERSATION_ID);

      expect(stats).toEqual({
        total: 0,
        inbound: 0,
        outbound: 0,
        aiGenerated: 0,
        byStatus: {},
      });
    });
  });
});
