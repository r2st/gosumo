import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtyVisitsController } from './realty-sitevisits.controller';
import { RealtyVisitsService } from './realty-sitevisits.service';
import { RealtyVisitsRepository } from './realty-sitevisits.repository';
import { RealtyVisitsProcessor } from './realty-sitevisits.processor';
import { RealtyLeadsModule } from '../realty-leads/realty-leads.module';
import { BookingModule } from '../booking/booking.module';
import { RealtyHardeningModule } from '../realty-hardening/realty-hardening.module';
import { REALTY_VISITS_QUEUE } from './realty-sitevisits.constants';

/**
 * RealtyVisitsModule (GoSumo Realty, Phase 3) — property site-visit scheduling.
 *
 * Sits on top of the `booking` module for Google Calendar OAuth sync and drives
 * the lead pipeline via `realty-leads`. Registers the `realty-visits` Bull queue
 * for the T-24h / T-2h reminder cadence (Redis connection is configured globally
 * in app.module.ts via BullModule.forRootAsync).
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: REALTY_VISITS_QUEUE }),
    RealtyLeadsModule,
    BookingModule,
    RealtyHardeningModule,
  ],
  controllers: [RealtyVisitsController],
  providers: [
    RealtyVisitsService,
    RealtyVisitsRepository,
    RealtyVisitsProcessor,
    PrismaService,
  ],
  exports: [RealtyVisitsService],
})
export class RealtyVisitsModule {}
