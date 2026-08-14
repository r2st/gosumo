import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { AuthThrottleLimiter } from './auth-throttle.limiter';
import { AUTH_THROTTLE_BUCKET } from './auth-throttle.decorator';
import { clientIp } from '../../common/utils/client-ip.util';

/**
 * AuthThrottleGuard — enforces the `AUTH_THROTTLE_BUCKETS` ceilings on the
 * unauthenticated auth routes.
 *
 * Registered globally but entirely opt-in: with no `@AuthThrottle()` on the
 * handler or its controller it returns `true` before touching the limiter, so
 * making it global cannot change the outcome of any route that has not asked
 * for it. That mirrors how `RolesGuard` is registered a few lines away in
 * `AuthModule`.
 *
 * It must run *before* the request reaches the service layer, which is the
 * whole point — the work being rationed (a bcrypt hash, a business insert, an
 * outbound email) all happens downstream of here.
 *
 * On breach it throws 429 with `Retry-After`, matching `RealtyRateLimitGuard`
 * so clients have one shape to handle.
 */
@Injectable()
export class AuthThrottleGuard implements CanActivate {
  constructor(
    private readonly limiter: AuthThrottleLimiter,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const bucket = this.reflector.getAllAndOverride<string | undefined>(AUTH_THROTTLE_BUCKET, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!bucket) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const rule = this.limiter.ruleFor(bucket);

    // Guards run after Express has parsed the body but before ValidationPipe,
    // so the subject field is readable here and is whatever the caller sent —
    // it is a grouping key, never trusted as data.
    const rawSubject = rule?.subject
      ? (req.body as Record<string, unknown> | undefined)?.[rule.subject.field]
      : undefined;

    const decision = this.limiter.consume(bucket, {
      ip: clientIp(req),
      // Case-folded, because the only subject in use is an email address and
      // the service treats addresses case-insensitively. Keying on the raw
      // spelling would mean `Bob@acme.in` and `bob@acme.in` drew from separate
      // windows against the same account — one victim mailed a reset link as
      // often as an attacker cared to re-case the address.
      subject: typeof rawSubject === 'string' ? rawSubject.trim().toLowerCase() : null,
    });

    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader('X-RateLimit-Limit', decision.limit);
    res.setHeader('X-RateLimit-Remaining', decision.remaining);

    if (!decision.allowed) {
      const retryAfterSec = Math.ceil(decision.retryAfterMs / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          // Deliberately says nothing about *which* dimension was hit. On
          // `forgot-password` the subject window is keyed by an email address,
          // and naming it would turn the 429 into the account-existence oracle
          // the endpoint's identical-response design exists to avoid.
          message: `Too many requests — retry in ${retryAfterSec}s`,
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
