import { Test, TestingModule } from '@nestjs/testing';
import { SiteVisitOutcome, SiteVisitStatus } from '@gosumo/shared';
import { RealtyVisitsController } from './realty-sitevisits.controller';
import { RealtyVisitsService } from './realty-sitevisits.service';

/**
 * Controller-level tests for the site-visit REST surface.
 *
 * The controller is a thin pass-through, so what matters here is that the
 * tenant id comes from @TenantId() (never the body) and that every route
 * forwards exactly the arguments the service expects.
 */

const TENANT_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-a000-0000000000ff';
const VISIT_ID = '00000000-0000-4000-a000-000000000020';
const LEAD_ID = '00000000-0000-4000-a000-000000000010';
const PROJECT_ID = '00000000-0000-4000-a000-000000000040';

describe('RealtyVisitsController', () => {
  let controller: RealtyVisitsController;
  let service: jest.Mocked<RealtyVisitsService>;

  beforeEach(async () => {
    const mockService: Partial<Record<keyof RealtyVisitsService, jest.Mock>> = {
      bookVisit: jest.fn().mockResolvedValue({ id: VISIT_ID }),
      listVisits: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
      getCalendar: jest.fn().mockResolvedValue([]),
      getVisit: jest.fn().mockResolvedValue({ id: VISIT_ID }),
      confirmVisit: jest.fn().mockResolvedValue({ id: VISIT_ID, status: 'CONFIRMED' }),
      rescheduleVisit: jest.fn().mockResolvedValue({ id: VISIT_ID, status: 'RESCHEDULED' }),
      cancelVisit: jest.fn().mockResolvedValue({ id: VISIT_ID, status: 'CANCELLED' }),
      completeVisit: jest.fn().mockResolvedValue({ id: VISIT_ID, status: 'COMPLETED' }),
      markNoShow: jest.fn().mockResolvedValue({ id: VISIT_ID, status: 'NO_SHOW' }),
      deleteVisit: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RealtyVisitsController],
      providers: [{ provide: RealtyVisitsService, useValue: mockService }],
    }).compile();

    controller = module.get(RealtyVisitsController);
    service = module.get(RealtyVisitsService);
  });

  it('books a visit under the caller tenant', async () => {
    const dto = {
      leadId: LEAD_ID,
      projectId: PROJECT_ID,
      scheduledAt: '2026-09-01T05:30:00.000Z',
    };

    const result = await controller.book(TENANT_ID, dto);

    expect(service.bookVisit).toHaveBeenCalledWith(TENANT_ID, dto);
    expect(result).toEqual({ id: VISIT_ID });
  });

  it('never lets a body-supplied businessId override the tenant', async () => {
    const dto = {
      leadId: LEAD_ID,
      projectId: PROJECT_ID,
      scheduledAt: '2026-09-01T05:30:00.000Z',
      // A hostile client trying to write into another tenant.
      businessId: OTHER_TENANT,
    } as never;

    await controller.book(TENANT_ID, dto);

    expect(service.bookVisit).toHaveBeenCalledWith(TENANT_ID, dto);
    expect(service.bookVisit.mock.calls[0]?.[0]).toBe(TENANT_ID);
  });

  it('lists visits with the query forwarded intact', async () => {
    const query = { status: SiteVisitStatus.BOOKED, page: 2, limit: 50 };

    const result = await controller.list(TENANT_ID, query);

    expect(service.listVisits).toHaveBeenCalledWith(TENANT_ID, query);
    expect(result).toMatchObject({ total: 0, page: 1 });
  });

  it('unwraps the calendar query into from/to arguments', async () => {
    await controller.calendar(TENANT_ID, {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T00:00:00.000Z',
    });

    expect(service.getCalendar).toHaveBeenCalledWith(
      TENANT_ID,
      '2026-09-01T00:00:00.000Z',
      '2026-09-30T00:00:00.000Z',
    );
  });

  it('fetches a single visit', async () => {
    await controller.get(TENANT_ID, VISIT_ID);

    expect(service.getVisit).toHaveBeenCalledWith(TENANT_ID, VISIT_ID);
  });

  it('confirms a visit', async () => {
    const result = await controller.confirm(TENANT_ID, VISIT_ID);

    expect(service.confirmVisit).toHaveBeenCalledWith(TENANT_ID, VISIT_ID);
    expect(result).toMatchObject({ status: 'CONFIRMED' });
  });

  it('reschedules a visit', async () => {
    const dto = { newScheduledAt: '2026-09-02T05:30:00.000Z', durationMinutes: 60 };

    await controller.reschedule(TENANT_ID, VISIT_ID, dto);

    expect(service.rescheduleVisit).toHaveBeenCalledWith(TENANT_ID, VISIT_ID, dto);
  });

  it('cancels a visit with a reason', async () => {
    const dto = { reason: 'Buyer travelling' };

    await controller.cancel(TENANT_ID, VISIT_ID, dto);

    expect(service.cancelVisit).toHaveBeenCalledWith(TENANT_ID, VISIT_ID, dto);
  });

  it('completes a visit with outcome and feedback', async () => {
    const dto = {
      outcome: SiteVisitOutcome.INTERESTED,
      feedback: 'Liked the 3BHK',
    };

    await controller.complete(TENANT_ID, VISIT_ID, dto);

    expect(service.completeVisit).toHaveBeenCalledWith(TENANT_ID, VISIT_ID, dto);
  });

  it('marks a no-show', async () => {
    await controller.noShow(TENANT_ID, VISIT_ID);

    expect(service.markNoShow).toHaveBeenCalledWith(TENANT_ID, VISIT_ID);
  });

  it('soft-deletes a visit and returns no body', async () => {
    const result = await controller.remove(TENANT_ID, VISIT_ID);

    expect(service.deleteVisit).toHaveBeenCalledWith(TENANT_ID, VISIT_ID);
    expect(result).toBeUndefined();
  });

  it('propagates service errors rather than swallowing them', async () => {
    service.getVisit.mockRejectedValue(new Error('boom'));

    await expect(controller.get(TENANT_ID, VISIT_ID)).rejects.toThrow('boom');
  });

  it('threads the caller tenant through every mutating route', async () => {
    await controller.confirm(TENANT_ID, VISIT_ID);
    await controller.cancel(TENANT_ID, VISIT_ID, {});
    await controller.noShow(TENANT_ID, VISIT_ID);
    await controller.remove(TENANT_ID, VISIT_ID);

    for (const spy of [
      service.confirmVisit,
      service.cancelVisit,
      service.markNoShow,
      service.deleteVisit,
    ]) {
      expect(spy.mock.calls[0]?.[0]).toBe(TENANT_ID);
    }
  });
});
