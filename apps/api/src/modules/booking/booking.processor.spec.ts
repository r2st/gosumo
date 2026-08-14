import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { BookingProcessor } from './booking.processor';
import { BookingService } from './booking.service';
import {
  BOOKING_QUEUE,
  BOOKING_JOBS,
  ReminderJobData,
  AutoCancelJobData,
} from './booking.constants';

/**
 * The processor is pure wiring, so the tests assert two things: the Bull
 * decorators bind each handler to the queue/job name the service enqueues
 * against (a rename on either side silently strands the jobs), and each
 * handler forwards the job payload to the service unchanged.
 */
const QUEUE_METADATA = 'bull:module_queue';
const PROCESS_METADATA = 'bull:module_queue_process';

const job = <T>(data: T): Job<T> => ({ data }) as Job<T>;

describe('BookingProcessor', () => {
  let service: {
    fireReminder: jest.Mock;
    autoCancelIfUnpaid: jest.Mock;
  };
  let processor: BookingProcessor;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    service = {
      fireReminder: jest.fn().mockResolvedValue(undefined),
      autoCancelIfUnpaid: jest.fn().mockResolvedValue(undefined),
    };
    processor = new BookingProcessor(service as unknown as BookingService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('queue wiring', () => {
    it('is registered against the booking queue', () => {
      expect(Reflect.getMetadata(QUEUE_METADATA, BookingProcessor)).toEqual(
        expect.objectContaining({ name: BOOKING_QUEUE }),
      );
    });

    it('binds handleReminder to the reminder job name', () => {
      // @Process stores its metadata on the handler function itself.
      expect(
        Reflect.getMetadata(PROCESS_METADATA, BookingProcessor.prototype.handleReminder),
      ).toEqual(expect.objectContaining({ name: BOOKING_JOBS.REMINDER }));
    });

    it('binds handleAutoCancel to the auto-cancel job name', () => {
      expect(
        Reflect.getMetadata(
          PROCESS_METADATA,
          BookingProcessor.prototype.handleAutoCancel,
        ),
      ).toEqual(expect.objectContaining({ name: BOOKING_JOBS.AUTO_CANCEL }));
    });
  });

  describe('handleReminder', () => {
    const data: ReminderJobData = {
      businessId: 'biz-1',
      bookingId: 'bk-1',
      minutesBefore: 1440,
    };

    it('fires the reminder for the tenant, booking and lead time on the job', async () => {
      await processor.handleReminder(job(data));
      expect(service.fireReminder).toHaveBeenCalledWith('biz-1', 'bk-1', 1440);
    });

    it('passes the lead time through verbatim rather than defaulting it', async () => {
      await processor.handleReminder(job({ ...data, minutesBefore: 60 }));
      expect(service.fireReminder).toHaveBeenCalledWith('biz-1', 'bk-1', 60);
    });

    it('lets a service failure surface so Bull retries the job', async () => {
      service.fireReminder.mockRejectedValueOnce(new Error('channel down'));
      await expect(processor.handleReminder(job(data))).rejects.toThrow(
        'channel down',
      );
    });

    it('resolves with nothing on success', async () => {
      await expect(processor.handleReminder(job(data))).resolves.toBeUndefined();
    });
  });

  describe('handleAutoCancel', () => {
    const data: AutoCancelJobData = { businessId: 'biz-2', bookingId: 'bk-2' };

    it('asks the service to cancel the booking if it is still unpaid', async () => {
      await processor.handleAutoCancel(job(data));
      expect(service.autoCancelIfUnpaid).toHaveBeenCalledWith('biz-2', 'bk-2');
    });

    it('never scopes the cancel to a different tenant than the job', async () => {
      await processor.handleAutoCancel(job({ ...data, businessId: 'biz-3' }));
      expect(service.autoCancelIfUnpaid).toHaveBeenCalledWith('biz-3', 'bk-2');
      expect(service.fireReminder).not.toHaveBeenCalled();
    });

    it('lets a service failure surface so Bull retries the job', async () => {
      service.autoCancelIfUnpaid.mockRejectedValueOnce(new Error('db down'));
      await expect(processor.handleAutoCancel(job(data))).rejects.toThrow(
        'db down',
      );
    });
  });
});
