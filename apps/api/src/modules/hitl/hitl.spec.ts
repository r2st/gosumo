/**
 * HITL module unit tests
 *
 * Coverage:
 *  1.  createTask: success — no existing open task, creates task, emits 'task.created'
 *  2.  createTask: duplicate conversation task throws ConflictException
 *  3.  createTask: sets SLA defaults — verify slaMinutes and dueAt from SLA_DEFAULTS
 *  4.  getTask: success — returns task from repository
 *  5.  getTask: not found throws NotFoundException
 *  6.  assignTask: success — sets status IN_PROGRESS, emits 'task.assigned'
 *  7.  assignTask: invalid status throws BadRequestException — task is RESOLVED
 *  8.  resolveTask: success — sets status RESOLVED, timestamps, emits 'task.resolved'
 *  9.  resolveTask: already resolved throws BadRequestException
 *  10. approveDraft: success — emits 'ai.response.approved' with wasEdited=false, emits 'message.send'
 *  11. approveDraft: no AI draft throws BadRequestException
 *  12. rejectDraft: success — emits 'ai.response.rejected', emits 'task.resolved'
 *  13. editAndSendDraft: success — emits 'ai.response.approved' with wasEdited=true, emits 'message.send'
 *  14. escalateTask: success — marks original ESCALATED, creates child task with incremented level
 *  15. escalateTask: resolved task throws BadRequestException
 *  16. listTasks: delegates to repository with filters
 *  17. getTaskQueueStats: returns correct aggregated stats
 *  18. handleAIResponseGenerated: creates task when mode is DRAFT
 *  19. handleAIResponseGenerated: skips when mode is not DRAFT
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { TaskStatus, TaskType, TaskPriority, ConfidenceMode, IntentType } from '@gosumo/shared';
import { HitlService } from './hitl.service';
import { HitlRepository } from './hitl.repository';

// ─────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const CONVERSATION_ID = '22222222-2222-2222-2222-222222222222';
const TASK_ID = '33333333-3333-3333-3333-333333333333';
const ASSIGNEE_ID = '44444444-4444-4444-4444-444444444444';
const RESOLVER_ID = '55555555-5555-5555-5555-555555555555';
const AI_DECISION_ID = '66666666-6666-6666-6666-666666666666';
const CHILD_TASK_ID = '77777777-7777-7777-7777-777777777777';

function makeTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TASK_ID,
    business_id: BUSINESS_ID,
    conversation_id: CONVERSATION_ID,
    ai_decision_id: null,
    type: TaskType.REVIEW_RESPONSE,
    status: TaskStatus.PENDING,
    priority: TaskPriority.MEDIUM,
    title: 'Review AI Response',
    description: null,
    assigned_to: null,
    assigned_at: null,
    ai_draft: { message: 'Hello, how can I help?' },
    resolved_by: null,
    resolved_at: null,
    resolution_note: null,
    resolution: null,
    due_at: new Date(Date.now() + 15 * 60 * 1000),
    sla_minutes: 15,
    sla_breached: false,
    sla_breached_at: null,
    escalated_from: null,
    escalation_level: 0,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Mock repository
// ─────────────────────────────────────────────

function createMockRepository() {
  return {
    createTask: jest.fn(),
    findTaskById: jest.fn(),
    findTasks: jest.fn(),
    updateTask: jest.fn(),
    findOpenTaskForConversation: jest.fn(),
    countTasksByStatus: jest.fn(),
    findOverdueTasks: jest.fn(),
    countSlaBreach: jest.fn(),
    getAvgResolutionTime: jest.fn(),
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('HitlService', () => {
  let service: HitlService;
  let repository: ReturnType<typeof createMockRepository>;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    repository = createMockRepository();
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HitlService,
        { provide: HitlRepository, useValue: repository },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<HitlService>(HitlService);
  });

  // ─── createTask ─────────────────────────────

  describe('createTask', () => {
    const dto = {
      conversationId: CONVERSATION_ID,
      type: TaskType.REVIEW_RESPONSE,
      title: 'Review AI Response',
    };

    it('should create task when no open task exists and emit task.created', async () => {
      const created = makeTask();
      repository.findOpenTaskForConversation.mockResolvedValue(null);
      repository.createTask.mockResolvedValue(created);

      const result = await service.createTask(BUSINESS_ID, dto);

      expect(result).toEqual(created);
      expect(repository.findOpenTaskForConversation).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
      );
      expect(repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          type: TaskType.REVIEW_RESPONSE,
          priority: TaskPriority.MEDIUM,
          title: 'Review AI Response',
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.created',
        expect.objectContaining({
          type: 'task.created',
          businessId: BUSINESS_ID,
          taskId: TASK_ID,
          conversationId: CONVERSATION_ID,
          taskType: TaskType.REVIEW_RESPONSE,
          priority: TaskPriority.MEDIUM,
        }),
      );
    });

    it('should throw ConflictException when conversation already has an open task', async () => {
      const existing = makeTask();
      repository.findOpenTaskForConversation.mockResolvedValue(existing);

      await expect(
        service.createTask(BUSINESS_ID, dto),
      ).rejects.toThrow(ConflictException);

      expect(repository.createTask).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should set SLA defaults based on task type', async () => {
      const created = makeTask();
      repository.findOpenTaskForConversation.mockResolvedValue(null);
      repository.createTask.mockResolvedValue(created);

      await service.createTask(BUSINESS_ID, dto);

      // REVIEW_RESPONSE has SLA of 15 minutes
      expect(repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          slaMinutes: 15,
          dueAt: expect.any(Date),
        }),
      );

      // Verify dueAt is roughly 15 minutes from now
      const callArgs = repository.createTask.mock.calls[0][0] as Record<string, unknown>;
      const dueAt = callArgs['dueAt'] as Date;
      const expectedDueAt = Date.now() + 15 * 60 * 1000;
      // Allow 5-second tolerance for test execution time
      expect(Math.abs(dueAt.getTime() - expectedDueAt)).toBeLessThan(5000);
    });
  });

  // ─── getTask ────────────────────────────────

  describe('getTask', () => {
    it('should return the task when found', async () => {
      const task = makeTask();
      repository.findTaskById.mockResolvedValue(task);

      const result = await service.getTask(BUSINESS_ID, TASK_ID);

      expect(result).toEqual(task);
      expect(repository.findTaskById).toHaveBeenCalledWith(BUSINESS_ID, TASK_ID);
    });

    it('should throw NotFoundException when task is not found', async () => {
      repository.findTaskById.mockResolvedValue(null);

      await expect(
        service.getTask(BUSINESS_ID, TASK_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── assignTask ─────────────────────────────

  describe('assignTask', () => {
    it('should assign task, set status to IN_PROGRESS, and emit task.assigned', async () => {
      const task = makeTask({ status: TaskStatus.PENDING });
      const updated = makeTask({
        status: TaskStatus.IN_PROGRESS,
        assigned_to: ASSIGNEE_ID,
        assigned_at: new Date(),
      });
      repository.findTaskById.mockResolvedValue(task);
      repository.updateTask.mockResolvedValue(updated);

      const result = await service.assignTask(BUSINESS_ID, TASK_ID, {
        assigneeId: ASSIGNEE_ID,
      });

      expect(result).toEqual(updated);
      expect(repository.updateTask).toHaveBeenCalledWith(
        BUSINESS_ID,
        TASK_ID,
        expect.objectContaining({
          status: TaskStatus.IN_PROGRESS,
          assignedTo: ASSIGNEE_ID,
          assignedAt: expect.any(Date),
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.assigned',
        expect.objectContaining({
          type: 'task.assigned',
          businessId: BUSINESS_ID,
          taskId: TASK_ID,
          conversationId: CONVERSATION_ID,
          assignedToMemberId: ASSIGNEE_ID,
        }),
      );
    });

    it('should throw BadRequestException when task status is RESOLVED', async () => {
      const task = makeTask({ status: TaskStatus.RESOLVED });
      repository.findTaskById.mockResolvedValue(task);

      await expect(
        service.assignTask(BUSINESS_ID, TASK_ID, { assigneeId: ASSIGNEE_ID }),
      ).rejects.toThrow(BadRequestException);

      expect(repository.updateTask).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ─── resolveTask ────────────────────────────

  describe('resolveTask', () => {
    const resolveDto = {
      resolution: { action: 'DONE' },
      note: 'Resolved successfully',
    };

    it('should resolve task, set timestamps, and emit task.resolved', async () => {
      const task = makeTask({ status: TaskStatus.IN_PROGRESS });
      const updated = makeTask({
        status: TaskStatus.RESOLVED,
        resolved_by: RESOLVER_ID,
        resolved_at: new Date(),
      });
      repository.findTaskById.mockResolvedValue(task);
      repository.updateTask.mockResolvedValue(updated);

      const result = await service.resolveTask(
        BUSINESS_ID,
        TASK_ID,
        resolveDto,
        RESOLVER_ID,
      );

      expect(result).toEqual(updated);
      expect(repository.updateTask).toHaveBeenCalledWith(
        BUSINESS_ID,
        TASK_ID,
        expect.objectContaining({
          status: TaskStatus.RESOLVED,
          resolvedBy: RESOLVER_ID,
          resolvedAt: expect.any(Date),
          resolution: { action: 'DONE' },
          resolutionNote: 'Resolved successfully',
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.resolved',
        expect.objectContaining({
          type: 'task.resolved',
          businessId: BUSINESS_ID,
          taskId: TASK_ID,
          conversationId: CONVERSATION_ID,
          resolvedByMemberId: RESOLVER_ID,
          resolutionDurationSeconds: expect.any(Number),
        }),
      );
    });

    it('should throw BadRequestException when task is already RESOLVED', async () => {
      const task = makeTask({ status: TaskStatus.RESOLVED });
      repository.findTaskById.mockResolvedValue(task);

      await expect(
        service.resolveTask(BUSINESS_ID, TASK_ID, resolveDto, RESOLVER_ID),
      ).rejects.toThrow(BadRequestException);

      expect(repository.updateTask).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ─── approveDraft ───────────────────────────

  describe('approveDraft', () => {
    it('should approve draft, emit ai.response.approved with wasEdited=false, and emit message.send when sendImmediately', async () => {
      const task = makeTask({
        ai_decision_id: AI_DECISION_ID,
        ai_draft: { message: 'Hello, how can I help?' },
      });
      const updated = makeTask({
        status: TaskStatus.RESOLVED,
        resolved_by: RESOLVER_ID,
        resolved_at: new Date(),
      });
      repository.findTaskById.mockResolvedValue(task);
      repository.updateTask.mockResolvedValue(updated);

      const result = await service.approveDraft(
        BUSINESS_ID,
        TASK_ID,
        { sendImmediately: true },
        RESOLVER_ID,
      );

      expect(result).toEqual(updated);
      expect(repository.updateTask).toHaveBeenCalledWith(
        BUSINESS_ID,
        TASK_ID,
        expect.objectContaining({
          status: TaskStatus.RESOLVED,
          resolvedBy: RESOLVER_ID,
          resolvedAt: expect.any(Date),
          resolution: { action: 'APPROVED' },
        }),
      );

      // Verify ai.response.approved event
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'ai.response.approved',
        expect.objectContaining({
          type: 'ai.response.approved',
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          aiDecisionId: AI_DECISION_ID,
          taskId: TASK_ID,
          approvedByMemberId: RESOLVER_ID,
          wasEdited: false,
        }),
      );

      // Verify message.send event
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'message.send',
        expect.objectContaining({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          content: { message: 'Hello, how can I help?' },
          senderType: 'AI',
          aiDecisionId: AI_DECISION_ID,
        }),
      );

      // Verify task.resolved event
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.resolved',
        expect.objectContaining({
          type: 'task.resolved',
          businessId: BUSINESS_ID,
          taskId: TASK_ID,
        }),
      );
    });

    it('should throw BadRequestException when task has no AI draft', async () => {
      const task = makeTask({
        ai_draft: null,
        ai_decision_id: null,
      });
      repository.findTaskById.mockResolvedValue(task);

      await expect(
        service.approveDraft(BUSINESS_ID, TASK_ID, { sendImmediately: true }, RESOLVER_ID),
      ).rejects.toThrow(BadRequestException);

      expect(repository.updateTask).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ─── rejectDraft ────────────────────────────

  describe('rejectDraft', () => {
    it('should reject draft, emit ai.response.rejected and task.resolved', async () => {
      const task = makeTask({
        ai_decision_id: AI_DECISION_ID,
        ai_draft: { message: 'Hello, how can I help?' },
      });
      const updated = makeTask({
        status: TaskStatus.RESOLVED,
        resolved_by: RESOLVER_ID,
        resolved_at: new Date(),
      });
      repository.findTaskById.mockResolvedValue(task);
      repository.updateTask.mockResolvedValue(updated);

      const result = await service.rejectDraft(
        BUSINESS_ID,
        TASK_ID,
        { reason: 'Response is off-topic' },
        RESOLVER_ID,
      );

      expect(result).toEqual(updated);

      // Verify ai.response.rejected event
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'ai.response.rejected',
        expect.objectContaining({
          type: 'ai.response.rejected',
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          aiDecisionId: AI_DECISION_ID,
          taskId: TASK_ID,
          rejectedByMemberId: RESOLVER_ID,
          rejectionReason: 'Response is off-topic',
        }),
      );

      // Verify task.resolved event
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.resolved',
        expect.objectContaining({
          type: 'task.resolved',
          businessId: BUSINESS_ID,
          taskId: TASK_ID,
          conversationId: CONVERSATION_ID,
          resolvedByMemberId: RESOLVER_ID,
        }),
      );
    });
  });

  // ─── editAndSendDraft ───────────────────────

  describe('editAndSendDraft', () => {
    it('should edit draft, emit ai.response.approved with wasEdited=true, and emit message.send', async () => {
      const task = makeTask({
        ai_decision_id: AI_DECISION_ID,
        ai_draft: { message: 'Hello, how can I help?' },
      });
      const updated = makeTask({
        status: TaskStatus.RESOLVED,
        resolved_by: RESOLVER_ID,
        resolved_at: new Date(),
      });
      repository.findTaskById.mockResolvedValue(task);
      repository.updateTask.mockResolvedValue(updated);

      const result = await service.editAndSendDraft(
        BUSINESS_ID,
        TASK_ID,
        { editedResponse: 'Hi there! How may I assist you today?' },
        RESOLVER_ID,
      );

      expect(result).toEqual(updated);

      // Verify ai.response.approved event with wasEdited=true
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'ai.response.approved',
        expect.objectContaining({
          type: 'ai.response.approved',
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          aiDecisionId: AI_DECISION_ID,
          taskId: TASK_ID,
          approvedByMemberId: RESOLVER_ID,
          wasEdited: true,
        }),
      );

      // Verify message.send event with the edited response
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'message.send',
        expect.objectContaining({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          content: 'Hi there! How may I assist you today?',
          senderType: 'AI',
          aiDecisionId: AI_DECISION_ID,
        }),
      );

      // Verify task.resolved event
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.resolved',
        expect.objectContaining({
          type: 'task.resolved',
          businessId: BUSINESS_ID,
          taskId: TASK_ID,
        }),
      );
    });
  });

  // ─── escalateTask ──────────────────────────

  describe('escalateTask', () => {
    it('should mark original task ESCALATED and create child task with incremented level', async () => {
      const task = makeTask({
        status: TaskStatus.IN_PROGRESS,
        escalation_level: 0,
      });
      const childTask = makeTask({
        id: CHILD_TASK_ID,
        title: '[Escalated] Review AI Response',
        priority: TaskPriority.URGENT,
        escalation_level: 1,
        escalated_from: TASK_ID,
      });
      repository.findTaskById.mockResolvedValue(task);
      repository.updateTask.mockResolvedValue(task);
      repository.createTask.mockResolvedValue(childTask);

      const result = await service.escalateTask(
        BUSINESS_ID,
        TASK_ID,
        { reason: 'Needs senior attention' },
        RESOLVER_ID,
      );

      expect(result).toEqual(childTask);

      // Verify original task was marked ESCALATED
      expect(repository.updateTask).toHaveBeenCalledWith(
        BUSINESS_ID,
        TASK_ID,
        { status: TaskStatus.ESCALATED },
      );

      // Verify child task was created with correct fields
      expect(repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          type: TaskType.REVIEW_RESPONSE,
          priority: TaskPriority.URGENT,
          title: '[Escalated] Review AI Response',
          description: 'Needs senior attention',
          escalatedFrom: TASK_ID,
          escalationLevel: 1,
        }),
      );

      // Verify task.created event for the child task
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.created',
        expect.objectContaining({
          type: 'task.created',
          businessId: BUSINESS_ID,
          taskId: CHILD_TASK_ID,
          conversationId: CONVERSATION_ID,
          priority: TaskPriority.URGENT,
        }),
      );
    });

    it('should throw BadRequestException when task is RESOLVED', async () => {
      const task = makeTask({ status: TaskStatus.RESOLVED });
      repository.findTaskById.mockResolvedValue(task);

      await expect(
        service.escalateTask(
          BUSINESS_ID,
          TASK_ID,
          { reason: 'Needs escalation' },
          RESOLVER_ID,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(repository.updateTask).not.toHaveBeenCalled();
      expect(repository.createTask).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ─── listTasks ──────────────────────────────

  describe('listTasks', () => {
    it('should delegate to repository with filters', async () => {
      const paginatedResult = {
        data: [makeTask()],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      };
      repository.findTasks.mockResolvedValue(paginatedResult);

      const query = {
        status: TaskStatus.PENDING,
        type: TaskType.REVIEW_RESPONSE,
        assigneeId: ASSIGNEE_ID,
        priority: TaskPriority.MEDIUM,
        conversationId: CONVERSATION_ID,
        page: 1,
        limit: 20,
      };

      const result = await service.listTasks(BUSINESS_ID, query);

      expect(result).toEqual(paginatedResult);
      expect(repository.findTasks).toHaveBeenCalledWith(BUSINESS_ID, {
        status: TaskStatus.PENDING,
        type: TaskType.REVIEW_RESPONSE,
        assigneeId: ASSIGNEE_ID,
        priority: TaskPriority.MEDIUM,
        conversationId: CONVERSATION_ID,
        page: 1,
        limit: 20,
      });
    });
  });

  // ─── getTaskQueueStats ──────────────────────

  describe('getTaskQueueStats', () => {
    it('should return correct aggregated stats', async () => {
      repository.countTasksByStatus.mockResolvedValue({
        [TaskStatus.PENDING]: 5,
        [TaskStatus.IN_PROGRESS]: 3,
        [TaskStatus.RESOLVED]: 10,
      });
      repository.countSlaBreach.mockResolvedValue(2);
      repository.getAvgResolutionTime.mockResolvedValue(45000);

      const result = await service.getTaskQueueStats(BUSINESS_ID);

      expect(result.pending).toBe(5);
      expect(result.inProgress).toBe(3);
      expect(result.resolved).toBe(10);
      expect(result.escalated).toBe(0);
      expect(result.expired).toBe(0);
      expect(result.breached).toBe(2);
      expect(result.avgResolutionMs).toBe(45000);

      expect(repository.countTasksByStatus).toHaveBeenCalledWith(BUSINESS_ID);
      expect(repository.countSlaBreach).toHaveBeenCalledWith(BUSINESS_ID);
      expect(repository.getAvgResolutionTime).toHaveBeenCalledWith(BUSINESS_ID);
    });
  });

  // ─── handleAIResponseGenerated ──────────────

  describe('handleAIResponseGenerated', () => {
    it('should create task when confidence mode is DRAFT', async () => {
      repository.findOpenTaskForConversation.mockResolvedValue(null);
      const created = makeTask({ ai_decision_id: AI_DECISION_ID });
      repository.createTask.mockResolvedValue(created);

      const event = {
        type: 'ai.response.generated' as const,
        id: 'evt-1',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr-1',
        conversationId: CONVERSATION_ID,
        messageId: 'msg-1',
        aiDecisionId: AI_DECISION_ID,
        intent: IntentType.GENERAL_INQUIRY,
        confidenceScore: {
          dataAvailability: 0.8,
          policyClarity: 0.7,
          finalScore: 0.75,
          mode: ConfidenceMode.DRAFT,
          overrides: [],
        },
        suggestedActions: [
          { type: 'SEND_MESSAGE', parameters: { text: 'Hello' }, confidence: 0.75 },
        ],
        modelId: 'claude-3',
        latencyMs: 500,
      };

      await service.handleAIResponseGenerated(event);

      expect(repository.findOpenTaskForConversation).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
      );
      expect(repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          type: TaskType.REVIEW_RESPONSE,
          title: 'Review AI Response',
          aiDecisionId: AI_DECISION_ID,
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.created',
        expect.objectContaining({
          type: 'task.created',
          businessId: BUSINESS_ID,
        }),
      );
    });

    it('should skip task creation when confidence mode is not DRAFT', async () => {
      const event = {
        type: 'ai.response.generated' as const,
        id: 'evt-2',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr-2',
        conversationId: CONVERSATION_ID,
        messageId: 'msg-2',
        aiDecisionId: AI_DECISION_ID,
        intent: IntentType.GENERAL_INQUIRY,
        confidenceScore: {
          dataAvailability: 0.95,
          policyClarity: 0.92,
          finalScore: 0.93,
          mode: ConfidenceMode.AUTO_PILOT,
          overrides: [],
        },
        suggestedActions: [
          { type: 'SEND_MESSAGE', parameters: { text: 'Hello' }, confidence: 0.93 },
        ],
        modelId: 'claude-3',
        latencyMs: 400,
      };

      await service.handleAIResponseGenerated(event);

      expect(repository.findOpenTaskForConversation).not.toHaveBeenCalled();
      expect(repository.createTask).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
