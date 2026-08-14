import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { sla_policies, sla_breaches } from '@prisma/client';
import { ChannelType } from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';

export type SlaBreachTypeValue = 'FIRST_RESPONSE' | 'RESOLUTION';

export interface SlaConditions {
  channels?: ChannelType[];
  tags?: string[];
}

export type SlaEscalationActionType = 'NOTIFY' | 'REASSIGN' | 'CREATE_TASK';

export interface SlaEscalationAction {
  type: SlaEscalationActionType;
  target?: string;
}

export interface CreatePolicyData {
  name: string;
  description?: string;
  priority?: number;
  isActive?: boolean;
  conditions: SlaConditions;
  firstResponseTargetMinutes: number;
  resolutionTargetMinutes: number;
  escalationActions: SlaEscalationAction[];
}

export interface UpdatePolicyData {
  name?: string;
  description?: string | null;
  priority?: number;
  isActive?: boolean;
  conditions?: SlaConditions;
  firstResponseTargetMinutes?: number;
  resolutionTargetMinutes?: number;
  escalationActions?: SlaEscalationAction[];
}

export interface BreachListFilters {
  breached?: boolean;
  escalated?: boolean;
  page?: number;
  limit?: number;
}

export interface PaginatedBreaches {
  data: sla_breaches[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class SlaRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────────────────────────────────────────────
  // Policies
  // ───────────────────────────────────────────────────────────────────

  async createPolicy(businessId: string, data: CreatePolicyData): Promise<sla_policies> {
    return this.prisma.sla_policies.create({
      data: {
        business_id: businessId,
        name: data.name,
        description: data.description,
        priority: data.priority ?? 0,
        is_active: data.isActive ?? true,
        conditions: data.conditions as unknown as Prisma.InputJsonValue,
        first_response_target_minutes: data.firstResponseTargetMinutes,
        resolution_target_minutes: data.resolutionTargetMinutes,
        escalation_actions: data.escalationActions as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async findActivePolicies(businessId: string): Promise<sla_policies[]> {
    return this.prisma.sla_policies.findMany({
      where: { business_id: businessId, deleted_at: null, is_active: true },
      orderBy: { priority: 'desc' },
    });
  }

  async findAllPolicies(businessId: string): Promise<sla_policies[]> {
    return this.prisma.sla_policies.findMany({
      where: { business_id: businessId, deleted_at: null },
      orderBy: { priority: 'desc' },
    });
  }

  async findPolicyById(businessId: string, id: string): Promise<sla_policies | null> {
    return this.prisma.sla_policies.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async updatePolicy(businessId: string, id: string, data: UpdatePolicyData): Promise<sla_policies> {
    return this.prisma.sla_policies.update({
      where: { id, business_id: businessId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
        ...(data.isActive !== undefined ? { is_active: data.isActive } : {}),
        ...(data.conditions !== undefined
          ? { conditions: data.conditions as unknown as Prisma.InputJsonValue }
          : {}),
        ...(data.firstResponseTargetMinutes !== undefined
          ? { first_response_target_minutes: data.firstResponseTargetMinutes }
          : {}),
        ...(data.resolutionTargetMinutes !== undefined
          ? { resolution_target_minutes: data.resolutionTargetMinutes }
          : {}),
        ...(data.escalationActions !== undefined
          ? { escalation_actions: data.escalationActions as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  async softDeletePolicy(businessId: string, id: string): Promise<void> {
    await this.prisma.sla_policies.update({
      where: { id, business_id: businessId },
      data: { deleted_at: new Date() },
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Breach trackers
  // ───────────────────────────────────────────────────────────────────

  /** Read-only lookup on the conversation this SLA tracks — channel/tags for policy matching. */
  async getConversationSummary(
    businessId: string,
    conversationId: string,
  ): Promise<{ channel: ChannelType; tags: string[]; createdAt: Date } | null> {
    const conversation = await this.prisma.conversations.findFirst({
      where: { id: conversationId, business_id: businessId },
      select: { channel: true, tags: true, created_at: true },
    });
    if (!conversation) return null;
    return {
      channel: conversation.channel as ChannelType,
      tags: conversation.tags,
      createdAt: conversation.created_at,
    };
  }

  async createBreachTrackers(
    businessId: string,
    conversationId: string,
    policyId: string,
    createdAt: Date,
    firstResponseTargetMinutes: number,
    resolutionTargetMinutes: number,
  ): Promise<void> {
    const trackers: Prisma.sla_breachesCreateManyInput[] = [
      {
        business_id: businessId,
        conversation_id: conversationId,
        policy_id: policyId,
        breach_type: 'FIRST_RESPONSE',
        target_minutes: firstResponseTargetMinutes,
        due_at: new Date(createdAt.getTime() + firstResponseTargetMinutes * 60_000),
      },
      {
        business_id: businessId,
        conversation_id: conversationId,
        policy_id: policyId,
        breach_type: 'RESOLUTION',
        target_minutes: resolutionTargetMinutes,
        due_at: new Date(createdAt.getTime() + resolutionTargetMinutes * 60_000),
      },
    ];

    await this.prisma.sla_breaches.createMany({ data: trackers, skipDuplicates: true });
  }

  async findBreachTracker(
    businessId: string,
    conversationId: string,
    breachType: SlaBreachTypeValue,
  ): Promise<sla_breaches | null> {
    return this.prisma.sla_breaches.findFirst({
      where: { business_id: businessId, conversation_id: conversationId, breach_type: breachType },
    });
  }

  async findBreachesForConversation(businessId: string, conversationId: string): Promise<sla_breaches[]> {
    return this.prisma.sla_breaches.findMany({
      where: { business_id: businessId, conversation_id: conversationId },
    });
  }

  /** Mark a tracker as met (target reached, on-time or late) at `metAt`. */
  async markMet(
    businessId: string,
    id: string,
    metAt: Date,
    breached: boolean,
  ): Promise<sla_breaches> {
    return this.prisma.sla_breaches.update({
      where: { id, business_id: businessId },
      data: {
        met_at: metAt,
        breached,
        breached_at: breached ? metAt : null,
      },
    });
  }

  /** Record that a single breach escalated — the event-driven path. */
  async markEscalated(
    businessId: string,
    id: string,
    escalatedAt: Date,
  ): Promise<sla_breaches> {
    return this.prisma.sla_breaches.update({
      where: { id, business_id: businessId },
      data: { escalated: true, escalated_at: escalatedAt },
    });
  }

  /**
   * Mark a whole sweep batch breached in one statement.
   *
   * The sweep selected these ids with `breached: false` and writes the same
   * `breachedAt` to every row, so this is equivalent to the per-row update it
   * replaces — minus up to {@link findOverdueUnmetTrackers}'s limit round
   * trips. `business_id` stays in the WHERE clause: a batch write is still a
   * tenant-scoped write.
   */
  async markBreachedBatch(
    businessId: string,
    ids: string[],
    breachedAt: Date,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.prisma.sla_breaches.updateMany({
      where: { id: { in: ids }, business_id: businessId },
      data: { breached: true, breached_at: breachedAt },
    });
    return count;
  }

  /** Batch counterpart to {@link markEscalated}, for the same reason. */
  async markEscalatedBatch(
    businessId: string,
    ids: string[],
    escalatedAt: Date,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.prisma.sla_breaches.updateMany({
      where: { id: { in: ids }, business_id: businessId },
      data: { escalated: true, escalated_at: escalatedAt },
    });
    return count;
  }

  /** Trackers whose deadline has passed with no activity yet — a sweep target. */
  async findOverdueUnmetTrackers(businessId: string, now: Date, limit: number): Promise<sla_breaches[]> {
    return this.prisma.sla_breaches.findMany({
      where: {
        business_id: businessId,
        met_at: null,
        breached: false,
        due_at: { lt: now },
      },
      take: limit,
    });
  }

  async listBreaches(businessId: string, filters: BreachListFilters): Promise<PaginatedBreaches> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const where: Prisma.sla_breachesWhereInput = { business_id: businessId };
    if (filters.breached !== undefined) where.breached = filters.breached;
    if (filters.escalated !== undefined) where.escalated = filters.escalated;

    const [data, total] = await Promise.all([
      this.prisma.sla_breaches.findMany({
        where,
        orderBy: { due_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.sla_breaches.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  /** Compliance summary in a date range: total trackers due, and how many breached. */
  async getComplianceStats(
    businessId: string,
    from: Date,
    to: Date,
  ): Promise<{ total: number; breached: number; met: number }> {
    const where: Prisma.sla_breachesWhereInput = {
      business_id: businessId,
      due_at: { gte: from, lt: to },
    };

    const [total, breached, met] = await Promise.all([
      this.prisma.sla_breaches.count({ where }),
      this.prisma.sla_breaches.count({ where: { ...where, breached: true } }),
      this.prisma.sla_breaches.count({ where: { ...where, met_at: { not: null } } }),
    ]);

    return { total, breached, met };
  }

  /**
   * Per-assignee breach counts in a date range — used by the agent-performance
   * module (injected via SlaService, never a direct table read).
   */
  async getBreachCountsByAssignee(
    businessId: string,
    from: Date,
    to: Date,
  ): Promise<{ assigneeId: string; breachedCount: number; totalCount: number }[]> {
    const rows = await this.prisma.$queryRaw<
      { assignee_id: string; breached_count: number; total_count: number }[]
    >`
      SELECT c.assigned_to AS assignee_id,
             COUNT(*) FILTER (WHERE b.breached)::int AS breached_count,
             COUNT(*)::int AS total_count
      FROM sla_breaches b
      JOIN conversations c ON c.id = b.conversation_id
      WHERE b.business_id = ${businessId}::uuid
        AND c.assigned_to IS NOT NULL
        AND b.due_at >= ${from} AND b.due_at < ${to}
      GROUP BY c.assigned_to
    `;
    return rows.map((r) => ({
      assigneeId: r.assignee_id,
      breachedCount: r.breached_count,
      totalCount: r.total_count,
    }));
  }
}
