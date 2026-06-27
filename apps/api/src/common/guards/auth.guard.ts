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
      this.logger.warn(
        `JWT auth failed: ${err?.message ?? info?.message ?? 'No token provided'}`,
      );
      throw new UnauthorizedException(
        err?.message ?? info?.message ?? 'Invalid or missing authentication token',
      );
    }
    return user as TUser;
  }
}

/**
 * @Public() — marks a route or controller as publicly accessible,
 * bypassing JwtAuthGuard and TenantInterceptor.
 */
export { IS_PUBLIC_KEY };
