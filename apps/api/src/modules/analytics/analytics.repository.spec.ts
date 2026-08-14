/**
 * AnalyticsRepository unit tests.
 *
 * Everything the analytics module reports is shaped here, and the service that
 * consumes it mocks this class away — so until now none of these queries had
 * been exercised at all. Three properties are worth pinning:
 *
 *  - **Tenancy.** Every query, builder or raw, must constrain `business_id`.
 *    The raw ones bind it as a parameter rather than interpolating it, which is
 *    both the injection guard and the reason the prepared plan is reusable.
 *  - **The half-open window.** `[from, to)` — inclusive start, exclusive end —
 *    is what stops a row on the boundary being counted in two adjacent periods.
 *    A `lte` slipping in anywhere would double-count the last bucket.
 *  - **Empty-result arithmetic.** These are aggregates over a range that is
 *    frequently empty (a new tenant, a quiet week). Every `?? 0`, every
 *    `rows[0]`, and every Decimal `.toNumber()` has to survive "no rows" and
 *    return a number, not `undefined` or `NaN`, because the service divides by
 *    several of them.
 *
 * Prisma is mocked. Decimal columns are mimicked with a `toNumber()`-only
 * object, matching how Prisma resolves `Decimal` at runtime.
 */

import { ChannelType } from '@gosumo/shared';
import { AnalyticsRepository } from './analytics.repository';
import { Granularity } from './dto';
import type { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

const RANGE = {
  from: new Date('2026-08-01T00:00:00.000Z'),
  to: new Date('2026-08-08T00:00:00.000Z'),
};

/** Prisma resolves Decimal columns to an object with `.toNumber()`. */
const decimal = (value: number) => ({ toNumber: () => value });

const count = (n: number) => ({ _count: { _all: n } });

interface Model {
  count: jest.Mock;
  groupBy: jest.Mock;
  aggregate: jest.Mock;
}

function model(): Model {
  return {
    count: jest.fn().mockResolvedValue(0),
    groupBy: jest.fn().mockResolvedValue([]),
    aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: {}, _avg: {} }),
  };
}

interface PrismaMock {
  conversations: Model;
  ai_decisions: Model;
  orders: Model;
  refunds: Model;
  clients: Model;
  bookings: Model;
  tasks: Model;
  $queryRaw: jest.Mock;
}

describe('AnalyticsRepository', () => {
  let prisma: PrismaMock;
  let repository: AnalyticsRepository;

  /** The bound parameters of the nth `$queryRaw` call (the tag's `...values`). */
  const rawParams = (call = 0) => prisma.$queryRaw.mock.calls[call]?.slice(1);
  /** The SQL text of the nth `$queryRaw` call, with `?` at each binding site. */
  const rawSql = (call = 0) => (prisma.$queryRaw.mock.calls[call]?.[0] as string[]).join('?');

  beforeEach(() => {
    prisma = {
      conversations: model(),
      ai_decisions: model(),
      orders: model(),
      refunds: model(),
      clients: model(),
      bookings: model(),
      tasks: model(),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    repository = new AnalyticsRepository(prisma as unknown as PrismaService);
  });

  // ── Conversations ─────────────────────────────────────────────────────────

  describe('getConversationCounts', () => {
    it('spreads the grouped rows across the named statuses and totals them', async () => {
      prisma.conversations.groupBy.mockResolvedValue([
        { status: 'RESOLVED', ...count(40) },
        { status: 'OPEN', ...count(6) },
        { status: 'PENDING_HUMAN', ...count(3) },
        { status: 'ESCALATED', ...count(2) },
        { status: 'SNOOZED', ...count(1) },
      ]);
      prisma.conversations.count.mockResolvedValueOnce(34).mockResolvedValueOnce(6);

      await expect(repository.getConversationCounts(BUSINESS_ID, RANGE)).resolves.toEqual({
        total: 52,
        resolved: 40,
        open: 6,
        pendingHuman: 3,
        escalated: 2,
        snoozed: 1,
        aiResolved: 34,
        humanResolved: 6,
      });
    });

    it('reports zero for a status the group-by never returned', async () => {
      prisma.conversations.groupBy.mockResolvedValue([{ status: 'OPEN', ...count(2) }]);

      const counts = await repository.getConversationCounts(BUSINESS_ID, RANGE);

      // A status with no rows must read as 0, not undefined — the service
      // divides by these.
      expect(counts.resolved).toBe(0);
      expect(counts.snoozed).toBe(0);
      expect(counts.total).toBe(2);
    });

    it('scopes the tenant, skips soft-deleted rows and uses a half-open window', async () => {
      await repository.getConversationCounts(BUSINESS_ID, RANGE);

      expect(prisma.conversations.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: {
          business_id: BUSINESS_ID,
          deleted_at: null,
          created_at: { gte: RANGE.from, lt: RANGE.to },
        },
        _count: { _all: true },
      });
    });

    it('splits AI from human resolution on the human message counter', async () => {
      await repository.getConversationCounts(BUSINESS_ID, RANGE);

      const [aiCall, humanCall] = prisma.conversations.count.mock.calls;
      // A conversation resolved with zero human messages is the AI's.
      expect(aiCall[0].where).toMatchObject({
        status: 'RESOLVED',
        human_message_count: { lte: 0 },
      });
      expect(humanCall[0].where).toMatchObject({
        status: 'RESOLVED',
        human_message_count: { gt: 0 },
      });
    });
  });

  describe('getConversationVolumeByChannel', () => {
    it('maps the grouped rows to channel/count pairs', async () => {
      prisma.conversations.groupBy.mockResolvedValue([
        { channel: 'WHATSAPP', ...count(120) },
        { channel: 'WEB_CHAT', ...count(8) },
      ]);

      await expect(
        repository.getConversationVolumeByChannel(BUSINESS_ID, RANGE),
      ).resolves.toEqual([
        { channel: ChannelType.WHATSAPP, count: 120 },
        { channel: ChannelType.WEB_CHAT, count: 8 },
      ]);
    });

    it('returns nothing for a tenant with no conversations', async () => {
      await expect(
        repository.getConversationVolumeByChannel(BUSINESS_ID, RANGE),
      ).resolves.toEqual([]);
    });
  });

  describe('getConversationVolumeSeries', () => {
    it('returns the bucket rows the database produced', async () => {
      const bucket = new Date('2026-08-02T00:00:00.000Z');
      prisma.$queryRaw.mockResolvedValue([{ bucket, value: 12 }]);

      await expect(
        repository.getConversationVolumeSeries(BUSINESS_ID, RANGE, Granularity.DAY),
      ).resolves.toEqual([{ bucket, value: 12 }]);
    });

    it('binds the tenant and the window rather than interpolating them', async () => {
      await repository.getConversationVolumeSeries(BUSINESS_ID, RANGE, Granularity.DAY);

      expect(rawParams()).toEqual(['day', BUSINESS_ID, RANGE.from, RANGE.to]);
      expect(rawSql()).toContain('business_id =');
      expect(rawSql()).not.toContain(BUSINESS_ID);
    });

    it('passes the granularity through as a date_trunc unit', async () => {
      await repository.getConversationVolumeSeries(BUSINESS_ID, RANGE, Granularity.MONTH);

      expect(rawParams()?.[0]).toBe('month');
      expect(rawSql()).toContain('date_trunc(');
    });
  });

  describe('countOpenConversations', () => {
    it('counts the three open-ish statuses without a date filter', async () => {
      prisma.conversations.count.mockResolvedValue(9);

      await expect(repository.countOpenConversations(BUSINESS_ID)).resolves.toBe(9);
      // This is a "right now" number — range-scoping it would make the
      // dashboard's backlog tile depend on the report period.
      expect(prisma.conversations.count).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          deleted_at: null,
          status: { in: ['OPEN', 'PENDING_HUMAN', 'ESCALATED'] },
        },
      });
    });
  });

  // ── Response times ────────────────────────────────────────────────────────

  describe('getResponseTimeStats', () => {
    it('renames the raw percentile columns onto the public shape', async () => {
      prisma.$queryRaw.mockResolvedValue([{ sample: 40, avg_sec: 91.5, p50: 45, p90: 240 }]);

      await expect(repository.getResponseTimeStats(BUSINESS_ID, RANGE)).resolves.toEqual({
        avgSeconds: 91.5,
        p50Seconds: 45,
        p90Seconds: 240,
        sampleSize: 40,
      });
    });

    it('returns zeroes when the aggregate produced no row at all', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(repository.getResponseTimeStats(BUSINESS_ID, RANGE)).resolves.toEqual({
        avgSeconds: 0,
        p50Seconds: 0,
        p90Seconds: 0,
        sampleSize: 0,
      });
    });

    it('binds the tenant as a parameter', async () => {
      await repository.getResponseTimeStats(BUSINESS_ID, RANGE);

      expect(rawParams()).toEqual([BUSINESS_ID, RANGE.from, RANGE.to]);
      expect(rawSql()).not.toContain(BUSINESS_ID);
    });
  });

  describe('getResponseTimeSeries', () => {
    it('returns one average per bucket', async () => {
      const bucket = new Date('2026-08-03T00:00:00.000Z');
      prisma.$queryRaw.mockResolvedValue([{ bucket, value: 62 }]);

      await expect(
        repository.getResponseTimeSeries(BUSINESS_ID, RANGE, Granularity.WEEK),
      ).resolves.toEqual([{ bucket, value: 62 }]);
      // The CTE filters before it buckets, so the tenant and window bind
      // ahead of the date_trunc unit here.
      expect(rawParams()).toEqual([BUSINESS_ID, RANGE.from, RANGE.to, 'week']);
    });
  });

  describe('getAvgResolutionSeconds', () => {
    it('returns the database-computed average', async () => {
      prisma.$queryRaw.mockResolvedValue([{ avg_sec: 3600 }]);

      await expect(repository.getAvgResolutionSeconds(BUSINESS_ID, RANGE)).resolves.toBe(3600);
    });

    it('returns zero when nothing was resolved in the range', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(repository.getAvgResolutionSeconds(BUSINESS_ID, RANGE)).resolves.toBe(0);
    });
  });

  // ── AI decisions ──────────────────────────────────────────────────────────

  describe('getAiDecisionCounts', () => {
    it('spreads the outcomes and carries the override count separately', async () => {
      prisma.ai_decisions.groupBy.mockResolvedValue([
        { outcome: 'AUTO_EXECUTED', ...count(300) },
        { outcome: 'SENT_FOR_REVIEW', ...count(50) },
        { outcome: 'ESCALATED', ...count(20) },
        { outcome: 'OVERRIDDEN_BY_HUMAN', ...count(5) },
        { outcome: 'EXPIRED', ...count(2) },
      ]);
      prisma.ai_decisions.count.mockResolvedValue(7);

      await expect(repository.getAiDecisionCounts(BUSINESS_ID, RANGE)).resolves.toEqual({
        total: 377,
        autoExecuted: 300,
        sentForReview: 50,
        escalated: 20,
        overriddenByHuman: 5,
        expired: 2,
        // `overridden` is a flag on any decision, not an outcome — it is
        // deliberately not derived from the group-by.
        overridden: 7,
      });
    });

    it('reports zeroes for a range with no decisions', async () => {
      await expect(repository.getAiDecisionCounts(BUSINESS_ID, RANGE)).resolves.toEqual({
        total: 0,
        autoExecuted: 0,
        sentForReview: 0,
        escalated: 0,
        overriddenByHuman: 0,
        expired: 0,
        overridden: 0,
      });
    });

    it('scopes both queries to the tenant and the decision window', async () => {
      await repository.getAiDecisionCounts(BUSINESS_ID, RANGE);

      const where = { business_id: BUSINESS_ID, decided_at: { gte: RANGE.from, lt: RANGE.to } };
      expect(prisma.ai_decisions.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where }),
      );
      expect(prisma.ai_decisions.count).toHaveBeenCalledWith({
        where: { ...where, was_overridden: true },
      });
    });
  });

  describe('getAutonomySeries', () => {
    it('returns the auto and total counters per bucket', async () => {
      const bucket = new Date('2026-08-04T00:00:00.000Z');
      prisma.$queryRaw.mockResolvedValue([{ bucket, auto: 90, total: 100 }]);

      await expect(
        repository.getAutonomySeries(BUSINESS_ID, RANGE, Granularity.HOUR),
      ).resolves.toEqual([{ bucket, auto: 90, total: 100 }]);
      expect(rawParams()?.[0]).toBe('hour');
    });
  });

  describe('getConfidenceStats', () => {
    it('converts the Decimal average and passes the histogram through', async () => {
      prisma.ai_decisions.aggregate.mockResolvedValue({
        _count: { _all: 120 },
        _avg: { confidence_score: decimal(0.91) },
      });
      prisma.$queryRaw.mockResolvedValue([{ bucket: 10, count: 80 }]);

      await expect(repository.getConfidenceStats(BUSINESS_ID, RANGE)).resolves.toEqual({
        total: 120,
        averageConfidence: 0.91,
        histogram: [{ bucket: 10, count: 80 }],
      });
    });

    it('returns a zero average when there is nothing to average', async () => {
      prisma.ai_decisions.aggregate.mockResolvedValue({
        _count: { _all: 0 },
        _avg: { confidence_score: null },
      });

      const stats = await repository.getConfidenceStats(BUSINESS_ID, RANGE);

      // `null.toNumber()` would throw; the caller needs a number here.
      expect(stats.averageConfidence).toBe(0);
      expect(stats.total).toBe(0);
    });
  });

  describe('getEscalationReasons', () => {
    it('renames the raw key column to a reason', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { key: 'LOW_CONFIDENCE', count: 12 },
        { key: 'REFUND_REQUEST', count: 3 },
      ]);

      await expect(repository.getEscalationReasons(BUSINESS_ID, RANGE)).resolves.toEqual([
        { reason: 'LOW_CONFIDENCE', count: 12 },
        { reason: 'REFUND_REQUEST', count: 3 },
      ]);
    });

    it('only considers escalated decisions', async () => {
      await repository.getEscalationReasons(BUSINESS_ID, RANGE);

      expect(rawSql()).toContain("outcome = 'ESCALATED'");
      expect(rawParams()).toEqual([BUSINESS_ID, RANGE.from, RANGE.to]);
    });
  });

  // ── Revenue & orders ──────────────────────────────────────────────────────

  describe('getRevenueSummary', () => {
    it('converts both Decimal sums and carries the order count', async () => {
      prisma.orders.aggregate.mockResolvedValue({
        _sum: { total: decimal(125_000) },
        _count: { _all: 42 },
      });
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: decimal(3_500) } });

      await expect(repository.getRevenueSummary(BUSINESS_ID, RANGE)).resolves.toEqual({
        grossRevenueRupees: 125_000,
        refundsRupees: 3_500,
        orderCount: 42,
      });
    });

    it('reports zero revenue rather than null for an empty range', async () => {
      prisma.orders.aggregate.mockResolvedValue({ _sum: { total: null }, _count: { _all: 0 } });
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: null } });

      await expect(repository.getRevenueSummary(BUSINESS_ID, RANGE)).resolves.toEqual({
        grossRevenueRupees: 0,
        refundsRupees: 0,
        orderCount: 0,
      });
    });

    it('counts only the order statuses that represent captured revenue', async () => {
      await repository.getRevenueSummary(BUSINESS_ID, RANGE);

      const where = prisma.orders.aggregate.mock.calls[0][0].where;
      expect(where.status.in).toEqual([
        'CONFIRMED',
        'PROCESSING',
        'PACKED',
        'SHIPPED',
        'DELIVERED',
        'PARTIALLY_REFUNDED',
      ]);
      // DRAFT was never paid; CANCELLED/REFUNDED/RETURNED were given back.
      expect(where.status.in).not.toContain('DRAFT');
      expect(where.status.in).not.toContain('CANCELLED');
      expect(where.deleted_at).toBeNull();
    });

    it('nets only refunds that actually completed inside the range', async () => {
      await repository.getRevenueSummary(BUSINESS_ID, RANGE);

      expect(prisma.refunds.aggregate).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          status: 'COMPLETED',
          completed_at: { gte: RANGE.from, lt: RANGE.to },
        },
        _sum: { amount: true },
      });
    });
  });

  describe('getRevenueSeries', () => {
    it('returns per-bucket revenue already scaled to paise by the query', async () => {
      const bucket = new Date('2026-08-05T00:00:00.000Z');
      prisma.$queryRaw.mockResolvedValue([{ bucket, value: 12_500_000 }]);

      await expect(
        repository.getRevenueSeries(BUSINESS_ID, RANGE, Granularity.DAY),
      ).resolves.toEqual([{ bucket, value: 12_500_000 }]);
      // The ×100 lives in SQL so the series never carries rupees.
      expect(rawSql()).toContain('* 100');
    });
  });

  describe('getOrderCountSeries', () => {
    it('returns one count per bucket', async () => {
      const bucket = new Date('2026-08-06T00:00:00.000Z');
      prisma.$queryRaw.mockResolvedValue([{ bucket, value: 7 }]);

      await expect(
        repository.getOrderCountSeries(BUSINESS_ID, RANGE, Granularity.DAY),
      ).resolves.toEqual([{ bucket, value: 7 }]);
    });
  });

  describe('getTopProducts', () => {
    it('rounds the summed units and revenue to integers', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { item_id: 'item-1', name: 'Deep Clean', units: 12.0000001, revenue: 4999.6 },
      ]);

      await expect(repository.getTopProducts(BUSINESS_ID, RANGE, 5)).resolves.toEqual([
        { itemId: 'item-1', name: 'Deep Clean', unitsSold: 12, revenuePaise: 5000 },
      ]);
    });

    it('labels a line item whose snapshot lost its id or name', async () => {
      // `line_items` is a JSONB snapshot; an older order may predate a field.
      prisma.$queryRaw.mockResolvedValue([
        { item_id: null, name: null, units: 3, revenue: 300 },
      ]);

      await expect(repository.getTopProducts(BUSINESS_ID, RANGE, 5)).resolves.toEqual([
        { itemId: 'unknown', name: 'Unknown product', unitsSold: 3, revenuePaise: 300 },
      ]);
    });

    it('binds the limit rather than splicing it into the SQL', async () => {
      await repository.getTopProducts(BUSINESS_ID, RANGE, 25);

      expect(rawParams()).toEqual([BUSINESS_ID, RANGE.from, RANGE.to, 25]);
    });
  });

  // ── Clients ───────────────────────────────────────────────────────────────

  describe('countNewClients', () => {
    it('counts first-seen inside the window', async () => {
      prisma.clients.count.mockResolvedValue(11);

      await expect(repository.countNewClients(BUSINESS_ID, RANGE)).resolves.toBe(11);
      expect(prisma.clients.count).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          deleted_at: null,
          first_seen_at: { gte: RANGE.from, lt: RANGE.to },
        },
      });
    });
  });

  describe('countReturningClients', () => {
    it('requires acquisition before the window and activity inside it', async () => {
      prisma.clients.count.mockResolvedValue(4);

      await expect(repository.countReturningClients(BUSINESS_ID, RANGE)).resolves.toBe(4);
      // Without the `first_seen_at < from` half, every new client would also
      // count as returning.
      expect(prisma.clients.count).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          deleted_at: null,
          first_seen_at: { lt: RANGE.from },
          last_interaction_at: { gte: RANGE.from, lt: RANGE.to },
        },
      });
    });
  });

  describe('getAcquisitionByChannel', () => {
    it('returns the channel split the join produced', async () => {
      prisma.$queryRaw.mockResolvedValue([{ channel: 'WHATSAPP', count: 30 }]);

      await expect(repository.getAcquisitionByChannel(BUSINESS_ID, RANGE)).resolves.toEqual([
        { channel: 'WHATSAPP', count: 30 },
      ]);
      // A client on two channels must count once per channel, not twice.
      expect(rawSql()).toContain('COUNT(DISTINCT c.id)');
    });
  });

  describe('getAcquisitionSeries', () => {
    it('returns new clients per bucket', async () => {
      const bucket = new Date('2026-08-07T00:00:00.000Z');
      prisma.$queryRaw.mockResolvedValue([{ bucket, value: 5 }]);

      await expect(
        repository.getAcquisitionSeries(BUSINESS_ID, RANGE, Granularity.DAY),
      ).resolves.toEqual([{ bucket, value: 5 }]);
    });
  });

  describe('getRetentionStats', () => {
    it('measures the cohort against an equally long preceding window', async () => {
      prisma.clients.count
        .mockResolvedValueOnce(200)
        .mockResolvedValueOnce(35)
        .mockResolvedValueOnce(18);

      await expect(repository.getRetentionStats(BUSINESS_ID, RANGE)).resolves.toEqual({
        activeAtStart: 200,
        churned: 35,
        atRisk: 18,
      });

      // The range is 7 days, so the cohort reaches back to 25 July.
      const priorFrom = new Date('2026-07-25T00:00:00.000Z');
      expect(prisma.clients.count.mock.calls[0][0].where).toMatchObject({
        first_seen_at: { lt: RANGE.from },
        last_interaction_at: { gte: priorFrom, lt: RANGE.to },
      });
      // Churned = last seen in the prior window and silent ever since.
      expect(prisma.clients.count.mock.calls[1][0].where).toMatchObject({
        last_interaction_at: { gte: priorFrom, lt: RANGE.from },
      });
    });

    it('scores at-risk on the churn threshold, independent of the window', async () => {
      await repository.getRetentionStats(BUSINESS_ID, RANGE);

      // At-risk is a property of the client today, so it carries no date
      // filter — only the tenant and the risk score.
      expect(prisma.clients.count.mock.calls[2][0]).toEqual({
        where: {
          business_id: BUSINESS_ID,
          deleted_at: null,
          churn_risk: { gte: 0.61 },
        },
      });
    });
  });

  // ── Bookings ──────────────────────────────────────────────────────────────

  describe('getBookingCounts', () => {
    it('spreads the grouped statuses and totals them', async () => {
      prisma.bookings.groupBy.mockResolvedValue([
        { status: 'CONFIRMED', ...count(10) },
        { status: 'COMPLETED', ...count(25) },
        { status: 'CANCELLED', ...count(4) },
        { status: 'NO_SHOW', ...count(1) },
      ]);

      await expect(repository.getBookingCounts(BUSINESS_ID, RANGE)).resolves.toEqual({
        total: 40,
        confirmed: 10,
        completed: 25,
        cancelled: 4,
        noShow: 1,
      });
    });

    it('reports zeroes for a week with no bookings', async () => {
      await expect(repository.getBookingCounts(BUSINESS_ID, RANGE)).resolves.toEqual({
        total: 0,
        confirmed: 0,
        completed: 0,
        cancelled: 0,
        noShow: 0,
      });
    });

    it('buckets bookings by when they start, not when they were made', async () => {
      await repository.getBookingCounts(BUSINESS_ID, RANGE);

      expect(prisma.bookings.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: {
          business_id: BUSINESS_ID,
          deleted_at: null,
          start_at: { gte: RANGE.from, lt: RANGE.to },
        },
        _count: { _all: true },
      });
    });
  });

  describe('getBookingSeries', () => {
    it('returns bookings per bucket', async () => {
      const bucket = new Date('2026-08-02T00:00:00.000Z');
      prisma.$queryRaw.mockResolvedValue([{ bucket, value: 3 }]);

      await expect(
        repository.getBookingSeries(BUSINESS_ID, RANGE, Granularity.DAY),
      ).resolves.toEqual([{ bucket, value: 3 }]);
    });
  });

  // ── Team ──────────────────────────────────────────────────────────────────

  describe('getStaffMetrics', () => {
    it('renames the raw columns and rounds the mean task time', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'tm-1',
          name: 'Priya',
          role: 'MANAGER',
          assigned: 12,
          resolved_conv: 30,
          tasks_resolved: 9,
          avg_task_sec: 412.7,
        },
      ]);

      await expect(repository.getStaffMetrics(BUSINESS_ID, RANGE)).resolves.toEqual([
        {
          memberId: 'tm-1',
          name: 'Priya',
          role: 'MANAGER',
          assignedConversations: 12,
          resolvedConversations: 30,
          tasksResolved: 9,
          avgTaskResolutionSeconds: 413,
        },
      ]);
    });

    it('reports only active members and binds the tenant last', async () => {
      await repository.getStaffMetrics(BUSINESS_ID, RANGE);

      const sql = rawSql();
      expect(sql).toContain("tm.status = 'ACTIVE'");
      expect(sql).toContain('tm.deleted_at IS NULL');
      expect(sql).not.toContain(BUSINESS_ID);
      // The window is bound three times — once per correlated subquery — and
      // the tenant once.
      expect(rawParams()).toEqual([
        RANGE.from,
        RANGE.to,
        RANGE.from,
        RANGE.to,
        RANGE.from,
        RANGE.to,
        BUSINESS_ID,
      ]);
    });

    it('returns an empty roster for a business with no active members', async () => {
      await expect(repository.getStaffMetrics(BUSINESS_ID, RANGE)).resolves.toEqual([]);
    });
  });

  describe('countPendingTasks', () => {
    it('counts the queue as it stands right now', async () => {
      prisma.tasks.count.mockResolvedValue(6);

      await expect(repository.countPendingTasks(BUSINESS_ID)).resolves.toBe(6);
      expect(prisma.tasks.count).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
      });
    });
  });

  describe('countBookings', () => {
    it('counts bookings starting inside the window', async () => {
      prisma.bookings.count.mockResolvedValue(14);

      await expect(repository.countBookings(BUSINESS_ID, RANGE)).resolves.toBe(14);
      expect(prisma.bookings.count).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          deleted_at: null,
          start_at: { gte: RANGE.from, lt: RANGE.to },
        },
      });
    });
  });

  // ── Cross-cutting ─────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('constrains business_id on every raw query it issues', async () => {
      await Promise.all([
        repository.getConversationVolumeSeries(BUSINESS_ID, RANGE, Granularity.DAY),
        repository.getResponseTimeStats(BUSINESS_ID, RANGE),
        repository.getResponseTimeSeries(BUSINESS_ID, RANGE, Granularity.DAY),
        repository.getAvgResolutionSeconds(BUSINESS_ID, RANGE),
        repository.getAutonomySeries(BUSINESS_ID, RANGE, Granularity.DAY),
        repository.getEscalationReasons(BUSINESS_ID, RANGE),
        repository.getRevenueSeries(BUSINESS_ID, RANGE, Granularity.DAY),
        repository.getOrderCountSeries(BUSINESS_ID, RANGE, Granularity.DAY),
        repository.getTopProducts(BUSINESS_ID, RANGE, 5),
        repository.getAcquisitionByChannel(BUSINESS_ID, RANGE),
        repository.getAcquisitionSeries(BUSINESS_ID, RANGE, Granularity.DAY),
        repository.getBookingSeries(BUSINESS_ID, RANGE, Granularity.DAY),
        repository.getStaffMetrics(BUSINESS_ID, RANGE),
      ]);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(13);
      for (const call of prisma.$queryRaw.mock.calls) {
        const sql = (call[0] as string[]).join('?');
        expect(sql).toMatch(/business_id = \?::uuid/);
        // Bound, never interpolated — this is both the injection guard and
        // what lets Postgres reuse the prepared plan across tenants.
        expect(sql).not.toContain(BUSINESS_ID);
        expect(call.slice(1)).toContain(BUSINESS_ID);
      }
    });

    it('never writes — the module is read-only by design', async () => {
      await repository.getConversationCounts(BUSINESS_ID, RANGE);
      await repository.getRevenueSummary(BUSINESS_ID, RANGE);
      await repository.getBookingCounts(BUSINESS_ID, RANGE);

      for (const table of [prisma.conversations, prisma.orders, prisma.bookings]) {
        expect(table).not.toHaveProperty('create.mock');
        expect(table).not.toHaveProperty('update.mock');
      }
    });
  });
});
