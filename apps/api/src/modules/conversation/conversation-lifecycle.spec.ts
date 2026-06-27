/**
 * Conversation lifecycle / features unit tests.
 *
 * Covers the functionality added on top of the base CRUD spec:
 *  - resolve / close / reopen (with open-task guard)
 *  - snooze (validation of bounds)
 *  - escalate (AI→human handoff)
 *  - auto-assignment (AI / ROUND_ROBIN / LEAST_BUSY)
 *  - tagging & notes
 *  - SLA metrics & stats
 *  - snooze wake-up
 *  - event handlers (task.resolved, ai.response.approved)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  ChannelType,
  ConversationStatus,
  TaskResolvedEvent,
  AIResponseApprovedEvent,
} from '@gosumo/shared';

import { ConversationService } from './conversation.service';
import { ConversationRepository } from './conversation.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { AutoAssignStrategy } from './conversation.constants';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const CHANNEL_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-4444-444444444444';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AGENT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

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

function createMockRepository() {
  return {
    findById: jest.fn(),
    findActiveByClientAndChannel: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
    update: jest.fn(),
    list: jest.fn(),
    updateLastMessageAt: jest.fn(),
    incrementHumanMessageCount: jest.fn(),
    assign: jest.fn(),
    countActiveByAssignees: jest.fn(),
    countByStatus: jest.fn(),
    getResolutionStats: jest.fn(),
    findSnoozedDue: jest.fn(),
  };
}

function createMockPrisma() {
  return {
    messages: { findMany: jest.fn(), findFirst: jest.fn() },
    tasks: { count: jest.fn() },
  };
}

describe('ConversationService — lifecycle & features', () => {
  let service: ConversationService;
  let repository: ReturnType<typeof createMockRepository>;
  let prisma: ReturnType<typeof createMockPrisma>;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    repository = createMockRepository();
    prisma = createMockPrisma();
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: ConversationRepository, useValue: repository },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<ConversationService>(ConversationService);
  });

  // ─── resolve ─────────────────────────────────

  describe('resolveConversation', () => {
    it('resolves an OPEN conversation, sets CSAT, and emits resolved + status.changed', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      prisma.tasks.count.mockResolvedValue(0);
      const resolved = makeConversation({
        status: ConversationStatus.RESOLVED,
        resolved_at: new Date(),
      });
      repository.update.mockResolvedValue(resolved);

      const result = await service.resolveConversation(
        BUSINESS_ID,
        CONVERSATION_ID,
        { resolvedBy: 'HUMAN', actorId: AGENT_A, csatScore: 5 },
      );

      expect(result).toEqual(resolved);
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        expect.objectContaining({
          status: ConversationStatus.RESOLVED,
          csatScore: 5,
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.status.changed',
        expect.objectContaining({ newStatus: ConversationStatus.RESOLVED }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.resolved',
        expect.objectContaining({
          type: 'conversation.resolved',
          resolvedBy: 'HUMAN',
          csatScore: 5,
        }),
      );
    });

    it('refuses to resolve while an open HITL task exists', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      prisma.tasks.count.mockResolvedValue(1);

      await expect(
        service.resolveConversation(BUSINESS_ID, CONVERSATION_ID),
      ).rejects.toThrow(ConflictException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('throws NotFound for a missing conversation', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(
        service.resolveConversation(BUSINESS_ID, CONVERSATION_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('reopenConversation', () => {
    it('moves RESOLVED → OPEN', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({ status: ConversationStatus.RESOLVED }),
      );
      const reopened = makeConversation({ status: ConversationStatus.OPEN });
      repository.updateStatus.mockResolvedValue(reopened);

      const result = await service.reopenConversation(
        BUSINESS_ID,
        CONVERSATION_ID,
        AGENT_A,
      );

      expect(result).toEqual(reopened);
      expect(repository.updateStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.OPEN,
      );
    });
  });

  // ─── snooze ──────────────────────────────────

  describe('snoozeConversation', () => {
    it('snoozes an OPEN conversation until a valid future time', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      const snoozed = makeConversation({ status: ConversationStatus.SNOOZED });
      repository.update.mockResolvedValue(snoozed);

      const until = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      const result = await service.snoozeConversation(
        BUSINESS_ID,
        CONVERSATION_ID,
        until,
      );

      expect(result).toEqual(snoozed);
      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        expect.objectContaining({
          status: ConversationStatus.SNOOZED,
          snoozedUntil: until,
        }),
      );
    });

    it('rejects a snooze in the past', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      await expect(
        service.snoozeConversation(
          BUSINESS_ID,
          CONVERSATION_ID,
          new Date(Date.now() - 1000),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a snooze beyond the 7-day maximum', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      await expect(
        service.snoozeConversation(
          BUSINESS_ID,
          CONVERSATION_ID,
          new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── escalate ────────────────────────────────

  describe('escalateConversation', () => {
    it('escalates and emits conversation.escalated', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      const escalated = makeConversation({
        status: ConversationStatus.ESCALATED,
        assigned_to: AGENT_A,
      });
      repository.update.mockResolvedValue(escalated);

      const result = await service.escalateConversation(
        BUSINESS_ID,
        CONVERSATION_ID,
        { reason: 'CUSTOMER_REQUEST', assignedToMemberId: AGENT_A, taskId: 'task-1' },
      );

      expect(result).toEqual(escalated);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.escalated',
        expect.objectContaining({
          type: 'conversation.escalated',
          reason: 'CUSTOMER_REQUEST',
          assignedToMemberId: AGENT_A,
          taskId: 'task-1',
        }),
      );
    });
  });

  // ─── auto-assign ─────────────────────────────

  describe('autoAssign', () => {
    it('AI strategy unassigns and emits nothing', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      const updated = makeConversation({ assigned_to: null });
      repository.assign.mockResolvedValue(updated);

      const result = await service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
        strategy: AutoAssignStrategy.AI,
      });

      expect(result).toEqual(updated);
      expect(repository.assign).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        null,
      );
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'conversation.assigned',
        expect.anything(),
      );
    });

    it('LEAST_BUSY picks the agent with fewest active conversations', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      repository.countActiveByAssignees.mockResolvedValue({
        [AGENT_A]: 5,
        [AGENT_B]: 2,
      });
      repository.assign.mockResolvedValue(
        makeConversation({ assigned_to: AGENT_B }),
      );

      await service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
        strategy: AutoAssignStrategy.LEAST_BUSY,
        candidateAgentIds: [AGENT_A, AGENT_B],
      });

      expect(repository.assign).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        AGENT_B,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.assigned',
        expect.objectContaining({ assigneeId: AGENT_B }),
      );
    });

    it('ROUND_ROBIN distributes deterministically by total load', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      // total active = 3 → 3 % 2 = 1 → AGENT_B
      repository.countActiveByAssignees.mockResolvedValue({
        [AGENT_A]: 2,
        [AGENT_B]: 1,
      });
      repository.assign.mockResolvedValue(
        makeConversation({ assigned_to: AGENT_B }),
      );

      await service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
        strategy: AutoAssignStrategy.ROUND_ROBIN,
        candidateAgentIds: [AGENT_A, AGENT_B],
      });

      expect(repository.assign).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        AGENT_B,
      );
    });

    it('rejects ROUND_ROBIN without candidates', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      await expect(
        service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
          strategy: AutoAssignStrategy.ROUND_ROBIN,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── tags & notes ────────────────────────────

  describe('tagging', () => {
    it('addTag de-duplicates', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({ tags: ['vip'] }),
      );
      repository.update.mockResolvedValue(
        makeConversation({ tags: ['vip', 'refund'] }),
      );

      await service.addTag(BUSINESS_ID, CONVERSATION_ID, 'refund');

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        { tags: ['vip', 'refund'] },
      );
    });

    it('removeTag filters out the tag', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({ tags: ['vip', 'refund'] }),
      );
      repository.update.mockResolvedValue(makeConversation({ tags: ['vip'] }));

      await service.removeTag(BUSINESS_ID, CONVERSATION_ID, 'refund');

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        { tags: ['vip'] },
      );
    });

    it('updateNote stores the note in metadata', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({ metadata: { foo: 'bar' } }),
      );
      repository.update.mockResolvedValue(makeConversation());

      await service.updateNote(BUSINESS_ID, CONVERSATION_ID, 'call back later');

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        { metadata: { foo: 'bar', internalNote: 'call back later' } },
      );
    });
  });

  // ─── SLA & stats ─────────────────────────────

  describe('getSlaMetrics', () => {
    it('computes first response and resolution times', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({
          first_message_at: new Date('2026-06-20T10:00:00Z'),
          resolved_at: new Date('2026-06-20T11:00:00Z'),
        }),
      );
      prisma.messages.findFirst
        .mockResolvedValueOnce({ created_at: new Date('2026-06-20T10:00:00Z') }) // inbound
        .mockResolvedValueOnce({ created_at: new Date('2026-06-20T10:02:00Z') }); // outbound

      const sla = await service.getSlaMetrics(BUSINESS_ID, CONVERSATION_ID);

      expect(sla.firstResponseTimeMs).toBe(2 * 60 * 1000);
      expect(sla.resolutionTimeMs).toBe(60 * 60 * 1000);
      expect(sla.firstResponseBreached).toBe(false); // 2m < 5m target
      expect(sla.resolutionBreached).toBe(false); // 1h < 24h target
    });

    it('flags a first-response SLA breach', async () => {
      repository.findById.mockResolvedValue(makeConversation({ resolved_at: null }));
      prisma.messages.findFirst
        .mockResolvedValueOnce({ created_at: new Date('2026-06-20T10:00:00Z') })
        .mockResolvedValueOnce({ created_at: new Date('2026-06-20T10:10:00Z') });

      const sla = await service.getSlaMetrics(BUSINESS_ID, CONVERSATION_ID);

      expect(sla.firstResponseTimeMs).toBe(10 * 60 * 1000);
      expect(sla.firstResponseBreached).toBe(true);
      expect(sla.resolutionTimeMs).toBeNull();
    });
  });

  describe('getConversationStats', () => {
    it('aggregates counts and resolution stats', async () => {
      repository.countByStatus.mockResolvedValue({ OPEN: 3, RESOLVED: 7 });
      repository.getResolutionStats.mockResolvedValue({
        resolvedCount: 7,
        avgResolutionSeconds: 3600,
      });

      const stats = await service.getConversationStats(BUSINESS_ID);

      expect(stats.total).toBe(10);
      expect(stats.resolvedCount).toBe(7);
      expect(stats.avgResolutionSeconds).toBe(3600);
      expect(stats.byStatus).toEqual({ OPEN: 3, RESOLVED: 7 });
    });
  });

  // ─── snooze wake-up ──────────────────────────

  describe('wakeSnoozedConversations', () => {
    it('re-opens due snoozed conversations', async () => {
      repository.findSnoozedDue.mockResolvedValue([
        makeConversation({ id: CONVERSATION_ID, status: ConversationStatus.SNOOZED }),
      ]);
      repository.updateStatus.mockResolvedValue(makeConversation());

      const woken = await service.wakeSnoozedConversations(BUSINESS_ID);

      expect(woken).toBe(1);
      expect(repository.updateStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.OPEN,
      );
    });
  });

  // ─── handoff event handlers ──────────────────

  describe('handleTaskResolved', () => {
    it('returns an ESCALATED conversation to OPEN', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({ status: ConversationStatus.ESCALATED }),
      );
      repository.updateStatus.mockResolvedValue(makeConversation());

      const event: TaskResolvedEvent = {
        type: 'task.resolved',
        id: 'evt',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr',
        taskId: 'task-1',
        conversationId: CONVERSATION_ID,
        resolvedByMemberId: AGENT_A,
        resolutionDurationSeconds: 120,
        slaBreach: false,
      };

      await service.handleTaskResolved(event);

      expect(repository.updateStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.OPEN,
      );
    });

    it('ignores a non-escalated conversation', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({ status: ConversationStatus.OPEN }),
      );

      const event: TaskResolvedEvent = {
        type: 'task.resolved',
        id: 'evt',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr',
        taskId: 'task-1',
        conversationId: CONVERSATION_ID,
        resolvedByMemberId: AGENT_A,
        resolutionDurationSeconds: 120,
        slaBreach: false,
      };

      await service.handleTaskResolved(event);
      expect(repository.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('handleAiResponseApproved', () => {
    it('returns a PENDING_HUMAN conversation to OPEN', async () => {
      repository.findById.mockResolvedValue(
        makeConversation({ status: ConversationStatus.PENDING_HUMAN }),
      );
      repository.updateStatus.mockResolvedValue(makeConversation());

      const event: AIResponseApprovedEvent = {
        type: 'ai.response.approved',
        id: 'evt',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr',
        conversationId: CONVERSATION_ID,
        aiDecisionId: 'dec-1',
        taskId: 'task-1',
        approvedByMemberId: AGENT_A,
        wasEdited: false,
      };

      await service.handleAiResponseApproved(event);

      expect(repository.updateStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.OPEN,
      );
    });
  });
});
