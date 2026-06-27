import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { TenantController } from './tenant.controller';
import { BusinessController } from './business.controller';
import { TenantService } from './tenant.service';
import { TenantRepository } from './tenant.repository';
import { SubscriptionService } from './services/subscription.service';
import { UsageService } from './services/usage.service';
import { OnboardingService } from './services/onboarding.service';
import { TenantIsolationMiddleware } from './tenant-isolation.middleware';

/**
 * TenantModule
 *
 * Owns business (tenant) lifecycle, configuration, subscriptions, usage/quota
 * enforcement, onboarding, and team membership. Exports services consumed by
 * other modules (channel-adapter, ai-engine, campaign, …).
 *
 * Applies {@link TenantIsolationMiddleware} to every route as the application-
 * edge layer of GoSumo's multi-tenant isolation (above PostgreSQL RLS).
 */
@Module({
  controllers: [TenantController, BusinessController],
  providers: [
    TenantService,
    TenantRepository,
    SubscriptionService,
    UsageService,
    OnboardingService,
    PrismaService,
  ],
  exports: [
    TenantService,
    TenantRepository,
    SubscriptionService,
    UsageService,
    OnboardingService,
  ],
})
export class TenantModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantIsolationMiddleware).forRoutes('*');
  }
}
