import { Module } from '@nestjs/common';
import { ClientIntelligenceService } from './client-intelligence.service';

@Module({
  controllers: [],
  providers: [ClientIntelligenceService],
  exports: [ClientIntelligenceService],
})
export class ClientIntelligenceModule {}
