import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { BookingService } from './booking.service';
import {
  BOOKING_QUEUE,
  BOOKING_JOBS,
  ReminderJobData,
  AutoCancelJobData,
} from './booking.constants';

/**
 * BookingProcessor — consumes delayed Bull jobs scheduled by BookingService.
 *
 *  - `reminder`     fires at 24h and 1h before an appointment → emits
 *                   `booking.reminder` for the notification module.
 *  - `auto-cancel`  fires 24h after a PENDING booking is created → cancels it
 *                   if it is still unpaid.
 *
 * The processor holds no business logic; it delegates back to the service so
 * the same code paths are exercised by the unit tests.
 */
@Processor(BOOKING_QUEUE)
export class BookingProcessor {
  private readonly logger = new Logger(BookingProcessor.name);

  constructor(private readonly bookingService: BookingService) {}

  @Process(BOOKING_JOBS.REMINDER)
  async handleReminder(job: Job<ReminderJobData>): Promise<void> {
    const { businessId, bookingId, minutesBefore } = job.data;
    this.logger.debug(
      `Processing reminder job for booking ${bookingId} (${minutesBefore}m before)`,
    );
    await this.bookingService.fireReminder(businessId, bookingId, minutesBefore);
  }

  @Process(BOOKING_JOBS.AUTO_CANCEL)
  async handleAutoCancel(job: Job<AutoCancelJobData>): Promise<void> {
    const { businessId, bookingId } = job.data;
    this.logger.debug(`Processing auto-cancel job for booking ${bookingId}`);
    await this.bookingService.autoCancelIfUnpaid(businessId, bookingId);
  }
}
