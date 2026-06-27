import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { ClientIntelligenceController } from './client-intelligence.controller';
import { ClientIntelligenceService } from './client-intelligence.service';
import { ClientIntelligenceRepository } from './client-intelligence.repository';

@Module({
  controllers: [ClientIntelligenceController],
  providers: [ClientIntelligenceService, ClientIntelligenceRepository, PrismaService],
  exports: [ClientIntelligenceService],
})
export class ClientIntelligenceModule {}
