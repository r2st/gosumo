/**
 * HitlRepository unit tests.
 *
 * Two things carry the risk here and neither is exercised by the service tests:
 *
 *  - `findTasks` and `updateTask` assemble their query object field by field.
 *    A filter that silently fails to land widens the read past the caller's
 *    intent, and `updateTask` distinguishes "not supplied" from "explicitly
 *    cleared to null" — assignee, resolver and due date are all nullable, so
 *    an `if (x)` where an `if (x !== undefined)` belongs would make unassigning
 *    a task impossible.
 *  - Every predicate must carry `business_id`. The queue is the one surface
 *    where a human is about to act on someone else's customer.
 *
 * PrismaService is mocked; the assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { TaskStatus, TaskType, TaskPriority } from '@gosumo/shared';
import { Prisma } from '@prisma/client';

import { HitlRepository } from './hitl.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS = '00000000-0000-4000-a000-0000000000ff';
const TASK_ID = '00000000-0000-4000-b000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-c000-000000000001';
const AGENT_ID = '00000000-0000-4000-d000-000000000001';

describe('HitlRepository', () => {
  let repository: HitlRepository;
  let prisma: {
    tasks: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      tasks: {
        create: jest.fn().mockResolvedValue({ id: TASK_ID }),
        findFirst: jest.fn().mockResolvedValue({ id: TASK_ID }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: TASK_ID }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [HitlRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(HitlRepository);
  });

  function lastWhere(mock: jest.Mock): Record<string, unknown> {
    return mock.mock.calls[mock.mock.calls.length - 1]![0].where;
  }

  // ── createTask ─────────────────────────────

  describe('createTask', () => {
    const base = {
      businessId: BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      type: TaskType.APPROVE_ORDER,
      priority: TaskPriority.HIGH,
      title: 'Approve the draft reply',
    };

    it('opens a task PENDING at escalation level 0 with the optional legs nulled', async () => {
      await repository.createTask(base);

      const { data } = prisma.tasks.create.mock.calls[0]![0];
      expect(data.business_id).toBe(BUSINESS_ID);
      expect(data.status).toBe(TaskStatus.PENDING);
      expect(data.escalation_level).toBe(0);
      expect(data.ai_decision_id).toBeNull();
      expect(data.description).toBeNull();
      expect(data.due_at).toBeNull();
      expect(data.sla_minutes).toBeNull();
      expect(data.escalated_from).toBeNull();
      expect(data.metadata).toEqual({});
    });

    /**
     * An absent AI draft must be Prisma's JsonNull, not `{}` — the column is
     * nullable and a reviewer distinguishes "the AI proposed nothing" from
     * "the AI proposed an empty object".
     */
    it('writes a JSON null rather than an empty object for a missing AI draft', async () => {
      await repository.createTask(base);
      expect(prisma.tasks.create.mock.calls[0]![0].data.ai_draft).toBe(Prisma.JsonNull);
    });

    it('carries every optional field through when supplied', async () => {
      const dueAt = new Date('2026-08-11T09:00:00Z');
      await repository.createTask({
        ...base,
        description: 'Buyer asked for a discount',
        aiDecisionId: 'dec-1',
        aiDraft: { reply: 'We can do 5%' },
        dueAt,
        slaMinutes: 30,
        escalatedFrom: 'task-0',
        escalationLevel: 2,
        metadata: { source: 'auto' },
      });

      const { data } = prisma.tasks.create.mock.calls[0]![0];
      expect(data.description).toBe('Buyer asked for a discount');
      expect(data.ai_decision_id).toBe('dec-1');
      expect(data.ai_draft).toEqual({ reply: 'We can do 5%' });
      expect(data.due_at).toBe(dueAt);
      expect(data.sla_minutes).toBe(30);
      expect(data.escalated_from).toBe('task-0');
      expect(data.escalation_level).toBe(2);
      expect(data.metadata).toEqual({ source: 'auto' });
    });
  });

  // ── findTaskById ───────────────────────────

  it('scopes a task read to the tenant', async () => {
    await repository.findTaskById(BUSINESS_ID, TASK_ID);
    expect(lastWhere(prisma.tasks.findFirst)).toEqual({
      id: TASK_ID,
      business_id: BUSINESS_ID,
    });
  });

  // ── findTasks ──────────────────────────────

  describe('findTasks', () => {
    it('defaults to page 1 of 20 and filters on the tenant alone', async () => {
      prisma.tasks.count.mockResolvedValue(45);

      const res = await repository.findTasks(BUSINESS_ID, {});

      const call = prisma.tasks.findMany.mock.calls[0]![0];
      expect(call.where).toEqual({ business_id: BUSINESS_ID });
      expect(call.skip).toBe(0);
      expect(call.take).toBe(20);
      expect(res).toMatchObject({ total: 45, page: 1, limit: 20, totalPages: 3 });
    });

    it('translates page and limit into skip/take', async () => {
      await repository.findTasks(BUSINESS_ID, { page: 3, limit: 15 });

      const call = prisma.tasks.findMany.mock.calls[0]![0];
      expect(call.skip).toBe(30);
      expect(call.take).toBe(15);
    });

    /** Overdue work has to surface first, and a task with no due date last. */
    it('orders by due date ascending with nulls last, then oldest first', async () => {
      await repository.findTasks(BUSINESS_ID, {});

      expect(prisma.tasks.findMany.mock.calls[0]![0].orderBy).toEqual([
        { due_at: { sort: 'asc', nulls: 'last' } },
        { created_at: 'asc' },
      ]);
    });

    it('adds each optional filter only when supplied', async () => {
      await repository.findTasks(BUSINESS_ID, { status: TaskStatus.PENDING });
      expect(lastWhere(prisma.tasks.findMany)).toEqual({
        business_id: BUSINESS_ID,
        status: TaskStatus.PENDING,
      });

      await repository.findTasks(BUSINESS_ID, { type: TaskType.HANDLE_COMPLAINT });
      expect(lastWhere(prisma.tasks.findMany)).toEqual({
        business_id: BUSINESS_ID,
        type: TaskType.HANDLE_COMPLAINT,
      });

      await repository.findTasks(BUSINESS_ID, { assigneeId: AGENT_ID });
      expect(lastWhere(prisma.tasks.findMany)).toEqual({
        business_id: BUSINESS_ID,
        assigned_to: AGENT_ID,
      });

      await repository.findTasks(BUSINESS_ID, { conversationId: CONVERSATION_ID });
      expect(lastWhere(prisma.tasks.findMany)).toEqual({
        business_id: BUSINESS_ID,
        conversation_id: CONVERSATION_ID,
      });

      await repository.findTasks(BUSINESS_ID, { priority: TaskPriority.URGENT });
      expect(lastWhere(prisma.tasks.findMany)).toEqual({
        business_id: BUSINESS_ID,
        priority: TaskPriority.URGENT,
      });
    });

    it('ANDs every filter together when all are supplied', async () => {
      await repository.findTasks(BUSINESS_ID, {
        status: TaskStatus.IN_PROGRESS,
        type: TaskType.APPROVE_ORDER,
        assigneeId: AGENT_ID,
        conversationId: CONVERSATION_ID,
        priority: TaskPriority.LOW,
      });

      expect(lastWhere(prisma.tasks.findMany)).toEqual({
        business_id: BUSINESS_ID,
        status: TaskStatus.IN_PROGRESS,
        type: TaskType.APPROVE_ORDER,
        assigned_to: AGENT_ID,
        conversation_id: CONVERSATION_ID,
        priority: TaskPriority.LOW,
      });
    });

    /** The count has to see the same predicate, or the page maths lies. */
    it('counts against the identical predicate', async () => {
      await repository.findTasks(BUSINESS_ID, { status: TaskStatus.PENDING });

      expect(lastWhere(prisma.tasks.count)).toEqual(
        lastWhere(prisma.tasks.findMany),
      );
    });

    it('reports a single empty page when nothing matches', async () => {
      prisma.tasks.count.mockResolvedValue(0);
      const res = await repository.findTasks(BUSINESS_ID, {});
      expect(res.totalPages).toBe(0);
      expect(res.data).toEqual([]);
    });
  });

  // ── updateTask ─────────────────────────────

  describe('updateTask', () => {
    it('sends an empty patch when nothing was supplied', async () => {
      await repository.updateTask(BUSINESS_ID, TASK_ID, {});
      expect(prisma.tasks.update.mock.calls[0]![0].data).toEqual({});
    });

    it('maps every supplied field onto its column', async () => {
      const assignedAt = new Date('2026-08-10T10:00:00Z');
      const resolvedAt = new Date('2026-08-10T11:00:00Z');
      const dueAt = new Date('2026-08-10T12:00:00Z');
      const breachedAt = new Date('2026-08-10T13:00:00Z');

      await repository.updateTask(BUSINESS_ID, TASK_ID, {
        status: TaskStatus.RESOLVED,
        priority: TaskPriority.URGENT,
        assignedTo: AGENT_ID,
        assignedAt,
        resolvedBy: AGENT_ID,
        resolvedAt,
        resolutionNote: 'Called the buyer',
        resolution: { outcome: 'approved' },
        dueAt,
        slaBreached: true,
        slaBreachedAt: breachedAt,
        metadata: { channel: 'whatsapp' },
      });

      expect(prisma.tasks.update.mock.calls[0]![0].data).toEqual({
        status: TaskStatus.RESOLVED,
        priority: TaskPriority.URGENT,
        assigned_to: AGENT_ID,
        assigned_at: assignedAt,
        resolved_by: AGENT_ID,
        resolved_at: resolvedAt,
        resolution_note: 'Called the buyer',
        resolution: { outcome: 'approved' },
        due_at: dueAt,
        sla_breached: true,
        sla_breached_at: breachedAt,
        metadata: { channel: 'whatsapp' },
      });
    });

    /**
     * Unassigning a task and clearing its due date are ordinary queue actions.
     * The patch builder tests `!== undefined`, so an explicit null must survive
     * — a truthiness check here would make both operations impossible.
     */
    it('carries explicit nulls through rather than dropping them', async () => {
      await repository.updateTask(BUSINESS_ID, TASK_ID, {
        assignedTo: null,
        assignedAt: null,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
        resolution: null,
        dueAt: null,
        slaBreachedAt: null,
      });

      expect(prisma.tasks.update.mock.calls[0]![0].data).toEqual({
        assigned_to: null,
        assigned_at: null,
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
        resolution: null,
        due_at: null,
        sla_breached_at: null,
      });
    });

    /** `false` is a real value for an SLA flag, not an absent one. */
    it('carries a false sla_breached through', async () => {
      await repository.updateTask(BUSINESS_ID, TASK_ID, { slaBreached: false });
      expect(prisma.tasks.update.mock.calls[0]![0].data).toEqual({ sla_breached: false });
    });

    it('verifies tenant ownership before writing and scopes the write too', async () => {
      await repository.updateTask(BUSINESS_ID, TASK_ID, { status: TaskStatus.RESOLVED });

      expect(lastWhere(prisma.tasks.findFirst)).toEqual({
        id: TASK_ID,
        business_id: BUSINESS_ID,
      });
      expect(prisma.tasks.update.mock.calls[0]![0].where).toEqual({
        id: TASK_ID,
        business_id: BUSINESS_ID,
      });
    });

    it('refuses to write a task belonging to another tenant', async () => {
      prisma.tasks.findFirst.mockResolvedValue(null);

      await expect(
        repository.updateTask(OTHER_BUSINESS, TASK_ID, { status: TaskStatus.RESOLVED }),
      ).rejects.toThrow(/not found/);
      expect(prisma.tasks.update).not.toHaveBeenCalled();
    });
  });

  // ── queue reads ────────────────────────────

  it('treats RESOLVED, ESCALATED and EXPIRED as closed when looking for an open task', async () => {
    await repository.findOpenTaskForConversation(BUSINESS_ID, CONVERSATION_ID);

    expect(lastWhere(prisma.tasks.findFirst)).toEqual({
      business_id: BUSINESS_ID,
      conversation_id: CONVERSATION_ID,
      status: { notIn: ['RESOLVED', 'ESCALATED', 'EXPIRED'] },
    });
  });

  describe('countTasksByStatus', () => {
    it('flattens the grouped counts into a status → count record', async () => {
      prisma.tasks.groupBy.mockResolvedValue([
        { status: 'PENDING', _count: { status: 4 } },
        { status: 'RESOLVED', _count: { status: 9 } },
      ]);

      expect(await repository.countTasksByStatus(BUSINESS_ID)).toEqual({
        PENDING: 4,
        RESOLVED: 9,
      });
      expect(prisma.tasks.groupBy.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
      });
    });

    it('returns an empty record for a business with no tasks', async () => {
      expect(await repository.countTasksByStatus(BUSINESS_ID)).toEqual({});
    });
  });

  /** Already-flagged breaches are excluded so the sweeper does not re-fire. */
  it('finds only unflagged, still-open, past-due tasks', async () => {
    await repository.findOverdueTasks(BUSINESS_ID);

    const where = lastWhere(prisma.tasks.findMany) as {
      due_at: { not: null; lt: Date };
      status: { in: string[] };
      sla_breached: boolean;
      business_id: string;
    };
    expect(where.business_id).toBe(BUSINESS_ID);
    expect(where.status).toEqual({ in: ['PENDING', 'IN_PROGRESS'] });
    expect(where.sla_breached).toBe(false);
    expect(where.due_at.not).toBeNull();
    expect(where.due_at.lt).toBeInstanceOf(Date);
  });

  it('counts breached tasks within the tenant', async () => {
    prisma.tasks.count.mockResolvedValue(7);
    expect(await repository.countSlaBreach(BUSINESS_ID)).toBe(7);
    expect(lastWhere(prisma.tasks.count)).toEqual({
      business_id: BUSINESS_ID,
      sla_breached: true,
    });
  });

  // ── getAvgResolutionTime ───────────────────

  describe('getAvgResolutionTime', () => {
    it('returns 0 when nothing has been resolved yet', async () => {
      expect(await repository.getAvgResolutionTime(BUSINESS_ID)).toBe(0);
    });

    it('averages resolved_at − created_at across resolved tasks', async () => {
      prisma.tasks.findMany.mockResolvedValue([
        {
          created_at: new Date('2026-08-10T10:00:00Z'),
          resolved_at: new Date('2026-08-10T10:10:00Z'), // 10 min
        },
        {
          created_at: new Date('2026-08-10T11:00:00Z'),
          resolved_at: new Date('2026-08-10T11:30:00Z'), // 30 min
        },
      ]);

      expect(await repository.getAvgResolutionTime(BUSINESS_ID)).toBe(20 * 60 * 1000);
      expect(lastWhere(prisma.tasks.findMany)).toEqual({
        business_id: BUSINESS_ID,
        status: TaskStatus.RESOLVED,
        resolved_at: { not: null },
      });
    });

    it('rounds a fractional average to whole milliseconds', async () => {
      prisma.tasks.findMany.mockResolvedValue([
        { created_at: new Date(0), resolved_at: new Date(1) },
        { created_at: new Date(0), resolved_at: new Date(2) },
        { created_at: new Date(0), resolved_at: new Date(2) },
      ]);

      expect(await repository.getAvgResolutionTime(BUSINESS_ID)).toBe(2);
    });
  });
});
