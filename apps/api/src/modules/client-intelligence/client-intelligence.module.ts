import { Module } from '@nestjs/common';
import { ClientIntelligenceController } from './client-intelligence.controller';
import { ClientIntelligenceService } from './client-intelligence.service';
import { ClientIntelligenceRepository } from './client-intelligence.repository';

@Module({
  controllers: [ClientIntelligenceController],
  providers: [ClientIntelligenceService, ClientIntelligenceRepository],
  exports: [ClientIntelligenceService],
})
export class ClientIntelligenceModule {}
