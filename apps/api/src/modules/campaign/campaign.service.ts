import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  // TODO: implement Campaign business logic
  getStatus(): Record<string, string> {
    return { module: 'Campaign', status: 'ready' };
  }
}
