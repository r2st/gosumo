import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { TenantModule } from '../tenant/tenant.module';
import { HitlController } from './hitl.controller';
import { HitlService } from './hitl.service';
import { HitlRepository } from './hitl.repository';

@Module({
  // TenantModule provides the tenant-scoped team-member read that
  // `assignTask` uses to reject a cross-tenant assignee.
  imports: [TenantModule],
  controllers: [HitlController],
  providers: [HitlService, HitlRepository, PrismaService],
  exports: [HitlService],
})
export class HitlModule {}
