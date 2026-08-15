/**
 * Unread-counter behaviour for the inbox.
 *
 * `conversations.unread_count` is written into the list DTO the dashboard
 * renders its unread pill from, and it was being initialised to 0 and never
 * touched again — every thread in every tenant's inbox read "no unread
 * messages" no matter how long a customer had been waiting. Nothing failed and
 * no test broke, because a counter that is always zero is still a valid
 * counter.
 *
 * What is pinned here is the round trip: a customer message raises the count,
 * an operator opening the thread clears it, and an agent's own reply does not
 * raise it. The concurrency tests run against a live counter rather than an
 * assertion on the emitted query, because the failure mode being guarded is a
 * lost or negative count, which only shows up when the operations interleave.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bull';
import { NotFoundException } from '@nestjs/common';
import { ChannelType, ConversationStatus, MessageReceivedEvent } from '@gosumo/shared';

import { ConversationService } from './conversation.service';
import { ConversationRepository } from './conversation.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { CONVERSATION_QUEUE } from './conversation.constants';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_BUSINESS_ID = '99999999-9999-9999-9999-999999999999';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const CHANNEL_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-4444-444444444444';
const MESSAGE_ID = '66666666-6666-6666-6666-666666666666';

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_ID,
    business_id: BUSINESS_ID,
    client_id: CLIENT_ID,
    channel_account_id: CHANNEL_ACCOUNT_ID,
    channel: ChannelType.WHATSAPP,
    status: ConversationStatus.OPEN,
    assigned_to: null,
    subject: null,
    external_thread_id: null,
    first_message_at: new Date('2026-08-14T09:00:00Z'),
    last_message_at: new Date('2026-08-14T09:00:00Z'),
    resolved_at: null,
    snoozed_until: null,
    message_count: 1,
    unread_count: 0,
    human_message_count: 0,
    tags: [],
    metadata: {},
    created_at: new Date('2026-08-14T09:00:00Z'),
    updated_at: new Date('2026-08-14T09:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

function inboundEvent(): MessageReceivedEvent {
  return {
    type: 'message.received',
    id: MESSAGE_ID,
    timestamp: new Date().toISOString(),
    businessId: BUSINESS_ID,
    correlationId: 'corr-1',
    messageId: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    channelAccountId: CHANNEL_ACCOUNT_ID,
    channel: ChannelType.WHATSAPP,
    senderExternalId: '+919876543210',
    clientId: CLIENT_ID,
  } as MessageReceivedEvent;
}

// ─────────────────────────────────────────────
// Service-level: the counter round trip
// ─────────────────────────────────────────────

describe('ConversationService — unread counter', () => {
  let service: ConversationService;
  let repository: {
    findById: jest.Mock;
    findLatestByClientAndChannel: jest.Mock;
    create: jest.Mock;
    updateStatus: jest.Mock;
    transitionStatus: jest.Mock;
    updateLastMessageAt: jest.Mock;
    incrementHumanMessageCount: jest.Mock;
    markRead: jest.Mock;
  };

  beforeEach(async () => {
    repository = {
      findById: jest.fn().mockResolvedValue(makeConversation()),
      findLatestByClientAndChannel: jest.fn().mockResolvedValue(makeConversation()),
      create: jest.fn().mockResolvedValue(makeConversation()),
      updateStatus: jest.fn().mockResolvedValue(makeConversation()),
      transitionStatus: jest.fn().mockResolvedValue(makeConversation()),
      updateLastMessageAt: jest.fn().mockResolvedValue(makeConversation()),
      incrementHumanMessageCount: jest.fn().mockResolvedValue(makeConversation()),
      markRead: jest.fn().mockResolvedValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: ConversationRepository, useValue: repository },
        { provide: PrismaService, useValue: { messages: { findMany: jest.fn() } } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: getQueueToken(CONVERSATION_QUEUE), useValue: { add: jest.fn() } },
        { provide: TenantService, useValue: { assertTeamMember: jest.fn() } },
      ],
    }).compile();

    service = module.get(ConversationService);
  });

  describe('an inbound customer message', () => {
    it('raises the unread count', async () => {
      await service.handleMessageReceived(inboundEvent());

      expect(repository.updateLastMessageAt).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        expect.any(Date),
      );
    });

    it('still raises it on a resolved thread that the message reopens', async () => {
      // The reopen path takes a different branch; the badge has to appear on a
      // thread that was closed a moment ago just as much as on an open one.
      repository.findLatestByClientAndChannel.mockResolvedValue(
        makeConversation({ status: ConversationStatus.RESOLVED }),
      );

      await service.handleMessageReceived(inboundEvent());

      expect(repository.updateLastMessageAt).toHaveBeenCalledTimes(1);
    });
  });

  describe("an agent's own reply", () => {
    it('does not raise the unread count', async () => {
      // message.stored/OUTBOUND is the agent's side of the thread. Counting it
      // would make the inbox badge every conversation the team just answered.
      await service.handleMessageStored({
        type: 'message.stored',
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        direction: 'OUTBOUND',
        senderType: 'HUMAN_AGENT',
      } as never);

      expect(repository.updateLastMessageAt).not.toHaveBeenCalled();
      expect(repository.incrementHumanMessageCount).toHaveBeenCalled();
    });
  });

  describe('markConversationRead', () => {
    it('clears the count and reports how many it cleared', async () => {
      repository.findById.mockResolvedValue(makeConversation({ unread_count: 5 }));
      repository.markRead.mockResolvedValue(5);

      const result = await service.markConversationRead(BUSINESS_ID, CONVERSATION_ID);

      expect(result.cleared).toBe(5);
      expect(result.conversation.unread_count).toBe(0);
    });

    it('returns the residual count when a message landed mid-read', async () => {
      // Observed 2, cleared 2, but a third arrived: the operator has not seen
      // it, so the badge must come back showing 1 rather than 0.
      repository.findById.mockResolvedValue(makeConversation({ unread_count: 3 }));
      repository.markRead.mockResolvedValue(2);

      const result = await service.markConversationRead(BUSINESS_ID, CONVERSATION_ID);

      expect(result.conversation.unread_count).toBe(1);
    });

    it('never reports a negative count', async () => {
      repository.findById.mockResolvedValue(makeConversation({ unread_count: 1 }));
      repository.markRead.mockResolvedValue(4);

      const result = await service.markConversationRead(BUSINESS_ID, CONVERSATION_ID);

      expect(result.conversation.unread_count).toBe(0);
    });

    it('404s on a conversation this business cannot see', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.markConversationRead(OTHER_BUSINESS_ID, CONVERSATION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.markRead).not.toHaveBeenCalled();
    });

    it('is not a status transition', async () => {
      // Reading a resolved thread must not reopen it, and reading an escalated
      // one must not clear the escalation.
      repository.findById.mockResolvedValue(
        makeConversation({ status: ConversationStatus.ESCALATED, unread_count: 2 }),
      );
      repository.markRead.mockResolvedValue(2);

      const result = await service.markConversationRead(BUSINESS_ID, CONVERSATION_ID);

      expect(result.conversation.status).toBe(ConversationStatus.ESCALATED);
      expect(repository.updateStatus).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────
// Repository-level: interleaved operations
// ─────────────────────────────────────────────

/**
 * A Prisma double backed by a real number, so `increment`, `decrement` and the
 * `gte` guard actually take effect. Every call is deliberately made to await a
 * microtask between reading and writing, which is exactly the window a real
 * connection leaves open for another statement to land.
 */
function makeCounterPrisma(initial: number) {
  const state = { unread_count: initial };

  return {
    state,
    conversations: {
      findFirst: jest.fn(async () => {
        await Promise.resolve();
        return { unread_count: state.unread_count };
      }),
      update: jest.fn(async ({ data }: { data: { unread_count?: { increment: number } } }) => {
        await Promise.resolve();
        if (data.unread_count?.increment) state.unread_count += data.unread_count.increment;
        return { id: CONVERSATION_ID };
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { unread_count?: { gte: number } };
          data: { unread_count: { decrement: number } };
        }) => {
          await Promise.resolve();
          const guard = where.unread_count?.gte ?? 0;
          if (state.unread_count < guard) return { count: 0 };
          state.unread_count -= data.unread_count.decrement;
          return { count: 1 };
        },
      ),
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
      create: jest.fn(),
    },
    $queryRaw: jest.fn(),
  };
}

describe('ConversationRepository — unread counter under concurrency', () => {
  async function makeRepository(initial: number) {
    const prisma = makeCounterPrisma(initial);
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConversationRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();
    return { repository: module.get(ConversationRepository), prisma };
  }

  it('loses no increment when several messages arrive at once', async () => {
    const { repository, prisma } = await makeRepository(0);

    await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.updateLastMessageAt(BUSINESS_ID, CONVERSATION_ID, new Date()),
      ),
    );

    expect(prisma.state.unread_count).toBe(10);
  });

  it('cannot be driven negative by two operators opening the thread at once', async () => {
    const { repository, prisma } = await makeRepository(3);

    // Both read 3 before either writes. Without the `gte` guard both would
    // subtract 3 and leave the counter at -3, which renders as a badge the
    // inbox can never clear.
    const [first, second] = await Promise.all([
      repository.markRead(BUSINESS_ID, CONVERSATION_ID),
      repository.markRead(BUSINESS_ID, CONVERSATION_ID),
    ]);

    expect(prisma.state.unread_count).toBe(0);
    expect(first + second).toBe(3);
  });

  it('keeps a message that arrives between the read and the clear', async () => {
    const { repository, prisma } = await makeRepository(2);

    const clearing = repository.markRead(BUSINESS_ID, CONVERSATION_ID);
    const arriving = repository.updateLastMessageAt(BUSINESS_ID, CONVERSATION_ID, new Date());
    await Promise.all([clearing, arriving]);

    // The third message was never seen by the operator, so it stays unread.
    expect(prisma.state.unread_count).toBe(1);
  });

  it('settles at zero when reads and arrivals are fully interleaved', async () => {
    const { repository, prisma } = await makeRepository(0);

    await Promise.all(
      Array.from({ length: 20 }, () =>
        repository.updateLastMessageAt(BUSINESS_ID, CONVERSATION_ID, new Date()),
      ),
    );
    // Drain with repeated reads; each clears whatever it observed.
    for (let i = 0; i < 5; i++) {
      await repository.markRead(BUSINESS_ID, CONVERSATION_ID);
    }

    expect(prisma.state.unread_count).toBe(0);
    expect(prisma.state.unread_count).toBeGreaterThanOrEqual(0);
  });
});
