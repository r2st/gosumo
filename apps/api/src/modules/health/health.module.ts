import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../../common/services/prisma.service';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * HealthModule — liveness and readiness probes.
 *
 * Imports AuthModule purely for its shared `REDIS_CLIENT`, so the readiness
 * probe checks the same connection the app actually uses rather than opening
 * a second one that could be healthy while the real one is not.
 */
@Module({
  imports: [AuthModule],
  controllers: [HealthController],
  providers: [HealthService, PrismaService],
  exports: [HealthService],
})
export class HealthModule {}
