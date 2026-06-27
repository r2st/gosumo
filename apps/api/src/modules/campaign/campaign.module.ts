import { Module } from '@nestjs/common';
import { CampaignService } from './campaign.service';

@Module({
  controllers: [],
  providers: [CampaignService],
  exports: [CampaignService],
})
export class CampaignModule {}
