import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';

export interface DateRange {
  from: Date;
  to: Date;
}

export interface TeamMemberSummary {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface AgentSummaryRaw {
  id: string;
  name: string;
  email: string;
  role: string;
  assigned: number;
  resolved_conv: number;
  avg_first_response_sec: number;
  first_response_sample: number;
  avg_resolution_sec: number;
  resolution_sample: number;
  csat_avg: number | null;
  csat_count: number;
  tasks_resolved: number;
  avg_task_resolution_sec: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  email: string;
  role: string;
  assignedConversations: number;
  resolvedConversations: number;
  avgFirstResponseSeconds: number;
  firstResponseSampleSize: number;
  avgResolutionSeconds: number;
  resolutionSampleSize: number;
  csatAverage: number | null;
  csatResponseCount: number;
  tasksResolved: number;
  avgTaskResolutionSeconds: number;
}

/**
 * AgentPerformanceRepository — read-only Prisma access for the
 * agent-performance module. Like `analytics`, it never writes; every query
 * is scoped by `business_id` and reads other modules' tables directly
 * (conversations, messages, tasks, team_members) the same way analytics does.
 */
@Injectable()
export class AgentPerformanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveMember(businessId: string, memberId: string): Promise<TeamMemberSummary | null> {
    const member = await this.prisma.team_members.findFirst({
      where: { id: memberId, business_id: businessId, deleted_at: null },
      select: { id: true, name: true, email: true, role: true },
    });
    return member;
  }

  async listAgentSummaries(businessId: string, range: DateRange): Promise<AgentSummary[]> {
    const rows = await this.prisma.$queryRaw<AgentSummaryRaw[]>`
      SELECT tm.id AS id,
             tm.name AS name,
             tm.email AS email,
             tm.role::text AS role,
             (SELECT COUNT(*)::int FROM conversations c
                WHERE c.business_id = tm.business_id AND c.assigned_to = tm.id
                  AND c.deleted_at IS NULL) AS assigned,
             (SELECT COUNT(*)::int FROM conversations c
                WHERE c.business_id = tm.business_id AND c.assigned_to = tm.id
                  AND c.status = 'RESOLVED'
                  AND c.resolved_at >= ${range.from} AND c.resolved_at < ${range.to}) AS resolved_conv,
             COALESCE((
               SELECT AVG(EXTRACT(EPOCH FROM (m.created_at - c.first_message_at)))::float8
               FROM messages m
               JOIN conversations c ON c.id = m.conversation_id
               WHERE m.business_id = tm.business_id AND m.sender_type = 'HUMAN_AGENT'
                 AND m.sender_id = tm.id AND c.assigned_to = tm.id
                 AND m.created_at >= ${range.from} AND m.created_at < ${range.to}
                 AND c.first_message_at IS NOT NULL
             ), 0) AS avg_first_response_sec,
             COALESCE((
               SELECT COUNT(*)::int
               FROM messages m
               JOIN conversations c ON c.id = m.conversation_id
               WHERE m.business_id = tm.business_id AND m.sender_type = 'HUMAN_AGENT'
                 AND m.sender_id = tm.id AND c.assigned_to = tm.id
                 AND m.created_at >= ${range.from} AND m.created_at < ${range.to}
                 AND c.first_message_at IS NOT NULL
             ), 0) AS first_response_sample,
             COALESCE((
               SELECT AVG(EXTRACT(EPOCH FROM (c.resolved_at - c.first_message_at)))::float8
               FROM conversations c
               WHERE c.business_id = tm.business_id AND c.assigned_to = tm.id
                 AND c.status = 'RESOLVED' AND c.first_message_at IS NOT NULL
                 AND c.resolved_at >= ${range.from} AND c.resolved_at < ${range.to}
             ), 0) AS avg_resolution_sec,
             COALESCE((
               SELECT COUNT(*)::int
               FROM conversations c
               WHERE c.business_id = tm.business_id AND c.assigned_to = tm.id
                 AND c.status = 'RESOLVED' AND c.first_message_at IS NOT NULL
                 AND c.resolved_at >= ${range.from} AND c.resolved_at < ${range.to}
             ), 0) AS resolution_sample,
             (SELECT AVG(c.csat_score)::float8 FROM conversations c
                WHERE c.business_id = tm.business_id AND c.assigned_to = tm.id
                  AND c.csat_score IS NOT NULL
                  AND c.csat_submitted_at >= ${range.from} AND c.csat_submitted_at < ${range.to}) AS csat_avg,
             COALESCE((SELECT COUNT(*)::int FROM conversations c
                WHERE c.business_id = tm.business_id AND c.assigned_to = tm.id
                  AND c.csat_score IS NOT NULL
                  AND c.csat_submitted_at >= ${range.from} AND c.csat_submitted_at < ${range.to}), 0) AS csat_count,
             (SELECT COUNT(*)::int FROM tasks t
                WHERE t.business_id = tm.business_id AND t.resolved_by = tm.id
                  AND t.status = 'RESOLVED'
                  AND t.resolved_at >= ${range.from} AND t.resolved_at < ${range.to}) AS tasks_resolved,
             COALESCE((SELECT AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)))::float8 FROM tasks t
                WHERE t.business_id = tm.business_id AND t.resolved_by = tm.id
                  AND t.status = 'RESOLVED'
                  AND t.resolved_at >= ${range.from} AND t.resolved_at < ${range.to}), 0) AS avg_task_resolution_sec
      FROM team_members tm
      WHERE tm.business_id = ${businessId}::uuid
        AND tm.deleted_at IS NULL
        AND tm.status = 'ACTIVE'
      ORDER BY resolved_conv DESC, tasks_resolved DESC
    `;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      assignedConversations: r.assigned,
      resolvedConversations: r.resolved_conv,
      avgFirstResponseSeconds: Math.round(r.avg_first_response_sec),
      firstResponseSampleSize: r.first_response_sample,
      avgResolutionSeconds: Math.round(r.avg_resolution_sec),
      resolutionSampleSize: r.resolution_sample,
      csatAverage: r.csat_avg !== null ? Math.round(r.csat_avg * 100) / 100 : null,
      csatResponseCount: r.csat_count,
      tasksResolved: r.tasks_resolved,
      avgTaskResolutionSeconds: Math.round(r.avg_task_resolution_sec),
    }));
  }
}
