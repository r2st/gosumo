import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { tasks, TaskType, TaskPriority, TaskStatus } from '@gosumo/database';
import { IntentType, SuggestedAction, TaskCreatedEvent, generateId, generateCorrelationId } from '@gosumo/shared';
import { PrismaService } from '../../../common/services/prisma.service';
import { RouteAction } from '../pipeline/action-router.service';
import { Urgency } from '../pipeline/response-parser.service';

export interface CreateReviewTaskInput {
  businessId: string;
  conversationId: string;
  aiDecisionId?: string | null;
  action: RouteAction;
  intent: IntentType;
  urgency: Urgency;
  draftResponse: string | null;
  suggestedActions: SuggestedAction[];
  confidence: number;
  reasoning: string;
  escalationReason?: string | null;
  correlationId?: string;
}

/**
 * ReviewQueueService — the AI engine's bridge into the Human-in-the-Loop
 * queue. When confidence lands below the auto-execute band, the pipeline
 * hands the decision here: it creates a `tasks` row carrying the AI draft,
 * sets an SLA deadline, and emits `task.created` so the dashboard lights up in
 * real time.
 *
 * Task resolution (approve / edit / reject) is owned by the `hitl` module;
 * this service only creates the work item.
 */
@Injectable()
export class ReviewQueueService {
  private readonly logger = new Logger(ReviewQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createReviewTask(input: CreateReviewTaskInput): Promise<tasks> {
    const type = this.taskType(input.action, input.intent);
    const priority = this.priority(input.urgency);
    const slaMinutes = this.slaMinutes(input.action, input.urgency);
    const dueAt = new Date(Date.now() + slaMinutes * 60_000);

    const aiDraft: Prisma.InputJsonValue = {
      message: input.draftResponse,
      actions: input.suggestedActions as unknown as Prisma.InputJsonValue,
      confidence: input.confidence,
      reasoning: input.reasoning,
    };

    const task = await this.prisma.tasks.create({
      data: {
        business_id: input.businessId,
        conversation_id: input.conversationId,
        ai_decision_id: input.aiDecisionId ?? null,
        type,
        status: TaskStatus.PENDING,
        priority,
        title: this.title(input.action, input.intent),
        description: input.escalationReason ?? input.reasoning ?? null,
        ai_draft: aiDraft,
        due_at: dueAt,
        sla_minutes: slaMinutes,
      },
    });

    const event: TaskCreatedEvent = {
      type: 'task.created',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId: input.businessId,
      correlationId: input.correlationId ?? generateCorrelationId(),
      taskId: task.id,
      conversationId: input.conversationId,
      aiDecisionId: input.aiDecisionId ?? undefined,
      taskType: type,
      priority,
      dueAt: dueAt.toISOString(),
    };
    this.eventEmitter.emit('task.created', event);

    this.logger.log(
      `Created ${type} task ${task.id} (priority=${priority}, SLA=${slaMinutes}m) for conversation ${input.conversationId}`,
    );

    return task;
  }

  // ─────────────────────────────────────────────
  // Mapping helpers
  // ─────────────────────────────────────────────

  private taskType(action: RouteAction, intent: IntentType): TaskType {
    if (action === 'DRAFT_REVIEW') return TaskType.REVIEW_RESPONSE;
    if (action === 'GUIDED') return TaskType.CLARIFY_INTENT;
    // ESCALATE — pick the most specific task type for the intent.
    switch (intent) {
      case IntentType.COMPLAINT:
        return TaskType.HANDLE_COMPLAINT;
      case IntentType.REFUND:
        return TaskType.APPROVE_REFUND;
      case IntentType.ORDER:
        return TaskType.APPROVE_ORDER;
      default:
        return TaskType.CUSTOM;
    }
  }

  private priority(urgency: Urgency): TaskPriority {
    switch (urgency) {
      case 'CRITICAL':
        return TaskPriority.URGENT;
      case 'HIGH':
        return TaskPriority.HIGH;
      case 'MEDIUM':
        return TaskPriority.MEDIUM;
      case 'LOW':
      default:
        return TaskPriority.LOW;
    }
  }

  private slaMinutes(action: RouteAction, urgency: Urgency): number {
    if (action === 'DRAFT_REVIEW') return 15;
    // Escalations / guided — scale by urgency.
    switch (urgency) {
      case 'CRITICAL':
        return 5;
      case 'HIGH':
        return 15;
      default:
        return 30;
    }
  }

  private title(action: RouteAction, intent: IntentType): string {
    switch (action) {
      case 'DRAFT_REVIEW':
        return `Review AI draft (${intent})`;
      case 'GUIDED':
        return `Monitor clarifying question (${intent})`;
      case 'ESCALATE':
        return `Escalation: ${intent}`;
      default:
        return `AI task (${intent})`;
    }
  }
}
