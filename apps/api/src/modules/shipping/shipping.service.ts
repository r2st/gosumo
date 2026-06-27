import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);

  // TODO: implement Shipping business logic
  getStatus(): Record<string, string> {
    return { module: 'Shipping', status: 'ready' };
  }
}
