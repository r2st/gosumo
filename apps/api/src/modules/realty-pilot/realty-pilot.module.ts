import { Module } from '@nestjs/common';
import { RealtyPilotController } from './realty-pilot.controller';
import { RealtyPilotRepository } from './realty-pilot.repository';
import { MigrationService } from './migration.service';
import { AutonomyService } from './autonomy.service';
import { LaunchGateService } from './launch-gate.service';
import { NoShipService } from './no-ship.service';
import { RealtyLeadsModule } from '../realty-leads/realty-leads.module';
import { RealtyInventoryModule } from '../realty-inventory/realty-inventory.module';
import { RealtyIngestionModule } from '../realty-ingestion/realty-ingestion.module';
import { RealtyVisitsModule } from '../realty-sitevisits/realty-sitevisits.module';
import { RealtyBrokerModule } from '../realty-broker/realty-broker.module';

/**
 * RealtyPilotModule (Phase 8) — pilot-firm migration + launch readiness:
 *  • MigrationService — imports leads/contacts (via ingestion) + inventory.
 *  • AutonomyService — the evidence-driven autonomy dial (writes broker settings).
 *  • NoShipService — the append-only no-ship ledger (+ AI-loop regression watch).
 *  • LaunchGateService — the §24 GO / NO-GO launch-readiness gate.
 *
 * Depends on the leads, inventory, ingestion, site-visits, and broker modules
 * for the cross-cutting reads the gate + dial need.
 */
@Module({
  imports: [
    RealtyLeadsModule,
    RealtyInventoryModule,
    RealtyIngestionModule,
    RealtyVisitsModule,
    RealtyBrokerModule,
  ],
  controllers: [RealtyPilotController],
  providers: [
    RealtyPilotRepository,
    MigrationService,
    AutonomyService,
    LaunchGateService,
    NoShipService,
  ],
  exports: [AutonomyService, LaunchGateService, NoShipService, MigrationService],
})
export class RealtyPilotModule {}
