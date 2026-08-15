import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../interceptors/tenant.interceptor';

/**
 * JwtAuthGuard — wraps Passport's built-in JWT strategy guard.
 *
 * Routes decorated with @Public() are excluded from authentication.
 * All other routes require a valid Bearer token in the Authorization header.
 *
 * The JWT payload (sub, businessId, email, role) is attached to request.user
 * by Passport after successful verification.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest<TUser = unknown>(
    err: Error | null,
    user: TUser | false,
    info: { message?: string } | undefined,
  ): TUser {
    if (err ?? !user) {
      const reason = err?.message ?? info?.message ?? 'No token provided';

      /**
       * Level split, because "authentication failed" covers two populations
       * that deserve opposite treatment.
       *
       * The routine ones below are the normal token lifecycle: an access token
       * expires on a schedule and the client refreshes and retries, a
       * dashboard tab left open overnight wakes up with a dead token, and
       * every unauthenticated probe of a protected URL arrives with no header
       * at all. Logging those at `warn` made this the loudest warning in the
       * app by a wide margin, on traffic that means nothing is wrong — and a
       * warning stream that is mostly noise is one nobody reads, which is how
       * the *interesting* line below gets missed.
       *
       * What stays at `warn` is the token that was neither absent nor merely
       * expired: a bad signature, a malformed token, an unexpected algorithm.
       * Those are not produced by a well-behaved client at all, so a burst of
       * them is worth someone's attention.
       */
      if (isRoutineAuthFailure(reason)) {
        this.logger.debug(`JWT auth failed: ${reason}`);
      } else {
        this.logger.warn(`JWT auth failed: ${reason}`);
      }

      throw new UnauthorizedException(
        err?.message ?? info?.message ?? 'Invalid or missing authentication token',
      );
    }
    return user as TUser;
  }
}

/**
 * The failure reasons a correctly-behaving client produces on its own.
 *
 * Matched on the message because that is all Passport hands back — `info` is a
 * plain `{ message }` for the expiry case and there is no error class to
 * branch on. Matching is deliberately loose and lowercase: a miss costs one
 * over-loud log line, never a missed rejection, since the `UnauthorizedException`
 * below is thrown either way.
 */
function isRoutineAuthFailure(reason: string): boolean {
  const text = reason.toLowerCase();
  return (
    text.includes('no auth token') ||
    text.includes('no token provided') ||
    text.includes('jwt expired') ||
    text.includes('token expired')
  );
}

/**
 * @Public() — marks a route or controller as publicly accessible,
 * bypassing JwtAuthGuard and TenantInterceptor.
 */
export { IS_PUBLIC_KEY };
