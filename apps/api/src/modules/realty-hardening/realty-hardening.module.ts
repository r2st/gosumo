import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { BullModule } from '@nestjs/bull';
import { RealtyLeadsModule } from '../realty-leads/realty-leads.module';
import { REALTY_DLQ_QUEUE } from './realty-hardening.constants';
import { RealtyHardeningController } from './realty-hardening.controller';
import { RealtyOperationsAuditService } from './realty-operations-audit.service';
import { RealtyAuditInterceptor } from './realty-audit.interceptor';
import { RealtyRateLimiter } from './realty-rate-limiter';
import { RealtyRateLimitGuard } from './realty-rate-limit.guard';
import { RealtyDlqRepository } from './realty-dlq.repository';
import { RealtyDlqService } from './realty-dlq.service';
import { RealtyDlqProcessor } from './realty-dlq.processor';
import { RealtyHealthService } from './realty-health.service';
import { RealtyContradictionService } from './realty-contradiction.service';

/**
 * RealtyHardeningModule (GoSumo Realty — Phase 7).
 *
 * The cross-cutting hardening surface that makes the realty stack safe to run
 * unattended for 7 days on shadow traffic:
 *
 *  - **Audit** every mutating realty HTTP op to append-only `audit_logs`
 *    (global {@link RealtyAuditInterceptor}) + a reusable audit service.
 *  - **Retries + DLQ** for failed async operations ({@link RealtyDlqService} +
 *    the `realty-dlq` Bull queue + `realty_dead_letters` table).
 *  - **Rate limits** on the realty API (global {@link RealtyRateLimitGuard}).
 *  - **Contradiction checks** — full BLTC data-consistency validation.
 *  - **Readiness** — the soak gate ({@link RealtyHealthService}).
 *
 * The interceptor and guard are registered globally but self-gate to `realty/`
 * mutating routes, so the rest of the platform is untouched.
 */
@Module({
  imports: [
    RealtyLeadsModule,
    BullModule.registerQueue({ name: REALTY_DLQ_QUEUE }),
  ],
  controllers: [RealtyHardeningController],
  providers: [
    RealtyOperationsAuditService,
    RealtyRateLimiter,
    RealtyDlqRepository,
    RealtyDlqService,
    RealtyDlqProcessor,
    RealtyHealthService,
    RealtyContradictionService,
    { provide: APP_INTERCEPTOR, useClass: RealtyAuditInterceptor },
    { provide: APP_GUARD, useClass: RealtyRateLimitGuard },
  ],
  exports: [
    RealtyOperationsAuditService,
    RealtyDlqService,
    RealtyRateLimiter,
    RealtyContradictionService,
  ],
})
export class RealtyHardeningModule {}
