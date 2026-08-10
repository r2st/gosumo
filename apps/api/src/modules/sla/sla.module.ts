import { Module } from '@nestjs/common';
import { SlaController } from './sla.controller';
import { SlaService } from './sla.service';
import { SlaRepository } from './sla.repository';
import { PrismaService } from '../../common/services/prisma.service';

/**
 * SlaModule — configurable SLA targets, breach detection, and escalation.
 */
@Module({
  controllers: [SlaController],
  providers: [SlaService, SlaRepository, PrismaService],
  exports: [SlaService],
})
export class SlaModule {}
