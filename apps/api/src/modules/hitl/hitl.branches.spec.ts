/**
 * Branch coverage for HitlService.
 *
 * `hitl.spec.ts` covers each operation's happy path and its headline guard.
 * The decisions left over are the ones that decide what an operator actually
 * sees: whether a resolution counts as an SLA breach (three ways to be true),
 * whether an approved draft is dispatched, how notes survive a task whose
 * metadata is missing or malformed, and which task type an escalation becomes.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import {
  TaskStatus,
  TaskType,
  TaskPriority,
  ConfidenceMode,
  IntentType,
} from '@gosumo/shared';
import type { AIResponseGeneratedEvent } from '@gosumo/shared';
import { HitlService } from './hitl.service';
import { TenantService } from '../tenant/tenant.service';
import { HitlRepository } from './hitl.repository';

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
    ai_decision_id: AI_DECISION_ID,
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

function draftEvent(
  overrides: Record<string, unknown> = {},
): AIResponseGeneratedEvent {
  return {
    type: 'ai.response.generated',
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
    modelId: 'openai/gpt-oss-20b:free',
    latencyMs: 500,
    ...overrides,
  } as AIResponseGeneratedEvent;
}

function escalationEvent(intent: IntentType) {
  return {
    type: 'ai.escalated' as const,
    id: 'evt-esc',
    timestamp: new Date().toISOString(),
    businessId: BUSINESS_ID,
    correlationId: 'corr-esc',
    conversationId: CONVERSATION_ID,
    messageId: 'msg-1',
    aiDecisionId: AI_DECISION_ID,
    intent,
    reason: 'Low confidence',
    suggestedActions: [],
  };
}

describe('HitlService — branches', () => {
  let service: HitlService;
  let repository: {
    createTask: jest.Mock;
    findTaskById: jest.Mock;
    findTasks: jest.Mock;
    updateTask: jest.Mock;
    findOpenTaskForConversation: jest.Mock;
    countTasksByStatus: jest.Mock;
    findOverdueTasks: jest.Mock;
    countSlaBreach: jest.Mock;
    getAvgResolutionTime: jest.Mock;
  };
  let eventEmitter: { emit: jest.Mock };
  let tenantService: { assertTeamMember: jest.Mock };

  /** The single `task.resolved` payload emitted during a call. */
  function resolvedEvent(): Record<string, unknown> {
    const call = eventEmitter.emit.mock.calls.find(
      ([name]) => name === 'task.resolved',
    );
    return call![1] as Record<string, unknown>;
  }

  beforeEach(async () => {
    repository = {
      createTask: jest.fn().mockResolvedValue(makeTask()),
      findTaskById: jest.fn().mockResolvedValue(makeTask()),
      findTasks: jest.fn(),
      updateTask: jest.fn().mockResolvedValue(makeTask()),
      findOpenTaskForConversation: jest.fn().mockResolvedValue(null),
      countTasksByStatus: jest.fn().mockResolvedValue({}),
      findOverdueTasks: jest.fn(),
      countSlaBreach: jest.fn().mockResolvedValue(0),
      getAvgResolutionTime: jest.fn().mockResolvedValue(0),
    };
    eventEmitter = { emit: jest.fn() };
    tenantService = { assertTeamMember: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HitlService,
        { provide: HitlRepository, useValue: repository },
        { provide: EventEmitter2, useValue: eventEmitter },
        // Assignment guard: by default every assignee is a member of this
        // tenant, so the existing cases exercise the happy path unchanged.
        { provide: TenantService, useValue: tenantService },
      ],
    }).compile();

    service = module.get(HitlService);
  });

  // ───────────────────────────────────────────────────────────────────
  // createTask
  // ───────────────────────────────────────────────────────────────────

  describe('createTask', () => {
    it('defaults an unspecified priority to MEDIUM', async () => {
      await service.createTask(BUSINESS_ID, {
        conversationId: CONVERSATION_ID,
        type: TaskType.REVIEW_RESPONSE,
        title: 'Review',
      });

      expect(repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ priority: TaskPriority.MEDIUM }),
      );
    });

    it('honours an explicit priority', async () => {
      await service.createTask(BUSINESS_ID, {
        conversationId: CONVERSATION_ID,
        type: TaskType.REVIEW_RESPONSE,
        priority: TaskPriority.URGENT,
        title: 'Review',
      });

      expect(repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ priority: TaskPriority.URGENT }),
      );
    });

    it('falls back to a two-hour SLA for a type with no default', async () => {
      await service.createTask(BUSINESS_ID, {
        conversationId: CONVERSATION_ID,
        type: 'UNMAPPED_TYPE' as TaskType,
        title: 'Odd one',
      });

      expect(repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ slaMinutes: 120 }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // assignTask
  // ───────────────────────────────────────────────────────────────────

  describe('assignTask', () => {
    it('throws NotFoundException for an unknown task', async () => {
      repository.findTaskById.mockResolvedValue(null);

      await expect(
        service.assignTask(BUSINESS_ID, TASK_ID, { assigneeId: ASSIGNEE_ID }),
      ).rejects.toThrow(NotFoundException);
    });

    it('allows reassigning a task that is already IN_PROGRESS', async () => {
      repository.findTaskById.mockResolvedValue(
        makeTask({ status: TaskStatus.IN_PROGRESS }),
      );

      await service.assignTask(BUSINESS_ID, TASK_ID, { assigneeId: ASSIGNEE_ID });

      expect(repository.updateTask).toHaveBeenCalledWith(
        BUSINESS_ID,
        TASK_ID,
        expect.objectContaining({
          status: TaskStatus.IN_PROGRESS,
          assignedTo: ASSIGNEE_ID,
        }),
      );
    });

    it('refuses to assign an escalated task', async () => {
      repository.findTaskById.mockResolvedValue(
        makeTask({ status: TaskStatus.ESCALATED }),
      );

      await expect(
        service.assignTask(BUSINESS_ID, TASK_ID, { assigneeId: ASSIGNEE_ID }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // SLA-breach determination — shared by four resolution paths
  // ───────────────────────────────────────────────────────────────────

  describe('SLA breach flagging', () => {
    it('flags a breach when the task was already marked breached', async () => {
      repository.findTaskById.mockResolvedValue(
        makeTask({ sla_breached: true, due_at: new Date(Date.now() + 60_000) }),
      );

      await service.resolveTask(
        BUSINESS_ID,
        TASK_ID,
        { resolution: { action: 'DONE' } },
        RESOLVER_ID,
      );

      expect(resolvedEvent()['slaBreach']).toBe(true);
    });

    it('flags a breach when the due date has passed', async () => {
      repository.findTaskById.mockResolvedValue(
        makeTask({ sla_breached: false, due_at: new Date(Date.now() - 60_000) }),
      );

      await service.resolveTask(
        BUSINESS_ID,
        TASK_ID,
        { resolution: { action: 'DONE' } },
        RESOLVER_ID,
      );

      expect(resolvedEvent()['slaBreach']).toBe(true);
    });

    it('reports no breach for a task with no due date', async () => {
      repository.findTaskById.mockResolvedValue(
        makeTask({ sla_breached: false, due_at: null }),
      );

      await service.resolveTask(
        BUSINESS_ID,
        TASK_ID,
        { resolution: { action: 'DONE' } },
        RESOLVER_ID,
      );

      expect(resolvedEvent()['slaBreach']).toBe(false);
    });

    it('carries the breach flag through an approved draft', async () => {
      repository.findTaskById.mockResolvedValue(
        makeTask({ due_at: new Date(Date.now() - 60_000) }),
      );

      await service.approveDraft(BUSINESS_ID, TASK_ID, {}, RESOLVER_ID);

      expect(resolvedEvent()['slaBreach']).toBe(true);
    });

    it('carries the breach flag through a rejected draft', async () => {
      repository.findTaskById.mockResolvedValue(makeTask({ sla_breached: true }));

      await service.rejectDraft(
        BUSINESS_ID,
        TASK_ID,
        { reason: 'wrong tone' },
        RESOLVER_ID,
      );

      expect(resolvedEvent()['slaBreach']).toBe(true);
    });

    it('carries the breach flag through an edited draft', async () => {
      repository.findTaskById.mockResolvedValue(makeTask({ due_at: null }));

      await service.editAndSendDraft(
        BUSINESS_ID,
        TASK_ID,
        { editedResponse: 'Rewritten' },
        RESOLVER_ID,
      );

      expect(resolvedEvent()['slaBreach']).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // resolveTask
  // ───────────────────────────────────────────────────────────────────

  describe('resolveTask', () => {
    it('throws NotFoundException for an unknown task', async () => {
      repository.findTaskById.mockResolvedValue(null);

      await expect(
        service.resolveTask(
          BUSINESS_ID,
          TASK_ID,
          { resolution: { action: 'DONE' } },
          RESOLVER_ID,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses to resolve an expired task', async () => {
      repository.findTaskById.mockResolvedValue(
        makeTask({ status: TaskStatus.EXPIRED }),
      );

      await expect(
        service.resolveTask(
          BUSINESS_ID,
          TASK_ID,
          { resolution: { action: 'DONE' } },
          RESOLVER_ID,
        ),
      ).rejects.toThrow(/already EXPIRED/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Draft handling
  // ───────────────────────────────────────────────────────────────────

  describe('approveDraft', () => {
    it('throws NotFoundException for an unknown task', async () => {
      repository.findTaskById.mockResolvedValue(null);

      await expect(
        service.approveDraft(BUSINESS_ID, TASK_ID, {}, RESOLVER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a task that carries a draft but no decision id', async () => {
      repository.findTaskById.mockResolvedValue(makeTask({ ai_decision_id: null }));

      await expect(
        service.approveDraft(BUSINESS_ID, TASK_ID, {}, RESOLVER_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('dispatches the draft by default', async () => {
      await service.approveDraft(BUSINESS_ID, TASK_ID, {}, RESOLVER_ID);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'message.send',
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          senderType: 'AI',
          aiDecisionId: AI_DECISION_ID,
        }),
      );
    });

    it('holds the draft back when sendImmediately is false', async () => {
      await service.approveDraft(
        BUSINESS_ID,
        TASK_ID,
        { sendImmediately: false },
        RESOLVER_ID,
      );

      expect(
        eventEmitter.emit.mock.calls.filter(([name]) => name === 'message.send'),
      ).toHaveLength(0);
      // The approval itself is still recorded.
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'ai.response.approved',
        expect.objectContaining({ wasEdited: false }),
      );
    });
  });

  describe('rejectDraft', () => {
    it('throws NotFoundException for an unknown task', async () => {
      repository.findTaskById.mockResolvedValue(null);

      await expect(
        service.rejectDraft(BUSINESS_ID, TASK_ID, { reason: 'no' }, RESOLVER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a task with no decision id', async () => {
      repository.findTaskById.mockResolvedValue(makeTask({ ai_decision_id: null }));

      await expect(
        service.rejectDraft(BUSINESS_ID, TASK_ID, { reason: 'no' }, RESOLVER_ID),
      ).rejects.toThrow(/no AI decision ID/);
    });

    it('does not dispatch anything to the customer', async () => {
      await service.rejectDraft(
        BUSINESS_ID,
        TASK_ID,
        { reason: 'wrong tone' },
        RESOLVER_ID,
      );

      expect(
        eventEmitter.emit.mock.calls.filter(([name]) => name === 'message.send'),
      ).toHaveLength(0);
    });
  });

  describe('editAndSendDraft', () => {
    it('throws NotFoundException for an unknown task', async () => {
      repository.findTaskById.mockResolvedValue(null);

      await expect(
        service.editAndSendDraft(
          BUSINESS_ID,
          TASK_ID,
          { editedResponse: 'Hi' },
          RESOLVER_ID,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a task with no decision id', async () => {
      repository.findTaskById.mockResolvedValue(makeTask({ ai_decision_id: null }));

      await expect(
        service.editAndSendDraft(
          BUSINESS_ID,
          TASK_ID,
          { editedResponse: 'Hi' },
          RESOLVER_ID,
        ),
      ).rejects.toThrow(/Cannot edit draft/);
    });

    it('sends the edited text, not the original draft', async () => {
      await service.editAndSendDraft(
        BUSINESS_ID,
        TASK_ID,
        { editedResponse: 'Rewritten reply' },
        RESOLVER_ID,
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'message.send',
        expect.objectContaining({ content: 'Rewritten reply' }),
      );
    });
  });

  describe('sendManualResponse', () => {
    it('emits a human-authored send', async () => {
      await service.sendManualResponse(
        BUSINESS_ID,
        { conversationId: CONVERSATION_ID, content: { text: 'On it!' } },
        RESOLVER_ID,
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith('message.send', {
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        content: { text: 'On it!' },
        senderType: 'HUMAN_AGENT',
        senderId: RESOLVER_ID,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Internal notes
  // ───────────────────────────────────────────────────────────────────

  describe('internal notes', () => {
    it('returns the note unattached when the conversation has no open task', async () => {
      repository.findOpenTaskForConversation.mockResolvedValue(null);

      const note = await service.postInternalNote(
        BUSINESS_ID,
        CONVERSATION_ID,
        { text: 'Watch this one' },
        RESOLVER_ID,
      );

      expect(note.text).toBe('Watch this one');
      expect(note.mentionedUserIds).toEqual([]);
      expect(repository.updateTask).not.toHaveBeenCalled();
    });

    it('records the mentioned users when given', async () => {
      repository.findOpenTaskForConversation.mockResolvedValue(makeTask());

      const note = await service.postInternalNote(
        BUSINESS_ID,
        CONVERSATION_ID,
        { text: 'cc you', mentionedUserIds: [ASSIGNEE_ID] },
        RESOLVER_ID,
      );

      expect(note.mentionedUserIds).toEqual([ASSIGNEE_ID]);
    });

    it('appends to the existing notes array', async () => {
      const existing = {
        id: 'note-0',
        text: 'earlier',
        authorId: ASSIGNEE_ID,
        mentionedUserIds: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      repository.findOpenTaskForConversation.mockResolvedValue(
        makeTask({ metadata: { notes: [existing], other: 'kept' } }),
      );

      await service.postInternalNote(
        BUSINESS_ID,
        CONVERSATION_ID,
        { text: 'later' },
        RESOLVER_ID,
      );

      const [, , payload] = repository.updateTask.mock.calls[0]!;
      const metadata = (payload as { metadata: Record<string, unknown> }).metadata;
      expect(metadata['other']).toBe('kept');
      expect(metadata['notes']).toHaveLength(2);
    });

    it('replaces a non-array notes value rather than crashing', async () => {
      repository.findOpenTaskForConversation.mockResolvedValue(
        makeTask({ metadata: { notes: 'corrupted' } }),
      );

      await service.postInternalNote(
        BUSINESS_ID,
        CONVERSATION_ID,
        { text: 'fresh start' },
        RESOLVER_ID,
      );

      const [, , payload] = repository.updateTask.mock.calls[0]!;
      const metadata = (payload as { metadata: Record<string, unknown> }).metadata;
      expect(metadata['notes']).toHaveLength(1);
    });

    it('tolerates a task with null metadata', async () => {
      repository.findOpenTaskForConversation.mockResolvedValue(
        makeTask({ metadata: null }),
      );

      await service.postInternalNote(
        BUSINESS_ID,
        CONVERSATION_ID,
        { text: 'first note' },
        RESOLVER_ID,
      );

      const [, , payload] = repository.updateTask.mock.calls[0]!;
      expect(
        (payload as { metadata: { notes: unknown[] } }).metadata.notes,
      ).toHaveLength(1);
    });

    it('reads back an empty list when there is no open task', async () => {
      repository.findOpenTaskForConversation.mockResolvedValue(null);

      expect(
        await service.getInternalNotes(BUSINESS_ID, CONVERSATION_ID),
      ).toEqual([]);
    });

    it('reads back an empty list when metadata is null', async () => {
      repository.findOpenTaskForConversation.mockResolvedValue(
        makeTask({ metadata: null }),
      );

      expect(
        await service.getInternalNotes(BUSINESS_ID, CONVERSATION_ID),
      ).toEqual([]);
    });

    it('reads back an empty list when notes is not an array', async () => {
      repository.findOpenTaskForConversation.mockResolvedValue(
        makeTask({ metadata: { notes: { nope: true } } }),
      );

      expect(
        await service.getInternalNotes(BUSINESS_ID, CONVERSATION_ID),
      ).toEqual([]);
    });

    it('reads back the stored notes', async () => {
      const note = {
        id: 'note-1',
        text: 'hi',
        authorId: RESOLVER_ID,
        mentionedUserIds: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      repository.findOpenTaskForConversation.mockResolvedValue(
        makeTask({ metadata: { notes: [note] } }),
      );

      expect(await service.getInternalNotes(BUSINESS_ID, CONVERSATION_ID)).toEqual([
        note,
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Escalation
  // ───────────────────────────────────────────────────────────────────

  describe('escalateTask', () => {
    it('throws NotFoundException for an unknown task', async () => {
      repository.findTaskById.mockResolvedValue(null);

      await expect(
        service.escalateTask(BUSINESS_ID, TASK_ID, { reason: 'stuck' }, RESOLVER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses to escalate an expired task', async () => {
      repository.findTaskById.mockResolvedValue(
        makeTask({ status: TaskStatus.EXPIRED }),
      );

      await expect(
        service.escalateTask(BUSINESS_ID, TASK_ID, { reason: 'stuck' }, RESOLVER_ID),
      ).rejects.toThrow(/already EXPIRED/);
    });

    it('defaults the child priority to URGENT', async () => {
      repository.createTask.mockResolvedValue(
        makeTask({ id: CHILD_TASK_ID, escalation_level: 1 }),
      );

      await service.escalateTask(
        BUSINESS_ID,
        TASK_ID,
        { reason: 'stuck' },
        RESOLVER_ID,
      );

      expect(repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: TaskPriority.URGENT,
          escalatedFrom: TASK_ID,
          escalationLevel: 1,
        }),
      );
    });

    it('honours an explicit child priority', async () => {
      repository.createTask.mockResolvedValue(makeTask({ id: CHILD_TASK_ID }));

      await service.escalateTask(
        BUSINESS_ID,
        TASK_ID,
        { reason: 'stuck', newPriority: TaskPriority.HIGH },
        RESOLVER_ID,
      );

      expect(repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ priority: TaskPriority.HIGH }),
      );
    });

    it('drops a null decision id rather than passing it on', async () => {
      repository.findTaskById.mockResolvedValue(
        makeTask({ ai_decision_id: null, type: 'UNMAPPED_TYPE' }),
      );
      repository.createTask.mockResolvedValue(makeTask({ id: CHILD_TASK_ID }));

      await service.escalateTask(
        BUSINESS_ID,
        TASK_ID,
        { reason: 'stuck' },
        RESOLVER_ID,
      );

      expect(repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ aiDecisionId: undefined, slaMinutes: 120 }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Stats
  // ───────────────────────────────────────────────────────────────────

  describe('getTaskQueueStats', () => {
    it('zero-fills every status the repository did not report', async () => {
      repository.countTasksByStatus.mockResolvedValue({
        [TaskStatus.PENDING]: 3,
      });
      repository.countSlaBreach.mockResolvedValue(1);
      repository.getAvgResolutionTime.mockResolvedValue(4200);

      const stats = await service.getTaskQueueStats(BUSINESS_ID);

      expect(stats).toMatchObject({
        pending: 3,
        inProgress: 0,
        resolved: 0,
        escalated: 0,
        expired: 0,
        breached: 1,
        avgResolutionMs: 4200,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Event handlers
  // ───────────────────────────────────────────────────────────────────

  describe('handleAIResponseGenerated', () => {
    it('swallows the duplicate-task conflict quietly', async () => {
      repository.findOpenTaskForConversation.mockResolvedValue(makeTask());

      await expect(
        service.handleAIResponseGenerated(draftEvent()),
      ).resolves.toBeUndefined();

      expect(repository.createTask).not.toHaveBeenCalled();
    });

    it('swallows an unexpected repository failure', async () => {
      repository.findOpenTaskForConversation.mockRejectedValue(new Error('db down'));

      await expect(
        service.handleAIResponseGenerated(draftEvent()),
      ).resolves.toBeUndefined();
    });

    it('swallows a non-Error rejection', async () => {
      repository.findOpenTaskForConversation.mockRejectedValue('db down');

      await expect(
        service.handleAIResponseGenerated(draftEvent()),
      ).resolves.toBeUndefined();
    });
  });

  describe('handleAIEscalated', () => {
    it('routes a complaint to a HANDLE_COMPLAINT task', async () => {
      await service.handleAIEscalated(escalationEvent(IntentType.COMPLAINT));

      expect(repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          type: TaskType.HANDLE_COMPLAINT,
          priority: TaskPriority.URGENT,
        }),
      );
    });

    it('routes any other intent to a CLARIFY_INTENT task', async () => {
      await service.handleAIEscalated(escalationEvent(IntentType.GENERAL_INQUIRY));

      expect(repository.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ type: TaskType.CLARIFY_INTENT }),
      );
    });

    it('swallows the duplicate-task conflict quietly', async () => {
      repository.findOpenTaskForConversation.mockResolvedValue(makeTask());

      await expect(
        service.handleAIEscalated(escalationEvent(IntentType.COMPLAINT)),
      ).resolves.toBeUndefined();

      expect(repository.createTask).not.toHaveBeenCalled();
    });

    it('swallows an unexpected repository failure', async () => {
      repository.findOpenTaskForConversation.mockRejectedValue(new Error('db down'));

      await expect(
        service.handleAIEscalated(escalationEvent(IntentType.COMPLAINT)),
      ).resolves.toBeUndefined();
    });

    it('swallows a non-Error rejection', async () => {
      repository.findOpenTaskForConversation.mockRejectedValue('db down');

      await expect(
        service.handleAIEscalated(escalationEvent(IntentType.COMPLAINT)),
      ).resolves.toBeUndefined();
    });
  });

  // A conflict must not be mistaken for a hard failure by callers either.
  it('surfaces the conflict to a direct createTask caller', async () => {
    repository.findOpenTaskForConversation.mockResolvedValue(makeTask());

    await expect(
      service.createTask(BUSINESS_ID, {
        conversationId: CONVERSATION_ID,
        type: TaskType.REVIEW_RESPONSE,
        title: 'Review',
      }),
    ).rejects.toThrow(ConflictException);
  });
});
