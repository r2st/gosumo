import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtyCadenceController } from './realty-cadence.controller';
import { RealtyCadenceService } from './realty-cadence.service';
import { CadenceEngineService } from './cadence-engine.service';
import { RealtyCadenceRepository } from './realty-cadence.repository';
import { RealtyLeadsModule } from '../realty-leads/realty-leads.module';

/**
 * RealtyCadenceModule (Phase 5) — the declarative follow-up engine, WhatsApp
 * template registry, and compliance gate. Depends on RealtyLeadsModule for lead
 * state (opt-out, stage, activity) used by enrolment and the compliance gate.
 */
@Module({
  imports: [RealtyLeadsModule],
  controllers: [RealtyCadenceController],
  providers: [RealtyCadenceService, CadenceEngineService, RealtyCadenceRepository, PrismaService],
  exports: [RealtyCadenceService, CadenceEngineService],
})
export class RealtyCadenceModule {}
