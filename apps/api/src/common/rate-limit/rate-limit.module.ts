import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TenantRateLimiter } from './tenant-rate-limiter.service';
import { TenantRateLimitGuard } from './tenant-rate-limit.guard';

/**
 * RateLimitModule — the per-tenant ceilings for the authenticated API.
 *
 * Must be imported **after** `AuthModule` in `app.module.ts`: global
 * `APP_GUARD`s run in declaration order, and this guard needs the
 * authenticated user `JwtAuthGuard` attaches in order to know which business
 * to charge. Imported before it, every request would look unauthenticated and
 * the guard would wave all of them through — a failure with no symptom.
 *
 * `@Global()` so the single limiter instance is injectable anywhere (the
 * readiness probe reads its pressure counters) without every module importing
 * this one. The instance is the state: a second copy would be a second set of
 * windows, and two half-sized quotas.
 */
@Global()
@Module({
  providers: [
    TenantRateLimiter,
    {
      provide: APP_GUARD,
      useClass: TenantRateLimitGuard,
    },
  ],
  exports: [TenantRateLimiter],
})
export class RateLimitModule {}
