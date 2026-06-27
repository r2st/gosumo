import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';

/**
 * Role hierarchy — higher index = higher authority.
 * A user with a higher role implicitly has access to lower roles.
 */
const ROLE_HIERARCHY: Record<string, number> = {
  VIEWER: 0,
  STAFF: 1,
  MANAGER: 2,
  OWNER: 3,
};

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

    const userRoleLevel = ROLE_HIERARCHY[user.role] ?? -1;

    // User has access if their role level >= the minimum required role level
    const hasRole = requiredRoles.some((role) => {
      const requiredLevel = ROLE_HIERARCHY[role] ?? -1;
      return userRoleLevel >= requiredLevel;
    });

    if (!hasRole) {
      throw new ForbiddenException(
        `Role '${user.role}' does not have sufficient permissions. Required: ${requiredRoles.join(' or ')}`,
      );
    }

    return true;
  }
}
