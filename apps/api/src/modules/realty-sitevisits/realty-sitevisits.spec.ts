/**
 * RealtyVisits module unit tests.
 *
 * Coverage:
 *  1. Booking — creates a visit, advances the lead to VISIT_BOOKED, mirrors to
 *     calendar, schedules reminders, emits realty.visit.booked
 *  2. Confirm — BOOKED → CONFIRMED, event; rejects terminal visits
 *  3. Reschedule — new time (future), rescheduled_from set, reminders re-scheduled, event
 *  4. Cancel — removes calendar event, clears reminders, event; rejects completed
 *  5. Complete — feedback + outcome captured, lead → VISITED, event
 *  6. No-show — status + event; rejects completed/cancelled
 *  7. Reminders — fireReminder emits for active visits, skips terminal ones
 *  8. Multi-tenant — businessId threaded into repository calls
 *
 * Repository, EventEmitter2, RealtyLeadsService, BookingService and the Bull
 * queue are all mocked; no database or Redis is touched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bull';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { SiteVisitStatus, SiteVisitOutcome, LeadStage } from '@gosumo/shared';

import { RealtyVisitsService } from './realty-sitevisits.service';
import { RealtyVisitsRepository } from './realty-sitevisits.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { BookingService } from '../booking/booking.service';
import { TenantService } from '../tenant/tenant.service';
import { REALTY_VISITS_QUEUE } from './realty-sitevisits.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const VISIT_ID = '00000000-0000-4000-a000-000000000020';
const LEAD_ID = '00000000-0000-4000-a000-000000000010';
const PROJECT_ID = '00000000-0000-4000-a000-000000000040';

/** One day out, so reminder scheduling and future validation pass. */
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

describe('RealtyVisitsService', () => {
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
      softDelete: jest.fn(),
      list: jest.fn(),
      listInRange: jest.fn(),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined), removeJobs: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyVisitsService,
        { provide: RealtyVisitsRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: RealtyLeadsService, useValue: { advanceStage: jest.fn().mockResolvedValue(undefined) } },
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

  // ── Booking ──────────────────────────────────

  describe('bookVisit', () => {
    it('creates a visit, advances the lead, and emits realty.visit.booked', async () => {
      const visit = makeVisit();
      repository.create.mockResolvedValue(visit as never);

      const result = await service.bookVisit(BUSINESS_ID, {
        leadId: LEAD_ID,
        projectId: PROJECT_ID,
        scheduledAt: futureIso(),
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, leadId: LEAD_ID, projectId: PROJECT_ID }),
      );
      expect(leadsService.advanceStage).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        LeadStage.VISIT_BOOKED,
      );
      expect(queue.add).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.visit.booked',
        expect.objectContaining({ type: 'realty.visit.booked', visitId: VISIT_ID, leadId: LEAD_ID }),
      );
      expect(result.status).toBe('BOOKED');
    });

    it('persists calendar ids when the booking module returns an event', async () => {
      const visit = makeVisit();
      repository.create.mockResolvedValue(visit as never);
      repository.update.mockResolvedValue(
        makeVisit({ calendar_event_id: 'evt_1', calendar_id: 'primary' }) as never,
      );
      bookingService.pushRealtyVisitToCalendar.mockResolvedValue({ eventId: 'evt_1', calendarId: 'primary' });

      const result = await service.bookVisit(BUSINESS_ID, {
        leadId: LEAD_ID,
        projectId: PROJECT_ID,
        scheduledAt: futureIso(),
      });

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        VISIT_ID,
        expect.objectContaining({ calendarEventId: 'evt_1', calendarId: 'primary' }),
      );
      expect(result.calendarEventId).toBe('evt_1');
    });

    it('rejects a scheduledAt in the past', async () => {
      await expect(
        service.bookVisit(BUSINESS_ID, {
          leadId: LEAD_ID,
          projectId: PROJECT_ID,
          scheduledAt: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── Confirm ──────────────────────────────────

  describe('confirmVisit', () => {
    it('moves BOOKED → CONFIRMED and emits', async () => {
      repository.findById.mockResolvedValue(makeVisit() as never);
      repository.update.mockResolvedValue(makeVisit({ status: 'CONFIRMED' }) as never);

      const result = await service.confirmVisit(BUSINESS_ID, VISIT_ID);

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        VISIT_ID,
        expect.objectContaining({ status: SiteVisitStatus.CONFIRMED }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith('realty.visit.confirmed', expect.any(Object));
      expect(result.status).toBe('CONFIRMED');
    });

    it('rejects confirming a completed visit', async () => {
      repository.findById.mockResolvedValue(makeVisit({ status: 'COMPLETED' }) as never);
      await expect(service.confirmVisit(BUSINESS_ID, VISIT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws NotFound when the visit is missing', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.confirmVisit(BUSINESS_ID, VISIT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ── Reschedule ───────────────────────────────

  describe('rescheduleVisit', () => {
    it('sets the new time, records rescheduled_from, re-schedules reminders, emits', async () => {
      const original = makeVisit();
      repository.findById.mockResolvedValue(original as never);
      repository.update.mockResolvedValue(makeVisit({ status: 'RESCHEDULED' }) as never);

      const newTime = futureIso(72);
      await service.rescheduleVisit(BUSINESS_ID, VISIT_ID, { newScheduledAt: newTime });

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        VISIT_ID,
        expect.objectContaining({
          status: SiteVisitStatus.RESCHEDULED,
          rescheduledFrom: original.scheduled_at,
        }),
      );
      expect(queue.removeJobs).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.visit.rescheduled',
        expect.objectContaining({ newScheduledAt: newTime }),
      );
    });
  });

  // ── Cancel ───────────────────────────────────

  describe('cancelVisit', () => {
    it('removes the calendar event, clears reminders, and emits', async () => {
      repository.findById.mockResolvedValue(
        makeVisit({ calendar_event_id: 'evt_1', calendar_id: 'primary' }) as never,
      );
      repository.update.mockResolvedValue(makeVisit({ status: 'CANCELLED' }) as never);

      await service.cancelVisit(BUSINESS_ID, VISIT_ID, { reason: 'buyer busy' });

      expect(bookingService.removeRealtyVisitFromCalendar).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ calendarId: 'primary', eventId: 'evt_1' }),
      );
      expect(queue.removeJobs).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.visit.cancelled',
        expect.objectContaining({ reason: 'buyer busy' }),
      );
    });

    it('rejects cancelling a completed visit', async () => {
      repository.findById.mockResolvedValue(makeVisit({ status: 'COMPLETED' }) as never);
      await expect(
        service.cancelVisit(BUSINESS_ID, VISIT_ID, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── Complete ─────────────────────────────────

  describe('completeVisit', () => {
    it('captures feedback + outcome, advances the lead to VISITED, emits', async () => {
      repository.findById.mockResolvedValue(makeVisit({ status: 'CONFIRMED' }) as never);
      repository.update.mockResolvedValue(
        makeVisit({ status: 'COMPLETED', outcome: 'INTERESTED', feedback: 'liked 3BHK' }) as never,
      );

      const result = await service.completeVisit(BUSINESS_ID, VISIT_ID, {
        outcome: SiteVisitOutcome.INTERESTED,
        feedback: 'liked 3BHK',
      });

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        VISIT_ID,
        expect.objectContaining({ status: SiteVisitStatus.COMPLETED, outcome: SiteVisitOutcome.INTERESTED }),
      );
      expect(leadsService.advanceStage).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        LeadStage.VISITED,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.visit.completed',
        expect.objectContaining({ outcome: SiteVisitOutcome.INTERESTED }),
      );
      expect(result.outcome).toBe('INTERESTED');
    });
  });

  // ── No-show ──────────────────────────────────

  describe('markNoShow', () => {
    it('sets NO_SHOW and emits', async () => {
      repository.findById.mockResolvedValue(makeVisit({ status: 'CONFIRMED' }) as never);
      repository.update.mockResolvedValue(makeVisit({ status: 'NO_SHOW' }) as never);

      await service.markNoShow(BUSINESS_ID, VISIT_ID);

      expect(eventEmitter.emit).toHaveBeenCalledWith('realty.visit.no_show', expect.any(Object));
    });

    it('rejects a completed visit', async () => {
      repository.findById.mockResolvedValue(makeVisit({ status: 'COMPLETED' }) as never);
      await expect(service.markNoShow(BUSINESS_ID, VISIT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a repeat on an already NO_SHOW visit — no second event, no reminder churn', async () => {
      repository.findById.mockResolvedValue(makeVisit({ status: 'NO_SHOW' }) as never);
      await expect(service.markNoShow(BUSINESS_ID, VISIT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ── Reminders ────────────────────────────────

  describe('fireReminder', () => {
    it('emits realty.visit.reminder and records it for an active visit', async () => {
      repository.findById.mockResolvedValue(makeVisit({ status: 'CONFIRMED' }) as never);
      repository.update.mockResolvedValue(makeVisit() as never);

      await service.fireReminder(BUSINESS_ID, VISIT_ID, 1440);

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        VISIT_ID,
        expect.objectContaining({ remindersSent: { increment: 1 } }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.visit.reminder',
        expect.objectContaining({ minutesBefore: 1440 }),
      );
    });

    it('does nothing for a cancelled visit', async () => {
      repository.findById.mockResolvedValue(makeVisit({ status: 'CANCELLED' }) as never);
      await service.fireReminder(BUSINESS_ID, VISIT_ID, 120);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });
  });
});
