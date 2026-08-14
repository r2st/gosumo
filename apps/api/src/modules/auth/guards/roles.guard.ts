import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { roleRank } from '../role-hierarchy';

/**
 * Registered globally as an APP_GUARD in {@link AuthModule}, immediately after
 * JwtAuthGuard. Handlers with no @Roles() decorator are unaffected — the guard
 * short-circuits to `true` before it looks at the request.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() decorator → allow access
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('No authenticated user found');
    }

    const userRoleLevel = roleRank(user.role);

    // User has access if their role level >= the minimum required role level.
    // An unknown role on either side ranks -1, so an unrecognised *required*
    // role is not a backdoor: the caller still needs a rank of at least -1,
    // which only an equally unrecognised role has. Guard against that by
    // rejecting an unranked caller outright.
    if (userRoleLevel < 0) {
      throw new ForbiddenException(
        `Role '${user.role}' is not a recognised role. Required: ${requiredRoles.join(' or ')}`,
      );
    }

    const hasRole = requiredRoles.some((role) => {
      const requiredLevel = roleRank(role);
      return requiredLevel >= 0 && userRoleLevel >= requiredLevel;
    });

    if (!hasRole) {
      throw new ForbiddenException(
        `Role '${user.role}' does not have sufficient permissions. Required: ${requiredRoles.join(' or ')}`,
      );
    }

    return true;
  }
}
