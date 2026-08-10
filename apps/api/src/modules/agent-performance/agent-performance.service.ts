import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AgentPerformanceRepository, AgentSummary, DateRange } from './agent-performance.repository';
import { SlaService } from '../sla/sla.service';
import { AgentPerformanceDto, AgentLeaderboardDto, ResolvedRangeDto } from './dto';

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface ResolvedRange {
  from: Date;
  to: Date;
}

/**
 * AgentPerformanceService — read-only per-agent productivity metrics.
 *
 * Mirrors the `analytics` module's read-only design (no owned tables, direct
 * reads across conversations/messages/tasks/team_members) but adds SLA
 * compliance by injecting `SlaService` for a synchronous read, rather than
 * querying `sla_breaches` directly.
 */
@Injectable()
export class AgentPerformanceService {
  constructor(
    private readonly repository: AgentPerformanceRepository,
    private readonly slaService: SlaService,
  ) {}

  async getAgentPerformance(
    businessId: string,
    memberId: string,
    fromIso?: string,
    toIso?: string,
  ): Promise<AgentPerformanceDto> {
    const member = await this.repository.findActiveMember(businessId, memberId);
    if (!member) {
      throw new NotFoundException(`Team member ${memberId} not found`);
    }

    const range = this.resolveRange(fromIso, toIso);
    const [summaries, breachCounts] = await Promise.all([
      this.repository.listAgentSummaries(businessId, range),
      this.slaService.getBreachCountsByAssignee(businessId, range.from, range.to),
    ]);

    const summary = summaries.find((s) => s.id === memberId) ?? this.emptySummary(member);
    return this.toDto(summary, range, breachCounts);
  }

  async listAgentPerformance(
    businessId: string,
    fromIso?: string,
    toIso?: string,
  ): Promise<AgentLeaderboardDto> {
    const range = this.resolveRange(fromIso, toIso);
    const [summaries, breachCounts] = await Promise.all([
      this.repository.listAgentSummaries(businessId, range),
      this.slaService.getBreachCountsByAssignee(businessId, range.from, range.to),
    ]);

    return {
      range: this.toResolvedRangeDto(range),
      agents: summaries.map((s) => this.toDto(s, range, breachCounts)),
    };
  }

  private resolveRange(fromIso?: string, toIso?: string): ResolvedRange {
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * MS_PER_DAY);

    const spanDays = (to.getTime() - from.getTime()) / MS_PER_DAY;
    if (spanDays > MAX_RANGE_DAYS) {
      throw new UnprocessableEntityException({
        code: 'DATE_RANGE_TOO_LARGE',
        message: `Date range is capped at ${MAX_RANGE_DAYS} days (requested ${Math.ceil(spanDays)}).`,
      });
    }

    return { from, to };
  }

  private toResolvedRangeDto(range: ResolvedRange): ResolvedRangeDto {
    return { from: range.from.toISOString(), to: range.to.toISOString() };
  }

  private emptySummary(member: { id: string; name: string; email: string; role: string }): AgentSummary {
    return {
      id: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
      assignedConversations: 0,
      resolvedConversations: 0,
      avgFirstResponseSeconds: 0,
      firstResponseSampleSize: 0,
      avgResolutionSeconds: 0,
      resolutionSampleSize: 0,
      csatAverage: null,
      csatResponseCount: 0,
      tasksResolved: 0,
      avgTaskResolutionSeconds: 0,
    };
  }

  private toDto(
    summary: AgentSummary,
    range: ResolvedRange,
    breachCounts: { assigneeId: string; breachedCount: number; totalCount: number }[],
  ): AgentPerformanceDto {
    const sla = breachCounts.find((b) => b.assigneeId === summary.id);
    const slaTotal = sla?.totalCount ?? 0;
    const slaBreached = sla?.breachedCount ?? 0;

    return {
      memberId: summary.id,
      name: summary.name,
      email: summary.email,
      role: summary.role,
      range: this.toResolvedRangeDto(range),
      assignedConversations: summary.assignedConversations,
      resolvedConversations: summary.resolvedConversations,
      avgFirstResponseSeconds: summary.avgFirstResponseSeconds,
      avgResolutionSeconds: summary.avgResolutionSeconds,
      csatAverage: summary.csatAverage,
      csatResponseCount: summary.csatResponseCount,
      tasksResolved: summary.tasksResolved,
      avgTaskResolutionSeconds: summary.avgTaskResolutionSeconds,
      slaTargetsTotal: slaTotal,
      slaBreachedCount: slaBreached,
      slaComplianceRate:
        slaTotal > 0 ? Math.round(((slaTotal - slaBreached) / slaTotal) * 10000) / 100 : 100,
    };
  }
}
