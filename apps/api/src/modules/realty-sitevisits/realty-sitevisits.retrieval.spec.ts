import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bull';
import { NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { SiteVisitOutcome, LeadStage } from '@gosumo/shared';

import { RealtyVisitsService } from './realty-sitevisits.service';
import { RealtyVisitsRepository } from './realty-sitevisits.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { BookingService } from '../booking/booking.service';
import { TenantService } from '../tenant/tenant.service';
import { REALTY_VISITS_QUEUE } from './realty-sitevisits.constants';

/**
 * Retrieval, stats, calendar, soft-delete and degradation paths for the
 * site-visit service — the half of the surface the lifecycle spec does not
 * reach. Also pins the best-effort contracts: a calendar, queue or lead-pipeline
 * failure must never abort the visit operation that triggered it.
 */

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const VISIT_ID = '00000000-0000-4000-a000-000000000020';
const LEAD_ID = '00000000-0000-4000-a000-000000000010';
const PROJECT_ID = '00000000-0000-4000-a000-000000000040';
const AGENT_ID = '00000000-0000-4000-a000-000000000050';

function futureIso(hoursAhead = 48): string {
  return new Date(Date.now() + hoursAhead * 3_600_000).toISOString();
}

function makeVisit(overrides: Record<string, unknown> = {}) {
  return {
    id: VISIT_ID,
    business_id: BUSINESS_ID,
    lead_id: LEAD_ID,
    project_id: PROJECT_ID,
    unit_id: null,
    assigned_agent_id: null,
    scheduled_at: new Date(futureIso()),
    duration_minutes: 45,
    timezone: 'Asia/Kolkata',
    status: 'BOOKED',
    booking_id: null,
    calendar_event_id: null,
    calendar_id: null,
    reminder_state: {},
    reminders_sent: 0,
    last_reminder_at: null,
    feedback: null,
    outcome: 'PENDING',
    rescheduled_from: null,
    cancellation_reason: null,
    metadata: {},
    created_at: new Date('2026-07-01T10:00:00Z'),
    updated_at: new Date('2026-07-01T10:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

describe('RealtyVisitsService — retrieval, stats and degradation', () => {
  let service: RealtyVisitsService;
  let repository: jest.Mocked<RealtyVisitsRepository>;
  let eventEmitter: jest.Mocked<EventEmitter2>;
  let leadsService: jest.Mocked<RealtyLeadsService>;
  let bookingService: jest.Mocked<BookingService>;
  let queue: { add: jest.Mock; removeJobs: jest.Mock };

  beforeEach(async () => {
    const mockRepository: Partial<Record<keyof RealtyVisitsRepository, jest.Mock>> = {
      create: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn().mockResolvedValue(undefined),
      list: jest.fn(),
      listInRange: jest.fn(),
      statusCounts: jest.fn(),
    };
    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      removeJobs: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyVisitsService,
        { provide: RealtyVisitsRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: RealtyLeadsService,
          useValue: { advanceStage: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: BookingService,
          useValue: {
            pushRealtyVisitToCalendar: jest.fn().mockResolvedValue(null),
            removeRealtyVisitFromCalendar: jest.fn().mockResolvedValue(undefined),
          },
        },
        // Assignment guard: every assignee is a member of this tenant by
        // default, so the existing cases run unchanged.
        {
          provide: TenantService,
          useValue: { assertTeamMember: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: getQueueToken(REALTY_VISITS_QUEUE), useValue: queue },
      ],
    }).compile();

    service = module.get(RealtyVisitsService);
    repository = module.get(RealtyVisitsRepository);
    eventEmitter = module.get(EventEmitter2);
    leadsService = module.get(RealtyLeadsService);
    bookingService = module.get(BookingService);
  });

  // ── Retrieval ────────────────────────────────

  describe('getVisit', () => {
    it('maps a persisted row onto the response DTO', async () => {
      const scheduled = new Date('2026-09-01T05:30:00.000Z');
      repository.findById.mockResolvedValue(
        makeVisit({
          scheduled_at: scheduled,
          last_reminder_at: new Date('2026-08-31T05:30:00.000Z'),
          rescheduled_from: new Date('2026-08-20T05:30:00.000Z'),
          reminder_state: { '1440': true },
          reminders_sent: 1,
          feedback: 'Good site',
          cancellation_reason: null,
        }) as never,
      );

      const result = await service.getVisit(BUSINESS_ID, VISIT_ID);

      expect(repository.findById).toHaveBeenCalledWith(BUSINESS_ID, VISIT_ID);
      expect(result).toMatchObject({
        id: VISIT_ID,
        businessId: BUSINESS_ID,
        leadId: LEAD_ID,
        projectId: PROJECT_ID,
        scheduledAt: scheduled.toISOString(),
        lastReminderAt: '2026-08-31T05:30:00.000Z',
        rescheduledFrom: '2026-08-20T05:30:00.000Z',
        reminderState: { '1440': true },
        remindersSent: 1,
        feedback: 'Good site',
      });
    });

    it('defaults a null reminder_state to an empty object', async () => {
      repository.findById.mockResolvedValue(
        makeVisit({ reminder_state: null }) as never,
      );

      const result = await service.getVisit(BUSINESS_ID, VISIT_ID);

      expect(result.reminderState).toEqual({});
    });

    it('nulls the optional timestamps when they are unset', async () => {
      repository.findById.mockResolvedValue(
        makeVisit({ last_reminder_at: null, rescheduled_from: null }) as never,
      );

      const result = await service.getVisit(BUSINESS_ID, VISIT_ID);

      expect(result.lastReminderAt).toBeNull();
      expect(result.rescheduledFrom).toBeNull();
    });

    it('throws NotFound for a visit outside the tenant', async () => {
      repository.findById.mockResolvedValue(null as never);

      await expect(service.getVisit(BUSINESS_ID, VISIT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listVisits', () => {
    it('passes every filter through and maps the page', async () => {
      repository.list.mockResolvedValue({
        data: [makeVisit()],
        total: 1,
        page: 2,
        limit: 10,
        totalPages: 1,
      } as never);

      const result = await service.listVisits(BUSINESS_ID, {
        status: 'BOOKED' as never,
        leadId: LEAD_ID,
        assignedAgentId: AGENT_ID,
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
        upcoming: true,
        page: 2,
        limit: 10,
      });

      expect(repository.list).toHaveBeenCalledWith(BUSINESS_ID, {
        status: 'BOOKED',
        leadId: LEAD_ID,
        assignedAgentId: AGENT_ID,
        from: new Date('2026-09-01T00:00:00.000Z'),
        to: new Date('2026-09-30T00:00:00.000Z'),
        upcoming: true,
        page: 2,
        limit: 10,
      });
      expect(result.data).toHaveLength(1);
      expect(result).toMatchObject({ total: 1, page: 2, limit: 10, totalPages: 1 });
    });

    it('leaves the range bounds undefined when no dates are supplied', async () => {
      repository.list.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      } as never);

      await service.listVisits(BUSINESS_ID, {});

      expect(repository.list).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ from: undefined, to: undefined }),
      );
    });
  });

  describe('getVisitStats', () => {
    it('totals every status bucket and surfaces completed vs no-show', async () => {
      repository.statusCounts.mockResolvedValue({
        BOOKED: 4,
        CONFIRMED: 2,
        COMPLETED: 7,
        NO_SHOW: 3,
      } as never);

      const stats = await service.getVisitStats(BUSINESS_ID);

      expect(stats).toEqual({ total: 16, completed: 7, noShow: 3 });
      expect(repository.statusCounts).toHaveBeenCalledWith(BUSINESS_ID);
    });

    it('reports zeroes when the tenant has no visits', async () => {
      repository.statusCounts.mockResolvedValue({} as never);

      expect(await service.getVisitStats(BUSINESS_ID)).toEqual({
        total: 0,
        completed: 0,
        noShow: 0,
      });
    });

    it('treats absent COMPLETED / NO_SHOW buckets as zero, not undefined', async () => {
      repository.statusCounts.mockResolvedValue({ BOOKED: 5 } as never);

      expect(await service.getVisitStats(BUSINESS_ID)).toEqual({
        total: 5,
        completed: 0,
        noShow: 0,
      });
    });
  });

  describe('getCalendar', () => {
    it('returns the mapped visits inside the range', async () => {
      repository.listInRange.mockResolvedValue([makeVisit()] as never);

      const result = await service.getCalendar(
        BUSINESS_ID,
        '2026-09-01T00:00:00.000Z',
        '2026-09-30T00:00:00.000Z',
      );

      expect(repository.listInRange).toHaveBeenCalledWith(
        BUSINESS_ID,
        new Date('2026-09-01T00:00:00.000Z'),
        new Date('2026-09-30T00:00:00.000Z'),
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe(VISIT_ID);
    });

    it('rejects an inverted range', async () => {
      await expect(
        service.getCalendar(
          BUSINESS_ID,
          '2026-09-30T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z',
        ),
      ).rejects.toThrow('`to` must be after `from`');
      expect(repository.listInRange).not.toHaveBeenCalled();
    });

    it('rejects a zero-width range', async () => {
      const same = '2026-09-01T00:00:00.000Z';

      await expect(service.getCalendar(BUSINESS_ID, same, same)).rejects.toThrow(
        BadRequestException,
      );
    });

    /**
     * `from`/`to` are caller-supplied and were passed straight through, so an
     * epoch-to-far-future range read the tenant's entire visit history into
     * memory and mapped every row to a DTO. The span cap is what stops one
     * query string from becoming an unbounded response.
     */
    it('refuses a range wider than the calendar cap without touching the database', async () => {
      await expect(
        service.getCalendar(BUSINESS_ID, '1970-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z'),
      ).rejects.toThrow(/must not exceed 366 days/);
      expect(repository.listInRange).not.toHaveBeenCalled();
    });

    it('serves a range exactly at the cap', async () => {
      // 366 days inclusive of a leap year — the widest legal calendar view.
      repository.listInRange.mockResolvedValue([makeVisit()] as never);

      await expect(
        service.getCalendar(BUSINESS_ID, '2026-01-01T00:00:00.000Z', '2027-01-02T00:00:00.000Z'),
      ).resolves.toHaveLength(1);
      expect(repository.listInRange).toHaveBeenCalled();
    });

    it('refuses a range one day past the cap', async () => {
      await expect(
        service.getCalendar(BUSINESS_ID, '2026-01-01T00:00:00.000Z', '2027-01-03T00:00:00.000Z'),
      ).rejects.toThrow(BadRequestException);
      expect(repository.listInRange).not.toHaveBeenCalled();
    });
  });

  // ── Soft delete ──────────────────────────────

  describe('deleteVisit', () => {
    it('clears pending reminders before soft-deleting', async () => {
      repository.findById.mockResolvedValue(makeVisit() as never);

      await service.deleteVisit(BUSINESS_ID, VISIT_ID);

      expect(queue.removeJobs).toHaveBeenCalledWith(`visit-reminder:${VISIT_ID}:*`);
      expect(repository.softDelete).toHaveBeenCalledWith(BUSINESS_ID, VISIT_ID);
    });

    it('refuses to delete a visit belonging to another tenant', async () => {
      repository.findById.mockResolvedValue(null as never);

      await expect(service.deleteVisit(BUSINESS_ID, VISIT_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.softDelete).not.toHaveBeenCalled();
    });
  });

  // ── Validation ───────────────────────────────

  describe('scheduledAt validation', () => {
    it('rejects a non-parseable date', async () => {
      await expect(
        service.bookVisit(BUSINESS_ID, {
          leadId: LEAD_ID,
          projectId: PROJECT_ID,
          scheduledAt: 'not-a-date',
        }),
      ).rejects.toThrow('Invalid ISO-8601 date for scheduledAt: not-a-date');
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects a date in the past', async () => {
      await expect(
        service.bookVisit(BUSINESS_ID, {
          leadId: LEAD_ID,
          projectId: PROJECT_ID,
          scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ).rejects.toThrow('scheduledAt must be in the future');
    });

    it('rejects a non-parseable reschedule target', async () => {
      repository.findById.mockResolvedValue(makeVisit() as never);

      await expect(
        service.rescheduleVisit(BUSINESS_ID, VISIT_ID, {
          newScheduledAt: 'garbage',
        }),
      ).rejects.toThrow('Invalid ISO-8601 date for newScheduledAt: garbage');
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  // ── Best-effort degradation ──────────────────

  describe('degradation', () => {
    it('books the visit even when the lead transition fails', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      repository.create.mockResolvedValue(makeVisit() as never);
      leadsService.advanceStage.mockRejectedValue(new Error('lead locked'));

      const result = await service.bookVisit(BUSINESS_ID, {
        leadId: LEAD_ID,
        projectId: PROJECT_ID,
        scheduledAt: futureIso(),
      });

      expect(result.id).toBe(VISIT_ID);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lead locked'));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.visit.booked',
        expect.anything(),
      );
      warn.mockRestore();
    });

    it('completes the visit even when the lead transition fails', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      repository.findById.mockResolvedValue(makeVisit() as never);
      repository.update.mockResolvedValue(
        makeVisit({ status: 'COMPLETED', outcome: 'INTERESTED' }) as never,
      );
      leadsService.advanceStage.mockRejectedValue(new Error('lead gone'));

      const result = await service.completeVisit(BUSINESS_ID, VISIT_ID, {
        outcome: SiteVisitOutcome.INTERESTED,
      });

      expect(result.status).toBe('COMPLETED');
      expect(leadsService.advanceStage).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        LeadStage.VISITED,
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lead gone'));
      warn.mockRestore();
    });

    it('books the visit even when the reminder queue is unreachable', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      repository.create.mockResolvedValue(makeVisit() as never);
      queue.removeJobs.mockRejectedValue(new Error('redis down'));

      const result = await service.bookVisit(BUSINESS_ID, {
        leadId: LEAD_ID,
        projectId: PROJECT_ID,
        scheduledAt: futureIso(),
      });

      expect(result.id).toBe(VISIT_ID);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('redis down'));
      warn.mockRestore();
    });
  });

  // ── Reminder scheduling arithmetic ───────────

  describe('scheduleReminders', () => {
    it('schedules both offsets for a visit more than 24h out', async () => {
      await service.scheduleReminders(BUSINESS_ID, VISIT_ID, new Date(futureIso(48)));

      expect(queue.add).toHaveBeenCalledTimes(2);
      const jobIds = queue.add.mock.calls.map((c) => c[2].jobId);
      expect(jobIds).toEqual([
        `visit-reminder:${VISIT_ID}:1440`,
        `visit-reminder:${VISIT_ID}:120`,
      ]);
    });

    it('skips the T-24h offset for a visit only 3h away', async () => {
      await service.scheduleReminders(BUSINESS_ID, VISIT_ID, new Date(futureIso(3)));

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add.mock.calls[0][2].jobId).toBe(
        `visit-reminder:${VISIT_ID}:120`,
      );
    });

    it('schedules nothing for a visit inside the last reminder window', async () => {
      await service.scheduleReminders(BUSINESS_ID, VISIT_ID, new Date(futureIso(1)));

      expect(queue.add).not.toHaveBeenCalled();
    });

    it('clears stale jobs first so a reschedule never double-fires', async () => {
      await service.scheduleReminders(BUSINESS_ID, VISIT_ID, new Date(futureIso(48)));

      expect(queue.removeJobs).toHaveBeenCalledWith(`visit-reminder:${VISIT_ID}:*`);
      expect(queue.removeJobs.mock.invocationCallOrder[0]).toBeLessThan(
        queue.add.mock.invocationCallOrder[0] as number,
      );
    });

    it('delays each job to its own offset before the visit', async () => {
      const scheduledAt = new Date(Date.now() + 48 * 3_600_000);

      await service.scheduleReminders(BUSINESS_ID, VISIT_ID, scheduledAt);

      const [t24, t2] = queue.add.mock.calls.map((c) => c[2].delay as number);
      // T-24h fires a full 22h before T-2h on a 48h-out visit.
      expect((t2 as number) - (t24 as number)).toBeCloseTo(22 * 3_600_000, -3);
    });
  });

  // ── fireReminder ─────────────────────────────

  describe('fireReminder', () => {
    it('records the offset in reminder_state and bumps the counter', async () => {
      repository.findById.mockResolvedValue(
        makeVisit({ reminder_state: { '1440': true } }) as never,
      );
      repository.update.mockResolvedValue(makeVisit() as never);

      await service.fireReminder(BUSINESS_ID, VISIT_ID, 120);

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        VISIT_ID,
        expect.objectContaining({
          reminderState: { '1440': true, '120': true },
          remindersSent: { increment: 1 },
          lastReminderAt: expect.any(Date),
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.visit.reminder',
        expect.objectContaining({ visitId: VISIT_ID, minutesBefore: 120 }),
      );
    });

    it('is a no-op for a visit that no longer exists', async () => {
      repository.findById.mockResolvedValue(null as never);

      await expect(
        service.fireReminder(BUSINESS_ID, VISIT_ID, 120),
      ).resolves.toBeUndefined();
      expect(repository.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'])(
      'does not fire for a %s visit',
      async (status) => {
        repository.findById.mockResolvedValue(makeVisit({ status }) as never);

        await service.fireReminder(BUSINESS_ID, VISIT_ID, 120);

        expect(repository.update).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      },
    );
  });

  // ── Calendar staff resolution ────────────────

  describe('calendar staff resolution', () => {
    it('prefers the remembered calendarStaffId on reschedule', async () => {
      repository.findById.mockResolvedValue(
        makeVisit({
          metadata: { calendarStaffId: AGENT_ID },
          assigned_agent_id: 'someone-else',
          calendar_event_id: 'evt-1',
          calendar_id: 'cal-1',
        }) as never,
      );
      repository.update.mockResolvedValue(makeVisit() as never);

      await service.rescheduleVisit(BUSINESS_ID, VISIT_ID, {
        newScheduledAt: futureIso(72),
      });

      expect(bookingService.pushRealtyVisitToCalendar).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          staffId: AGENT_ID,
          existingEventId: 'evt-1',
          existingCalendarId: 'cal-1',
        }),
      );
    });

    it('falls back to the assigned agent when no staff id was remembered', async () => {
      repository.findById.mockResolvedValue(
        makeVisit({ metadata: {}, assigned_agent_id: AGENT_ID }) as never,
      );
      repository.update.mockResolvedValue(makeVisit() as never);

      await service.rescheduleVisit(BUSINESS_ID, VISIT_ID, {
        newScheduledAt: futureIso(72),
      });

      expect(bookingService.pushRealtyVisitToCalendar).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ staffId: AGENT_ID }),
      );
    });

    it('ignores a non-string calendarStaffId and falls back', async () => {
      repository.findById.mockResolvedValue(
        makeVisit({
          metadata: { calendarStaffId: 42 },
          assigned_agent_id: AGENT_ID,
        }) as never,
      );
      repository.update.mockResolvedValue(makeVisit() as never);

      await service.rescheduleVisit(BUSINESS_ID, VISIT_ID, {
        newScheduledAt: futureIso(72),
      });

      expect(bookingService.pushRealtyVisitToCalendar).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ staffId: AGENT_ID }),
      );
    });

    it('keeps the existing calendar linkage when the push returns nothing', async () => {
      repository.findById.mockResolvedValue(
        makeVisit({ calendar_event_id: 'evt-1', calendar_id: 'cal-1' }) as never,
      );
      repository.update.mockResolvedValue(makeVisit() as never);
      bookingService.pushRealtyVisitToCalendar.mockResolvedValue(null as never);

      await service.rescheduleVisit(BUSINESS_ID, VISIT_ID, {
        newScheduledAt: futureIso(72),
      });

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        VISIT_ID,
        expect.objectContaining({
          calendarEventId: 'evt-1',
          calendarId: 'cal-1',
          reminderState: {},
        }),
      );
    });

    it('skips the calendar delete when the visit was never synced', async () => {
      repository.findById.mockResolvedValue(
        makeVisit({ calendar_event_id: null, calendar_id: null }) as never,
      );
      repository.update.mockResolvedValue(
        makeVisit({ status: 'CANCELLED' }) as never,
      );

      await service.cancelVisit(BUSINESS_ID, VISIT_ID, { reason: 'no longer needed' });

      expect(bookingService.removeRealtyVisitFromCalendar).not.toHaveBeenCalled();
    });
  });

  // ── Terminal-state guards ────────────────────

  describe('terminal-state guards', () => {
    it('refuses to cancel an already-cancelled visit', async () => {
      repository.findById.mockResolvedValue(
        makeVisit({ status: 'CANCELLED' }) as never,
      );

      await expect(
        service.cancelVisit(BUSINESS_ID, VISIT_ID, {}),
      ).rejects.toThrow('Visit is already cancelled');
    });

    it('refuses to cancel a completed visit', async () => {
      repository.findById.mockResolvedValue(
        makeVisit({ status: 'COMPLETED' }) as never,
      );

      await expect(
        service.cancelVisit(BUSINESS_ID, VISIT_ID, {}),
      ).rejects.toThrow('Cannot cancel a completed visit');
    });

    it('refuses to complete a cancelled visit', async () => {
      repository.findById.mockResolvedValue(
        makeVisit({ status: 'CANCELLED' }) as never,
      );

      await expect(
        service.completeVisit(BUSINESS_ID, VISIT_ID, {
          outcome: SiteVisitOutcome.INTERESTED,
        }),
      ).rejects.toThrow('Cannot complete a cancelled visit');
      expect(repository.update).not.toHaveBeenCalled();
    });

    it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'])(
      'refuses to confirm a %s visit',
      async (status) => {
        repository.findById.mockResolvedValue(makeVisit({ status }) as never);

        await expect(service.confirmVisit(BUSINESS_ID, VISIT_ID)).rejects.toThrow(
          `Cannot confirm a ${status} visit`,
        );
      },
    );

    it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'])(
      'refuses to mark a %s visit as a no-show',
      async (status) => {
        repository.findById.mockResolvedValue(makeVisit({ status }) as never);

        await expect(service.markNoShow(BUSINESS_ID, VISIT_ID)).rejects.toThrow(
          `Cannot mark a ${status} visit as no-show`,
        );
      },
    );
  });
});
