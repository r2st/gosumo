import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { ConversationStatus, ChannelType, ResourceNotFoundError } from '@gosumo/shared';
import { Prisma } from '@prisma/client';
import type { conversations } from '@prisma/client';
import { escapeLikeTerm } from '../../common/utils/search-pattern.util';
import { MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST } from '../../common/utils/message-order';
import { SNOOZE_WAKE_BATCH_SIZE } from './conversation.constants';

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
    // `take: 1` is the tightest LIMIT there is, so an untied sort decides the
    // inbox preview by coin flip when the last two messages are simultaneous —
    // and can show a different one on the next poll. A nested include is
    // per-conversation by construction, so this sorts on `sequence`. See
    // MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST.
    orderBy: MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST,
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
   * Find the conversation a new inbound message from this client on this
   * channel account belongs to — the most recently active non-deleted thread,
   * whatever its status.
   *
   * RESOLVED is deliberately *not* filtered out: there is one thread per
   * (business, client, channel account), and a resolved one is reopened when
   * the client writes again rather than being shadowed by a duplicate. Ordering
   * by last_message_at picks the newest thread when duplicates already exist.
   */
  async findLatestByClientAndChannel(
    businessId: string,
    clientId: string,
    channelAccountId: string,
  ): Promise<conversations | null> {
    return this.prisma.conversations.findFirst({
      where: {
        business_id: businessId,
        client_id: clientId,
        channel_account_id: channelAccountId,
        deleted_at: null,
      },
      orderBy: [{ last_message_at: 'desc' }, { created_at: 'desc' }],
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
   * Move a conversation from one status to another, and only from that one.
   *
   * ## The race
   *
   * Every lifecycle method used to read the conversation, check the transition
   * against `VALID_TRANSITIONS` in the service, and then write the new status
   * unconditionally. The check and the write are separate statements over a row
   * nothing is holding, so two callers arriving together both read `OPEN`, both
   * find their transition legal, and both write — and the second silently
   * overwrites the first. The state machine is enforced against a snapshot that
   * is already stale by the time it is consulted.
   *
   * It is not a theoretical window either. The pairs that collide are the ones
   * the product produces constantly: an agent clicking Resolve while
   * `ai.escalated` lands, `task.created` labelling a conversation PENDING_HUMAN
   * while the customer's reply reopens it, two agents on the same inbox. The
   * losing outcome is a conversation sitting in ESCALATED with no open task, or
   * RESOLVED while a person is still working it — states the machine exists to
   * make unreachable, reached anyway.
   *
   * ## The fix
   *
   * `expectedStatus` goes into the WHERE clause, so the guard and the write are
   * one statement and Postgres decides the winner. `updateMany` is used rather
   * than `update` because it compiles to exactly that conditional UPDATE;
   * `update` with extra filters is Prisma's `extendedWhereUnique`, which does
   * not guarantee it stays one statement, and a read-then-write underneath this
   * API would reintroduce the race while looking correct.
   *
   * Returns `null` when the row was not in `expectedStatus` — the caller lost,
   * and the transition it validated no longer applies. That is a conflict to
   * report, not a state to force.
   */
  async transitionStatus(
    businessId: string,
    conversationId: string,
    expectedStatus: ConversationStatus,
    status: ConversationStatus,
    extra: Omit<UpdateConversationData, 'status'> = {},
  ): Promise<conversations | null> {
    const data: Prisma.conversationsUpdateManyMutationInput = { status };

    if (status === ConversationStatus.RESOLVED) {
      data.resolved_at = extra.resolvedAt ?? new Date();
    } else if (status === ConversationStatus.OPEN) {
      // Reopening clears the prior resolution timestamp.
      data.resolved_at = null;
    } else if (extra.resolvedAt !== undefined) {
      data.resolved_at = extra.resolvedAt;
    }

    if (extra.assignedTo !== undefined) data.assigned_to = extra.assignedTo;
    if (extra.snoozedUntil !== undefined) data.snoozed_until = extra.snoozedUntil;
    if (extra.csatScore !== undefined) data.csat_score = extra.csatScore;
    if (extra.csatSubmittedAt !== undefined) {
      data.csat_submitted_at = extra.csatSubmittedAt;
    }

    const { count } = await this.prisma.conversations.updateMany({
      where: {
        id: conversationId,
        business_id: businessId,
        deleted_at: null,
        status: expectedStatus,
      },
      data,
    });

    // Lost the race, or the row is gone. Either way this caller did not make
    // the change and must not be told it did.
    if (count === 0) return null;

    // Read back separately because `updateMany` cannot return rows. This read
    // may already reflect a *later* transition by someone else, which is fine
    // and is the honest answer: `count` is what says the write landed, and the
    // row is what the conversation looks like now.
    return this.prisma.conversations.findFirst({
      where: { id: conversationId, business_id: businessId },
      include: CONVERSATION_INCLUDE,
    });
  }

  /**
   * Update conversation status. Sets resolved_at when transitioning to
   * RESOLVED and clears it when leaving RESOLVED (reopen).
   *
   * Unconditional: it writes whatever the caller asks for regardless of where
   * the row currently is. Prefer {@link transitionStatus} for anything driven
   * by the state machine — this remains only for the callers that genuinely
   * have no expected prior state.
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
      where: { id: conversationId, business_id: businessId },
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
      throw new ResourceNotFoundError('Conversation', conversationId, {
        context: { businessId },
      });
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
      where: { id: conversationId, business_id: businessId },
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
      // Escaped so `%`/`_` are searched for, not executed as LIKE wildcards.
      const search = escapeLikeTerm(filters.search);
      where.OR = [
        { subject: { contains: search, mode: 'insensitive' } },
        { current_topic: { contains: search, mode: 'insensitive' } },
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
   * Record an inbound message: bump last_message_at and the message and unread
   * counters. Called once per `message.received`, so it only ever sees customer
   * traffic — an agent's own reply must not make a thread look unread.
   *
   * All three writes go in one statement, and the counters use `increment`
   * rather than a read-then-write, so two messages landing on the same
   * conversation at once cannot lose an increment between them.
   */
  async updateLastMessageAt(
    businessId: string,
    conversationId: string,
    timestamp: Date,
  ): Promise<conversations> {
    return this.prisma.conversations.update({
      where: { id: conversationId, business_id: businessId },
      data: {
        last_message_at: timestamp,
        message_count: { increment: 1 },
        unread_count: { increment: 1 },
      },
    });
  }

  /**
   * Clear the unread counter for a conversation an operator has just opened,
   * and report how many messages that cleared.
   *
   * Subtracts exactly the number of unread messages that were observed rather
   * than assigning zero. The difference matters: a message that arrives between
   * the read and the write survives as unread instead of being silently marked
   * seen by an operator who never saw it.
   *
   * The `gte` guard is what makes a concurrent double-read safe — the second
   * writer finds the counter already below what it meant to subtract, matches
   * no rows, and leaves the counter alone instead of driving it negative.
   */
  async markRead(businessId: string, conversationId: string): Promise<number> {
    const existing = await this.prisma.conversations.findFirst({
      where: { id: conversationId, business_id: businessId, deleted_at: null },
      select: { unread_count: true },
    });
    if (!existing) {
      throw new ResourceNotFoundError('Conversation', conversationId, {
        context: { businessId },
      });
    }

    const seen = existing.unread_count;
    if (seen <= 0) return 0;

    const { count } = await this.prisma.conversations.updateMany({
      where: {
        id: conversationId,
        business_id: businessId,
        unread_count: { gte: seen },
      },
      data: { unread_count: { decrement: seen } },
    });

    // No rows matched: another reader got there first and already cleared what
    // this call had observed. Nothing was cleared here, so report nothing.
    return count === 0 ? 0 : seen;
  }

  /**
   * Increment the human_message_count counter (used for SLA / handoff metrics).
   */
  async incrementHumanMessageCount(
    businessId: string,
    conversationId: string,
  ): Promise<conversations> {
    return this.prisma.conversations.update({
      where: { id: conversationId, business_id: businessId },
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
      where: { id: conversationId, business_id: businessId },
      data: { assigned_to: assigneeId },
      include: CONVERSATION_INCLUDE,
    });
  }

  /**
   * Assign only if the conversation is still held by `expectedAssigneeId`.
   * Returns the updated row, or `null` when someone else moved it first.
   *
   * Assignment is read-then-write — the caller reads the current assignee to
   * report it on `conversation.assigned`, then writes the new one. Two
   * supervisors acting on the same conversation would both read the same
   * "before" and both write, and the second write would win silently: the
   * loser's agent still receives an event naming them as the new owner, opens
   * the conversation, and works it alongside whoever actually holds it. The
   * guard turns that into a conflict the caller can be told about.
   *
   * `updateMany` rather than `update` because only `updateMany` takes a
   * non-unique field in its WHERE — the compare-and-set *is* the WHERE clause,
   * so it and the write are one statement and nothing can interleave.
   */
  async assignIfHeldBy(
    businessId: string,
    conversationId: string,
    assigneeId: string | null,
    expectedAssigneeId: string | null,
  ): Promise<conversations | null> {
    const { count } = await this.prisma.conversations.updateMany({
      where: {
        id: conversationId,
        business_id: businessId,
        assigned_to: expectedAssigneeId,
        deleted_at: null,
      },
      data: { assigned_to: assigneeId },
    });
    if (count === 0) return null;

    return this.prisma.conversations.findFirst({
      where: { id: conversationId, business_id: businessId },
      include: CONVERSATION_INCLUDE,
    });
  }

  /**
   * Return every live conversation held by `assigneeId` to the unassigned
   * queue. Returns the ids released.
   *
   * RESOLVED conversations keep their assignee deliberately: there the field is
   * a record of who handled it, and clearing it would rewrite history and skew
   * per-agent resolution stats. Only work that is still open needs an owner.
   *
   * The ids are read first because `updateMany` reports a count and not rows,
   * and the caller logs which conversations moved — after the write the rows no
   * longer match. A conversation assigned to this member in the gap between the
   * two statements is simply missed; it is released by the next sweep rather
   * than by a transaction taken out for a bookkeeping read.
   */
  async releaseAssignments(
    businessId: string,
    assigneeId: string,
  ): Promise<string[]> {
    const where = {
      business_id: businessId,
      assigned_to: assigneeId,
      status: { not: ConversationStatus.RESOLVED },
      deleted_at: null,
    };

    const held = await this.prisma.conversations.findMany({
      where,
      select: { id: true },
    });
    if (held.length === 0) return [];

    await this.prisma.conversations.updateMany({
      where,
      data: { assigned_to: null },
    });

    return held.map((c) => c.id);
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
    // The count and the average are computed in the database. Reading every
    // resolved conversation back just to average two timestamps meant this
    // dashboard tile grew a full table scan's worth of memory for the tenant's
    // entire history — the older the tenant, the slower its dashboard.
    const [row] = await this.prisma.$queryRaw<
      { resolved_count: number; avg_resolution_seconds: number | null }[]
    >`
      SELECT COUNT(*)::int AS resolved_count,
             AVG(EXTRACT(EPOCH FROM (resolved_at - first_message_at))) AS avg_resolution_seconds
      FROM conversations
      WHERE business_id = ${businessId}::uuid
        AND status = ${ConversationStatus.RESOLVED}::"ConversationStatus"
        AND resolved_at IS NOT NULL
        AND first_message_at IS NOT NULL
        AND deleted_at IS NULL
    `;

    if (!row || row.resolved_count === 0) {
      return { resolvedCount: 0, avgResolutionSeconds: 0 };
    }

    return {
      resolvedCount: row.resolved_count,
      avgResolutionSeconds: Math.round(Number(row.avg_resolution_seconds ?? 0)),
    };
  }

  /**
   * Find SNOOZED conversations whose snoozed_until has elapsed.
   * Used by the snooze-wake job to re-open them.
   *
   * Bounded: each row is hydrated with the full conversation include, so an
   * unbounded read here would let a backlog (a worker outage, a clock jump)
   * pull an arbitrary number of joined rows into the job in one go. The wake
   * job is periodic, so a capped batch drains across ticks instead.
   */
  async findSnoozedDue(
    businessId: string,
    now: Date,
    limit: number = SNOOZE_WAKE_BATCH_SIZE,
  ): Promise<conversations[]> {
    return this.prisma.conversations.findMany({
      where: {
        business_id: businessId,
        status: ConversationStatus.SNOOZED,
        snoozed_until: { not: null, lte: now },
        deleted_at: null,
      },
      include: CONVERSATION_INCLUDE,
      orderBy: { snoozed_until: 'asc' },
      take: limit,
    });
  }
}
