import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  // TODO: implement Order business logic
  getStatus(): Record<string, string> {
    return { module: 'Order', status: 'ready' };
  }
}
