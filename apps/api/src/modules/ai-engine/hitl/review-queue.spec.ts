import { EventEmitter2 } from '@nestjs/event-emitter';
import { TaskType, TaskPriority, TaskStatus } from '@gosumo/database';
import { IntentType } from '@gosumo/shared';
import { ReviewQueueService } from './review-queue.service';
import { PrismaService } from '../../../common/services/prisma.service';

interface CreatedTask {
  id: string;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  sla_minutes: number;
  ai_draft: unknown;
}

function makeService(): {
  service: ReviewQueueService;
  create: jest.Mock;
  emit: jest.Mock;
} {
  const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
    id: 'task-1',
    ...data,
  }));
  const prisma = { tasks: { create } } as unknown as PrismaService;
  const emit = jest.fn();
  const emitter = { emit } as unknown as EventEmitter2;
  return { service: new ReviewQueueService(prisma, emitter), create, emit };
}

describe('ReviewQueueService', () => {
  it('creates a REVIEW_RESPONSE task with a 15-minute SLA for a draft', async () => {
    const { service, create, emit } = makeService();
    const task = (await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      action: 'DRAFT_REVIEW',
      intent: IntentType.BOOKING,
      urgency: 'MEDIUM',
      draftResponse: 'Your slot is confirmed',
      suggestedActions: [],
      confidence: 0.8,
      reasoning: 'looks good',
    })) as unknown as CreatedTask;

    expect(create).toHaveBeenCalledTimes(1);
    expect(task.type).toBe(TaskType.REVIEW_RESPONSE);
    expect(task.priority).toBe(TaskPriority.MEDIUM);
    expect(task.status).toBe(TaskStatus.PENDING);
    expect(task.sla_minutes).toBe(15);
    expect(emit).toHaveBeenCalledWith('task.created', expect.objectContaining({ type: 'task.created' }));
  });

  it('maps a REFUND escalation to APPROVE_REFUND with URGENT priority and 5-minute SLA', async () => {
    const { service } = makeService();
    const task = (await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      action: 'ESCALATE',
      intent: IntentType.REFUND,
      urgency: 'CRITICAL',
      draftResponse: null,
      suggestedActions: [],
      confidence: 0.2,
      reasoning: 'refund over limit',
    })) as unknown as CreatedTask;

    expect(task.type).toBe(TaskType.APPROVE_REFUND);
    expect(task.priority).toBe(TaskPriority.URGENT);
    expect(task.sla_minutes).toBe(5);
  });

  it('maps a GUIDED action to a CLARIFY_INTENT task', async () => {
    const { service } = makeService();
    const task = (await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      action: 'GUIDED',
      intent: IntentType.PRICING,
      urgency: 'LOW',
      draftResponse: 'Which item did you mean?',
      suggestedActions: [],
      confidence: 0.6,
      reasoning: 'ambiguous',
    })) as unknown as CreatedTask;

    expect(task.type).toBe(TaskType.CLARIFY_INTENT);
  });

  it('stores the AI draft (message, actions, confidence) on the task', async () => {
    const { service } = makeService();
    const task = (await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      action: 'DRAFT_REVIEW',
      intent: IntentType.ORDER,
      urgency: 'LOW',
      draftResponse: 'Order confirmed',
      suggestedActions: [{ type: 'CREATE_ORDER', parameters: {}, confidence: 0.9 }],
      confidence: 0.82,
      reasoning: 'all good',
    })) as unknown as CreatedTask;

    expect(task.ai_draft).toMatchObject({ message: 'Order confirmed', confidence: 0.82 });
  });
});
