import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { RealtyRateLimiter } from './realty-rate-limiter';
import { AUDITED_METHODS } from './realty-hardening.constants';
import { REALTY_RATE_LIMIT_BUCKET } from './realty-rate-limit.decorator';

interface TenantRequest extends Request {
  tenantId?: string;
  user?: { businessId?: string };
}

/**
 * RealtyRateLimitGuard — enforces per-(business, bucket) fixed-window limits on
 * the realty REST surface (Phase 7). Registered globally, it only engages for
 * mutating requests (`POST/PUT/PATCH/DELETE`) to a `realty/` path; reads and all
 * non-realty routes pass through untouched.
 *
 * On breach it throws HTTP 429 with a `Retry-After` header (seconds), so a
 * runaway AI loop or import burst degrades gracefully instead of overloading the
 * DB / LLM. The bucket comes from `@RealtyRateLimit()` (else the default rule).
 */
@Injectable()
export class RealtyRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RealtyRateLimiter,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<TenantRequest>();
    const method = (req.method ?? 'GET').toUpperCase();
    const path = req.path ?? req.url ?? '';

    // Only throttle mutating realty operations.
    if (!AUDITED_METHODS.has(method) || !/(^|\/)realty\//.test(path)) return true;

    const businessId = req.tenantId ?? req.user?.businessId;
    // No tenant context yet — let the auth layer reject it (401), not us.
    if (!businessId) return true;

    const bucket =
      this.reflector.getAllAndOverride<string | undefined>(REALTY_RATE_LIMIT_BUCKET, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'default';

    const decision = this.limiter.tryConsume(businessId, bucket);
    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader('X-RateLimit-Limit', decision.limit);
    res.setHeader('X-RateLimit-Remaining', decision.remaining);

    if (!decision.allowed) {
      const retryAfterSec = Math.ceil(decision.retryAfterMs / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Realty rate limit exceeded for bucket "${bucket}" — retry in ${retryAfterSec}s`,
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
