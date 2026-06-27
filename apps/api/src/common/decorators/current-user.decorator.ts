import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

export interface AuthenticatedUser {
  sub: string;          // user/agent UUID
  businessId: string;   // tenant UUID
  email?: string;
  role: string;
  sessionId?: string;   // active session id (present for dashboard JWTs)
  iat?: number;
  exp?: number;
}

/**
 * @CurrentUser() — extracts the authenticated user from the JWT payload
 * as populated by Passport's JwtStrategy.
 *
 * Usage:
 *   async getProfile(@CurrentUser() user: AuthenticatedUser) { ... }
 *   async getProfile(@CurrentUser('email') email: string) { ... }
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('No authenticated user found on request');
    }

    return field ? user[field] : user;
  },
);
