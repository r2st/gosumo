import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { TenantModule } from '../tenant/tenant.module';
import { RealtyLeadsController } from './realty-leads.controller';
import { RealtyLeadsService } from './realty-leads.service';
import { RealtyLeadsRepository } from './realty-leads.repository';

@Module({
  // TenantModule provides the tenant-scoped team-member read that rejects a
  // cross-tenant `assignedAgentId`.
  imports: [TenantModule],
  controllers: [RealtyLeadsController],
  providers: [RealtyLeadsService, RealtyLeadsRepository, PrismaService],
  exports: [RealtyLeadsService],
})
export class RealtyLeadsModule {}
