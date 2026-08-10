import { Module } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma.service';
import { RealtyTenantService } from './realty-tenant.service';

/**
 * RealtyTenantModule — a tiny leaf that classifies a business as a GoSumo Realty
 * tenant. Kept standalone (PrismaService only) so both `AiEngineModule` (which
 * skips realty tenants in the generic pipeline) and `RealtyAiModule` (which
 * routes them into the grounded loop) can import it without a module cycle.
 */
@Module({
  providers: [RealtyTenantService, PrismaService],
  exports: [RealtyTenantService],
})
export class RealtyTenantModule {}
