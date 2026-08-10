import { Module } from '@nestjs/common';
import { AgentPerformanceController } from './agent-performance.controller';
import { AgentPerformanceService } from './agent-performance.service';
import { AgentPerformanceRepository } from './agent-performance.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { SlaModule } from '../sla/sla.module';

/**
 * AgentPerformanceModule — read-only per-agent productivity metrics.
 * Depends on SlaModule for SLA compliance data (synchronous read via
 * SlaService, never a direct read of `sla_breaches`).
 */
@Module({
  imports: [SlaModule],
  controllers: [AgentPerformanceController],
  providers: [AgentPerformanceService, AgentPerformanceRepository, PrismaService],
  exports: [AgentPerformanceService],
})
export class AgentPerformanceModule {}
