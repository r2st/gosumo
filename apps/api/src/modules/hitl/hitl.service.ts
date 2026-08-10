import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { tasks } from '@prisma/client';
import {
  TaskStatus,
  TaskType,
  TaskPriority,
  ConfidenceMode,
  IntentType,
  generateId,
  generateCorrelationId,
} from '@gosumo/shared';
import type {
  TaskCreatedEvent,
  TaskAssignedEvent,
  TaskResolvedEvent,
  AIResponseApprovedEvent,
  AIResponseRejectedEvent,
  AIResponseGeneratedEvent,
  SuggestedAction,
} from '@gosumo/shared';
import { TenantService } from '../tenant/tenant.service';
import { HitlRepository, PaginatedTasks } from './hitl.repository';
import {
  CreateTaskDto,
  ListTasksQueryDto,
  AssignTaskDto,
  ResolveTaskDto,
  ApproveDraftDto,
  RejectDraftDto,
  EditDraftDto,
  SendManualResponseDto,
  PostInternalNoteDto,
  EscalateTaskDto,
  TaskStatsResponseDto,
} from './dto';

// ─────────────────────────────────────────────
// SLA Defaults (in minutes) per task type
// ─────────────────────────────────────────────

const SLA_DEFAULTS: Record<string, number> = {
  [TaskType.REVIEW_RESPONSE]: 15,
  [TaskType.HANDLE_COMPLAINT]: 240,
  [TaskType.APPROVE_REFUND]: 60,
  [TaskType.APPROVE_DISCOUNT]: 30,
  [TaskType.CLARIFY_INTENT]: 30,
  [TaskType.FOLLOW_UP]: 480,
  [TaskType.APPROVE_ORDER]: 60,
  [TaskType.CUSTOM]: 120,
};

// ─────────────────────────────────────────────
// Internal note shape stored in task metadata
// ─────────────────────────────────────────────

export interface InternalNote {
  id: string;
  text: string;
  authorId: string;
  mentionedUserIds: string[];
  createdAt: string;
}

// ─────────────────────────────────────────────
// Event shape for AI escalation events
// ─────────────────────────────────────────────

interface AIEscalatedEvent {
  readonly type: 'ai.escalated';
  id: string;
  timestamp: string;
  businessId: string;
  correlationId: string;
  conversationId: string;
  messageId: string;
  aiDecisionId: string;
  intent: IntentType;
  reason: string;
  suggestedActions: SuggestedAction[];
}

/**
 * HitlService — core business logic for the Human-In-The-Loop module.
 *
 * Manages task lifecycle: creation, assignment, resolution, escalation,
 * AI draft approval/rejection, internal notes, and queue statistics.
 * Listens to AI engine events to automatically create review tasks.
 */
@Injectable()
export class HitlService {
  private readonly logger = new Logger(HitlService.name);

  constructor(
    private readonly repository: HitlRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly tenantService: TenantService,
  ) {}

  // ─────────────────────────────────────────────
  // Task CRUD
  // ─────────────────────────────────────────────

  /**
   * Create a new HITL task for a conversation.
   * Throws ConflictException if an open task already exists for the conversation.
   *
   * Emits `task.created` on success.
   */
  async createTask(businessId: string, dto: CreateTaskDto): Promise<tasks> {
    const existingTask = await this.repository.findOpenTaskForConversation(
      businessId,
      dto.conversationId,
    );

    if (existingTask) {
      throw new ConflictException('Conversation already has an open task');
    }

    const slaMinutes = SLA_DEFAULTS[dto.type] ?? 120;
    const dueAt = new Date(Date.now() + slaMinutes * 60 * 1000);

    const task = await this.repository.createTask({
      businessId,
      conversationId: dto.conversationId,
      type: dto.type,
      priority: dto.priority ?? TaskPriority.MEDIUM,
      title: dto.title,
      description: dto.description,
      aiDecisionId: dto.aiDecisionId,
      aiDraft: dto.draftResponse,
      dueAt,
      slaMinutes,
    });

    const event: TaskCreatedEvent = {
      type: 'task.created',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      taskId: task.id,
      conversationId: dto.conversationId,
      aiDecisionId: dto.aiDecisionId,
      taskType: dto.type,
      priority: task.priority,
      dueAt: dueAt.toISOString(),
    };

    this.eventEmitter.emit('task.created', event);

    this.logger.log(
      `Created task ${task.id} (${dto.type}) for conversation ${dto.conversationId}`,
    );

    return task;
  }

  /**
   * Get a single task by ID.
   * Throws NotFoundException if not found.
   */
  async getTask(businessId: string, taskId: string): Promise<tasks> {
    const task = await this.repository.findTaskById(businessId, taskId);

    if (!task) {
      throw new NotFoundException(`Task not found: ${taskId}`);
    }

    return task;
  }

  /**
   * List tasks with optional filters, paginated.
   */
  async listTasks(
    businessId: string,
    query: ListTasksQueryDto,
  ): Promise<PaginatedTasks> {
    return this.repository.findTasks(businessId, {
      status: query.status,
      type: query.type,
      assigneeId: query.assigneeId,
      priority: query.priority,
      conversationId: query.conversationId,
      page: query.page,
      limit: query.limit,
    });
  }

  // ─────────────────────────────────────────────
  // Task Assignment
  // ─────────────────────────────────────────────

  /**
   * Assign a task to a team member.
   * Moves the task to IN_PROGRESS if currently PENDING.
   *
   * Emits `task.assigned` on success.
   */
  async assignTask(
    businessId: string,
    taskId: string,
    dto: AssignTaskDto,
  ): Promise<tasks> {
    const task = await this.repository.findTaskById(businessId, taskId);

    if (!task) {
      throw new NotFoundException(`Task not found: ${taskId}`);
    }

    const status = task.status as TaskStatus;

    if (status !== TaskStatus.PENDING && status !== TaskStatus.IN_PROGRESS) {
      throw new BadRequestException(
        `Cannot assign task in status ${status}. Task must be PENDING or IN_PROGRESS.`,
      );
    }

    // `taskId` is tenant-scoped by the lookup above, but `assigneeId` arrives in
    // the body and is not. The `tasks.assigned_to` foreign key is satisfied by
    // any real `team_members` row, so without this the caller could assign
    // their task to another business's operator.
    await this.tenantService.assertTeamMember(businessId, dto.assigneeId);

    const updated = await this.repository.updateTask(businessId, taskId, {
      status: TaskStatus.IN_PROGRESS,
      assignedTo: dto.assigneeId,
      assignedAt: new Date(),
    });

    const event: TaskAssignedEvent = {
      type: 'task.assigned',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      taskId,
      conversationId: task.conversation_id,
      assignedToMemberId: dto.assigneeId,
    };

    this.eventEmitter.emit('task.assigned', event);

    this.logger.log(`Task ${taskId} assigned to ${dto.assigneeId}`);

    return updated;
  }

  // ─────────────────────────────────────────────
  // Task Resolution
  // ─────────────────────────────────────────────

  /**
   * Resolve a task with a resolution payload.
   *
   * Emits `task.resolved` on success.
   */
  async resolveTask(
    businessId: string,
    taskId: string,
    dto: ResolveTaskDto,
    resolvedBy: string,
  ): Promise<tasks> {
    const task = await this.repository.findTaskById(businessId, taskId);

    if (!task) {
      throw new NotFoundException(`Task not found: ${taskId}`);
    }

    const status = task.status as TaskStatus;

    if (status === TaskStatus.RESOLVED || status === TaskStatus.EXPIRED) {
      throw new BadRequestException(
        `Cannot resolve task in status ${status}. Task is already ${status}.`,
      );
    }

    const now = new Date();

    const updated = await this.repository.updateTask(businessId, taskId, {
      status: TaskStatus.RESOLVED,
      resolvedBy,
      resolvedAt: now,
      resolution: dto.resolution,
      resolutionNote: dto.note,
    });

    const resolutionDurationSeconds = Math.round(
      (now.getTime() - new Date(task.created_at).getTime()) / 1000,
    );

    const slaBreach = task.sla_breached === true ||
      (task.due_at !== null && now > new Date(task.due_at));

    const event: TaskResolvedEvent = {
      type: 'task.resolved',
      id: generateId(),
      timestamp: now.toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      taskId,
      conversationId: task.conversation_id,
      resolvedByMemberId: resolvedBy,
      resolutionNote: dto.note,
      resolutionDurationSeconds,
      slaBreach,
    };

    this.eventEmitter.emit('task.resolved', event);

    this.logger.log(
      `Task ${taskId} resolved by ${resolvedBy} in ${resolutionDurationSeconds}s`,
    );

    return updated;
  }

  // ─────────────────────────────────────────────
  // AI Draft: Approve / Reject / Edit
  // ─────────────────────────────────────────────

  /**
   * Approve an AI-generated draft response.
   * Optionally sends the draft immediately.
   *
   * Emits `ai.response.approved` and `task.resolved`.
   */
  async approveDraft(
    businessId: string,
    taskId: string,
    dto: ApproveDraftDto,
    approvedBy: string,
  ): Promise<tasks> {
    const task = await this.repository.findTaskById(businessId, taskId);

    if (!task) {
      throw new NotFoundException(`Task not found: ${taskId}`);
    }

    if (!task.ai_draft || !task.ai_decision_id) {
      throw new BadRequestException(
        'Task has no AI draft or AI decision ID. Cannot approve.',
      );
    }

    const now = new Date();

    const updated = await this.repository.updateTask(businessId, taskId, {
      status: TaskStatus.RESOLVED,
      resolvedBy: approvedBy,
      resolvedAt: now,
      resolution: { action: 'APPROVED' },
    });

    const approvedEvent: AIResponseApprovedEvent = {
      type: 'ai.response.approved',
      id: generateId(),
      timestamp: now.toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId: task.conversation_id,
      aiDecisionId: task.ai_decision_id,
      taskId,
      approvedByMemberId: approvedBy,
      wasEdited: false,
    };

    this.eventEmitter.emit('ai.response.approved', approvedEvent);

    const sendImmediately = dto.sendImmediately ?? true;

    if (sendImmediately) {
      this.eventEmitter.emit('message.send', {
        businessId,
        conversationId: task.conversation_id,
        content: task.ai_draft,
        senderType: 'AI',
        aiDecisionId: task.ai_decision_id,
      });

      this.logger.log(`AI draft for task ${taskId} approved and sent`);
    } else {
      this.logger.log(`AI draft for task ${taskId} approved (not sent)`);
    }

    const resolutionDurationSeconds = Math.round(
      (now.getTime() - new Date(task.created_at).getTime()) / 1000,
    );

    const slaBreach = task.sla_breached === true ||
      (task.due_at !== null && now > new Date(task.due_at));

    const resolvedEvent: TaskResolvedEvent = {
      type: 'task.resolved',
      id: generateId(),
      timestamp: now.toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      taskId,
      conversationId: task.conversation_id,
      resolvedByMemberId: approvedBy,
      resolutionDurationSeconds,
      slaBreach,
    };

    this.eventEmitter.emit('task.resolved', resolvedEvent);

    return updated;
  }

  /**
   * Reject an AI-generated draft response.
   *
   * Emits `ai.response.rejected` and `task.resolved`.
   */
  async rejectDraft(
    businessId: string,
    taskId: string,
    dto: RejectDraftDto,
    rejectedBy: string,
  ): Promise<tasks> {
    const task = await this.repository.findTaskById(businessId, taskId);

    if (!task) {
      throw new NotFoundException(`Task not found: ${taskId}`);
    }

    if (!task.ai_decision_id) {
      throw new BadRequestException(
        'Task has no AI decision ID. Cannot reject.',
      );
    }

    const now = new Date();

    const updated = await this.repository.updateTask(businessId, taskId, {
      status: TaskStatus.RESOLVED,
      resolvedBy: rejectedBy,
      resolvedAt: now,
      resolution: { action: 'REJECTED', reason: dto.reason },
    });

    const rejectedEvent: AIResponseRejectedEvent = {
      type: 'ai.response.rejected',
      id: generateId(),
      timestamp: now.toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId: task.conversation_id,
      aiDecisionId: task.ai_decision_id,
      taskId,
      rejectedByMemberId: rejectedBy,
      rejectionReason: dto.reason,
    };

    this.eventEmitter.emit('ai.response.rejected', rejectedEvent);

    const resolutionDurationSeconds = Math.round(
      (now.getTime() - new Date(task.created_at).getTime()) / 1000,
    );

    const slaBreach = task.sla_breached === true ||
      (task.due_at !== null && now > new Date(task.due_at));

    const resolvedEvent: TaskResolvedEvent = {
      type: 'task.resolved',
      id: generateId(),
      timestamp: now.toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      taskId,
      conversationId: task.conversation_id,
      resolvedByMemberId: rejectedBy,
      resolutionNote: dto.reason,
      resolutionDurationSeconds,
      slaBreach,
    };

    this.eventEmitter.emit('task.resolved', resolvedEvent);

    this.logger.log(`AI draft for task ${taskId} rejected by ${rejectedBy}`);

    return updated;
  }

  /**
   * Edit an AI draft and send the edited version.
   *
   * Emits `ai.response.approved` (wasEdited=true), `message.send`, and `task.resolved`.
   */
  async editAndSendDraft(
    businessId: string,
    taskId: string,
    dto: EditDraftDto,
    editedBy: string,
  ): Promise<tasks> {
    const task = await this.repository.findTaskById(businessId, taskId);

    if (!task) {
      throw new NotFoundException(`Task not found: ${taskId}`);
    }

    if (!task.ai_decision_id) {
      throw new BadRequestException(
        'Task has no AI decision ID. Cannot edit draft.',
      );
    }

    const now = new Date();

    const updated = await this.repository.updateTask(businessId, taskId, {
      status: TaskStatus.RESOLVED,
      resolvedBy: editedBy,
      resolvedAt: now,
      resolution: { action: 'EDITED', editedResponse: dto.editedResponse },
    });

    const approvedEvent: AIResponseApprovedEvent = {
      type: 'ai.response.approved',
      id: generateId(),
      timestamp: now.toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId: task.conversation_id,
      aiDecisionId: task.ai_decision_id,
      taskId,
      approvedByMemberId: editedBy,
      wasEdited: true,
    };

    this.eventEmitter.emit('ai.response.approved', approvedEvent);

    this.eventEmitter.emit('message.send', {
      businessId,
      conversationId: task.conversation_id,
      content: dto.editedResponse,
      senderType: 'AI',
      aiDecisionId: task.ai_decision_id,
    });

    const resolutionDurationSeconds = Math.round(
      (now.getTime() - new Date(task.created_at).getTime()) / 1000,
    );

    const slaBreach = task.sla_breached === true ||
      (task.due_at !== null && now > new Date(task.due_at));

    const resolvedEvent: TaskResolvedEvent = {
      type: 'task.resolved',
      id: generateId(),
      timestamp: now.toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      taskId,
      conversationId: task.conversation_id,
      resolvedByMemberId: editedBy,
      resolutionDurationSeconds,
      slaBreach,
    };

    this.eventEmitter.emit('task.resolved', resolvedEvent);

    this.logger.log(
      `AI draft for task ${taskId} edited and sent by ${editedBy}`,
    );

    return updated;
  }

  // ─────────────────────────────────────────────
  // Manual Response
  // ─────────────────────────────────────────────

  /**
   * Send a manual (human agent) response in a conversation.
   *
   * Emits `message.send`.
   */
  async sendManualResponse(
    businessId: string,
    dto: SendManualResponseDto,
    senderId: string,
  ): Promise<void> {
    this.eventEmitter.emit('message.send', {
      businessId,
      conversationId: dto.conversationId,
      content: dto.content,
      senderType: 'HUMAN_AGENT',
      senderId,
    });

    this.logger.log(
      `Manual response sent by ${senderId} in conversation ${dto.conversationId}`,
    );
  }

  // ─────────────────────────────────────────────
  // Internal Notes
  // ─────────────────────────────────────────────

  /**
   * Post an internal note on a conversation's open task.
   * Notes are stored in the task's metadata.notes array.
   * If no open task exists, a warning is logged but the note is still returned.
   */
  async postInternalNote(
    businessId: string,
    conversationId: string,
    dto: PostInternalNoteDto,
    authorId: string,
  ): Promise<InternalNote> {
    const task = await this.repository.findOpenTaskForConversation(
      businessId,
      conversationId,
    );

    const note: InternalNote = {
      id: generateId(),
      text: dto.text,
      authorId,
      mentionedUserIds: dto.mentionedUserIds ?? [],
      createdAt: new Date().toISOString(),
    };

    if (!task) {
      this.logger.warn(
        `No open task for conversation ${conversationId}. Note created without task context.`,
      );
      return note;
    }

    const metadata = (task.metadata as Record<string, unknown>) ?? {};
    const existingNotes = Array.isArray(metadata['notes'])
      ? (metadata['notes'] as InternalNote[])
      : [];

    const updatedNotes = [...existingNotes, note];

    await this.repository.updateTask(businessId, task.id, {
      metadata: { ...metadata, notes: updatedNotes },
    });

    this.logger.debug(
      `Internal note ${note.id} posted on task ${task.id} by ${authorId}`,
    );

    return note;
  }

  /**
   * Retrieve internal notes for a conversation's open task.
   * Returns an empty array if no open task exists.
   */
  async getInternalNotes(
    businessId: string,
    conversationId: string,
  ): Promise<InternalNote[]> {
    const task = await this.repository.findOpenTaskForConversation(
      businessId,
      conversationId,
    );

    if (!task) {
      return [];
    }

    const metadata = (task.metadata as Record<string, unknown>) ?? {};
    const notes = Array.isArray(metadata['notes'])
      ? (metadata['notes'] as InternalNote[])
      : [];

    return notes;
  }

  // ─────────────────────────────────────────────
  // Escalation
  // ─────────────────────────────────────────────

  /**
   * Escalate a task by marking it ESCALATED and creating a new child task
   * at a higher escalation level.
   *
   * Emits `task.created` for the new child task.
   */
  async escalateTask(
    businessId: string,
    taskId: string,
    dto: EscalateTaskDto,
    escalatedBy: string,
  ): Promise<tasks> {
    const task = await this.repository.findTaskById(businessId, taskId);

    if (!task) {
      throw new NotFoundException(`Task not found: ${taskId}`);
    }

    const status = task.status as TaskStatus;

    if (status === TaskStatus.RESOLVED || status === TaskStatus.EXPIRED) {
      throw new BadRequestException(
        `Cannot escalate task in status ${status}. Task is already ${status}.`,
      );
    }

    // Mark original task as escalated
    await this.repository.updateTask(businessId, taskId, {
      status: TaskStatus.ESCALATED,
    });

    const childPriority = dto.newPriority ?? TaskPriority.URGENT;
    const slaMinutes = SLA_DEFAULTS[task.type as string] ?? 120;
    const dueAt = new Date(Date.now() + slaMinutes * 60 * 1000);

    // Create escalated child task
    const childTask = await this.repository.createTask({
      businessId,
      conversationId: task.conversation_id,
      type: task.type as TaskType,
      priority: childPriority,
      title: `[Escalated] ${task.title}`,
      description: dto.reason,
      aiDecisionId: task.ai_decision_id ?? undefined,
      aiDraft: task.ai_draft as Record<string, unknown> | undefined,
      dueAt,
      slaMinutes,
      escalatedFrom: taskId,
      escalationLevel: task.escalation_level + 1,
    });

    const event: TaskCreatedEvent = {
      type: 'task.created',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      taskId: childTask.id,
      conversationId: task.conversation_id,
      aiDecisionId: task.ai_decision_id ?? undefined,
      taskType: task.type as string,
      priority: childPriority,
      dueAt: dueAt.toISOString(),
    };

    this.eventEmitter.emit('task.created', event);

    this.logger.log(
      `Task ${taskId} escalated by ${escalatedBy}. Child task: ${childTask.id} (level ${childTask.escalation_level})`,
    );

    return childTask;
  }

  // ─────────────────────────────────────────────
  // Queue Statistics
  // ─────────────────────────────────────────────

  /**
   * Get aggregate task queue statistics for the HITL dashboard.
   */
  async getTaskQueueStats(businessId: string): Promise<TaskStatsResponseDto> {
    const [counts, breached, avgResolutionMs] = await Promise.all([
      this.repository.countTasksByStatus(businessId),
      this.repository.countSlaBreach(businessId),
      this.repository.getAvgResolutionTime(businessId),
    ]);

    const stats = new TaskStatsResponseDto();
    stats.pending = counts[TaskStatus.PENDING] ?? 0;
    stats.inProgress = counts[TaskStatus.IN_PROGRESS] ?? 0;
    stats.resolved = counts[TaskStatus.RESOLVED] ?? 0;
    stats.escalated = counts[TaskStatus.ESCALATED] ?? 0;
    stats.expired = counts[TaskStatus.EXPIRED] ?? 0;
    stats.breached = breached;
    stats.avgResolutionMs = avgResolutionMs;

    return stats;
  }

  // ─────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────

  /**
   * Listen for AI-generated responses in DRAFT mode.
   * Automatically creates a REVIEW_RESPONSE task for human review.
   */
  @OnEvent('ai.response.generated')
  async handleAIResponseGenerated(event: AIResponseGeneratedEvent): Promise<void> {
    if (event.confidenceScore.mode !== ConfidenceMode.DRAFT) {
      return;
    }

    try {
      const dto: CreateTaskDto = {
        conversationId: event.conversationId,
        type: TaskType.REVIEW_RESPONSE,
        title: 'Review AI Response',
        aiDecisionId: event.aiDecisionId,
        draftResponse: event.suggestedActions as unknown as Record<string, unknown>,
      };

      await this.createTask(event.businessId, dto);

      this.logger.log(
        `Auto-created REVIEW_RESPONSE task for AI decision ${event.aiDecisionId}`,
      );
    } catch (error) {
      if (error instanceof ConflictException) {
        this.logger.debug(
          `Skipped duplicate task creation for conversation ${event.conversationId}: ${error.message}`,
        );
        return;
      }
      this.logger.error(
        `Failed to auto-create task for AI decision ${event.aiDecisionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Listen for AI escalation events.
   * Creates a HANDLE_COMPLAINT or CLARIFY_INTENT task with URGENT priority.
   */
  @OnEvent('ai.escalated')
  async handleAIEscalated(event: AIEscalatedEvent): Promise<void> {
    try {
      const taskType = event.intent === IntentType.COMPLAINT
        ? TaskType.HANDLE_COMPLAINT
        : TaskType.CLARIFY_INTENT;

      const dto: CreateTaskDto = {
        conversationId: event.conversationId,
        type: taskType,
        priority: TaskPriority.URGENT,
        title: `AI Escalation: ${event.intent}`,
        aiDecisionId: event.aiDecisionId,
        draftResponse: event.suggestedActions as unknown as Record<string, unknown>,
      };

      await this.createTask(event.businessId, dto);

      this.logger.log(
        `Auto-created ${taskType} task for escalated AI decision ${event.aiDecisionId}`,
      );
    } catch (error) {
      if (error instanceof ConflictException) {
        this.logger.debug(
          `Skipped duplicate escalation task for conversation ${event.conversationId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      this.logger.error(
        `Failed to auto-create escalation task for AI decision ${event.aiDecisionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
