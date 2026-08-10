import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { TaskStatus, TaskType, TaskPriority, ResourceNotFoundError } from '@gosumo/shared';
import type { tasks } from '@prisma/client';
import { Prisma } from '@prisma/client';

// ─────────────────────────────────────────────
// Data interfaces
// ─────────────────────────────────────────────

export interface CreateTaskData {
  businessId: string;
  conversationId: string;
  type: TaskType;
  priority: TaskPriority;
  title: string;
  description?: string;
  aiDecisionId?: string;
  aiDraft?: Record<string, unknown>;
  dueAt?: Date;
  slaMinutes?: number;
  escalatedFrom?: string;
  escalationLevel?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskData {
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedTo?: string | null;
  assignedAt?: Date | null;
  resolvedBy?: string | null;
  resolvedAt?: Date | null;
  resolutionNote?: string | null;
  resolution?: Record<string, unknown> | null;
  dueAt?: Date | null;
  slaBreached?: boolean;
  slaBreachedAt?: Date | null;
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────
// Filter & pagination types
// ─────────────────────────────────────────────

export interface TaskListFilters {
  status?: TaskStatus;
  type?: TaskType;
  assigneeId?: string;
  conversationId?: string;
  priority?: TaskPriority;
  page?: number;
  limit?: number;
}

export interface PaginatedTasks {
  data: tasks[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * HitlRepository — all Prisma queries for the HITL (Human-in-the-Loop) module.
 *
 * Every query includes businessId scoping.
 */
@Injectable()
export class HitlRepository {
  private readonly logger = new Logger(HitlRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Default includes for task queries. */
  private readonly taskIncludes = {
    conversation: true,
    assignee: true,
    resolver: true,
    parent_task: true,
    child_tasks: true,
  } as const;

  /**
   * Create a new HITL task.
   */
  async createTask(data: CreateTaskData): Promise<tasks> {
    return this.prisma.tasks.create({
      data: {
        business_id: data.businessId,
        conversation_id: data.conversationId,
        ai_decision_id: data.aiDecisionId ?? null,
        type: data.type,
        status: TaskStatus.PENDING,
        priority: data.priority,
        title: data.title,
        description: data.description ?? null,
        ai_draft: (data.aiDraft ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        due_at: data.dueAt ?? null,
        sla_minutes: data.slaMinutes ?? null,
        escalated_from: data.escalatedFrom ?? null,
        escalation_level: data.escalationLevel ?? 0,
        metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
      },
      include: this.taskIncludes,
    });
  }

  /**
   * Find a task by ID within a business scope.
   * Includes conversation, assignee, resolver, parent_task, and child_tasks.
   */
  async findTaskById(
    businessId: string,
    taskId: string,
  ): Promise<tasks | null> {
    return this.prisma.tasks.findFirst({
      where: {
        id: taskId,
        business_id: businessId,
      },
      include: this.taskIncludes,
    });
  }

  /**
   * List tasks for a business with optional filters, paginated.
   * Ordered by due_at ASC (nulls last), then created_at ASC.
   * Priority sorting is handled at the service layer.
   */
  async findTasks(
    businessId: string,
    filters: TaskListFilters,
  ): Promise<PaginatedTasks> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      business_id: businessId,
    };

    if (filters.status) {
      where['status'] = filters.status;
    }
    if (filters.type) {
      where['type'] = filters.type;
    }
    if (filters.assigneeId) {
      where['assigned_to'] = filters.assigneeId;
    }
    if (filters.conversationId) {
      where['conversation_id'] = filters.conversationId;
    }
    if (filters.priority) {
      where['priority'] = filters.priority;
    }

    const [data, total] = await Promise.all([
      this.prisma.tasks.findMany({
        where,
        include: this.taskIncludes,
        orderBy: [
          { due_at: { sort: 'asc', nulls: 'last' } },
          { created_at: 'asc' },
        ],
        skip,
        take: limit,
      }),
      this.prisma.tasks.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Partial update of a task. Both id and business_id are checked.
   * Returns the updated task with includes.
   */
  async updateTask(
    businessId: string,
    taskId: string,
    data: Partial<UpdateTaskData>,
  ): Promise<tasks> {
    const updateData: Record<string, unknown> = {};

    if (data.status !== undefined) {
      updateData['status'] = data.status;
    }
    if (data.priority !== undefined) {
      updateData['priority'] = data.priority;
    }
    if (data.assignedTo !== undefined) {
      updateData['assigned_to'] = data.assignedTo;
    }
    if (data.assignedAt !== undefined) {
      updateData['assigned_at'] = data.assignedAt;
    }
    if (data.resolvedBy !== undefined) {
      updateData['resolved_by'] = data.resolvedBy;
    }
    if (data.resolvedAt !== undefined) {
      updateData['resolved_at'] = data.resolvedAt;
    }
    if (data.resolutionNote !== undefined) {
      updateData['resolution_note'] = data.resolutionNote;
    }
    if (data.resolution !== undefined) {
      updateData['resolution'] = data.resolution;
    }
    if (data.dueAt !== undefined) {
      updateData['due_at'] = data.dueAt;
    }
    if (data.slaBreached !== undefined) {
      updateData['sla_breached'] = data.slaBreached;
    }
    if (data.slaBreachedAt !== undefined) {
      updateData['sla_breached_at'] = data.slaBreachedAt;
    }
    if (data.metadata !== undefined) {
      updateData['metadata'] = data.metadata;
    }

    // Use findFirst to verify business_id scoping, then update by id
    const existing = await this.prisma.tasks.findFirst({
      where: {
        id: taskId,
        business_id: businessId,
      },
    });

    if (!existing) {
      throw new ResourceNotFoundError('Task', taskId, {
        context: { businessId },
      });
    }

    return this.prisma.tasks.update({
      where: { id: taskId, business_id: businessId },
      data: updateData,
      include: this.taskIncludes,
    });
  }

  /**
   * Find an open (non-terminal) task for a given conversation within a business.
   * Excludes tasks with status RESOLVED, ESCALATED, or EXPIRED.
   */
  async findOpenTaskForConversation(
    businessId: string,
    conversationId: string,
  ): Promise<tasks | null> {
    return this.prisma.tasks.findFirst({
      where: {
        business_id: businessId,
        conversation_id: conversationId,
        status: { notIn: ['RESOLVED', 'ESCALATED', 'EXPIRED'] },
      },
      include: this.taskIncludes,
    });
  }

  /**
   * Count tasks grouped by status for a business.
   * Returns a record mapping status string to count.
   */
  async countTasksByStatus(businessId: string): Promise<Record<string, number>> {
    const groups = await this.prisma.tasks.groupBy({
      by: ['status'],
      where: { business_id: businessId },
      _count: { status: true },
    });

    const result: Record<string, number> = {};
    for (const group of groups) {
      result[group.status] = group._count.status;
    }
    return result;
  }

  /**
   * Find tasks that are overdue: due_at has passed, status is still
   * PENDING or IN_PROGRESS, and sla_breached has not yet been flagged.
   */
  async findOverdueTasks(businessId: string): Promise<tasks[]> {
    return this.prisma.tasks.findMany({
      where: {
        business_id: businessId,
        due_at: { not: null, lt: new Date() },
        status: { in: ['PENDING', 'IN_PROGRESS'] },
        sla_breached: false,
      },
      include: this.taskIncludes,
    });
  }

  /**
   * Count tasks where the SLA has been breached for a business.
   */
  async countSlaBreach(businessId: string): Promise<number> {
    return this.prisma.tasks.count({
      where: {
        business_id: businessId,
        sla_breached: true,
      },
    });
  }

  /**
   * Compute the average resolution time (in milliseconds) for resolved tasks.
   * Calculates the difference between resolved_at and created_at for each
   * resolved task and returns the average.
   * Returns 0 if no resolved tasks exist.
   */
  async getAvgResolutionTime(businessId: string): Promise<number> {
    const resolvedTasks = await this.prisma.tasks.findMany({
      where: {
        business_id: businessId,
        status: TaskStatus.RESOLVED,
        resolved_at: { not: null },
      },
      select: {
        created_at: true,
        resolved_at: true,
      },
    });

    if (resolvedTasks.length === 0) {
      return 0;
    }

    let totalMs = 0;
    for (const task of resolvedTasks) {
      const resolvedAt = task.resolved_at as Date;
      totalMs += resolvedAt.getTime() - task.created_at.getTime();
    }

    return Math.round(totalMs / resolvedTasks.length);
  }
}
