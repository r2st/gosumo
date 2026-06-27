import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Extracts businessId (tenantId) from the decoded JWT payload and attaches it
 * to the request object so downstream code can access it via @TenantId().
 *
 * Passport's JwtStrategy populates `request.user` before this interceptor runs.
 * For public routes decorated with @Public() the tenant extraction is skipped.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantInterceptor.name);

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request & { user?: Record<string, unknown>; tenantId?: string }>();
    const user = request.user;

    if (!user) {
      // Auth guard should have already rejected unauthenticated requests.
      // This is a safety net in case the interceptor is applied before the guard.
      throw new UnauthorizedException('No authenticated user found on request');
    }

    const businessId = user['businessId'] as string | undefined;

    if (!businessId) {
      this.logger.warn('JWT payload missing businessId — tenant context not set');
    } else {
      request.tenantId = businessId;
    }

    return next.handle();
  }
}
