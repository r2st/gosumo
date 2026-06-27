import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';

@Module({
  controllers: [],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
