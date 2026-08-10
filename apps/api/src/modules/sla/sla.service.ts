import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { sla_policies, sla_breaches } from '@prisma/client';
import { ChannelType, generateId, generateCorrelationId } from '@gosumo/shared';
import type {
  ConversationCreatedEvent,
  MessageSentEvent,
  ConversationResolvedEvent,
  SlaBreachedEvent,
  SlaEscalatedEvent,
} from '@gosumo/shared';
import {
  SlaRepository,
  SlaConditions,
  SlaEscalationAction,
  SlaBreachTypeValue,
} from './sla.repository';
import {
  CreateSlaPolicyDto,
  UpdateSlaPolicyDto,
  ListBreachesQueryDto,
  SlaPolicyDto,
  SlaBreachDto,
  PaginatedBreachesDto,
  SlaComplianceDto,
} from './dto';

const DEFAULT_RANGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SWEEP_BATCH_SIZE = 200;

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

/**
 * SlaService — configurable SLA targets, breach detection, and escalation.
 *
 * A policy is matched against each new conversation (by channel/tags); two
 * clocks are then tracked — first-response and resolution — and checked
 * opportunistically off `message.sent` / `conversation.resolved`. A sweep
 * (`sweepOverdueBreaches`) catches clocks that expire with no triggering
 * event at all (e.g. a conversation nobody ever responds to).
 */
@Injectable()
export class SlaService {
  private readonly logger = new Logger(SlaService.name);

  constructor(
    private readonly repository: SlaRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ───────────────────────────────────────────────────────────────────
  // Policy CRUD
  // ───────────────────────────────────────────────────────────────────

  async createPolicy(businessId: string, dto: CreateSlaPolicyDto): Promise<SlaPolicyDto> {
    if (dto.resolutionTargetMinutes < dto.firstResponseTargetMinutes) {
      throw new BadRequestException(
        'resolutionTargetMinutes must be greater than or equal to firstResponseTargetMinutes',
      );
    }
    const created = await this.repository.createPolicy(businessId, {
      ...dto,
      conditions: dto.conditions as SlaConditions,
      escalationActions: (dto.escalationActions ?? []) as SlaEscalationAction[],
    });
    return this.toPolicyDto(created);
  }

  async listPolicies(businessId: string): Promise<SlaPolicyDto[]> {
    const policies = await this.repository.findAllPolicies(businessId);
    return policies.map((p) => this.toPolicyDto(p));
  }

  async getPolicy(businessId: string, id: string): Promise<SlaPolicyDto> {
    const policy = await this.getPolicyEntity(businessId, id);
    return this.toPolicyDto(policy);
  }

  async updatePolicy(businessId: string, id: string, dto: UpdateSlaPolicyDto): Promise<SlaPolicyDto> {
    await this.getPolicyEntity(businessId, id);
    const updated = await this.repository.updatePolicy(businessId, id, {
      ...dto,
      conditions: dto.conditions as SlaConditions | undefined,
      escalationActions: dto.escalationActions as SlaEscalationAction[] | undefined,
    });
    return this.toPolicyDto(updated);
  }

  async deletePolicy(businessId: string, id: string): Promise<void> {
    await this.getPolicyEntity(businessId, id);
    await this.repository.softDeletePolicy(businessId, id);
  }

  private async getPolicyEntity(businessId: string, id: string): Promise<sla_policies> {
    const policy = await this.repository.findPolicyById(businessId, id);
    if (!policy) {
      throw new NotFoundException(`SLA policy ${id} not found`);
    }
    return policy;
  }

  // ───────────────────────────────────────────────────────────────────
  // Breach queries
  // ───────────────────────────────────────────────────────────────────

  async listBreaches(businessId: string, query: ListBreachesQueryDto): Promise<PaginatedBreachesDto> {
    const result = await this.repository.listBreaches(businessId, query);
    return {
      data: result.data.map((b) => this.toBreachDto(b)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  async getBreachesForConversation(businessId: string, conversationId: string): Promise<SlaBreachDto[]> {
    const breaches = await this.repository.findBreachesForConversation(businessId, conversationId);
    return breaches.map((b) => this.toBreachDto(b));
  }

  async getComplianceSummary(businessId: string, fromIso?: string, toIso?: string): Promise<SlaComplianceDto> {
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * MS_PER_DAY);

    const stats = await this.repository.getComplianceStats(businessId, from, to);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalTargets: stats.total,
      metTargets: stats.met,
      breachedTargets: stats.breached,
      complianceRate: pct(stats.total - stats.breached, stats.total),
    };
  }

  /**
   * Per-assignee breach counts in a date range — read via injection by the
   * agent-performance module (never a direct table read from outside sla).
   */
  async getBreachCountsByAssignee(
    businessId: string,
    from: Date,
    to: Date,
  ): Promise<{ assigneeId: string; breachedCount: number; totalCount: number }[]> {
    return this.repository.getBreachCountsByAssignee(businessId, from, to);
  }

  // ───────────────────────────────────────────────────────────────────
  // Event listeners — breach lifecycle
  // ───────────────────────────────────────────────────────────────────

  @OnEvent('conversation.created')
  async handleConversationCreated(event: ConversationCreatedEvent): Promise<void> {
    try {
      const summary = await this.repository.getConversationSummary(event.businessId, event.conversationId);
      if (!summary) return;

      const policies = await this.repository.findActivePolicies(event.businessId);
      const policy = this.matchPolicy(policies, summary.channel, summary.tags);
      if (!policy) return;

      await this.repository.createBreachTrackers(
        event.businessId,
        event.conversationId,
        policy.id,
        summary.createdAt,
        policy.first_response_target_minutes,
        policy.resolution_target_minutes,
      );
    } catch (err) {
      this.logger.error(
        `Failed to assign SLA policy for conversation ${event.conversationId}: ${this.errMsg(err)}`,
      );
    }
  }

  @OnEvent('message.sent')
  async handleMessageSent(event: MessageSentEvent): Promise<void> {
    await this.checkTracker(event.businessId, event.conversationId, 'FIRST_RESPONSE');
  }

  @OnEvent('conversation.resolved')
  async handleConversationResolved(event: ConversationResolvedEvent): Promise<void> {
    await this.checkTracker(event.businessId, event.conversationId, 'RESOLUTION');
  }

  private async checkTracker(
    businessId: string,
    conversationId: string,
    breachType: SlaBreachTypeValue,
  ): Promise<void> {
    try {
      const tracker = await this.repository.findBreachTracker(businessId, conversationId, breachType);
      if (!tracker || tracker.met_at) return;

      const now = new Date();
      const breached = now.getTime() > tracker.due_at.getTime();
      const wasAlreadyBreached = tracker.breached;
      const updated = await this.repository.markMet(businessId, tracker.id, now, breached);

      if (breached && !wasAlreadyBreached) {
        await this.onBreachDetected(businessId, updated);
      }
    } catch (err) {
      this.logger.error(
        `Failed to check SLA tracker (${breachType}) for conversation ${conversationId}: ${this.errMsg(err)}`,
      );
    }
  }

  /**
   * Sweep trackers whose deadline passed with no triggering event at all
   * (e.g. nobody ever responded). Intended to be called periodically by an
   * operator/ops job; exposed via `POST /sla/breaches/sweep`.
   */
  async sweepOverdueBreaches(businessId: string): Promise<{ swept: number }> {
    const now = new Date();
    const overdue = await this.repository.findOverdueUnmetTrackers(businessId, now, SWEEP_BATCH_SIZE);

    for (const tracker of overdue) {
      const updated = await this.repository.markBreachedOnly(businessId, tracker.id, now);
      await this.onBreachDetected(businessId, updated);
    }

    return { swept: overdue.length };
  }

  private async onBreachDetected(businessId: string, breach: sla_breaches): Promise<void> {
    const actualMinutes = Math.round(
      breach.target_minutes + Math.max(0, (Date.now() - breach.due_at.getTime()) / 60_000),
    );

    const event: SlaBreachedEvent = {
      id: generateId(),
      type: 'sla.breached',
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId: breach.conversation_id,
      policyId: breach.policy_id,
      breachType: breach.breach_type,
      targetMinutes: breach.target_minutes,
      actualMinutes,
    };
    this.eventEmitter.emit('sla.breached', event);

    await this.escalate(businessId, breach);
  }

  private async escalate(businessId: string, breach: sla_breaches): Promise<void> {
    const policy = await this.repository.findPolicyById(businessId, breach.policy_id);
    const actions = (policy?.escalation_actions as unknown as SlaEscalationAction[] | undefined) ?? [];
    if (!actions.length) return;

    for (const action of actions) {
      const event: SlaEscalatedEvent = {
        id: generateId(),
        type: 'sla.escalated',
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: generateCorrelationId(),
        conversationId: breach.conversation_id,
        policyId: breach.policy_id,
        breachType: breach.breach_type,
        action: action.type,
        target: action.target,
      };
      this.eventEmitter.emit('sla.escalated', event);
    }

    await this.repository.markEscalated(businessId, breach.id, new Date());
  }

  // ───────────────────────────────────────────────────────────────────
  // Matching
  // ───────────────────────────────────────────────────────────────────

  private matchPolicy(
    policies: sla_policies[],
    channel: ChannelType,
    tags: string[],
  ): sla_policies | null {
    for (const policy of policies) {
      const conditions = policy.conditions as unknown as SlaConditions;
      if (this.matchesConditions(conditions, channel, tags)) {
        return policy;
      }
    }
    return null;
  }

  private matchesConditions(conditions: SlaConditions, channel: ChannelType, tags: string[]): boolean {
    if (conditions.channels?.length && !conditions.channels.includes(channel)) {
      return false;
    }
    if (conditions.tags?.length && !conditions.tags.some((t) => tags.includes(t))) {
      return false;
    }
    return true;
  }

  // ───────────────────────────────────────────────────────────────────
  // Mappers
  // ───────────────────────────────────────────────────────────────────

  private toPolicyDto(p: sla_policies): SlaPolicyDto {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      priority: p.priority,
      isActive: p.is_active,
      conditions: p.conditions as unknown as SlaPolicyDto['conditions'],
      firstResponseTargetMinutes: p.first_response_target_minutes,
      resolutionTargetMinutes: p.resolution_target_minutes,
      escalationActions: p.escalation_actions as unknown as SlaPolicyDto['escalationActions'],
      createdAt: p.created_at.toISOString(),
      updatedAt: p.updated_at.toISOString(),
    };
  }

  private toBreachDto(b: sla_breaches): SlaBreachDto {
    return {
      id: b.id,
      conversationId: b.conversation_id,
      policyId: b.policy_id,
      breachType: b.breach_type,
      targetMinutes: b.target_minutes,
      dueAt: b.due_at.toISOString(),
      metAt: b.met_at?.toISOString() ?? null,
      breached: b.breached,
      breachedAt: b.breached_at?.toISOString() ?? null,
      escalated: b.escalated,
      escalatedAt: b.escalated_at?.toISOString() ?? null,
    };
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
