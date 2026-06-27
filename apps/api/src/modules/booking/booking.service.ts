import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  // TODO: implement Booking business logic
  getStatus(): Record<string, string> {
    return { module: 'Booking', status: 'ready' };
  }
}
