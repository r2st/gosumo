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

  // ─── Intent → task-type mapping on the escalation path ───

  it.each([
    [IntentType.COMPLAINT, TaskType.HANDLE_COMPLAINT],
    [IntentType.ORDER, TaskType.APPROVE_ORDER],
    [IntentType.CHIT_CHAT, TaskType.CUSTOM],
  ])('maps an escalated %s to %s', async (intent, expected) => {
    // Escalations pick the most specific queue for the intent so the right
    // operator picks the task up; anything unmapped lands in CUSTOM rather
    // than being dropped.
    const { service } = makeService();
    const task = (await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      action: 'ESCALATE',
      intent,
      urgency: 'HIGH',
      draftResponse: null,
      suggestedActions: [],
      confidence: 0.3,
      reasoning: 'needs a human',
    })) as unknown as CreatedTask;

    expect(task.type).toBe(expected);
  });

  // ─── Urgency → priority and SLA ───

  it.each([
    ['HIGH' as const, TaskPriority.HIGH, 15],
    ['MEDIUM' as const, TaskPriority.MEDIUM, 30],
    ['LOW' as const, TaskPriority.LOW, 30],
  ])('escalating at %s urgency gives %s priority and a %d-minute SLA', async (
    urgency,
    priority,
    sla,
  ) => {
    const { service } = makeService();
    const task = (await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      action: 'ESCALATE',
      intent: IntentType.COMPLAINT,
      urgency,
      draftResponse: null,
      suggestedActions: [],
      confidence: 0.3,
      reasoning: 'needs a human',
    })) as unknown as CreatedTask;

    expect(task.priority).toBe(priority);
    expect(task.sla_minutes).toBe(sla);
  });

  it('holds a draft review to 15 minutes even when the urgency is low', async () => {
    // A draft is already written and waiting to go out; the SLA is about how
    // long the customer waits for a reply, not how severe the issue is.
    const { service } = makeService();
    const task = (await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      action: 'DRAFT_REVIEW',
      intent: IntentType.CHIT_CHAT,
      urgency: 'LOW',
      draftResponse: 'Hello!',
      suggestedActions: [],
      confidence: 0.75,
      reasoning: 'small talk',
    })) as unknown as CreatedTask;

    expect(task.sla_minutes).toBe(15);
    expect(task.priority).toBe(TaskPriority.LOW);
  });

  // ─── Description, due date, and event payload ───

  it('prefers the escalation reason over the AI reasoning as the description', async () => {
    const { service, create } = makeService();

    await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      action: 'ESCALATE',
      intent: IntentType.COMPLAINT,
      urgency: 'HIGH',
      draftResponse: null,
      suggestedActions: [],
      confidence: 0.3,
      reasoning: 'model reasoning',
      escalationReason: 'customer asked for a manager',
    });

    expect(create.mock.calls[0]![0].data.description).toBe('customer asked for a manager');
  });

  it('falls back to the AI reasoning when there is no escalation reason', async () => {
    const { service, create } = makeService();

    await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      action: 'ESCALATE',
      intent: IntentType.COMPLAINT,
      urgency: 'HIGH',
      draftResponse: null,
      suggestedActions: [],
      confidence: 0.3,
      reasoning: 'model reasoning',
    });

    expect(create.mock.calls[0]![0].data.description).toBe('model reasoning');
  });

  it('sets due_at one SLA window into the future', async () => {
    const { service, create } = makeService();
    const before = Date.now();

    await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      action: 'ESCALATE',
      intent: IntentType.REFUND,
      urgency: 'CRITICAL',
      draftResponse: null,
      suggestedActions: [],
      confidence: 0.2,
      reasoning: 'over limit',
    });

    const dueAt = create.mock.calls[0]![0].data.due_at as Date;
    expect(dueAt.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(dueAt.getTime()).toBeLessThan(before + 6 * 60_000);
  });

  it('carries the caller correlation id onto the event', async () => {
    // The correlation id threads one inbound message through the pipeline and
    // into the dashboard; minting a fresh one here would break the trace.
    const { service, emit } = makeService();

    await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      action: 'DRAFT_REVIEW',
      intent: IntentType.BOOKING,
      urgency: 'MEDIUM',
      draftResponse: 'ok',
      suggestedActions: [],
      confidence: 0.8,
      reasoning: 'fine',
      correlationId: 'corr-abc',
    });

    expect(emit).toHaveBeenCalledWith(
      'task.created',
      expect.objectContaining({ correlationId: 'corr-abc' }),
    );
  });

  it('generates a correlation id when the caller supplies none', async () => {
    const { service, emit } = makeService();

    await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      action: 'DRAFT_REVIEW',
      intent: IntentType.BOOKING,
      urgency: 'MEDIUM',
      draftResponse: 'ok',
      suggestedActions: [],
      confidence: 0.8,
      reasoning: 'fine',
    });

    const event = emit.mock.calls[0]![1] as { correlationId: string };
    expect(event.correlationId).toEqual(expect.any(String));
    expect(event.correlationId.length).toBeGreaterThan(0);
  });

  it('links the AI decision when one is given, and nulls it when not', async () => {
    const { service, create, emit } = makeService();

    await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      aiDecisionId: 'dec-1',
      action: 'DRAFT_REVIEW',
      intent: IntentType.BOOKING,
      urgency: 'MEDIUM',
      draftResponse: 'ok',
      suggestedActions: [],
      confidence: 0.8,
      reasoning: 'fine',
    });

    expect(create.mock.calls[0]![0].data.ai_decision_id).toBe('dec-1');
    expect(emit.mock.calls[0]![1]).toMatchObject({ aiDecisionId: 'dec-1' });

    await service.createReviewTask({
      businessId: 'b1',
      conversationId: 'c1',
      aiDecisionId: null,
      action: 'DRAFT_REVIEW',
      intent: IntentType.BOOKING,
      urgency: 'MEDIUM',
      draftResponse: 'ok',
      suggestedActions: [],
      confidence: 0.8,
      reasoning: 'fine',
    });

    expect(create.mock.calls[1]![0].data.ai_decision_id).toBeNull();
    expect(emit.mock.calls[1]![1]).toMatchObject({ aiDecisionId: undefined });
  });

  it('titles the task after the action and intent', async () => {
    const { service, create } = makeService();

    for (const [action, expected] of [
      ['DRAFT_REVIEW', 'Review AI draft (COMPLAINT)'],
      ['GUIDED', 'Monitor clarifying question (COMPLAINT)'],
      ['ESCALATE', 'Escalation: COMPLAINT'],
    ] as const) {
      await service.createReviewTask({
        businessId: 'b1',
        conversationId: 'c1',
        action,
        intent: IntentType.COMPLAINT,
        urgency: 'MEDIUM',
        draftResponse: null,
        suggestedActions: [],
        confidence: 0.5,
        reasoning: 'r',
      });

      expect(create.mock.calls.at(-1)![0].data.title).toBe(expected);
    }
  });
});
