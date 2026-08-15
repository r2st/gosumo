import { Module } from '@nestjs/common';
import { RealtyTenantService } from './realty-tenant.service';

/**
 * RealtyTenantModule — a tiny leaf that classifies a business as a GoSumo Realty
 * tenant. Kept standalone (no dependencies of its own beyond the globally
 * provided `PrismaService`) so both `AiEngineModule` (which
 * skips realty tenants in the generic pipeline) and `RealtyAiModule` (which
 * routes them into the grounded loop) can import it without a module cycle.
 */
@Module({
  providers: [RealtyTenantService],
  exports: [RealtyTenantService],
})
export class RealtyTenantModule {}
