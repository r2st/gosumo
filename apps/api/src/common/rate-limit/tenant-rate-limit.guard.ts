import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { TenantRateLimiter } from './tenant-rate-limiter.service';
import { TENANT_RATE_LIMIT_BUCKET } from './tenant-rate-limit.decorator';

interface TenantRequest extends Request {
  tenantId?: string;
  user?: { businessId?: string };
}

/**
 * TenantRateLimitGuard — enforces the `TENANT_RATE_LIMIT_BUCKETS` ceilings
 * per business.
 *
 * Registered globally but entirely opt-in: with no `@TenantRateLimit()` on the
 * handler or its controller it returns `true` before touching the limiter, so
 * adding it to the chain cannot change the outcome of any route that has not
 * asked for it. Same registration shape as `RolesGuard` and
 * `AuthThrottleGuard`.
 *
 * **Order matters.** It is registered after `JwtAuthGuard` so `request.user`
 * exists by the time it runs — global `APP_GUARD`s execute in declaration
 * order, and without the authenticated user there is no business to key on.
 * It reads `request.tenantId` first only because the realty guard established
 * that convention; on the normal path `TenantInterceptor` has not run yet
 * (interceptors run after guards) and `request.user.businessId` is the value
 * that answers.
 */
@Injectable()
export class TenantRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: TenantRateLimiter,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const bucket = this.reflector.getAllAndOverride<string | undefined>(
      TENANT_RATE_LIMIT_BUCKET,
      [context.getHandler(), context.getClass()],
    );
    if (!bucket) return true;

    const req = context.switchToHttp().getRequest<TenantRequest>();
    const businessId = req.tenantId ?? req.user?.businessId;

    // No tenant context. Either the route is `@Public()` — in which case it is
    // the auth throttle's job, not ours, and there is no business to charge —
    // or authentication is about to reject it. Charging an unauthenticated
    // request would mean every such request shared one window, which is a
    // lockout an anonymous caller could inflict on a real tenant.
    if (!businessId) return true;

    const decision = this.limiter.consume(businessId, bucket);
    const res = context.switchToHttp().getResponse<Response>();

    if (decision.unknownBucket) {
      // The route asked for a ceiling that does not exist, so it has none.
      // Admitted (see `TenantRateLimiter.consume`), but the headers are
      // omitted rather than filled with the zeroes of a rule that isn't there
      // — advertising `X-RateLimit-Limit: 0` would have clients back off
      // against a quota nobody is enforcing.
      return true;
    }

    res.setHeader('X-RateLimit-Limit', decision.limit);
    res.setHeader('X-RateLimit-Remaining', decision.remaining);
    // Seconds, matching `Retry-After`'s unit, so a client does not have to
    // handle two time bases in the same response.
    res.setHeader('X-RateLimit-Reset', Math.ceil(decision.resetAt / 1000));

    if (!decision.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      res.setHeader('Retry-After', retryAfterSec);
      const rule = this.limiter.ruleFor(bucket);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          // Names the resource class, never the tenant, the bucket key, or
          // anyone else's usage. The caller needs to know which of their own
          // behaviours to slow down; that is the whole disclosure budget here.
          message:
            `Rate limit exceeded for ${rule?.description ?? 'this operation'} — ` +
            `retry in ${retryAfterSec}s`,
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
