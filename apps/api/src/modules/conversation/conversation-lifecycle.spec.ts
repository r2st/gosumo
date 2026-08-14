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
import { getQueueToken } from '@nestjs/bull';
import {
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  ChannelType,
  ConversationStatus,
  TaskResolvedEvent,
  TeamMemberRemovedEvent,
  AIResponseApprovedEvent,
} from '@gosumo/shared';

import { ConversationService } from './conversation.service';
import { ConversationRepository } from './conversation.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { AutoAssignStrategy, CONVERSATION_QUEUE } from './conversation.constants';

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
    findLatestByClientAndChannel: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
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
  let queue: { add: jest.Mock };
  let tenantService: { assertAssignableTeamMember: jest.Mock; filterAssignableTeamMembers: jest.Mock };

  beforeEach(async () => {
    repository = createMockRepository();
    prisma = createMockPrisma();
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

    /** The escalation target is the same unscoped body reference as assign. */
    it('rejects a routing target outside the tenant before writing', async () => {
      tenantService.assertAssignableTeamMember.mockRejectedValue(
        new BadRequestException('Team member does not belong to this business'),
      );

      await expect(
        service.escalateConversation(BUSINESS_ID, CONVERSATION_ID, {
          assignedToMemberId: AGENT_A,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(repository.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    /** Escalating without a target is the common case and must stay open. */
    it('does not consult the tenant guard when no target is supplied', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      repository.update.mockResolvedValue(
        makeConversation({ status: ConversationStatus.ESCALATED }),
      );

      await service.escalateConversation(BUSINESS_ID, CONVERSATION_ID, {});

      expect(tenantService.assertAssignableTeamMember).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalled();
    });
  });

  // ─── auto-assign ─────────────────────────────

  describe('autoAssign', () => {
    it('AI strategy unassigns and emits nothing', async () => {
      repository.findById.mockResolvedValue(makeConversation({ assigned_to: AGENT_A }));
      const updated = makeConversation({ assigned_to: null });
      repository.assignIfHeldBy.mockResolvedValue(updated);

      const result = await service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
        strategy: AutoAssignStrategy.AI,
      });

      expect(result).toEqual(updated);
      // The write is guarded on the assignee that was read, so handing the
      // conversation back to the AI cannot silently undo a human claim made
      // in the meantime.
      expect(repository.assignIfHeldBy).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        null,
        AGENT_A,
      );
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'conversation.assigned',
        expect.anything(),
      );
    });

    it('does not write or announce when the conversation is already with the AI', async () => {
      repository.findById.mockResolvedValue(makeConversation({ assigned_to: null }));

      await service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
        strategy: AutoAssignStrategy.AI,
      });

      expect(repository.assignIfHeldBy).not.toHaveBeenCalled();
    });

    it('LEAST_BUSY picks the agent with fewest active conversations', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      repository.countActiveByAssignees.mockResolvedValue({
        [AGENT_A]: 5,
        [AGENT_B]: 2,
      });
      repository.assignIfHeldBy.mockResolvedValue(
        makeConversation({ assigned_to: AGENT_B }),
      );

      await service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
        strategy: AutoAssignStrategy.LEAST_BUSY,
        candidateAgentIds: [AGENT_A, AGENT_B],
      });

      expect(repository.assignIfHeldBy).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        AGENT_B,
        null,
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
      repository.assignIfHeldBy.mockResolvedValue(
        makeConversation({ assigned_to: AGENT_B }),
      );

      await service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
        strategy: AutoAssignStrategy.ROUND_ROBIN,
        candidateAgentIds: [AGENT_A, AGENT_B],
      });

      expect(repository.assignIfHeldBy).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        AGENT_B,
        null,
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

    // ── candidate scoping ──
    //
    // `candidateAgentIds` is a caller-supplied list of bare UUIDs, and
    // `conversations.assigned_to` carries no foreign key at all — the schema's
    // "FK to team_members" is a comment. Nothing but this guard stands between
    // the body and the column.

    it('never assigns to a candidate the tenant guard rejects', async () => {
      const FOREIGN_AGENT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      repository.findById.mockResolvedValue(makeConversation());
      tenantService.filterAssignableTeamMembers.mockResolvedValue([AGENT_B]);
      repository.countActiveByAssignees.mockResolvedValue({ [AGENT_B]: 0 });
      repository.assignIfHeldBy.mockResolvedValue(
        makeConversation({ assigned_to: AGENT_B }),
      );

      await service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
        strategy: AutoAssignStrategy.LEAST_BUSY,
        // The foreign id is the least busy by a mile — zero conversations here.
        candidateAgentIds: [FOREIGN_AGENT, AGENT_B],
      });

      expect(tenantService.filterAssignableTeamMembers).toHaveBeenCalledWith(
        BUSINESS_ID,
        [FOREIGN_AGENT, AGENT_B],
      );
      expect(repository.assignIfHeldBy).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        AGENT_B,
        null,
      );
    });

    it('rejects the request when no candidate is assignable', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      // Every candidate is another tenant's, suspended, or never signed in.
      tenantService.filterAssignableTeamMembers.mockResolvedValue([]);

      await expect(
        service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
          strategy: AutoAssignStrategy.LEAST_BUSY,
          candidateAgentIds: [AGENT_A, AGENT_B],
        }),
      ).rejects.toThrow(BadRequestException);

      expect(repository.assignIfHeldBy).not.toHaveBeenCalled();
    });

    it('counts load only among the candidates that survived the guard', async () => {
      repository.findById.mockResolvedValue(makeConversation());
      tenantService.filterAssignableTeamMembers.mockResolvedValue([AGENT_A]);
      repository.countActiveByAssignees.mockResolvedValue({ [AGENT_A]: 7 });
      repository.assignIfHeldBy.mockResolvedValue(
        makeConversation({ assigned_to: AGENT_A }),
      );

      await service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
        strategy: AutoAssignStrategy.ROUND_ROBIN,
        candidateAgentIds: [AGENT_A, AGENT_B],
      });

      // Counting the rejected agent's load would skew the round-robin cursor.
      expect(repository.countActiveByAssignees).toHaveBeenCalledWith(BUSINESS_ID, [
        AGENT_A,
      ]);
    });

    // ── concurrency ──

    it('reports a conflict when someone else reassigned it first', async () => {
      repository.findById
        .mockResolvedValueOnce(makeConversation({ assigned_to: null }))
        // The re-read after the failed compare-and-set: a third agent holds it.
        .mockResolvedValueOnce(makeConversation({ assigned_to: AGENT_A }));
      tenantService.filterAssignableTeamMembers.mockResolvedValue([AGENT_B]);
      repository.countActiveByAssignees.mockResolvedValue({ [AGENT_B]: 0 });
      repository.assignIfHeldBy.mockResolvedValue(null);

      await expect(
        service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
          strategy: AutoAssignStrategy.LEAST_BUSY,
          candidateAgentIds: [AGENT_B],
        }),
      ).rejects.toThrow(ConflictException);

      // The loser must not announce an ownership it does not have.
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'conversation.assigned',
        expect.anything(),
      );
    });

    it('treats a lost race with the same outcome as success, not a conflict', async () => {
      const settled = makeConversation({ assigned_to: AGENT_B });
      repository.findById
        .mockResolvedValueOnce(makeConversation({ assigned_to: null }))
        .mockResolvedValueOnce(settled);
      tenantService.filterAssignableTeamMembers.mockResolvedValue([AGENT_B]);
      repository.countActiveByAssignees.mockResolvedValue({ [AGENT_B]: 0 });
      repository.assignIfHeldBy.mockResolvedValue(null);

      // Both supervisors wanted AGENT_B; failing the second is a conflict
      // about nothing.
      const result = await service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
        strategy: AutoAssignStrategy.LEAST_BUSY,
        candidateAgentIds: [AGENT_B],
      });

      expect(result).toEqual(settled);
      // The winner already announced it; a second event would double-notify.
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'conversation.assigned',
        expect.anything(),
      );
    });

    it('does not write or announce when the chosen agent already holds it', async () => {
      repository.findById.mockResolvedValue(makeConversation({ assigned_to: AGENT_B }));
      tenantService.filterAssignableTeamMembers.mockResolvedValue([AGENT_B]);
      repository.countActiveByAssignees.mockResolvedValue({ [AGENT_B]: 3 });

      await service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
        strategy: AutoAssignStrategy.LEAST_BUSY,
        candidateAgentIds: [AGENT_B],
      });

      // `conversation.assigned` announces a transfer. Auto-assignment can
      // genuinely pick the incumbent, and a consumer that re-notifies or
      // resets an SLA clock on every event must not fire on a non-change.
      expect(repository.assignIfHeldBy).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'conversation.assigned',
        expect.anything(),
      );
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

// ─────────────────────────────────────────────
// An agent who leaves mid-conversation
//
// Removal soft-deletes the member and sets them SUSPENDED. Nothing in the
// database follows the assignment: `conversations.assigned_to` has no foreign
// key, so their live conversations keep pointing at an id that no longer
// resolves to anybody. That row is then in the one state nobody looks at —
// assigned, so it is filtered out of the unassigned queue; unresolved, so it
// never closes; and since assignment requires an ACTIVE member, no routine
// path would move it again. The customer is left waiting on a conversation
// owned by someone who no longer works there.
// ─────────────────────────────────────────────

describe('ConversationService — releasing a removed member\'s conversations', () => {
  let service: ConversationService;
  let repository: ReturnType<typeof createMockRepository>;
  let eventEmitter: { emit: jest.Mock };
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const removed: TeamMemberRemovedEvent = {
    type: 'team.member.removed',
    id: 'evt-1',
    timestamp: new Date().toISOString(),
    businessId: BUSINESS_ID,
    correlationId: 'corr',
    memberId: AGENT_A,
  };

  beforeEach(async () => {
    repository = createMockRepository();
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: ConversationRepository, useValue: repository },
        { provide: PrismaService, useValue: createMockPrisma() },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: getQueueToken(CONVERSATION_QUEUE), useValue: { add: jest.fn() } },
        {
          provide: TenantService,
          useValue: {
            assertAssignableTeamMember: jest.fn(),
            filterAssignableTeamMembers: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ConversationService>(ConversationService);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('hands the departing agent\'s conversations back, scoped to their tenant', async () => {
    repository.releaseAssignments.mockResolvedValue([CONVERSATION_ID]);

    await service.handleTeamMemberRemoved(removed);

    expect(repository.releaseAssignments).toHaveBeenCalledWith(BUSINESS_ID, AGENT_A);
  });

  it('records which conversations moved, so the release is not silent', async () => {
    repository.releaseAssignments.mockResolvedValue([CONVERSATION_ID, 'c-2']);

    await service.handleTeamMemberRemoved(removed);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(CONVERSATION_ID));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(AGENT_A));
  });

  it('says nothing when the member held no live conversations', async () => {
    // The common case — removing someone who was never assigned anything must
    // not produce a log line suggesting work was moved.
    repository.releaseAssignments.mockResolvedValue([]);

    await service.handleTeamMemberRemoved(removed);

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Released'));
  });

  it('does not auto-reassign, because choosing a new owner is a routing decision', async () => {
    // Dropping a departing agent's whole caseload onto whoever is least busy
    // is not obviously what the business wants; `autoAssign` exists for that
    // and is invoked deliberately.
    repository.releaseAssignments.mockResolvedValue([CONVERSATION_ID]);

    await service.handleTeamMemberRemoved(removed);

    expect(repository.assign).not.toHaveBeenCalled();
    expect(repository.assignIfHeldBy).not.toHaveBeenCalled();
    expect(repository.countActiveByAssignees).not.toHaveBeenCalled();
  });

  it('swallows a repository failure rather than throwing into the event bus', async () => {
    // A rejection here propagates through EventEmitter2 and takes out the other
    // listeners on team.member.removed alongside this one.
    repository.releaseAssignments.mockRejectedValue(new Error('connection reset'));

    await expect(service.handleTeamMemberRemoved(removed)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(AGENT_A));
  });
});
