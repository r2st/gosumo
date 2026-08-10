import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import type { conversations } from '@prisma/client';
import {
  ConversationStatus,
  ChannelType,
  generateId,
  generateCorrelationId,
  MessageReceivedEvent,
  MessageStoredEvent,
  ConversationCreatedEvent,
  ConversationStatusChangedEvent,
  ConversationAssignedEvent,
  ConversationResolvedEvent,
  ConversationEscalatedEvent,
  TaskResolvedEvent,
  AIResponseApprovedEvent,
} from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';
import {
  ConversationRepository,
  ConversationListFilters,
  PaginatedConversations,
} from './conversation.repository';
import { ListConversationsQueryDto } from './dto';
import {
  CONTEXT_WINDOW_SIZE,
  MAX_SNOOZE_MS,
  MAX_SNOOZE_DAYS,
  AutoAssignStrategy,
  OPEN_TASK_STATUSES,
  INTERNAL_NOTE_KEY,
  RESOLVED_BY,
  ESCALATION_REASON,
  SLA_FIRST_RESPONSE_TARGET_SECONDS,
  SLA_RESOLUTION_TARGET_SECONDS,
  CONVERSATION_QUEUE,
  CONVERSATION_JOBS,
  type EscalationReason,
  type SnoozeWakeJobData,
} from './conversation.constants';

// ─────────────────────────────────────────────
// State machine: valid status transitions
// ─────────────────────────────────────────────

const VALID_TRANSITIONS: Record<ConversationStatus, ConversationStatus[]> = {
  [ConversationStatus.OPEN]: [
    ConversationStatus.PENDING_HUMAN,
    ConversationStatus.ESCALATED,
    ConversationStatus.RESOLVED,
    ConversationStatus.SNOOZED,
  ],
  [ConversationStatus.PENDING_HUMAN]: [
    ConversationStatus.OPEN,
    ConversationStatus.ESCALATED,
    ConversationStatus.RESOLVED,
    ConversationStatus.SNOOZED,
  ],
  [ConversationStatus.ESCALATED]: [
    ConversationStatus.OPEN,
    ConversationStatus.PENDING_HUMAN,
    ConversationStatus.RESOLVED,
  ],
  [ConversationStatus.RESOLVED]: [ConversationStatus.OPEN],
  [ConversationStatus.SNOOZED]: [
    ConversationStatus.OPEN,
    ConversationStatus.ESCALATED,
  ],
};

// ─────────────────────────────────────────────
// Response / option types
// ─────────────────────────────────────────────

export interface ConversationContext {
  conversation: conversations;
  messages: unknown[];
  client: unknown;
}

export interface ResolveOptions {
  /** Who resolved the conversation: AI | HUMAN | SYSTEM. */
  resolvedBy?: string;
  /** Acting team member / system actor id. */
  actorId?: string;
  /** Optional CSAT score (1–5) captured at resolution. */
  csatScore?: number;
}

export interface EscalateOptions {
  reason?: EscalationReason | string;
  /** HITL task that owns the escalation, if one was created. */
  taskId?: string;
  /** Team member the escalation is routed to. */
  assignedToMemberId?: string;
  actorId?: string;
}

export interface AutoAssignOptions {
  strategy: AutoAssignStrategy;
  /** Candidate team-member ids for ROUND_ROBIN / LEAST_BUSY strategies. */
  candidateAgentIds?: string[];
}

export interface SlaMetrics {
  conversationId: string;
  /** Time from first inbound message to first outbound reply (ms). */
  firstResponseTimeMs: number | null;
  firstResponseBreached: boolean;
  /** Time from first message to resolution (ms). */
  resolutionTimeMs: number | null;
  resolutionBreached: boolean;
}

export interface ConversationStats {
  byStatus: Record<string, number>;
  total: number;
  resolvedCount: number;
  avgResolutionSeconds: number;
}

/**
 * ConversationService — core business logic for the Conversation module.
 *
 * Owns the conversation lifecycle (open → assign → resolve/escalate/snooze →
 * reopen), auto-assignment, tagging, SLA tracking, and the AI↔human handoff.
 * Every mutation validates the state-machine transition and emits the
 * corresponding domain event.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly repository: ConversationRepository,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    @InjectQueue(CONVERSATION_QUEUE) private readonly queue: Queue<SnoozeWakeJobData>,
  ) {}

  // ─────────────────────────────────────────────
  // Lifecycle: create / read / list
  // ─────────────────────────────────────────────

  /**
   * Find an active conversation for the given client + channel account,
   * or create a new one if none exists.
   *
   * Emits `conversation.created` when a new conversation is created.
   */
  async findOrCreate(
    businessId: string,
    dto: { clientId: string; channelAccountId: string; channel: ChannelType },
  ): Promise<conversations> {
    const existing = await this.repository.findActiveByClientAndChannel(
      businessId,
      dto.clientId,
      dto.channelAccountId,
    );

    if (existing) {
      this.logger.debug(
        `Found active conversation ${existing.id} for client ${dto.clientId} on ${dto.channel}`,
      );
      return existing;
    }

    const conversation = await this.repository.create({
      businessId,
      clientId: dto.clientId,
      channelAccountId: dto.channelAccountId,
      channel: dto.channel,
    });

    const event: ConversationCreatedEvent = {
      type: 'conversation.created',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId: conversation.id,
      clientId: dto.clientId,
      channelAccountId: dto.channelAccountId,
      channel: dto.channel,
    };

    this.eventEmitter.emit('conversation.created', event);

    this.logger.log(
      `Created conversation ${conversation.id} for client ${dto.clientId} on ${dto.channel}`,
    );

    return conversation;
  }

  /**
   * Get a single conversation by ID with relations.
   * Throws NotFoundException if not found.
   */
  async getConversation(
    businessId: string,
    id: string,
  ): Promise<conversations> {
    const conversation = await this.repository.findById(businessId, id);
    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${id}`);
    }
    return conversation;
  }

  /**
   * List conversations with optional filters, paginated.
   */
  async listConversations(
    businessId: string,
    query: ListConversationsQueryDto,
    currentUserId?: string,
  ): Promise<PaginatedConversations> {
    const filters: ConversationListFilters = {
      status: query.status,
      channel: query.channelType,
      unassigned: query.unassigned,
      clientId: query.clientId,
      tags: query.tags,
      search: query.q,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      page: query.page,
      limit: query.limit,
    };

    // `assignedTo` accepts a team-member UUID plus the magic values
    // "me" (the current user) and "unassigned".
    if (query.assignedTo === 'unassigned') {
      filters.unassigned = true;
    } else if (query.assignedTo === 'me') {
      filters.assigneeId = currentUserId;
    } else if (query.assignedTo) {
      filters.assigneeId = query.assignedTo;
    }

    return this.repository.list(businessId, filters);
  }

  // ─────────────────────────────────────────────
  // Lifecycle: status transitions
  // ─────────────────────────────────────────────

  /**
   * Update the status of a conversation. Validates the state transition.
   * Emits `conversation.status.changed` on success.
   */
  async updateStatus(
    businessId: string,
    id: string,
    newStatus: ConversationStatus,
    actorId?: string,
  ): Promise<conversations> {
    const conversation = await this.requireConversation(businessId, id);
    const currentStatus = conversation.status as ConversationStatus;
    this.assertTransition(currentStatus, newStatus);

    const updated = await this.repository.updateStatus(
      businessId,
      id,
      newStatus,
    );

    this.emitStatusChanged(
      businessId,
      id,
      conversation.client_id,
      currentStatus,
      newStatus,
      actorId,
    );

    this.logger.log(
      `Conversation ${id} status changed: ${currentStatus} → ${newStatus}`,
    );

    return updated;
  }

  /**
   * Resolve a conversation. Refuses if an open HITL task still references it.
   * Emits `conversation.status.changed` and `conversation.resolved`.
   */
  async resolveConversation(
    businessId: string,
    id: string,
    options: ResolveOptions = {},
  ): Promise<conversations> {
    const conversation = await this.requireConversation(businessId, id);
    const currentStatus = conversation.status as ConversationStatus;
    this.assertTransition(currentStatus, ConversationStatus.RESOLVED);

    const openTasks = await this.countOpenTasks(businessId, id);
    if (openTasks > 0) {
      throw new ConflictException(
        `Cannot resolve conversation ${id}: ${openTasks} open task(s) exist`,
      );
    }

    const resolvedAt = new Date();
    const updated = await this.repository.update(businessId, id, {
      status: ConversationStatus.RESOLVED,
      resolvedAt,
      csatScore: options.csatScore,
      csatSubmittedAt: options.csatScore != null ? resolvedAt : undefined,
    });

    this.emitStatusChanged(
      businessId,
      id,
      conversation.client_id,
      currentStatus,
      ConversationStatus.RESOLVED,
      options.actorId,
    );

    const resolutionDurationSeconds = conversation.first_message_at
      ? Math.round(
          (resolvedAt.getTime() - conversation.first_message_at.getTime()) /
            1000,
        )
      : 0;

    const resolvedEvent: ConversationResolvedEvent = {
      type: 'conversation.resolved',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId: id,
      clientId: conversation.client_id,
      resolvedBy: options.resolvedBy ?? RESOLVED_BY.HUMAN,
      resolvedByActorId: options.actorId,
      resolutionDurationSeconds,
      csatScore: options.csatScore,
    };
    this.eventEmitter.emit('conversation.resolved', resolvedEvent);

    this.logger.log(
      `Conversation ${id} resolved by ${resolvedEvent.resolvedBy} in ${resolutionDurationSeconds}s`,
    );

    return updated;
  }

  /**
   * Close a conversation — semantically equivalent to resolving it by a human
   * agent. Provided as a distinct verb for the dashboard "Close" action.
   */
  async closeConversation(
    businessId: string,
    id: string,
    actorId?: string,
  ): Promise<conversations> {
    return this.resolveConversation(businessId, id, {
      resolvedBy: RESOLVED_BY.HUMAN,
      actorId,
    });
  }

  /**
   * Reopen a RESOLVED or SNOOZED conversation back to OPEN.
   */
  async reopenConversation(
    businessId: string,
    id: string,
    actorId?: string,
  ): Promise<conversations> {
    return this.updateStatus(businessId, id, ConversationStatus.OPEN, actorId);
  }

  /**
   * Snooze a conversation until a future time (max 7 days out).
   * Emits `conversation.status.changed`.
   */
  async snoozeConversation(
    businessId: string,
    id: string,
    snoozeUntil: Date,
    actorId?: string,
  ): Promise<conversations> {
    const conversation = await this.requireConversation(businessId, id);
    const currentStatus = conversation.status as ConversationStatus;
    this.assertTransition(currentStatus, ConversationStatus.SNOOZED);

    const delta = snoozeUntil.getTime() - Date.now();
    if (delta <= 0) {
      throw new BadRequestException('snoozeUntil must be in the future');
    }
    if (delta > MAX_SNOOZE_MS) {
      throw new BadRequestException(
        `Snooze duration exceeds the ${MAX_SNOOZE_DAYS}-day maximum`,
      );
    }

    const updated = await this.repository.update(businessId, id, {
      status: ConversationStatus.SNOOZED,
      snoozedUntil: snoozeUntil,
    });

    this.emitStatusChanged(
      businessId,
      id,
      conversation.client_id,
      currentStatus,
      ConversationStatus.SNOOZED,
      actorId,
    );

    // Schedule the wake-up: a delayed job is the only thing that reopens a
    // SNOOZED conversation when the customer never replies before the
    // window elapses. jobId is deterministic per (conversation, deadline)
    // so re-snoozing to the same time is a no-op rather than a duplicate.
    await this.queue.add(
      CONVERSATION_JOBS.SNOOZE_WAKE,
      { businessId, conversationId: id },
      {
        delay: delta,
        jobId: `${CONVERSATION_JOBS.SNOOZE_WAKE}:${id}:${snoozeUntil.getTime()}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    this.logger.log(
      `Conversation ${id} snoozed until ${snoozeUntil.toISOString()}`,
    );

    return updated;
  }

  /**
   * Escalate a conversation to a human agent (AI→human handoff).
   * Optionally assigns it and records the originating HITL task.
   * Emits `conversation.status.changed` and `conversation.escalated`.
   */
  async escalateConversation(
    businessId: string,
    id: string,
    options: EscalateOptions = {},
  ): Promise<conversations> {
    const conversation = await this.requireConversation(businessId, id);
    const currentStatus = conversation.status as ConversationStatus;
    this.assertTransition(currentStatus, ConversationStatus.ESCALATED);

    const updated = await this.repository.update(businessId, id, {
      status: ConversationStatus.ESCALATED,
      assignedTo: options.assignedToMemberId ?? undefined,
    });

    this.emitStatusChanged(
      businessId,
      id,
      conversation.client_id,
      currentStatus,
      ConversationStatus.ESCALATED,
      options.actorId,
    );

    const escalatedEvent: ConversationEscalatedEvent = {
      type: 'conversation.escalated',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId: id,
      clientId: conversation.client_id,
      taskId: options.taskId ?? '',
      assignedToMemberId: options.assignedToMemberId,
      reason: options.reason ?? ESCALATION_REASON.MANUAL,
    };
    this.eventEmitter.emit('conversation.escalated', escalatedEvent);

    this.logger.log(
      `Conversation ${id} escalated (${escalatedEvent.reason})`,
    );

    return updated;
  }

  // ─────────────────────────────────────────────
  // Assignment
  // ─────────────────────────────────────────────

  /**
   * Assign a conversation to a team member.
   * Emits `conversation.assigned`.
   */
  async assignConversation(
    businessId: string,
    id: string,
    assigneeId: string,
  ): Promise<conversations> {
    const conversation = await this.requireConversation(businessId, id);
    const previousAssigneeId = conversation.assigned_to ?? undefined;

    const updated = await this.repository.assign(businessId, id, assigneeId);

    this.emitAssigned(
      businessId,
      id,
      conversation.client_id,
      assigneeId,
      previousAssigneeId,
    );

    this.logger.log(`Conversation ${id} assigned to ${assigneeId}`);

    return updated;
  }

  /**
   * Auto-assign a conversation using the requested strategy.
   *
   * - AI: leave it with the AI — unassign, status stays OPEN.
   * - ROUND_ROBIN: pick the least-recently-loaded candidate deterministically.
   * - LEAST_BUSY: pick the candidate with the fewest active conversations.
   *
   * Emits `conversation.assigned` when a human agent is chosen.
   */
  async autoAssign(
    businessId: string,
    id: string,
    options: AutoAssignOptions,
  ): Promise<conversations> {
    const conversation = await this.requireConversation(businessId, id);

    if (options.strategy === AutoAssignStrategy.AI) {
      const updated = await this.repository.assign(businessId, id, null);
      this.logger.log(`Conversation ${id} kept with AI (unassigned)`);
      return updated;
    }

    const candidates = options.candidateAgentIds ?? [];
    if (candidates.length === 0) {
      throw new BadRequestException(
        `Strategy ${options.strategy} requires at least one candidate agent`,
      );
    }

    const counts = await this.repository.countActiveByAssignees(
      businessId,
      candidates,
    );

    let chosen: string;
    if (options.strategy === AutoAssignStrategy.LEAST_BUSY) {
      chosen = candidates.reduce((best, agent) =>
        (counts[agent] ?? 0) < (counts[best] ?? 0) ? agent : best,
      );
    } else {
      // ROUND_ROBIN: spread load by total active count, breaking ties by the
      // candidate order so the choice is deterministic and testable.
      const totalActive = Object.values(counts).reduce((a, b) => a + b, 0);
      chosen = candidates[totalActive % candidates.length] as string;
    }

    const previousAssigneeId = conversation.assigned_to ?? undefined;
    const updated = await this.repository.assign(businessId, id, chosen);
    this.emitAssigned(
      businessId,
      id,
      conversation.client_id,
      chosen,
      previousAssigneeId,
    );

    this.logger.log(
      `Conversation ${id} auto-assigned to ${chosen} via ${options.strategy}`,
    );

    return updated;
  }

  // ─────────────────────────────────────────────
  // Tagging & notes
  // ─────────────────────────────────────────────

  /** Add a tag (idempotent — duplicates are collapsed). */
  async addTag(
    businessId: string,
    id: string,
    tag: string,
  ): Promise<conversations> {
    const conversation = await this.requireConversation(businessId, id);
    const next = Array.from(new Set([...conversation.tags, tag.trim()])).filter(
      Boolean,
    );
    return this.repository.update(businessId, id, { tags: next });
  }

  /** Remove a tag (no-op if absent). */
  async removeTag(
    businessId: string,
    id: string,
    tag: string,
  ): Promise<conversations> {
    const conversation = await this.requireConversation(businessId, id);
    const next = conversation.tags.filter((t) => t !== tag);
    return this.repository.update(businessId, id, { tags: next });
  }

  /** Replace the full tag set. */
  async setTags(
    businessId: string,
    id: string,
    tags: string[],
  ): Promise<conversations> {
    await this.requireConversation(businessId, id);
    const deduped = Array.from(
      new Set(tags.map((t) => t.trim()).filter(Boolean)),
    );
    return this.repository.update(businessId, id, { tags: deduped });
  }

  /** Set the internal note (stored in the metadata JSONB). */
  async updateNote(
    businessId: string,
    id: string,
    note: string,
  ): Promise<conversations> {
    const conversation = await this.requireConversation(businessId, id);
    const metadata = {
      ...(conversation.metadata as Record<string, unknown>),
      [INTERNAL_NOTE_KEY]: note,
    };
    return this.repository.update(businessId, id, { metadata });
  }

  // ─────────────────────────────────────────────
  // SLA & stats
  // ─────────────────────────────────────────────

  /**
   * Compute SLA metrics for a single conversation:
   * - first response time: first inbound → first outbound (ms)
   * - resolution time: first message → resolved_at (ms)
   */
  async getSlaMetrics(businessId: string, id: string): Promise<SlaMetrics> {
    const conversation = await this.requireConversation(businessId, id);

    const [firstInbound, firstOutbound] = await Promise.all([
      this.prisma.messages.findFirst({
        where: { business_id: businessId, conversation_id: id, direction: 'INBOUND' },
        orderBy: { created_at: 'asc' },
        select: { created_at: true },
      }),
      this.prisma.messages.findFirst({
        where: {
          business_id: businessId,
          conversation_id: id,
          direction: 'OUTBOUND',
        },
        orderBy: { created_at: 'asc' },
        select: { created_at: true },
      }),
    ]);

    let firstResponseTimeMs: number | null = null;
    if (firstInbound && firstOutbound) {
      const delta =
        firstOutbound.created_at.getTime() - firstInbound.created_at.getTime();
      firstResponseTimeMs = delta >= 0 ? delta : null;
    }

    let resolutionTimeMs: number | null = null;
    if (conversation.first_message_at && conversation.resolved_at) {
      resolutionTimeMs =
        conversation.resolved_at.getTime() -
        conversation.first_message_at.getTime();
    }

    const firstResponseTargetMs =
      SLA_FIRST_RESPONSE_TARGET_SECONDS * 1000;
    const resolutionTargetMs = SLA_RESOLUTION_TARGET_SECONDS * 1000;

    return {
      conversationId: id,
      firstResponseTimeMs,
      firstResponseBreached:
        firstResponseTimeMs != null &&
        firstResponseTimeMs > firstResponseTargetMs,
      resolutionTimeMs,
      resolutionBreached:
        resolutionTimeMs != null && resolutionTimeMs > resolutionTargetMs,
    };
  }

  /** Aggregate conversation counts and resolution stats for a business. */
  async getConversationStats(businessId: string): Promise<ConversationStats> {
    const [byStatus, resolution] = await Promise.all([
      this.repository.countByStatus(businessId),
      this.repository.getResolutionStats(businessId),
    ]);

    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

    return {
      byStatus,
      total,
      resolvedCount: resolution.resolvedCount,
      avgResolutionSeconds: resolution.avgResolutionSeconds,
    };
  }

  // ─────────────────────────────────────────────
  // AI context
  // ─────────────────────────────────────────────

  /**
   * Load conversation context for the AI engine: the conversation, the last
   * CONTEXT_WINDOW_SIZE messages (chronological), and the client profile.
   */
  async getConversationContext(
    businessId: string,
    id: string,
  ): Promise<ConversationContext> {
    const conversation = await this.requireConversation(businessId, id);

    const messages = await this.prisma.messages.findMany({
      where: { conversation_id: id, business_id: businessId },
      orderBy: { created_at: 'desc' },
      take: CONTEXT_WINDOW_SIZE,
      select: {
        id: true,
        direction: true,
        type: true,
        sender_type: true,
        sender_id: true,
        content: true,
        text_content: true,
        created_at: true,
      },
    });

    const chronologicalMessages = messages.reverse();
    const client = (conversation as Record<string, unknown>)['client'] ?? null;

    return {
      conversation,
      messages: chronologicalMessages,
      client,
    };
  }

  // ─────────────────────────────────────────────
  // Snooze wake-up
  // ─────────────────────────────────────────────

  /**
   * Re-open every snoozed conversation whose snooze window has elapsed.
   * Invoked by the snooze-wake scheduled job. Returns the count re-opened.
   */
  async wakeSnoozedConversations(
    businessId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const due = await this.repository.findSnoozedDue(businessId, now);
    let woken = 0;
    for (const conversation of due) {
      try {
        await this.repository.updateStatus(
          businessId,
          conversation.id,
          ConversationStatus.OPEN,
        );
        this.emitStatusChanged(
          businessId,
          conversation.id,
          conversation.client_id,
          ConversationStatus.SNOOZED,
          ConversationStatus.OPEN,
          RESOLVED_BY.SYSTEM,
        );
        woken += 1;
      } catch (error) {
        this.logger.error(
          `Failed to wake snoozed conversation ${conversation.id}: ${this.errMsg(error)}`,
        );
      }
    }
    if (woken > 0) {
      this.logger.log(`Woke ${woken} snoozed conversation(s)`);
    }
    return woken;
  }

  // ─────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────

  /**
   * message.received → find/create the conversation and bump last_message_at.
   */
  @OnEvent('message.received')
  async handleMessageReceived(event: MessageReceivedEvent): Promise<void> {
    if (!event.clientId) {
      this.logger.debug(
        `Skipping message.received ${event.messageId}: clientId not yet resolved`,
      );
      return;
    }

    try {
      const conversation = await this.findOrCreate(event.businessId, {
        clientId: event.clientId,
        channelAccountId: event.channelAccountId,
        channel: event.channel,
      });

      await this.repository.updateLastMessageAt(conversation.id, new Date());

      // A resolved or snoozed conversation auto-reopens when the client
      // messages again — a reply during a snooze window means the human
      // reason to wait no longer applies, and this is the only reopen path
      // that fires before the scheduled snooze-wake job is due.
      if (
        conversation.status === ConversationStatus.RESOLVED ||
        conversation.status === ConversationStatus.SNOOZED
      ) {
        const previousStatus = conversation.status as ConversationStatus;
        await this.repository
          .updateStatus(event.businessId, conversation.id, ConversationStatus.OPEN)
          .then(() =>
            this.emitStatusChanged(
              event.businessId,
              conversation.id,
              conversation.client_id,
              previousStatus,
              ConversationStatus.OPEN,
              RESOLVED_BY.SYSTEM,
            ),
          );
      }

      this.logger.debug(
        `Processed message.received for conversation ${conversation.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle message.received for message ${event.messageId}: ${this.errMsg(error)}`,
      );
    }
  }

  /**
   * message.stored (OUTBOUND) → count human replies for handoff metrics.
   */
  @OnEvent('message.stored')
  async handleMessageStored(event: MessageStoredEvent): Promise<void> {
    if (event.direction !== 'OUTBOUND') return;
    if (event.senderType !== 'HUMAN_AGENT') return;
    try {
      await this.repository.incrementHumanMessageCount(event.conversationId);
    } catch (error) {
      this.logger.debug(
        `Could not increment human_message_count for ${event.conversationId}: ${this.errMsg(error)}`,
      );
    }
  }

  /**
   * task.resolved → an escalated conversation returns to OPEN for follow-up.
   */
  @OnEvent('task.resolved')
  async handleTaskResolved(event: TaskResolvedEvent): Promise<void> {
    try {
      const conversation = await this.repository.findById(
        event.businessId,
        event.conversationId,
      );
      if (!conversation) return;
      if (conversation.status !== ConversationStatus.ESCALATED) return;

      await this.repository.updateStatus(
        event.businessId,
        conversation.id,
        ConversationStatus.OPEN,
      );
      this.emitStatusChanged(
        event.businessId,
        conversation.id,
        conversation.client_id,
        ConversationStatus.ESCALATED,
        ConversationStatus.OPEN,
        event.resolvedByMemberId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle task.resolved for conversation ${event.conversationId}: ${this.errMsg(error)}`,
      );
    }
  }

  /**
   * ai.response.approved → a PENDING_HUMAN conversation returns to OPEN so the
   * AI can continue handling it.
   */
  @OnEvent('ai.response.approved')
  async handleAiResponseApproved(
    event: AIResponseApprovedEvent,
  ): Promise<void> {
    try {
      const conversation = await this.repository.findById(
        event.businessId,
        event.conversationId,
      );
      if (!conversation) return;
      if (conversation.status !== ConversationStatus.PENDING_HUMAN) return;

      await this.repository.updateStatus(
        event.businessId,
        conversation.id,
        ConversationStatus.OPEN,
      );
      this.emitStatusChanged(
        event.businessId,
        conversation.id,
        conversation.client_id,
        ConversationStatus.PENDING_HUMAN,
        ConversationStatus.OPEN,
        event.approvedByMemberId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle ai.response.approved for conversation ${event.conversationId}: ${this.errMsg(error)}`,
      );
    }
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  private async requireConversation(
    businessId: string,
    id: string,
  ): Promise<conversations> {
    const conversation = await this.repository.findById(businessId, id);
    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${id}`);
    }
    return conversation;
  }

  private assertTransition(
    current: ConversationStatus,
    next: ConversationStatus,
  ): void {
    if (current === next) return;
    const allowed = VALID_TRANSITIONS[current];
    if (!allowed || !allowed.includes(next)) {
      throw new BadRequestException(
        `Invalid status transition: ${current} → ${next}`,
      );
    }
  }

  private async countOpenTasks(
    businessId: string,
    conversationId: string,
  ): Promise<number> {
    return this.prisma.tasks.count({
      where: {
        business_id: businessId,
        conversation_id: conversationId,
        status: { in: [...OPEN_TASK_STATUSES] },
      },
    });
  }

  private emitStatusChanged(
    businessId: string,
    conversationId: string,
    clientId: string,
    previousStatus: ConversationStatus,
    newStatus: ConversationStatus,
    actorId?: string,
  ): void {
    const event: ConversationStatusChangedEvent = {
      type: 'conversation.status.changed',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId,
      clientId,
      previousStatus,
      newStatus,
      actorId,
    };
    this.eventEmitter.emit('conversation.status.changed', event);
  }

  private emitAssigned(
    businessId: string,
    conversationId: string,
    clientId: string,
    assigneeId: string,
    previousAssigneeId?: string,
  ): void {
    const event: ConversationAssignedEvent = {
      type: 'conversation.assigned',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId,
      clientId,
      assigneeId,
      previousAssigneeId,
    };
    this.eventEmitter.emit('conversation.assigned', event);
  }

  private errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
