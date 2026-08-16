import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import type { conversations } from '@prisma/client';
import { AuditAction } from '@gosumo/database';
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
  TaskCreatedEvent,
  TaskResolvedEvent,
  TeamMemberRemovedEvent,
  AIResponseApprovedEvent,
} from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST } from '../../common/utils/message-order';
import { TenantService } from '../tenant/tenant.service';
import {
  ConversationRepository,
  ConversationListFilters,
  PaginatedConversations,
  UpdateConversationData,
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

/**
 * HITL task types that mean "an AI draft is waiting for a person to look at
 * it" — as opposed to an escalation, which `ai.escalated` handles with the
 * stronger ESCALATED status. Compared as strings because the enum lives in
 * `@gosumo/database` and this module does not otherwise depend on it.
 */
const REVIEW_TASK_TYPES: readonly string[] = ['REVIEW_RESPONSE', 'CLARIFY_INTENT'];

/**
 * How each target status reads on the audit trail.
 *
 * `AuditAction` is a small closed enum shared across the platform, so the two
 * transitions it has a word for get that word and the rest are UPDATE. Reading
 * "UPDATE conversation" and having to open `resource_after` to learn it was an
 * escalation is exactly the friction the enum exists to remove.
 */
const AUDIT_ACTION_FOR_STATUS: Record<ConversationStatus, AuditAction> = {
  [ConversationStatus.OPEN]: AuditAction.UPDATE,
  [ConversationStatus.PENDING_HUMAN]: AuditAction.UPDATE,
  [ConversationStatus.SNOOZED]: AuditAction.UPDATE,
  [ConversationStatus.ESCALATED]: AuditAction.ESCALATE,
  [ConversationStatus.RESOLVED]: AuditAction.RESOLVE,
};

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
  /** Candidate team-member ids for ROUND_ROBIN / LEAST_BUSY / SKILL_BASED. */
  candidateAgentIds?: string[];
  /**
   * Skills a candidate must hold for SKILL_BASED. Every one of them, not any.
   * Ignored by the other strategies.
   */
  requiredSkills?: string[];
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
    private readonly tenantService: TenantService,
    @InjectQueue(CONVERSATION_QUEUE) private readonly queue: Queue<SnoozeWakeJobData>,
    /**
     * Optional — the append-only trail every status transition is recorded on.
     * Wired in `ConversationModule`; absent in unit tests that construct the
     * service positionally, which then behave exactly as before minus the row.
     */
    @Optional() private readonly audit?: AuditLogService,
  ) {}

  /**
   * Reject an assignee who is not an active team member of this tenant.
   *
   * `@TenantId()` scopes the conversation being written, but the assignee id
   * arrives in the request body as a second, unscoped reference — and unlike
   * `tasks.assigned_to`, `conversations.assigned_to` has no foreign key at
   * all, so the database accepts any UUID whatsoever.
   *
   * The check is `assertAssignableTeamMember` rather than the plain membership
   * one because a conversation is live customer work: parking it with an
   * INVITED member who has never signed in, or a SUSPENDED one who cannot,
   * takes it out of the unassigned queue without putting it in front of
   * anybody. Omitting the assignee is fine — only a supplied one is checked.
   */
  private async assertAssignee(
    businessId: string,
    assigneeId?: string | null,
  ): Promise<void> {
    if (!assigneeId) return;
    await this.tenantService.assertAssignableTeamMember(businessId, assigneeId);
  }

  // ─────────────────────────────────────────────
  // Lifecycle: create / read / list
  // ─────────────────────────────────────────────

  /**
   * Find the existing conversation for the given client + channel account,
   * or create a new one if this client has never written on this channel.
   *
   * A RESOLVED thread is returned as-is rather than skipped — there is one
   * thread per (business, client, channel account), and the caller decides
   * whether the new activity reopens it (see `handleMessageReceived`).
   * Creating a second thread instead would split the client's history.
   *
   * Emits `conversation.created` when a new conversation is created.
   */
  async findOrCreate(
    businessId: string,
    dto: { clientId: string; channelAccountId: string; channel: ChannelType },
  ): Promise<conversations> {
    const existing = await this.repository.findLatestByClientAndChannel(
      businessId,
      dto.clientId,
      dto.channelAccountId,
    );

    if (existing) {
      this.logger.debug(
        `Found ${existing.status} conversation ${existing.id} for client ${dto.clientId} on ${dto.channel}`,
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
   * Mark a conversation read, clearing its unread counter, and return the
   * conversation with the cleared count.
   *
   * Called when an operator opens a thread. Only the counter moves — reading a
   * conversation is not a status transition, so nothing is emitted and no
   * lifecycle rule applies.
   */
  async markConversationRead(
    businessId: string,
    id: string,
  ): Promise<{ conversation: conversations; cleared: number }> {
    const conversation = await this.repository.findById(businessId, id);
    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${id}`);
    }

    const cleared = await this.repository.markRead(businessId, id);

    return {
      // Reflect the clear in the returned row without a second read: the caller
      // renders this straight back into the inbox, where a stale non-zero count
      // would flash the badge the operator just dismissed.
      conversation: {
        ...conversation,
        unread_count: Math.max(0, conversation.unread_count - cleared),
      },
      cleared,
    };
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

    return this.commitTransition({
      businessId,
      id,
      clientId: conversation.client_id,
      from: currentStatus,
      to: newStatus,
      actorId,
    });
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
    const updated = await this.commitTransition({
      businessId,
      id,
      clientId: conversation.client_id,
      from: currentStatus,
      to: ConversationStatus.RESOLVED,
      actorId: options.actorId,
      extra: {
        resolvedAt,
        csatScore: options.csatScore,
        csatSubmittedAt: options.csatScore != null ? resolvedAt : undefined,
      },
      description: `Conversation resolved by ${options.resolvedBy ?? RESOLVED_BY.HUMAN}`,
    });

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

    const updated = await this.commitTransition({
      businessId,
      id,
      clientId: conversation.client_id,
      from: currentStatus,
      to: ConversationStatus.SNOOZED,
      actorId,
      extra: { snoozedUntil: snoozeUntil },
      description: `Conversation snoozed until ${snoozeUntil.toISOString()}`,
    });

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
    await this.assertAssignee(businessId, options.assignedToMemberId);

    const conversation = await this.requireConversation(businessId, id);
    const currentStatus = conversation.status as ConversationStatus;
    this.assertTransition(currentStatus, ConversationStatus.ESCALATED);

    const updated = await this.commitTransition({
      businessId,
      id,
      clientId: conversation.client_id,
      from: currentStatus,
      to: ConversationStatus.ESCALATED,
      actorId: options.actorId,
      extra: { assignedTo: options.assignedToMemberId ?? undefined },
      description: `Conversation escalated: ${options.reason ?? ESCALATION_REASON.MANUAL}`,
    });

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
    await this.assertAssignee(businessId, assigneeId);

    const conversation = await this.requireConversation(businessId, id);

    return this.commitAssignment(
      businessId,
      id,
      conversation.client_id,
      assigneeId,
      conversation.assigned_to,
      `assigned to ${assigneeId}`,
    );
  }

  /**
   * Write an assignment that was decided against `expectedAssigneeId`, and
   * announce it only if it changed something.
   *
   * Two things are folded in here because both are about the same window
   * between reading the current assignee and writing the new one:
   *
   *  - **The write is a compare-and-set.** If someone else moved the
   *    conversation in that window, the write does not land and the caller is
   *    told, rather than the loser's agent being handed an event that says
   *    they own a conversation they do not.
   *  - **A lost race whose outcome already matches is not a conflict.** Two
   *    supervisors both assigning to the same agent is the end state everyone
   *    wanted; failing the second one would be a conflict about nothing.
   *
   * The no-change case is silent for the same reason. `conversation.assigned`
   * announces a transfer, so emitting one where assignee and previous assignee
   * are the same agent means any future consumer — a re-notification, an SLA
   * clock reset, a reassignment rule — fires on a non-event. Auto-assignment
   * can genuinely pick the incumbent, so this is reachable, not theoretical.
   */
  private async commitAssignment(
    businessId: string,
    id: string,
    clientId: string,
    assigneeId: string | null,
    expectedAssigneeId: string | null,
    logDetail: string,
  ): Promise<conversations> {
    if (assigneeId === expectedAssigneeId) {
      // Nothing to write and nothing to announce.
      return this.requireConversation(businessId, id);
    }

    const updated = await this.repository.assignIfHeldBy(
      businessId,
      id,
      assigneeId,
      expectedAssigneeId,
    );

    if (!updated) {
      const current = await this.requireConversation(businessId, id);
      if (current.assigned_to === assigneeId) {
        // Someone else got there first with the same answer.
        return current;
      }
      throw new ConflictException(
        `Conversation ${id} was reassigned by someone else — reload and retry`,
      );
    }

    if (assigneeId) {
      this.emitAssigned(
        businessId,
        id,
        clientId,
        assigneeId,
        expectedAssigneeId ?? undefined,
      );
    }
    this.logger.log(`Conversation ${id} ${logDetail}`);

    return updated;
  }

  /**
   * Auto-assign a conversation using the requested strategy.
   *
   * - AI: leave it with the AI — unassign, status stays OPEN.
   * - ROUND_ROBIN: pick the least-recently-loaded candidate deterministically.
   * - LEAST_BUSY: pick the candidate with the fewest active conversations.
   * - SKILL_BASED: drop candidates missing any required skill, then least-busy
   *   among the rest. With no required skills it is exactly LEAST_BUSY.
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
      return this.commitAssignment(
        businessId,
        id,
        conversation.client_id,
        null,
        conversation.assigned_to,
        'kept with AI (unassigned)',
      );
    }

    const requested = options.candidateAgentIds ?? [];
    if (requested.length === 0) {
      throw new BadRequestException(
        `Strategy ${options.strategy} requires at least one candidate agent`,
      );
    }

    // `candidateAgentIds` is a caller-supplied list of bare UUIDs, and
    // `conversations.assigned_to` has no foreign key at all — the "FK to
    // team_members" in the schema is a comment. Without this, a business could
    // route its own conversation to another business's team member, which is
    // the hole `assertAssignee` closes on the single-assignee path and this
    // one skipped entirely. Unusable candidates are dropped rather than
    // rejected: a suspended agent in a stale candidate list should be passed
    // over, not fail the request.
    const requiredSkills =
      options.strategy === AutoAssignStrategy.SKILL_BASED
        ? (options.requiredSkills ?? [])
        : [];

    const candidates =
      requiredSkills.length > 0
        ? await this.tenantService.filterAssignableTeamMembersBySkills(
            businessId,
            requested,
            requiredSkills,
          )
        : await this.tenantService.filterAssignableTeamMembers(businessId, requested);

    if (candidates.length < requested.length) {
      this.logger.warn(
        `Auto-assign for ${id}: ${requested.length - candidates.length} of ` +
          `${requested.length} candidates are not assignable in this business` +
          (requiredSkills.length > 0
            ? ` or lack the required skills [${requiredSkills.join(', ')}]`
            : ''),
      );
    }
    if (candidates.length === 0) {
      // Deliberately an error rather than a silent fall-back to an unqualified
      // agent: a conversation nobody on the candidate list can handle belongs
      // in the unassigned queue where a human will see it, not with someone who
      // cannot answer it.
      throw new BadRequestException(
        requiredSkills.length > 0
          ? `No assignable candidate holds all required skills: ${requiredSkills.join(', ')}`
          : `Strategy ${options.strategy} requires at least one assignable candidate agent`,
      );
    }

    const counts = await this.repository.countActiveByAssignees(
      businessId,
      candidates,
    );

    let chosen: string;
    if (
      options.strategy === AutoAssignStrategy.LEAST_BUSY ||
      options.strategy === AutoAssignStrategy.SKILL_BASED
    ) {
      // SKILL_BASED shares the least-busy tie-break: the skill filter has
      // already removed everyone unqualified, so what is left is a load
      // question. `reduce` keeps the earliest candidate on a tie, which makes
      // the choice deterministic against the caller's ordering.
      chosen = candidates.reduce((best, agent) =>
        (counts[agent] ?? 0) < (counts[best] ?? 0) ? agent : best,
      );
    } else {
      // ROUND_ROBIN: spread load by total active count, breaking ties by the
      // candidate order so the choice is deterministic and testable.
      const totalActive = Object.values(counts).reduce((a, b) => a + b, 0);
      chosen = candidates[totalActive % candidates.length] as string;
    }

    return this.commitAssignment(
      businessId,
      id,
      conversation.client_id,
      chosen,
      conversation.assigned_to,
      `auto-assigned to ${chosen} via ${options.strategy}`,
    );
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
      // Newest-first-then-reverse, so the `LIMIT` selects the *latest*
      // CONTEXT_WINDOW_SIZE. The tie-break is what makes that selection
      // deterministic: without it, a tie straddling the twentieth row lets the
      // database choose which of two simultaneous messages the AI is shown, and
      // it can choose differently on the retry. Scoped to one conversation, so
      // it sorts on `sequence`. See MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST.
      orderBy: MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST,
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

      await this.repository.updateLastMessageAt(
        event.businessId,
        conversation.id,
        new Date(),
      );

      // A resolved or snoozed conversation auto-reopens when the client
      // messages again — a reply during a snooze window means the human
      // reason to wait no longer applies, and this is the only reopen path
      // that fires before the scheduled snooze-wake job is due. Reopening
      // also clears resolved_at, so the SLA resolution clock restarts.
      if (
        conversation.status === ConversationStatus.RESOLVED ||
        conversation.status === ConversationStatus.SNOOZED
      ) {
        const previousStatus = conversation.status as ConversationStatus;
        await this.repository.updateStatus(
          event.businessId,
          conversation.id,
          ConversationStatus.OPEN,
        );
        this.emitStatusChanged(
          event.businessId,
          conversation.id,
          conversation.client_id,
          previousStatus,
          ConversationStatus.OPEN,
          RESOLVED_BY.SYSTEM,
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
      await this.repository.incrementHumanMessageCount(
        event.businessId,
        event.conversationId,
      );
    } catch (error) {
      this.logger.debug(
        `Could not increment human_message_count for ${event.conversationId}: ${this.errMsg(error)}`,
      );
    }
  }

  /**
   * team.member.removed → hand back everything that member was holding.
   *
   * Removing a member soft-deletes the row and sets it to SUSPENDED, but says
   * nothing about the conversations they own — and `conversations.assigned_to`
   * has no foreign key, so nothing in the database notices either. Their live
   * conversations stay pointed at an id that no longer resolves to anybody:
   * assigned, so they are filtered out of the unassigned queue nobody-owns-this
   * work is picked up from; not resolved, so they never close; and since
   * assignment now requires an ACTIVE member, no routine path would ever move
   * them again. Nothing surfaces it — the customer is simply waiting on a
   * conversation with an owner who left.
   *
   * Released to the unassigned queue rather than auto-reassigned. Choosing a
   * new owner is a routing decision with a policy behind it (`autoAssign`
   * exists precisely to make it), and silently dropping a departing agent's
   * whole caseload on whoever happens to be least busy is not obviously what
   * the business wants. Unassigned is the honest state: visible, and pickable
   * by the paths that already exist.
   */
  @OnEvent('team.member.removed')
  async handleTeamMemberRemoved(event: TeamMemberRemovedEvent): Promise<void> {
    try {
      const released = await this.repository.releaseAssignments(
        event.businessId,
        event.memberId,
      );
      if (released.length === 0) return;

      this.logger.log(
        `Released ${released.length} conversation(s) held by removed member ` +
          `${event.memberId}: ${released.join(', ')}`,
      );
    } catch (error) {
      // A throw here would propagate into the event bus and take out the other
      // listeners on this event alongside it.
      this.logger.error(
        `Could not release conversations held by removed member ${event.memberId}: ` +
          this.errMsg(error),
      );
    }
  }

  /**
   * ai.escalated → the conversation is now a human's, and says so.
   *
   * The AI pipeline files a HITL task when it escalates, but for a long time
   * that was the *only* trace: the conversation itself stayed OPEN. Three
   * things were broken by that, all silently —
   *
   *  - the inbox's "Escalated" filter never showed an AI escalation, so the
   *    queue a business actually watches did not contain the conversations
   *    the AI had given up on;
   *  - `handleTaskResolved` below returns early unless the status is
   *    ESCALATED, so the documented ESCALATED → OPEN return path could never
   *    fire — the hand-back half of the handoff was unreachable code;
   *  - the AI's own "don't answer over a human" guard keys off this status,
   *    so the pipeline kept auto-replying to a conversation it had itself
   *    escalated moments earlier.
   *
   * Best-effort and non-throwing, like every other listener here: the task is
   * already written by the time this runs, so a failure to relabel the
   * conversation must not unwind the escalation.
   */
  @OnEvent('ai.escalated')
  async handleAiEscalated(event: {
    businessId: string;
    conversationId: string;
    reason?: string;
  }): Promise<void> {
    if (!event.businessId || !event.conversationId) return;
    try {
      const conversation = await this.repository.findById(
        event.businessId,
        event.conversationId,
      );
      if (!conversation) return;

      // Already there, or somewhere ESCALATED cannot be reached from (a
      // RESOLVED thread the customer has since reopened is handled by the
      // reopen path, not here). Either way there is nothing to relabel, and
      // `escalateConversation` would throw on the invalid transition.
      const current = conversation.status as ConversationStatus;
      if (current === ConversationStatus.ESCALATED) return;
      if (!this.canTransition(current, ConversationStatus.ESCALATED)) {
        this.logger.debug(
          `Not escalating conversation ${event.conversationId}: ${current} → ESCALATED is not a valid transition`,
        );
        return;
      }

      await this.escalateConversation(event.businessId, event.conversationId, {
        reason: event.reason ?? ESCALATION_REASON.LOW_CONFIDENCE,
      });
    } catch (error) {
      this.logger.error(
        `Failed to handle ai.escalated for conversation ${event.conversationId}: ${this.errMsg(error)}`,
      );
    }
  }

  /**
   * task.created → a queued AI draft means the next move is a person's.
   *
   * The mirror of {@link handleAiEscalated}, and broken the same way: nothing
   * set PENDING_HUMAN, so `handleAiResponseApproved` below — the documented
   * PENDING_HUMAN → OPEN return — was unreachable, and a second message
   * arriving while a draft sat in the queue could be auto-answered, leaving
   * the reviewer holding a reply that now contradicts what the customer was
   * already told.
   *
   * Only the two review task types. An escalation task arrives here too, and
   * `ai.escalated` already gives that one the stronger ESCALATED status.
   */
  @OnEvent('task.created')
  async handleTaskCreated(event: TaskCreatedEvent): Promise<void> {
    if (!REVIEW_TASK_TYPES.includes(event.taskType as string)) return;
    if (!event.businessId || !event.conversationId) return;
    try {
      const conversation = await this.repository.findById(
        event.businessId,
        event.conversationId,
      );
      if (!conversation) return;

      const current = conversation.status as ConversationStatus;
      // ESCALATED outranks PENDING_HUMAN — a conversation already handed to a
      // person must not be quietly demoted to "a draft is waiting".
      if (current === ConversationStatus.ESCALATED) return;
      if (current === ConversationStatus.PENDING_HUMAN) return;
      if (!this.canTransition(current, ConversationStatus.PENDING_HUMAN)) return;

      // Conditional on `current`: between the read above and this write the
      // customer may have replied (reopening it) or `ai.escalated` may have
      // landed, and PENDING_HUMAN must not overwrite either. A lost race here
      // is the ordinary case rather than an error, so it is logged and dropped
      // — the conversation is in a *later* state, which is the correct one.
      await this.applyHandlerTransition(
        event.businessId,
        conversation.id,
        conversation.client_id,
        current,
        ConversationStatus.PENDING_HUMAN,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle task.created for conversation ${event.conversationId}: ${this.errMsg(error)}`,
      );
    }
  }

  /**
   * task.resolved → a conversation a human was holding returns to OPEN.
   *
   * Emitted on every resolution path HITL has — plain resolve, approve, reject,
   * and edit-and-send — so this is the one exit that covers all of them. A
   * rejected draft in particular has no other way back: without it the
   * conversation would sit in PENDING_HUMAN forever and the AI would never
   * answer that customer again.
   *
   * Held back while *another* task on the same conversation is still open. The
   * status is what re-arms the AI, so returning to OPEN on the first of two
   * resolutions would put it back to answering over a person who still has
   * work queued — which is the whole thing these statuses exist to prevent.
   */
  @OnEvent('task.resolved')
  async handleTaskResolved(event: TaskResolvedEvent): Promise<void> {
    try {
      const conversation = await this.repository.findById(
        event.businessId,
        event.conversationId,
      );
      if (!conversation) return;

      const current = conversation.status as ConversationStatus;
      if (
        current !== ConversationStatus.ESCALATED &&
        current !== ConversationStatus.PENDING_HUMAN
      ) {
        return;
      }

      const stillOpen = await this.countOpenTasks(event.businessId, conversation.id);
      if (stillOpen > 0) {
        this.logger.debug(
          `Conversation ${conversation.id} stays ${current}: ${stillOpen} task(s) still open`,
        );
        return;
      }

      await this.applyHandlerTransition(
        event.businessId,
        conversation.id,
        conversation.client_id,
        current,
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

      await this.applyHandlerTransition(
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

  /**
   * The same state-machine question {@link assertTransition} asks, answered
   * rather than thrown. Event listeners need to *skip* a transition they
   * cannot make; a rejected REST call needs to hear why.
   */
  private canTransition(
    current: ConversationStatus,
    next: ConversationStatus,
  ): boolean {
    if (current === next) return true;
    return VALID_TRANSITIONS[current]?.includes(next) ?? false;
  }

  private assertTransition(
    current: ConversationStatus,
    next: ConversationStatus,
  ): void {
    if (!this.canTransition(current, next)) {
      throw new BadRequestException(
        `Invalid status transition: ${current} → ${next}`,
      );
    }
  }

  /**
   * Apply a validated transition, then announce and record it.
   *
   * The single place a conversation's status changes, so that three things
   * cannot drift apart: the write is conditional on the status the caller
   * validated against, the `conversation.status.changed` event fires only when
   * the write actually landed, and the audit row describes a change that
   * happened.
   *
   * `assertTransition` answers "is this move legal", which is a question about
   * the machine. This answers "is this move still available", which is a
   * question about the row, and only the database can answer it — see
   * `ConversationRepository.transitionStatus`. A caller that loses gets a
   * `ConflictException` naming the status that beat it, because the honest
   * response to "resolve this" when someone else escalated it a moment ago is
   * to say so, not to silently overwrite them or to silently do nothing.
   */
  private async commitTransition(options: {
    businessId: string;
    id: string;
    clientId: string;
    from: ConversationStatus;
    to: ConversationStatus;
    actorId?: string;
    /** Columns that belong to this transition (snooze deadline, CSAT, assignee). */
    extra?: Omit<UpdateConversationData, 'status'>;
    /** Recorded on the audit row; defaults by target status. */
    auditAction?: AuditAction;
    description?: string;
  }): Promise<conversations> {
    const { businessId, id, clientId, from, to, actorId } = options;

    const updated = await this.repository.transitionStatus(
      businessId,
      id,
      from,
      to,
      options.extra ?? {},
    );

    if (!updated) {
      // Re-read for the message only. The status we report is a snapshot too,
      // but an operator reading "expected OPEN, found ESCALATED" can act on it,
      // where a bare 409 sends them to the logs.
      const current = await this.repository.findById(businessId, id);
      throw new ConflictException(
        `Conversation ${id} is no longer ${from}` +
          (current ? ` (now ${current.status})` : ' (no longer available)') +
          `; the ${from} → ${to} transition was not applied`,
      );
    }

    this.emitStatusChanged(businessId, id, clientId, from, to, actorId);

    // Append-only, best-effort, and after the write — a row describing a change
    // that did not happen is worse than a missing one.
    void this.audit?.record({
      businessId,
      actorType: actorId ? 'TEAM_MEMBER' : 'SYSTEM',
      actorId: actorId ?? null,
      action: options.auditAction ?? AUDIT_ACTION_FOR_STATUS[to],
      resourceType: 'conversation',
      resourceId: id,
      before: { status: from },
      after: { status: to },
      description:
        options.description ?? `Conversation status ${from} → ${to}`,
    });

    this.logger.log(`Conversation ${id} status changed: ${from} → ${to}`);

    return updated;
  }

  /**
   * The event-listener form of {@link commitTransition}: losing the race is a
   * normal outcome, not an error.
   *
   * These handlers relabel a conversation to reflect something that has already
   * happened elsewhere (a task was queued, a draft was approved). If the row
   * moved on between the read and the write, the state it moved to is newer
   * than the one this handler wanted to write, so the right thing is to leave
   * it alone. Every listener here is already documented as best-effort and
   * non-throwing; this keeps that true without making it silent.
   */
  private async applyHandlerTransition(
    businessId: string,
    conversationId: string,
    clientId: string,
    from: ConversationStatus,
    to: ConversationStatus,
    actorId?: string,
  ): Promise<void> {
    try {
      await this.commitTransition({
        businessId,
        id: conversationId,
        clientId,
        from,
        to,
        actorId,
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        this.logger.debug(
          `Conversation ${conversationId} left as-is: it is no longer ${from}, ` +
            `so the ${from} → ${to} relabel no longer applies`,
        );
        return;
      }
      throw error;
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
