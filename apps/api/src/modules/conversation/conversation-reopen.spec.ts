/**
 * Conversation round-trip lifecycle tests.
 *
 * The other conversation specs stub one repository call per assertion, which
 * is fine for branch coverage but cannot see a *sequence* going wrong. These
 * drive the real service against a small in-memory store that mimics the
 * Prisma-backed repository, so open → resolve → reply and open → snooze →
 * reply are exercised end to end.
 *
 * This is the shape that caught the duplicate-thread bug: the old
 * `findActiveByClientAndChannel` filtered RESOLVED out of the lookup, so a
 * client writing back after resolution silently got a *second* conversation
 * and their history forked. Per-call mocks happily returned `null` and agreed
 * with themselves; only replaying the sequence shows the fork.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bull';
import {
  ChannelType,
  ConversationStatus,
  MessageReceivedEvent,
} from '@gosumo/shared';

import { ConversationService } from './conversation.service';
import { ConversationRepository } from './conversation.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { CONVERSATION_QUEUE } from './conversation.constants';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_BUSINESS_ID = '1111aaaa-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_CLIENT_ID = '2222bbbb-2222-2222-2222-222222222222';
const CHANNEL_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_CHANNEL_ACCOUNT_ID = '3333cccc-3333-3333-3333-333333333333';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

interface Row {
  id: string;
  business_id: string;
  client_id: string;
  channel_account_id: string;
  channel: ChannelType;
  status: ConversationStatus;
  assigned_to: string | null;
  first_message_at: Date;
  last_message_at: Date;
  resolved_at: Date | null;
  snoozed_until: Date | null;
  message_count: number;
  unread_count: number;
  human_message_count: number;
  csat_score: number | null;
  csat_submitted_at: Date | null;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface CreateArgs {
  businessId: string;
  clientId: string;
  channelAccountId: string;
  channel: ChannelType;
}

interface UpdateArgs {
  status?: ConversationStatus;
  assignedTo?: string | null;
  resolvedAt?: Date | null;
  snoozedUntil?: Date | null;
  csatScore?: number;
  csatSubmittedAt?: Date;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * In-memory stand-in for ConversationRepository. Mirrors the real query
 * semantics that matter here: business scoping, soft-delete exclusion,
 * newest-thread-wins ordering, and resolved_at being set on RESOLVED and
 * cleared on reopen.
 */
function createStore() {
  const rows: Row[] = [];
  let seq = 0;

  const insert = (overrides: Partial<Row> = {}): Row => {
    seq += 1;
    const now = new Date(Date.UTC(2026, 5, 20, 10, seq));
    const row: Row = {
      id: `conv-${seq}`,
      business_id: BUSINESS_ID,
      client_id: CLIENT_ID,
      channel_account_id: CHANNEL_ACCOUNT_ID,
      channel: ChannelType.WHATSAPP,
      status: ConversationStatus.OPEN,
      assigned_to: null,
      first_message_at: now,
      last_message_at: now,
      resolved_at: null,
      snoozed_until: null,
      message_count: 0,
      unread_count: 0,
      human_message_count: 0,
      csat_score: null,
      csat_submitted_at: null,
      tags: [],
      metadata: {},
      created_at: now,
      updated_at: now,
      deleted_at: null,
      ...overrides,
    };
    rows.push(row);
    return row;
  };

  const repository = {
    findById: jest.fn(async (businessId: string, id: string) =>
      rows.find(
        (r) => r.id === id && r.business_id === businessId && !r.deleted_at,
      ) ?? null,
    ),

    findLatestByClientAndChannel: jest.fn(
      async (businessId: string, clientId: string, channelAccountId: string) =>
        rows
          .filter(
            (r) =>
              r.business_id === businessId &&
              r.client_id === clientId &&
              r.channel_account_id === channelAccountId &&
              !r.deleted_at,
          )
          .sort(
            (a, b) => b.last_message_at.getTime() - a.last_message_at.getTime(),
          )[0] ?? null,
    ),

    create: jest.fn(async (data: CreateArgs) =>
      insert({
        business_id: data.businessId,
        client_id: data.clientId,
        channel_account_id: data.channelAccountId,
        channel: data.channel,
      }),
    ),

    // The conditional write the service now uses. Modelled faithfully: the
    // update only lands when the row is still in `expected`, which is what lets
    // this suite exercise a lost race rather than assume one cannot happen.
    transitionStatus: jest.fn(
      async (
        businessId: string,
        id: string,
        expected: ConversationStatus,
        status: ConversationStatus,
        extra: UpdateArgs = {},
      ) => {
        const row = rows.find(
          (r) => r.id === id && r.business_id === businessId && !r.deleted_at,
        );
        if (!row || row.status !== expected) return null;

        row.status = status;
        if (status === ConversationStatus.RESOLVED) {
          row.resolved_at = extra.resolvedAt ?? new Date();
        } else if (status === ConversationStatus.OPEN) {
          row.resolved_at = null;
        } else if (extra.resolvedAt !== undefined) {
          row.resolved_at = extra.resolvedAt;
        }
        if (extra.assignedTo !== undefined) row.assigned_to = extra.assignedTo;
        if (extra.snoozedUntil !== undefined) row.snoozed_until = extra.snoozedUntil;
        if (extra.csatScore !== undefined) row.csat_score = extra.csatScore;
        if (extra.csatSubmittedAt !== undefined) {
          row.csat_submitted_at = extra.csatSubmittedAt;
        }
        return row;
      },
    ),

    updateStatus: jest.fn(
      async (businessId: string, id: string, status: ConversationStatus) => {
        const row = rows.find(
          (r) => r.id === id && r.business_id === businessId,
        )!;
        row.status = status;
        if (status === ConversationStatus.RESOLVED) row.resolved_at = new Date();
        else if (status === ConversationStatus.OPEN) row.resolved_at = null;
        return row;
      },
    ),

    update: jest.fn(
      async (businessId: string, id: string, data: UpdateArgs) => {
        const row = rows.find(
          (r) => r.id === id && r.business_id === businessId && !r.deleted_at,
        )!;
        if (data.status !== undefined) row.status = data.status;
        if (data.assignedTo !== undefined) row.assigned_to = data.assignedTo;
        if (data.resolvedAt !== undefined) row.resolved_at = data.resolvedAt;
        if (data.snoozedUntil !== undefined) row.snoozed_until = data.snoozedUntil;
        if (data.csatScore !== undefined) row.csat_score = data.csatScore;
        if (data.csatSubmittedAt !== undefined) {
          row.csat_submitted_at = data.csatSubmittedAt;
        }
        if (data.tags !== undefined) row.tags = data.tags;
        if (data.metadata !== undefined) row.metadata = data.metadata;
        return row;
      },
    ),

    updateLastMessageAt: jest.fn(
      async (businessId: string, id: string, at: Date) => {
        const row = rows.find(
          (r) => r.id === id && r.business_id === businessId,
        )!;
        row.last_message_at = at;
        row.message_count += 1;
        return row;
      },
    ),

    incrementHumanMessageCount: jest.fn(),
    findSnoozedDue: jest.fn(async (businessId: string, now: Date) =>
      rows.filter(
        (r) =>
          r.business_id === businessId &&
          r.status === ConversationStatus.SNOOZED &&
          r.snoozed_until !== null &&
          r.snoozed_until <= now,
      ),
    ),
    list: jest.fn(),
    assign: jest.fn(),
    countActiveByAssignees: jest.fn(),
    countByStatus: jest.fn(),
    getResolutionStats: jest.fn(),
  };

  return { rows, insert, repository };
}

function inboundMessage(
  overrides: Partial<MessageReceivedEvent> = {},
): MessageReceivedEvent {
  return {
    type: 'message.received',
    id: '77777777-7777-7777-7777-777777777777',
    timestamp: new Date().toISOString(),
    businessId: BUSINESS_ID,
    correlationId: 'gs-test-corr',
    messageId: '55555555-5555-5555-5555-555555555555',
    conversationId: '',
    channelAccountId: CHANNEL_ACCOUNT_ID,
    channel: ChannelType.WHATSAPP,
    senderExternalId: '919876543210',
    clientId: CLIENT_ID,
    ...overrides,
  } as MessageReceivedEvent;
}

describe('ConversationService — reopen round trip', () => {
  let service: ConversationService;
  let store: ReturnType<typeof createStore>;
  let eventEmitter: { emit: jest.Mock };
  let queue: { add: jest.Mock };
  let prisma: { tasks: { count: jest.Mock }; messages: Record<string, jest.Mock> };

  const statusChanges = (): Array<{ previousStatus: string; newStatus: string }> =>
    eventEmitter.emit.mock.calls
      .filter(([name]) => name === 'conversation.status.changed')
      .map(([, payload]) => payload as { previousStatus: string; newStatus: string });

  beforeEach(async () => {
    store = createStore();
    eventEmitter = { emit: jest.fn() };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      tasks: { count: jest.fn().mockResolvedValue(0) },
      messages: { findMany: jest.fn(), findFirst: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: ConversationRepository, useValue: store.repository },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: getQueueToken(CONVERSATION_QUEUE), useValue: queue },
        {
          provide: TenantService,
          useValue: { assertTeamMember: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(ConversationService);
  });

  // ─── open → resolve → reopen ─────────────────

  describe('open → resolve → client replies', () => {
    it('reopens the resolved thread instead of forking a second one', async () => {
      const opened = await service.findOrCreate(BUSINESS_ID, {
        clientId: CLIENT_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
      });
      await service.resolveConversation(BUSINESS_ID, opened.id, {
        resolvedBy: 'HUMAN',
        actorId: AGENT_A,
        csatScore: 5,
      });
      expect(store.rows[0]!.status).toBe(ConversationStatus.RESOLVED);

      await service.handleMessageReceived(inboundMessage());

      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]!.id).toBe(opened.id);
      expect(store.rows[0]!.status).toBe(ConversationStatus.OPEN);
    });

    it('clears resolved_at so the SLA resolution clock restarts', async () => {
      const opened = await service.findOrCreate(BUSINESS_ID, {
        clientId: CLIENT_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
      });
      await service.resolveConversation(BUSINESS_ID, opened.id);
      expect(store.rows[0]!.resolved_at).toBeInstanceOf(Date);

      await service.handleMessageReceived(inboundMessage());

      expect(store.rows[0]!.resolved_at).toBeNull();
    });

    it('emits RESOLVED → OPEN attributed to SYSTEM, not to the last human actor', async () => {
      const opened = await service.findOrCreate(BUSINESS_ID, {
        clientId: CLIENT_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
      });
      await service.resolveConversation(BUSINESS_ID, opened.id, {
        actorId: AGENT_A,
      });
      eventEmitter.emit.mockClear();

      await service.handleMessageReceived(inboundMessage());

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.status.changed',
        expect.objectContaining({
          conversationId: opened.id,
          previousStatus: ConversationStatus.RESOLVED,
          newStatus: ConversationStatus.OPEN,
          actorId: 'SYSTEM',
        }),
      );
    });

    it('does not re-emit conversation.created for the reopened thread', async () => {
      const opened = await service.findOrCreate(BUSINESS_ID, {
        clientId: CLIENT_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
      });
      await service.resolveConversation(BUSINESS_ID, opened.id);
      eventEmitter.emit.mockClear();

      await service.handleMessageReceived(inboundMessage());

      expect(store.repository.create).toHaveBeenCalledTimes(1);
      expect(
        eventEmitter.emit.mock.calls.filter(
          ([name]) => name === 'conversation.created',
        ),
      ).toHaveLength(0);
    });

    it('survives a second full cycle: resolve → reply → resolve → reply', async () => {
      const opened = await service.findOrCreate(BUSINESS_ID, {
        clientId: CLIENT_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
      });

      for (let i = 0; i < 2; i += 1) {
        await service.resolveConversation(BUSINESS_ID, opened.id);
        await service.handleMessageReceived(inboundMessage());
      }

      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]!.status).toBe(ConversationStatus.OPEN);
      expect(statusChanges().map((c) => `${c.previousStatus}→${c.newStatus}`)).toEqual([
        'OPEN→RESOLVED',
        'RESOLVED→OPEN',
        'OPEN→RESOLVED',
        'RESOLVED→OPEN',
      ]);
    });
  });

  // ─── open → snooze → reopen ──────────────────

  describe('open → snooze → client replies', () => {
    it('wakes the snoozed thread early and keeps it single', async () => {
      const opened = await service.findOrCreate(BUSINESS_ID, {
        clientId: CLIENT_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
      });
      await service.snoozeConversation(
        BUSINESS_ID,
        opened.id,
        new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        AGENT_A,
      );
      expect(queue.add).toHaveBeenCalledTimes(1);

      await service.handleMessageReceived(inboundMessage());

      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]!.status).toBe(ConversationStatus.OPEN);
      expect(statusChanges().map((c) => `${c.previousStatus}→${c.newStatus}`)).toEqual([
        'OPEN→SNOOZED',
        'SNOOZED→OPEN',
      ]);
    });

    it('leaves the already-woken thread alone when the wake job later fires', async () => {
      const opened = await service.findOrCreate(BUSINESS_ID, {
        clientId: CLIENT_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
      });
      await service.snoozeConversation(
        BUSINESS_ID,
        opened.id,
        new Date(Date.now() + 60_000),
        AGENT_A,
      );
      await service.handleMessageReceived(inboundMessage());
      eventEmitter.emit.mockClear();

      // The delayed job fires after the client already reopened the thread.
      const woken = await service.wakeSnoozedConversations(BUSINESS_ID);

      expect(woken).toBe(0);
      expect(store.rows[0]!.status).toBe(ConversationStatus.OPEN);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ─── steady state & scoping ──────────────────

  describe('steady state', () => {
    it('does not touch status when an OPEN thread receives another message', async () => {
      await service.findOrCreate(BUSINESS_ID, {
        clientId: CLIENT_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
      });
      eventEmitter.emit.mockClear();

      await service.handleMessageReceived(inboundMessage());
      await service.handleMessageReceived(inboundMessage());

      expect(store.repository.updateStatus).not.toHaveBeenCalled();
      expect(statusChanges()).toHaveLength(0);
      expect(store.rows[0]!.message_count).toBe(2);
    });

    it('reuses the ESCALATED thread without downgrading it to OPEN', async () => {
      const opened = await service.findOrCreate(BUSINESS_ID, {
        clientId: CLIENT_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
      });
      await service.escalateConversation(BUSINESS_ID, opened.id, {
        reason: 'angry customer',
      });

      await service.handleMessageReceived(inboundMessage());

      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]!.status).toBe(ConversationStatus.ESCALATED);
    });
  });

  describe('thread scoping', () => {
    it('gives a different client on the same channel account its own thread', async () => {
      await service.findOrCreate(BUSINESS_ID, {
        clientId: CLIENT_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
      });

      await service.handleMessageReceived(
        inboundMessage({ clientId: OTHER_CLIENT_ID }),
      );

      expect(store.rows).toHaveLength(2);
      expect(store.rows[1]!.client_id).toBe(OTHER_CLIENT_ID);
    });

    it('gives the same client on a different channel account its own thread', async () => {
      await service.findOrCreate(BUSINESS_ID, {
        clientId: CLIENT_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
      });

      await service.handleMessageReceived(
        inboundMessage({
          channelAccountId: OTHER_CHANNEL_ACCOUNT_ID,
          channel: ChannelType.INSTAGRAM,
        }),
      );

      expect(store.rows).toHaveLength(2);
      expect(store.rows[1]!.channel).toBe(ChannelType.INSTAGRAM);
    });

    it('never reuses another tenant row that shares the client id', async () => {
      store.insert({
        business_id: OTHER_BUSINESS_ID,
        status: ConversationStatus.RESOLVED,
      });

      await service.handleMessageReceived(inboundMessage());

      expect(store.rows).toHaveLength(2);
      expect(store.rows[0]!.status).toBe(ConversationStatus.RESOLVED);
      expect(store.rows[1]!.business_id).toBe(BUSINESS_ID);
    });

    it('starts a fresh thread when the only prior one was soft-deleted', async () => {
      store.insert({
        status: ConversationStatus.RESOLVED,
        deleted_at: new Date(),
      });

      await service.handleMessageReceived(inboundMessage());

      expect(store.rows).toHaveLength(2);
      expect(store.rows[1]!.deleted_at).toBeNull();
      expect(store.rows[1]!.status).toBe(ConversationStatus.OPEN);
    });

    it('reopens the most recent thread when the old bug already left duplicates', async () => {
      // Two rows for the same (business, client, channel account) — the state
      // the pre-fix code could leave behind. The newer one wins.
      const stale = store.insert({
        status: ConversationStatus.RESOLVED,
        last_message_at: new Date('2026-01-01T00:00:00Z'),
      });
      const recent = store.insert({
        status: ConversationStatus.RESOLVED,
        last_message_at: new Date('2026-06-01T00:00:00Z'),
      });

      await service.handleMessageReceived(inboundMessage());

      expect(store.rows).toHaveLength(2);
      expect(recent.status).toBe(ConversationStatus.OPEN);
      expect(stale.status).toBe(ConversationStatus.RESOLVED);
    });
  });
});
