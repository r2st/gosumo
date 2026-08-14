/**
 * AgentPerformanceRepository unit tests.
 *
 * `listAgentSummaries` is one long raw statement plus a row-mapping step, and
 * the mapping was never driven with a row in it — the leaderboard could have
 * been handing the dashboard snake_case columns and nothing would have failed.
 *
 * The mapping is not a pure rename either. It rounds four averages and treats
 * CSAT specially: an agent with no ratings must come back as `null`, not `0`,
 * because a leaderboard that reads "0.00 CSAT" for an agent nobody rated is
 * actively misleading — that is the difference between "rated badly" and "not
 * rated". Postgres returns NULL for `AVG()` over no rows, so the two arrive
 * indistinguishably unless the mapping keeps them apart.
 */

import { AgentPerformanceRepository } from './agent-performance.repository';
import type { PrismaService } from '../../common/services/prisma.service';

const BIZ = '00000000-0000-4000-a000-00000000000a';
const MEMBER = '00000000-0000-4000-a000-00000000000b';
const RANGE = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') };

function prismaMock() {
  return {
    team_members: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

/** One row in the shape the raw statement projects. */
function summaryRow(over: Record<string, unknown> = {}) {
  return {
    id: MEMBER,
    name: 'Priya Sharma',
    email: 'priya@acme.in',
    role: 'AGENT',
    assigned: 7,
    resolved_conv: 12,
    avg_first_response_sec: 41.6,
    first_response_sample: 12,
    avg_resolution_sec: 903.2,
    resolution_sample: 12,
    csat_avg: 4.3333333,
    csat_count: 9,
    tasks_resolved: 4,
    avg_task_resolution_sec: 120.9,
    ...over,
  };
}

describe('AgentPerformanceRepository', () => {
  let prisma: ReturnType<typeof prismaMock>;
  let repo: AgentPerformanceRepository;

  beforeEach(() => {
    prisma = prismaMock();
    repo = new AgentPerformanceRepository(prisma as unknown as PrismaService);
  });

  describe('findActiveMember', () => {
    it('requires the tenant, and excludes soft-deleted members', async () => {
      await repo.findActiveMember(BIZ, MEMBER);

      expect(prisma.team_members.findFirst).toHaveBeenCalledWith({
        where: { id: MEMBER, business_id: BIZ, deleted_at: null },
        select: { id: true, name: true, email: true, role: true },
      });
    });

    it('returns null for a member this tenant cannot see', async () => {
      await expect(repo.findActiveMember(BIZ, MEMBER)).resolves.toBeNull();
    });
  });

  describe('listAgentSummaries', () => {
    it('maps a row onto the leaderboard DTO', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([summaryRow()]);

      const [dto] = await repo.listAgentSummaries(BIZ, RANGE);

      expect(dto).toEqual({
        id: MEMBER,
        name: 'Priya Sharma',
        email: 'priya@acme.in',
        role: 'AGENT',
        assignedConversations: 7,
        resolvedConversations: 12,
        // Seconds are rounded to whole numbers…
        avgFirstResponseSeconds: 42,
        firstResponseSampleSize: 12,
        avgResolutionSeconds: 903,
        resolutionSampleSize: 12,
        // …but CSAT keeps two decimals, since a 1–5 scale rounded to an
        // integer loses the distinction the metric exists to show.
        csatAverage: 4.33,
        csatResponseCount: 9,
        tasksResolved: 4,
        avgTaskResolutionSeconds: 121,
      });
    });

    it('keeps an unrated agent as null CSAT rather than zero', async () => {
      // Postgres AVG() over no rows is NULL. Collapsing that to 0 would rank
      // an unrated agent below every rated one.
      prisma.$queryRaw.mockResolvedValueOnce([summaryRow({ csat_avg: null, csat_count: 0 })]);

      const [dto] = await repo.listAgentSummaries(BIZ, RANGE);

      expect(dto?.csatAverage).toBeNull();
      expect(dto?.csatResponseCount).toBe(0);
    });

    it('preserves a genuine zero CSAT distinctly from no ratings', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([summaryRow({ csat_avg: 0, csat_count: 3 })]);

      const [dto] = await repo.listAgentSummaries(BIZ, RANGE);

      expect(dto?.csatAverage).toBe(0);
      expect(dto?.csatResponseCount).toBe(3);
    });

    it('maps every row, not just the first', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        summaryRow({ id: 'm-1', name: 'A' }),
        summaryRow({ id: 'm-2', name: 'B', csat_avg: null }),
      ]);

      const list = await repo.listAgentSummaries(BIZ, RANGE);

      expect(list.map((a) => a.id)).toEqual(['m-1', 'm-2']);
      expect(list[1]?.csatAverage).toBeNull();
    });

    it('returns an empty leaderboard when the tenant has no active members', async () => {
      await expect(repo.listAgentSummaries(BIZ, RANGE)).resolves.toEqual([]);
    });

    it('scopes the statement to the tenant and to active members only', async () => {
      await repo.listAgentSummaries(BIZ, RANGE);

      const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?').replace(/\s+/g, ' ');
      expect(sql).toContain('tm.business_id =');
      expect(sql).toContain('tm.deleted_at IS NULL');
      expect(sql).toContain("tm.status = 'ACTIVE'");
      // First-response time is human-agent-specific: an AI reply must never
      // count toward a person's responsiveness.
      expect(sql).toContain("m.sender_type = 'HUMAN_AGENT'");
    });

    it('binds the range rather than inlining it', async () => {
      await repo.listAgentSummaries(BIZ, RANGE);

      // The interpolated values arrive as bind parameters after the template
      // strings — not spliced into the SQL text.
      const values = prisma.$queryRaw.mock.calls[0].slice(1);
      expect(values).toContain(BIZ);
      expect(values).toContain(RANGE.from);
      expect(values).toContain(RANGE.to);
    });
  });
});
