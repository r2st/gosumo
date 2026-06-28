import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { ConversationStatus, ChannelType } from '@gosumo/shared';
import { Prisma } from '@prisma/client';
import type { conversations } from '@prisma/client';

// ─────────────────────────────────────────────
// Filter & pagination types
// ─────────────────────────────────────────────

export interface ConversationListFilters {
  status?: ConversationStatus;
  channel?: ChannelType;
  assigneeId?: string;
  /** Filter to conversations with no assignee. */
  unassigned?: boolean;
  clientId?: string;
  /** Match any of these tags (OR semantics). */
  tags?: string[];
  /** Free-text search across subject and current_topic. */
  search?: string;
  /** Created-at lower bound (inclusive), ISO-8601. */
  dateFrom?: string;
  /** Created-at upper bound (inclusive), ISO-8601. */
  dateTo?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedConversations {
  data: conversations[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CreateConversationData {
  businessId: string;
  clientId: string;
  channelAccountId: string;
  channel: ChannelType;
}

/**
 * Partial update payload. Only provided keys are written.
 * `null` clears a nullable column; `undefined` leaves it untouched.
 */
export interface UpdateConversationData {
  status?: ConversationStatus;
  assignedTo?: string | null;
  resolvedAt?: Date | null;
  snoozedUntil?: Date | null;
  subject?: string | null;
  currentTopic?: string | null;
  tags?: string[];
  csatScore?: number | null;
  csatSubmittedAt?: Date | null;
  /** Replaces the metadata JSONB document wholesale. */
  metadata?: Record<string, unknown>;
}

export interface ResolutionStats {
  resolvedCount: number;
  /** Average first-message → resolved_at duration in seconds. */
  avgResolutionSeconds: number;
}

const CONVERSATION_INCLUDE = {
  client: true,
  channel_account: true,
} as const;

/**
 * List include: client + channel account plus the single most recent message,
 * used to render the last-message preview in the dashboard inbox.
 */
const CONVERSATION_LIST_INCLUDE = {
  client: true,
  channel_account: true,
  messages: {
    orderBy: { created_at: 'desc' },
    take: 1,
  },
} as const;

/**
 * ConversationRepository — all Prisma queries for the Conversation module.
 *
 * Every query includes businessId scoping. Soft-deleted records
 * are excluded by default (deleted_at: null).
 */
@Injectable()
export class ConversationRepository {
  private readonly logger = new Logger(ConversationRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find a conversation by ID within a business scope.
   * Includes client and channel_account relations.
   */
  async findById(
    businessId: string,
    conversationId: string,
  ): Promise<conversations | null> {
    return this.prisma.conversations.findFirst({
      where: {
        id: conversationId,
        business_id: businessId,
        deleted_at: null,
      },
      include: CONVERSATION_INCLUDE,
    });
  }

  /**
   * Find an active (non-RESOLVED, non-deleted) conversation for a given
   * client and channel account within a business.
   */
  async findActiveByClientAndChannel(
    businessId: string,
    clientId: string,
    channelAccountId: string,
  ): Promise<conversations | null> {
    return this.prisma.conversations.findFirst({
      where: {
        business_id: businessId,
        client_id: clientId,
        channel_account_id: channelAccountId,
        status: { not: ConversationStatus.RESOLVED },
        deleted_at: null,
      },
      include: CONVERSATION_INCLUDE,
    });
  }

  /**
   * Create a new conversation with OPEN status.
   */
  async create(data: CreateConversationData): Promise<conversations> {
    return this.prisma.conversations.create({
      data: {
        business_id: data.businessId,
        client_id: data.clientId,
        channel_account_id: data.channelAccountId,
        channel: data.channel,
        status: ConversationStatus.OPEN,
        first_message_at: new Date(),
        last_message_at: new Date(),
        message_count: 0,
        unread_count: 0,
        human_message_count: 0,
        tags: [],
        metadata: {},
      },
      include: CONVERSATION_INCLUDE,
    });
  }

  /**
   * Update conversation status. Sets resolved_at when transitioning to
   * RESOLVED and clears it when leaving RESOLVED (reopen).
   */
  async updateStatus(
    businessId: string,
    conversationId: string,
    status: ConversationStatus,
  ): Promise<conversations> {
    const updateData: Prisma.conversationsUpdateInput = { status };

    if (status === ConversationStatus.RESOLVED) {
      updateData.resolved_at = new Date();
    } else if (status === ConversationStatus.OPEN) {
      // Reopening clears the prior resolution timestamp.
      updateData.resolved_at = null;
    }

    return this.prisma.conversations.update({
      where: { id: conversationId },
      data: updateData,
      include: CONVERSATION_INCLUDE,
    });
  }

  /**
   * Generic partial update. Used by lifecycle, tagging, snooze, and SLA flows.
   * Verifies business ownership before writing.
   */
  async update(
    businessId: string,
    conversationId: string,
    data: UpdateConversationData,
  ): Promise<conversations> {
    const existing = await this.prisma.conversations.findFirst({
      where: { id: conversationId, business_id: businessId, deleted_at: null },
      select: { id: true },
    });
    if (!existing) {
      throw new Error(
        `Conversation ${conversationId} not found for business ${businessId}`,
      );
    }

    const updateData: Prisma.conversationsUpdateInput = {};

    if (data.status !== undefined) updateData.status = data.status;
    if (data.assignedTo !== undefined) updateData.assigned_to = data.assignedTo;
    if (data.resolvedAt !== undefined) updateData.resolved_at = data.resolvedAt;
    if (data.snoozedUntil !== undefined)
      updateData.snoozed_until = data.snoozedUntil;
    if (data.subject !== undefined) updateData.subject = data.subject;
    if (data.currentTopic !== undefined)
      updateData.current_topic = data.currentTopic;
    if (data.tags !== undefined) updateData.tags = data.tags;
    if (data.csatScore !== undefined) updateData.csat_score = data.csatScore;
    if (data.csatSubmittedAt !== undefined)
      updateData.csat_submitted_at = data.csatSubmittedAt;
    if (data.metadata !== undefined)
      updateData.metadata = data.metadata as Prisma.InputJsonValue;

    return this.prisma.conversations.update({
      where: { id: conversationId },
      data: updateData,
      include: CONVERSATION_INCLUDE,
    });
  }

  /**
   * List conversations for a business with optional filters, paginated.
   * Ordered by last_message_at DESC.
   */
  async list(
    businessId: string,
    filters: ConversationListFilters,
  ): Promise<PaginatedConversations> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = this.buildWhere(businessId, filters);

    const [data, total] = await Promise.all([
      this.prisma.conversations.findMany({
        where,
        include: CONVERSATION_LIST_INCLUDE,
        orderBy: { last_message_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.conversations.count({ where }),
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
   * Translate list filters into a Prisma where clause. Always scopes by
   * business_id and excludes soft-deleted rows.
   */
  private buildWhere(
    businessId: string,
    filters: ConversationListFilters,
  ): Prisma.conversationsWhereInput {
    const where: Prisma.conversationsWhereInput = {
      business_id: businessId,
      deleted_at: null,
    };

    if (filters.status) where.status = filters.status;
    if (filters.channel) where.channel = filters.channel;
    if (filters.clientId) where.client_id = filters.clientId;

    if (filters.unassigned) {
      where.assigned_to = null;
    } else if (filters.assigneeId) {
      where.assigned_to = filters.assigneeId;
    }

    if (filters.tags && filters.tags.length > 0) {
      where.tags = { hasSome: filters.tags };
    }

    if (filters.search) {
      where.OR = [
        { subject: { contains: filters.search, mode: 'insensitive' } },
        { current_topic: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    if (filters.dateFrom || filters.dateTo) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (filters.dateFrom) createdAt.gte = new Date(filters.dateFrom);
      if (filters.dateTo) createdAt.lte = new Date(filters.dateTo);
      where.created_at = createdAt;
    }

    return where;
  }

  /**
   * Update last_message_at timestamp and increment message_count.
   */
  async updateLastMessageAt(
    conversationId: string,
    timestamp: Date,
  ): Promise<conversations> {
    return this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        last_message_at: timestamp,
        message_count: { increment: 1 },
      },
    });
  }

  /**
   * Increment the human_message_count counter (used for SLA / handoff metrics).
   */
  async incrementHumanMessageCount(
    conversationId: string,
  ): Promise<conversations> {
    return this.prisma.conversations.update({
      where: { id: conversationId },
      data: { human_message_count: { increment: 1 } },
    });
  }

  /**
   * Assign (or, with null, unassign) a conversation to a team member.
   */
  async assign(
    businessId: string,
    conversationId: string,
    assigneeId: string | null,
  ): Promise<conversations> {
    return this.prisma.conversations.update({
      where: { id: conversationId },
      data: { assigned_to: assigneeId },
      include: CONVERSATION_INCLUDE,
    });
  }

  /**
   * Count active (non-RESOLVED, non-deleted) conversations per assignee
   * among the given candidate agents. Returns a map of agentId → count.
   * Agents with zero active conversations are included with count 0.
   */
  async countActiveByAssignees(
    businessId: string,
    agentIds: string[],
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const id of agentIds) counts[id] = 0;

    if (agentIds.length === 0) return counts;

    const groups = await this.prisma.conversations.groupBy({
      by: ['assigned_to'],
      where: {
        business_id: businessId,
        assigned_to: { in: agentIds },
        status: { not: ConversationStatus.RESOLVED },
        deleted_at: null,
      },
      _count: { assigned_to: true },
    });

    for (const group of groups) {
      if (group.assigned_to) {
        counts[group.assigned_to] = group._count.assigned_to;
      }
    }
    return counts;
  }

  /**
   * Count conversations grouped by status for a business.
   */
  async countByStatus(businessId: string): Promise<Record<string, number>> {
    const groups = await this.prisma.conversations.groupBy({
      by: ['status'],
      where: { business_id: businessId, deleted_at: null },
      _count: { status: true },
    });

    const result: Record<string, number> = {};
    for (const group of groups) {
      result[group.status] = group._count.status;
    }
    return result;
  }

  /**
   * Compute resolution statistics: count of resolved conversations and the
   * average duration from first_message_at to resolved_at (in seconds).
   */
  async getResolutionStats(businessId: string): Promise<ResolutionStats> {
    const resolved = await this.prisma.conversations.findMany({
      where: {
        business_id: businessId,
        status: ConversationStatus.RESOLVED,
        resolved_at: { not: null },
        first_message_at: { not: null },
        deleted_at: null,
      },
      select: { first_message_at: true, resolved_at: true },
    });

    if (resolved.length === 0) {
      return { resolvedCount: 0, avgResolutionSeconds: 0 };
    }

    let totalMs = 0;
    for (const row of resolved) {
      const start = row.first_message_at as Date;
      const end = row.resolved_at as Date;
      totalMs += end.getTime() - start.getTime();
    }

    return {
      resolvedCount: resolved.length,
      avgResolutionSeconds: Math.round(totalMs / resolved.length / 1000),
    };
  }

  /**
   * Find SNOOZED conversations whose snoozed_until has elapsed.
   * Used by the snooze-wake job to re-open them.
   */
  async findSnoozedDue(businessId: string, now: Date): Promise<conversations[]> {
    return this.prisma.conversations.findMany({
      where: {
        business_id: businessId,
        status: ConversationStatus.SNOOZED,
        snoozed_until: { not: null, lte: now },
        deleted_at: null,
      },
      include: CONVERSATION_INCLUDE,
    });
  }
}
