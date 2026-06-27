import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  // TODO: implement Admin business logic
  getStatus(): Record<string, string> {
    return { module: 'Admin', status: 'ready' };
  }
}
