import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtyBrokerController } from './realty-broker.controller';
import { RealtyBrokerService } from './realty-broker.service';
import { RealtyBrokerRepository } from './realty-broker.repository';
import { RealtyLeadsModule } from '../realty-leads/realty-leads.module';
import { RealtyCadenceModule } from '../realty-cadence/realty-cadence.module';

/**
 * RealtyBrokerModule (Phase 6) — the broker surface: hot-lead alerts, morning
 * briefing, approval queue, takeover protocol, autonomy dial, and console
 * metrics. Depends on RealtyLeadsModule (lead/pipeline data) and
 * RealtyCadenceModule (active-cadence counts for the console).
 */
@Module({
  imports: [RealtyLeadsModule, RealtyCadenceModule],
  controllers: [RealtyBrokerController],
  providers: [RealtyBrokerService, RealtyBrokerRepository, PrismaService],
  exports: [RealtyBrokerService],
})
export class RealtyBrokerModule {}
