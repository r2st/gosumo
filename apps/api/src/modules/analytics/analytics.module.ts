import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsRepository } from './analytics.repository';
import { analyticsCacheProvider } from './analytics.cache';
import { PrismaService } from '../../common/services/prisma.service';
import { LlmClientService } from '../ai-engine/pipeline/llm-client.service';

/**
 * AnalyticsModule
 *
 * Read-only reporting module. Aggregates operational data from across the
 * platform (conversations, AI decisions, orders, bookings, clients, team)
 * into chart-ready, tenant-scoped dashboard metrics.
 *
 * Wiring:
 *  - AnalyticsController      — /analytics/* REST endpoints
 *  - AnalyticsService         — orchestration, range validation, KPIs, caching
 *  - AnalyticsRepository      — all read-only Prisma queries (businessId-scoped)
 *  - ANALYTICS_CACHE provider — Redis-backed dashboard summary cache (5m TTL)
 *
 * The module emits no events and never writes — by design.
 */
@Module({
  imports: [ConfigModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    AnalyticsRepository,
    PrismaService,
    analyticsCacheProvider,
    LlmClientService,
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
