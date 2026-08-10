import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtyHardeningModule } from '../realty-hardening/realty-hardening.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingRepository } from './billing.repository';
import { PlanGuard } from './plan.guard';

/**
 * BillingModule — pricing-tier enforcement for GoSumo Realty (business plan §9).
 *
 * Owns `business_subscriptions`: plan definitions (SOLO/TEAM/DEVELOPER), monthly
 * lead + seat limits, cycle rollover, overage billing, and upgrades. Registers
 * the {@link PlanGuard} globally — it self-gates to routes decorated with
 * `@PlanLimit()`, so the rest of the platform is untouched. Counts lead usage by
 * listening to `realty.lead.created`. Reuses the append-only audit trail from the
 * hardening module for plan changes.
 */
@Module({
  imports: [RealtyHardeningModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    BillingRepository,
    PrismaService,
    { provide: APP_GUARD, useClass: PlanGuard },
  ],
  exports: [BillingService],
})
export class BillingModule {}
