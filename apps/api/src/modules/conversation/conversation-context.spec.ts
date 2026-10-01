/**
 * Conversation context, notes/tags and event-handler resilience tests.
 *
 * Covers the surface the CRUD and lifecycle specs leave out:
 *  - getConversationContext (the AI engine's read path)
 *  - close / tags / note
 *  - every @OnEvent handler's failure branch — a handler must never throw back
 *    into the event bus, because a rejection there kills unrelated listeners
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import {
  ChannelType,
  ConversationStatus,
  MessageReceivedEvent,
  MessageStoredEvent,
  TaskResolvedEvent,
  AIResponseApprovedEvent,
} from '@gosumo/shared';

import { ConversationService } from './conversation.service';
import { ConversationRepository } from './conversation.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST } from '../../common/utils/message-order';
import { TenantService } from '../tenant/tenant.service';
import { CONVERSATION_QUEUE } from './conversation.constants';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const CHANNEL_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-4444-444444444444';
const MESSAGE_ID = '55555555-5555-5555-5555-555555555555';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeConversation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: CONVERSATION_ID,
    business_id: BUSINESS_ID,
    client_id: CLIENT_ID,
    channel_account_id: CHANNEL_ACCOUNT_ID,
    channel: ChannelType.WHATSAPP,
    status: ConversationStatus.OPEN,
    assigned_to: null,
    subject: null,
    first_message_at: new Date('2026-06-20T10:00:00Z'),
    last_message_at: new Date('2026-06-20T10:05:00Z'),
    resolved_at: null,
    snoozed_until: null,
    message_count: 2,
    unread_count: 0,
    human_message_count: 0,
    csat_score: null,
    csat_submitted_at: null,
    tags: [],
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

describe('ConversationService — context, notes and handler resilience', () => {
  let service: ConversationService;
  let repository: {
    findById: jest.Mock;
    findLatestByClientAndChannel: jest.Mock;
    create: jest.Mock;
    updateStatus: jest.Mock;
    transitionStatus: jest.Mock;
    update: jest.Mock;
    list: jest.Mock;
    updateLastMessageAt: jest.Mock;
    incrementHumanMessageCount: jest.Mock;
    assign: jest.Mock;
    assignIfHeldBy: jest.Mock;
    countActiveByAssignees: jest.Mock;
    countByStatus: jest.Mock;
    getResolutionStats: jest.Mock;
    findSnoozedDue: jest.Mock;
    releaseAssignments: jest.Mock;
  };
  let prisma: {
    messages: { findMany: jest.Mock; findFirst: jest.Mock };
    tasks: { count: jest.Mock };
  };
  let eventEmitter: { emit: jest.Mock };
  let queue: { add: jest.Mock };
  let tenantService: { assertAssignableTeamMember: jest.Mock; filterAssignableTeamMembers: jest.Mock };
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(async () => {
    repository = {
      findById: jest.fn(),
      findLatestByClientAndChannel: jest.fn(),
      create: jest.fn(),
      updateStatus: jest.fn(),
      transitionStatus: jest.fn(),
      update: jest.fn(),
      list: jest.fn(),
      updateLastMessageAt: jest.fn(),
      incrementHumanMessageCount: jest.fn(),
      assign: jest.fn(),
      assignIfHeldBy: jest.fn(),
      countActiveByAssignees: jest.fn(),
      countByStatus: jest.fn(),
      getResolutionStats: jest.fn(),
      findSnoozedDue: jest.fn(),
      releaseAssignments: jest.fn(),
    };
    prisma = {
      messages: { findMany: jest.fn(), findFirst: jest.fn() },
      tasks: { count: jest.fn() },
    };
    eventEmitter = { emit: jest.fn() };
    queue = { add: jest.fn() };
    tenantService = {
      assertAssignableTeamMember: jest.fn().mockResolvedValue(undefined),
      // Auto-assign narrows its candidate list through the tenant guard;
      // the default fake keeps every id the caller supplied.
      filterAssignableTeamMembers: jest.fn(async (_b: string, ids: string[]) => ids),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: ConversationRepository, useValue: repository },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: getQueueToken(CONVERSATION_QUEUE), useValue: queue },
        { provide: TenantService, useValue: tenantService },
      ],
    }).compile();

    service = module.get<ConversationService>(ConversationService);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  // ═══════════════════════════════════════════
  // getConversationContext
  // ═══════════════════════════════════════════

  describe('getConversationContext', () => {
    it('returns the conversation, its recent messages chronologically, and the client', async () => {
      const client = { id: CLIENT_ID, name: 'Priya' };
      repository.findById.mockResolvedValue(makeConversation({ client }));
      // The repository reads newest-first; the context must be oldest-first.
      prisma.messages.findMany.mockResolvedValue([
        { id: 'm3', text_content: 'third', created_at: new Date('2026-06-20T10:03:00Z') },
        { id: 'm2', text_content: 'second', created_at: new Date('2026-06-20T10:02:00Z') },
        { id: 'm1', text_content: 'first', created_at: new Date('2026-06-20T10:01:00Z') },
      ]);

      const context = await service.getConversationContext(BUSINESS_ID, CONVERSATION_ID);

      expect(context.messages.map((m) => (m as { id: string }).id)).toEqual([
        'm1',
        'm2',
        'm3',
      ]);
      expect(context.client).toEqual(client);
      expect((context.conversation as { id: string }).id).toBe(CONVERSATION_ID);
    });

    it('scopes the message read to both the tenant and the conversation', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      prisma.messages.findMany.mockResolvedValue([]);

      await service.getConversationContext(BUSINESS_ID, CONVERSATION_ID);

      expect(prisma.messages.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversation_id: CONVERSATION_ID, business_id: BUSINESS_ID },
          orderBy: MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST,
        }),
      );
    });

    it('bounds the context window rather than reading the whole thread', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      prisma.messages.findMany.mockResolvedValue([]);

      await service.getConversationContext(BUSINESS_ID, CONVERSATION_ID);

      const take = prisma.messages.findMany.mock.calls[0]?.[0].take as number;
      expect(take).toBeGreaterThan(0);
      expect(take).toBeLessThanOrEqual(50);
    });

    it('yields a null client when the conversation carries none', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      prisma.messages.findMany.mockResolvedValue([]);

      const context = await service.getConversationContext(BUSINESS_ID, CONVERSATION_ID);

      expect(context.client).toBeNull();
      expect(context.messages).toEqual([]);
    });

    it('throws NotFound for a conversation outside the tenant', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.getConversationContext(BUSINESS_ID, CONVERSATION_ID),
      ).rejects.toThrow(/not found/i);
      expect(prisma.messages.findMany).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════
  // close / tags / note
  // ═══════════════════════════════════════════

  describe('closeConversation', () => {
    it('resolves the conversation as a human action', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      prisma.tasks.count.mockResolvedValue(0);
      repository.transitionStatus.mockResolvedValue(
        makeConversation({ status: ConversationStatus.RESOLVED }),
      );

      const result = await service.closeConversation(
        BUSINESS_ID,
        CONVERSATION_ID,
        AGENT_A,
      );

      expect(repository.transitionStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.OPEN,
        ConversationStatus.RESOLVED,
        expect.any(Object),
      );
      expect((result as { status: string }).status).toBe(
        ConversationStatus.RESOLVED,
      );
      // Close is a human verb — the resolved event must not read as SYSTEM.
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.resolved',
        expect.objectContaining({ resolvedBy: 'HUMAN', resolvedByActorId: AGENT_A }),
      );
    });

    it('closes without an actor id', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      prisma.tasks.count.mockResolvedValue(0);
      repository.transitionStatus.mockResolvedValue(
        makeConversation({ status: ConversationStatus.RESOLVED }),
      );

      await expect(
        service.closeConversation(BUSINESS_ID, CONVERSATION_ID),
      ).resolves.toBeDefined();
    });

    it('refuses to close while an open HITL task still references it', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      prisma.tasks.count.mockResolvedValue(2);

      await expect(
        service.closeConversation(BUSINESS_ID, CONVERSATION_ID, AGENT_A),
      ).rejects.toThrow(/2 open task\(s\) exist/);
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('setTags', () => {
    it('trims, drops blanks, and de-duplicates the tag set', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      repository.update.mockResolvedValue(makeConversation());

      await service.setTags(BUSINESS_ID, CONVERSATION_ID, [
        '  vip ',
        'vip',
        '',
        '   ',
        'urgent',
      ]);

      expect(repository.update).toHaveBeenCalledWith(BUSINESS_ID, CONVERSATION_ID, {
        tags: ['vip', 'urgent'],
      });
    });

    it('accepts an empty set as a clear', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      repository.update.mockResolvedValue(makeConversation());

      await service.setTags(BUSINESS_ID, CONVERSATION_ID, []);

      expect(repository.update).toHaveBeenCalledWith(BUSINESS_ID, CONVERSATION_ID, {
        tags: [],
      });
    });

    it('refuses to tag a conversation outside the tenant', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.setTags(BUSINESS_ID, CONVERSATION_ID, ['vip']),
      ).rejects.toThrow(/not found/i);
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('updateNote', () => {
    it('merges the note into existing metadata without dropping other keys', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({ metadata: { source: 'import', priority: 'high' } }),
      );
      repository.update.mockResolvedValue(makeConversation());

      await service.updateNote(BUSINESS_ID, CONVERSATION_ID, 'Call after 6pm');

      const metadata = repository.update.mock.calls[0]?.[2].metadata as Record<
        string,
        unknown
      >;
      expect(metadata['source']).toBe('import');
      expect(metadata['priority']).toBe('high');
      expect(Object.values(metadata)).toContain('Call after 6pm');
    });

    it('overwrites a previously stored note', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      repository.update.mockResolvedValue(makeConversation());

      await service.updateNote(BUSINESS_ID, CONVERSATION_ID, 'first');
      const firstMetadata = repository.update.mock.calls[0]?.[2]
        .metadata as Record<string, unknown>;

      repository.findById.mockResolvedValue(
        makeConversation({ metadata: firstMetadata }),
      );
      await service.updateNote(BUSINESS_ID, CONVERSATION_ID, 'second');

      const secondMetadata = repository.update.mock.calls[1]?.[2]
        .metadata as Record<string, unknown>;
      expect(Object.values(secondMetadata)).toContain('second');
      expect(Object.values(secondMetadata)).not.toContain('first');
    });

    it('refuses to note a conversation outside the tenant', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.updateNote(BUSINESS_ID, CONVERSATION_ID, 'x'),
      ).rejects.toThrow(/not found/i);
    });
  });

  // ═══════════════════════════════════════════
  // Event-handler resilience
  // ═══════════════════════════════════════════

  const messageReceived = (
    over: Partial<MessageReceivedEvent> = {},
  ): MessageReceivedEvent =>
    ({
      type: 'message.received',
      id: '77777777-7777-7777-7777-777777777777',
      timestamp: new Date().toISOString(),
      businessId: BUSINESS_ID,
      correlationId: 'gs-test-corr',
      messageId: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      channelAccountId: CHANNEL_ACCOUNT_ID,
      channel: ChannelType.WHATSAPP,
      senderExternalId: '919876543210',
      clientId: CLIENT_ID,
      ...over,
    }) as MessageReceivedEvent;

  describe('handleMessageReceived', () => {
    it('swallows a repository failure instead of rejecting into the event bus', async () => {
      repository.findLatestByClientAndChannel.mockRejectedValue(
        new Error('connection reset'),
      );

      await expect(
        service.handleMessageReceived(messageReceived()),
      ).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('connection reset'),
      );
    });

    it('logs the offending message id so a failure is traceable', async () => {
      repository.findLatestByClientAndChannel.mockRejectedValue(
        new Error('boom'),
      );

      await service.handleMessageReceived(messageReceived());

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(MESSAGE_ID),
      );
    });

    it('stringifies a non-Error rejection', async () => {
      repository.findLatestByClientAndChannel.mockRejectedValue('string failure');

      await service.handleMessageReceived(messageReceived());

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('string failure'),
      );
    });
  });

  describe('handleMessageStored', () => {
    const stored = (over: Partial<MessageStoredEvent> = {}): MessageStoredEvent =>
      ({
        type: 'message.stored',
        id: '88888888-8888-8888-8888-888888888888',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'gs-test-corr',
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        direction: 'OUTBOUND',
        senderType: 'HUMAN_AGENT',
        ...over,
      }) as MessageStoredEvent;

    it('counts an outbound human reply toward the handoff metric', async () => {
      repository.incrementHumanMessageCount.mockResolvedValue(undefined);

      await service.handleMessageStored(stored());

      expect(repository.incrementHumanMessageCount).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
      );
    });

    it('ignores inbound messages', async () => {
      await service.handleMessageStored(stored({ direction: 'INBOUND' }));

      expect(repository.incrementHumanMessageCount).not.toHaveBeenCalled();
    });

    it('ignores outbound messages sent by the AI', async () => {
      await service.handleMessageStored(stored({ senderType: 'AI' }));

      expect(repository.incrementHumanMessageCount).not.toHaveBeenCalled();
    });

    it('swallows a counter failure — the metric is not worth failing a send over', async () => {
      repository.incrementHumanMessageCount.mockRejectedValue(
        new Error('row locked'),
      );

      await expect(service.handleMessageStored(stored())).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('row locked'));
    });
  });

  describe('handleTaskResolved', () => {
    const resolved = (
      over: Partial<TaskResolvedEvent> = {},
    ): TaskResolvedEvent =>
      ({
        type: 'task.resolved',
        id: '99999999-9999-9999-9999-999999999999',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'gs-test-corr',
        taskId: 'task-1',
        conversationId: CONVERSATION_ID,
        resolvedByMemberId: AGENT_A,
        ...over,
      }) as TaskResolvedEvent;

    it('swallows a lookup failure instead of rejecting into the event bus', async () => {
      repository.findById.mockRejectedValue(new Error('db unavailable'));

      await expect(service.handleTaskResolved(resolved())).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('db unavailable'),
      );
    });

    it('names the conversation in the failure log', async () => {
      repository.findById.mockRejectedValue(new Error('boom'));

      await service.handleTaskResolved(resolved());

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(CONVERSATION_ID),
      );
    });
  });

  describe('handleAiResponseApproved', () => {
    const approved = (
      over: Partial<AIResponseApprovedEvent> = {},
    ): AIResponseApprovedEvent =>
      ({
        type: 'ai.response.approved',
        id: 'abababab-abab-abab-abab-abababababab',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'gs-test-corr',
        conversationId: CONVERSATION_ID,
        aiDecisionId: 'decision-1',
        taskId: 'task-1',
        wasEdited: false,
        approvedByMemberId: AGENT_A,
        ...over,
      }) as AIResponseApprovedEvent;

    it('swallows a lookup failure instead of rejecting into the event bus', async () => {
      repository.findById.mockRejectedValue(new Error('timeout'));

      await expect(
        service.handleAiResponseApproved(approved()),
      ).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    });

    it('stringifies a non-Error rejection', async () => {
      repository.findById.mockRejectedValue({ code: 'P2024' });

      await service.handleAiResponseApproved(approved());

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to handle ai.response.approved'),
      );
    });
  });

  // ═══════════════════════════════════════════
  // Resolve / escalate option branches
  // ═══════════════════════════════════════════

  describe('resolveConversation options', () => {
    it('stamps csat_submitted_at only when a CSAT score is supplied', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      prisma.tasks.count.mockResolvedValue(0);
      repository.transitionStatus.mockResolvedValue(makeConversation());

      await service.resolveConversation(BUSINESS_ID, CONVERSATION_ID, {
        csatScore: 5,
      });

      const payload = repository.transitionStatus.mock.calls[0]?.[4] as Record<
        string,
        unknown
      >;
      expect(payload['csatScore']).toBe(5);
      expect(payload['csatSubmittedAt']).toBeInstanceOf(Date);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.resolved',
        expect.objectContaining({ csatScore: 5 }),
      );
    });

    it('leaves csat_submitted_at unset when no score is supplied', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      prisma.tasks.count.mockResolvedValue(0);
      repository.transitionStatus.mockResolvedValue(makeConversation());

      await service.resolveConversation(BUSINESS_ID, CONVERSATION_ID, {});

      const payload = repository.transitionStatus.mock.calls[0]?.[4] as Record<
        string,
        unknown
      >;
      expect(payload['csatSubmittedAt']).toBeUndefined();
    });

    it('reports a zero resolution duration when the thread has no first message', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({ first_message_at: null }),
      );
      prisma.tasks.count.mockResolvedValue(0);
      repository.transitionStatus.mockResolvedValue(makeConversation());

      await service.resolveConversation(BUSINESS_ID, CONVERSATION_ID, {});

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.resolved',
        expect.objectContaining({ resolutionDurationSeconds: 0 }),
      );
    });
  });

  describe('escalateConversation options', () => {
    it('defaults the reason to MANUAL and the task id to empty', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      repository.transitionStatus.mockResolvedValue(
        makeConversation({ status: ConversationStatus.ESCALATED }),
      );

      await service.escalateConversation(BUSINESS_ID, CONVERSATION_ID, {});

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.escalated',
        expect.objectContaining({ reason: 'MANUAL', taskId: '' }),
      );
      // No assignee supplied — the update must not clear an existing one.
      expect(repository.transitionStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.OPEN,
        ConversationStatus.ESCALATED,
        expect.objectContaining({ assignedTo: undefined }),
      );
    });

    it('carries an explicit assignee, task id and reason onto the event', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      repository.transitionStatus.mockResolvedValue(
        makeConversation({ status: ConversationStatus.ESCALATED }),
      );

      await service.escalateConversation(BUSINESS_ID, CONVERSATION_ID, {
        assignedToMemberId: AGENT_A,
        taskId: 'task-9',
        reason: 'LOW_CONFIDENCE',
        actorId: AGENT_A,
      } as never);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.escalated',
        expect.objectContaining({
          assignedToMemberId: AGENT_A,
          taskId: 'task-9',
          reason: 'LOW_CONFIDENCE',
        }),
      );
    });
  });

  // ═══════════════════════════════════════════
  // Handler pre-conditions
  // ═══════════════════════════════════════════

  describe('handler pre-conditions', () => {
    it('task.resolved is a no-op for a missing conversation', async () => {
      repository.findById.mockResolvedValue(null);

      await service.handleTaskResolved({
        type: 'task.resolved',
        id: 'e1',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'c',
        taskId: 'task-1',
        conversationId: CONVERSATION_ID,
        resolvedByMemberId: AGENT_A,
      } as TaskResolvedEvent);

      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    it('task.resolved is a no-op when the conversation is not ESCALATED', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({ status: ConversationStatus.OPEN }),
      );

      await service.handleTaskResolved({
        type: 'task.resolved',
        id: 'e1',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'c',
        taskId: 'task-1',
        conversationId: CONVERSATION_ID,
        resolvedByMemberId: AGENT_A,
      } as TaskResolvedEvent);

      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    it('ai.response.approved is a no-op for a missing conversation', async () => {
      repository.findById.mockResolvedValue(null);

      await service.handleAiResponseApproved({
        type: 'ai.response.approved',
        id: 'e2',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'c',
        conversationId: CONVERSATION_ID,
        aiDecisionId: 'd1',
        taskId: 'task-1',
        wasEdited: false,
        approvedByMemberId: AGENT_A,
      } as AIResponseApprovedEvent);

      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    it('ai.response.approved is a no-op when the conversation is not PENDING_HUMAN', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({ status: ConversationStatus.OPEN }),
      );

      await service.handleAiResponseApproved({
        type: 'ai.response.approved',
        id: 'e2',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'c',
        conversationId: CONVERSATION_ID,
        aiDecisionId: 'd1',
        taskId: 'task-1',
        wasEdited: false,
        approvedByMemberId: AGENT_A,
      } as AIResponseApprovedEvent);

      expect(repository.updateStatus).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════
  // SLA edge cases
  // ═══════════════════════════════════════════

  describe('getSlaMetrics edge cases', () => {
    it('treats an outbound message predating the first inbound as no response time', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      // Clock skew or a proactive outreach: outbound is older than inbound.
      prisma.messages.findFirst
        .mockResolvedValueOnce({ created_at: new Date('2026-06-20T10:05:00Z') })
        .mockResolvedValueOnce({ created_at: new Date('2026-06-20T10:00:00Z') });

      const metrics = await service.getSlaMetrics(BUSINESS_ID, CONVERSATION_ID);

      expect(metrics.firstResponseTimeMs).toBeNull();
    });

    it('computes a positive first-response time in the normal ordering', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      prisma.messages.findFirst
        .mockResolvedValueOnce({ created_at: new Date('2026-06-20T10:00:00Z') })
        .mockResolvedValueOnce({ created_at: new Date('2026-06-20T10:02:00Z') });

      const metrics = await service.getSlaMetrics(BUSINESS_ID, CONVERSATION_ID);

      expect(metrics.firstResponseTimeMs).toBe(120_000);
    });
  });

  // ═══════════════════════════════════════════
  // Status transitions
  // ═══════════════════════════════════════════

  describe('status transitions', () => {
    it('treats a no-op transition to the same status as allowed', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({ status: ConversationStatus.OPEN }),
      );
      repository.transitionStatus.mockResolvedValue(makeConversation());

      await expect(
        service.updateStatus(BUSINESS_ID, CONVERSATION_ID, ConversationStatus.OPEN),
      ).resolves.toBeDefined();
    });
  });

  // ═══════════════════════════════════════════
  // wakeSnoozedConversations
  // ═══════════════════════════════════════════

  describe('wakeSnoozedConversations', () => {
    it('keeps waking the rest of the batch when one conversation fails', async () => {
      repository.findSnoozedDue.mockResolvedValue([
        makeConversation({ id: 'c1' }),
        makeConversation({ id: 'c2' }),
        makeConversation({ id: 'c3' }),
      ]);
      repository.updateStatus
        .mockResolvedValueOnce(makeConversation({ id: 'c1' }))
        .mockRejectedValueOnce(new Error('c2 is locked'))
        .mockResolvedValueOnce(makeConversation({ id: 'c3' }));

      const woken = await service.wakeSnoozedConversations(BUSINESS_ID);

      expect(woken).toBe(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('c2 is locked'),
      );
      // The two that succeeded still announce their status change.
      expect(eventEmitter.emit).toHaveBeenCalledTimes(2);
    });

    it('returns zero and emits nothing when none are due', async () => {
      repository.findSnoozedDue.mockResolvedValue([]);

      expect(await service.wakeSnoozedConversations(BUSINESS_ID)).toBe(0);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('stringifies a non-Error wake failure', async () => {
      repository.findSnoozedDue.mockResolvedValue([makeConversation({ id: 'c1' })]);
      repository.updateStatus.mockRejectedValue('nope');

      expect(await service.wakeSnoozedConversations(BUSINESS_ID)).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('nope'));
    });
  });
});
