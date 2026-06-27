import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

/**
 * @TenantId() — extracts the businessId set by TenantIsolationMiddleware from
 * the request context. Falls back to `request.user.businessId` for routes that
 * are exempt from the middleware (e.g. auth/*) but still require tenant scope.
 *
 * Usage:
 *   async findAll(@TenantId() tenantId: string) { ... }
 */
export const TenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<
      Request & { tenantId?: string; user?: { businessId?: string } }
    >();

    const tenantId =
      request.tenantId ??
      request.user?.businessId;

    if (!tenantId) {
      throw new UnauthorizedException('Tenant context is missing from request');
    }

    return tenantId;
  },
);
