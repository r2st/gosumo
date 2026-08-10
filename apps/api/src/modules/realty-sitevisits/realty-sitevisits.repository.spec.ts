/**
 * RealtyVisitsRepository unit tests.
 *
 * `buildWhere` is the interesting part: `from`/`to` build one shared
 * `scheduled_at` filter that must be omitted entirely when neither is present,
 * and `upcoming` layers on top of it — overriding any explicit status filter
 * with the active set and clamping the lower bound to "now" unless the caller
 * asked for something even later. Get that clamp wrong and the calendar shows
 * yesterday's visits as upcoming.
 *
 * PrismaService is mocked; assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';

import {
  RealtyVisitsRepository,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
} from './realty-sitevisits.repository';
import type { VisitListFilters } from './realty-sitevisits.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const VISIT_ID = '00000000-0000-4000-b000-000000000001';
const LEAD_ID = '00000000-0000-4000-c000-000000000001';
const PROJECT_ID = '00000000-0000-4000-d000-000000000001';
const AGENT_ID = '00000000-0000-4000-e000-000000000001';

describe('RealtyVisitsRepository', () => {
  let repository: RealtyVisitsRepository;
  let prisma: {
    realty_site_visits: Record<
      'findFirst' | 'findMany' | 'count' | 'groupBy' | 'create' | 'update',
      jest.Mock
    >;
  };

  beforeEach(async () => {
    prisma = {
      realty_site_visits: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: VISIT_ID }),
        update: jest.fn().mockResolvedValue({ id: VISIT_ID }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RealtyVisitsRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(RealtyVisitsRepository);
  });

  it('splits the status vocabulary into active and terminal with no overlap', () => {
    expect(ACTIVE_STATUSES).toEqual(['BOOKED', 'CONFIRMED', 'RESCHEDULED']);
    expect(TERMINAL_STATUSES).toEqual(['COMPLETED', 'NO_SHOW', 'CANCELLED']);
    expect(ACTIVE_STATUSES.filter((s) => TERMINAL_STATUSES.includes(s))).toEqual([]);
  });

  describe('create', () => {
    it('defaults the optional linkage columns', async () => {
      const at = new Date('2026-08-15T05:30:00Z');

      await repository.create({
        businessId: BUSINESS_ID,
        leadId: LEAD_ID,
        projectId: PROJECT_ID,
        scheduledAt: at,
        durationMinutes: 45,
        timezone: 'Asia/Kolkata',
      });

      expect(prisma.realty_site_visits.create.mock.calls[0]![0].data).toEqual({
        business_id: BUSINESS_ID,
        lead_id: LEAD_ID,
        project_id: PROJECT_ID,
        unit_id: null,
        assigned_agent_id: null,
        scheduled_at: at,
        duration_minutes: 45,
        timezone: 'Asia/Kolkata',
        booking_id: null,
        calendar_event_id: null,
        calendar_id: null,
        metadata: {},
      });
    });

    it('carries the calendar linkage through when present', async () => {
      await repository.create({
        businessId: BUSINESS_ID,
        leadId: LEAD_ID,
        projectId: PROJECT_ID,
        unitId: 'unit_1',
        assignedAgentId: AGENT_ID,
        scheduledAt: new Date(0),
        durationMinutes: 30,
        timezone: 'Asia/Kolkata',
        bookingId: 'bk_1',
        calendarEventId: 'ev_1',
        calendarId: 'cal_1',
        metadata: { via: 'ai' },
      });

      expect(prisma.realty_site_visits.create.mock.calls[0]![0].data).toMatchObject({
        unit_id: 'unit_1',
        assigned_agent_id: AGENT_ID,
        booking_id: 'bk_1',
        calendar_event_id: 'ev_1',
        calendar_id: 'cal_1',
        metadata: { via: 'ai' },
      });
    });
  });

  it('finds by id within the business, skipping deleted rows', async () => {
    await repository.findById(BUSINESS_ID, VISIT_ID);

    expect(prisma.realty_site_visits.findFirst.mock.calls[0]![0].where).toEqual({
      id: VISIT_ID,
      business_id: BUSINESS_ID,
      deleted_at: null,
    });
  });

  describe('update', () => {
    it('writes nothing for an empty patch', async () => {
      await repository.update(BUSINESS_ID, VISIT_ID, {});

      expect(prisma.realty_site_visits.update.mock.calls[0]![0]).toEqual({
        where: { id: VISIT_ID, business_id: BUSINESS_ID },
        data: {},
      });
    });

    it('maps every field onto its column', async () => {
      const at = new Date('2026-08-16T05:30:00Z');

      await repository.update(BUSINESS_ID, VISIT_ID, {
        scheduledAt: at,
        durationMinutes: 60,
        status: 'CONFIRMED',
        assignedAgentId: AGENT_ID,
        unitId: 'unit_1',
        calendarEventId: 'ev_1',
        calendarId: 'cal_1',
        reminderState: { t24: true },
        remindersSent: 2,
        lastReminderAt: at,
        feedback: 'liked the view',
        outcome: 'INTERESTED',
        rescheduledFrom: at,
        cancellationReason: null,
        metadata: { k: 'v' },
      });

      expect(prisma.realty_site_visits.update.mock.calls[0]![0].data).toEqual({
        scheduled_at: at,
        duration_minutes: 60,
        status: 'CONFIRMED',
        assigned_agent_id: AGENT_ID,
        unit_id: 'unit_1',
        calendar_event_id: 'ev_1',
        calendar_id: 'cal_1',
        reminder_state: { t24: true },
        reminders_sent: 2,
        last_reminder_at: at,
        feedback: 'liked the view',
        outcome: 'INTERESTED',
        rescheduled_from: at,
        cancellation_reason: null,
        metadata: { k: 'v' },
      });
    });

    it('passes an atomic reminder increment straight through', async () => {
      // Reminders are bumped concurrently by the scheduler; a read-modify-write
      // would lose one.
      await repository.update(BUSINESS_ID, VISIT_ID, { remindersSent: { increment: 1 } });

      expect(prisma.realty_site_visits.update.mock.calls[0]![0].data).toEqual({
        reminders_sent: { increment: 1 },
      });
    });

    it('writes a zero reminder count rather than skipping it', async () => {
      await repository.update(BUSINESS_ID, VISIT_ID, { remindersSent: 0 });

      expect(prisma.realty_site_visits.update.mock.calls[0]![0].data).toEqual({
        reminders_sent: 0,
      });
    });
  });

  it('soft-deletes within the business scope', async () => {
    await repository.softDelete(BUSINESS_ID, VISIT_ID);

    expect(prisma.realty_site_visits.update.mock.calls[0]![0]).toEqual({
      where: { id: VISIT_ID, business_id: BUSINESS_ID },
      data: { deleted_at: expect.any(Date) },
    });
  });

  describe('list filters', () => {
    async function whereFor(filters: VisitListFilters) {
      await repository.list(BUSINESS_ID, filters);
      return prisma.realty_site_visits.findMany.mock.calls[0]![0].where;
    }

    it('omits scheduled_at entirely when no window is given', async () => {
      const where = await whereFor({});

      expect(where).toEqual({ business_id: BUSINESS_ID, deleted_at: null });
    });

    it('defaults to page 1 / limit 20, ordered by schedule', async () => {
      prisma.realty_site_visits.count.mockResolvedValue(25);

      const result = await repository.list(BUSINESS_ID, {});

      expect(prisma.realty_site_visits.findMany.mock.calls[0]![0]).toMatchObject({
        orderBy: [{ scheduled_at: 'asc' }],
        skip: 0,
        take: 20,
      });
      expect(result).toMatchObject({ page: 1, limit: 20, total: 25, totalPages: 2 });
    });

    it('turns page/limit into a skip', async () => {
      await repository.list(BUSINESS_ID, { page: 2, limit: 10 });

      expect(prisma.realty_site_visits.findMany.mock.calls[0]![0]).toMatchObject({
        skip: 10,
        take: 10,
      });
    });

    it('applies the simple filters', async () => {
      expect(
        await whereFor({ status: 'COMPLETED', leadId: LEAD_ID, assignedAgentId: AGENT_ID }),
      ).toMatchObject({
        status: 'COMPLETED',
        lead_id: LEAD_ID,
        assigned_agent_id: AGENT_ID,
      });
    });

    it('builds a two-sided schedule window', async () => {
      const from = new Date('2026-08-01T00:00:00Z');
      const to = new Date('2026-08-31T00:00:00Z');

      expect((await whereFor({ from, to })).scheduled_at).toEqual({ gte: from, lte: to });
    });

    it('builds a one-sided window from either end', async () => {
      const from = new Date('2026-08-01T00:00:00Z');
      expect((await whereFor({ from })).scheduled_at).toEqual({ gte: from });

      prisma.realty_site_visits.findMany.mockClear();
      const to = new Date('2026-08-31T00:00:00Z');
      expect((await whereFor({ to })).scheduled_at).toEqual({ lte: to });
    });

    it('clamps `upcoming` to now and narrows to the active statuses', async () => {
      const before = Date.now();

      const where = await whereFor({ upcoming: true });

      expect(where.status).toEqual({ in: ACTIVE_STATUSES });
      expect((where.scheduled_at.gte as Date).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('keeps a future `from` bound instead of resetting it to now', async () => {
      const from = new Date(Date.now() + 7 * 24 * 3600 * 1000);

      expect((await whereFor({ upcoming: true, from })).scheduled_at.gte).toBe(from);
    });

    it('ignores a past `from` bound when upcoming is set', async () => {
      const from = new Date('2020-01-01T00:00:00Z');

      const where = await whereFor({ upcoming: true, from });

      expect(where.scheduled_at.gte).not.toBe(from);
      expect((where.scheduled_at.gte as Date).getTime()).toBeGreaterThan(from.getTime());
    });

    it('lets `upcoming` override an explicit terminal status filter', async () => {
      // Asking for upcoming CANCELLED visits is contradictory; the active set wins.
      expect((await whereFor({ upcoming: true, status: 'CANCELLED' })).status).toEqual({
        in: ACTIVE_STATUSES,
      });
    });

    it('counts with the same where as the page query', async () => {
      await repository.list(BUSINESS_ID, { upcoming: true });

      expect(prisma.realty_site_visits.count.mock.calls[0]![0].where).toEqual(
        prisma.realty_site_visits.findMany.mock.calls[0]![0].where,
      );
    });
  });

  describe('statusCounts', () => {
    it('flattens the grouping into a status → count map', async () => {
      prisma.realty_site_visits.groupBy.mockResolvedValue([
        { status: 'COMPLETED', _count: { _all: 8 } },
        { status: 'NO_SHOW', _count: { _all: 2 } },
      ]);

      await expect(repository.statusCounts(BUSINESS_ID)).resolves.toEqual({
        COMPLETED: 8,
        NO_SHOW: 2,
      });
    });

    it('returns an empty map when there are no visits', async () => {
      await expect(repository.statusCounts(BUSINESS_ID)).resolves.toEqual({});
    });
  });

  it('lists a calendar range inclusive of both ends', async () => {
    const from = new Date('2026-08-01T00:00:00Z');
    const to = new Date('2026-08-07T00:00:00Z');

    await repository.listInRange(BUSINESS_ID, from, to);

    expect(prisma.realty_site_visits.findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        business_id: BUSINESS_ID,
        deleted_at: null,
        scheduled_at: { gte: from, lte: to },
      },
      orderBy: [{ scheduled_at: 'asc' }],
    });
  });
});
