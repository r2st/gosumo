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
             COALESCE(cv.assigned, 0)::int                       AS assigned,
             COALESCE(cv.resolved_conv, 0)::int                  AS resolved_conv,
             COALESCE(fr.avg_first_response_sec, 0)::float8      AS avg_first_response_sec,
             COALESCE(fr.first_response_sample, 0)::int           AS first_response_sample,
             COALESCE(cv.avg_resolution_sec, 0)::float8           AS avg_resolution_sec,
             COALESCE(cv.resolution_sample, 0)::int               AS resolution_sample,
             cv.csat_avg::float8                                  AS csat_avg,
             COALESCE(cv.csat_count, 0)::int                      AS csat_count,
             COALESCE(tr.tasks_resolved, 0)::int                  AS tasks_resolved,
             COALESCE(tr.avg_task_resolution_sec, 0)::float8      AS avg_task_resolution_sec
      FROM team_members tm
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS assigned,
               COUNT(*) FILTER (
                 WHERE c.status = 'RESOLVED'
                   AND c.resolved_at >= ${range.from} AND c.resolved_at < ${range.to}
               )::int AS resolved_conv,
               AVG(EXTRACT(EPOCH FROM (c.resolved_at - c.first_message_at))) FILTER (
                 WHERE c.status = 'RESOLVED' AND c.first_message_at IS NOT NULL
                   AND c.resolved_at >= ${range.from} AND c.resolved_at < ${range.to}
               ) AS avg_resolution_sec,
               COUNT(*) FILTER (
                 WHERE c.status = 'RESOLVED' AND c.first_message_at IS NOT NULL
                   AND c.resolved_at >= ${range.from} AND c.resolved_at < ${range.to}
               )::int AS resolution_sample,
               AVG(c.csat_score) FILTER (
                 WHERE c.csat_score IS NOT NULL
                   AND c.csat_submitted_at >= ${range.from} AND c.csat_submitted_at < ${range.to}
               ) AS csat_avg,
               COUNT(*) FILTER (
                 WHERE c.csat_score IS NOT NULL
                   AND c.csat_submitted_at >= ${range.from} AND c.csat_submitted_at < ${range.to}
               )::int AS csat_count
        FROM conversations c
        WHERE c.business_id = tm.business_id AND c.assigned_to = tm.id
          AND c.deleted_at IS NULL
      ) cv ON TRUE
      LEFT JOIN LATERAL (
        SELECT AVG(EXTRACT(EPOCH FROM (m.created_at - c.first_message_at))) AS avg_first_response_sec,
               COUNT(*)::int AS first_response_sample
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.business_id = tm.business_id AND m.sender_type = 'HUMAN_AGENT'
          AND m.sender_id = tm.id AND c.assigned_to = tm.id
          AND m.created_at >= ${range.from} AND m.created_at < ${range.to}
          AND c.first_message_at IS NOT NULL
      ) fr ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS tasks_resolved,
               AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))) AS avg_task_resolution_sec
        FROM tasks t
        WHERE t.business_id = tm.business_id AND t.resolved_by = tm.id
          AND t.status = 'RESOLVED'::"TaskStatus"
          AND t.resolved_at >= ${range.from} AND t.resolved_at < ${range.to}
      ) tr ON TRUE
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
