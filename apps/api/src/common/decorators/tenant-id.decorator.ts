import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

/**
 * @TenantId() — extracts the businessId set by TenantInterceptor from the
 * request context.
 *
 * Usage:
 *   async findAll(@TenantId() tenantId: string) { ... }
 */
export const TenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request & { tenantId?: string }>();
    const tenantId = request.tenantId;

    if (!tenantId) {
      throw new UnauthorizedException('Tenant context is missing from request');
    }

    return tenantId;
  },
);
