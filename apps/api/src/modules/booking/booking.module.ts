import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaService } from '../../common/services/prisma.service';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { BookingRepository } from './booking.repository';
import { BookingProcessor } from './booking.processor';
import { GoogleCalendarService } from './google-calendar.service';
import { BOOKING_QUEUE } from './booking.constants';

/**
 * BookingModule — appointment scheduling, availability, recurring bookings,
 * reminders (Bull), and Google Calendar sync.
 *
 * Registers the `booking` Bull queue used for delayed reminder and
 * auto-cancel jobs (the Redis connection is configured globally in
 * app.module.ts via BullModule.forRootAsync).
 */
@Module({
  imports: [BullModule.registerQueue({ name: BOOKING_QUEUE })],
  controllers: [BookingController],
  providers: [
    BookingService,
    BookingRepository,
    BookingProcessor,
    GoogleCalendarService,
    PrismaService,
  ],
  exports: [BookingService],
})
export class BookingModule {}
