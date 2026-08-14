import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { SELF_SERVICE_KEY } from '../decorators/self-service.decorator';
import { IS_PUBLIC_KEY } from '../../../common/interceptors/tenant.interceptor';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { roleRank } from '../role-hierarchy';

/** HTTP verbs that mutate state. Anything else is treated as a read. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Minimum rank allowed to mutate business data. STAFF (rank 1) and above;
 * VIEWER (rank 0) is denied.
 */
const MIN_WRITE_RANK = roleRank('STAFF');

/**
 * Registered globally as an APP_GUARD in {@link AuthModule}, immediately after
 * JwtAuthGuard.
 *
 * Two things gate a request here:
 *
 * 1. An explicit `@Roles(...)` on the handler or controller — the caller must
 *    rank at or above one of the named roles.
 *
 * 2. **Writes are denied to VIEWER by default.** A route with no `@Roles()` is
 *    still closed to VIEWER if it uses a mutating verb. This is deliberately a
 *    guard-level default rather than 226 hand-written decorators: a decorator
 *    sweep only secures the routes that exist on the day it is written, and
 *    every endpoint added afterwards silently defaults back to open. Failing
 *    closed means a new route is safe before anyone remembers to think about
 *    it, and a route that genuinely needs to be looser has to say so out loud
 *    with `@Roles()` or `@SelfService()`.
 *
 * Reads are unaffected — any authenticated role may call them. `@Public()`
 * routes skip the guard entirely; they carry no authenticated user, and their
 * own HMAC verification is the gate.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Webhooks and the login/register surface authenticate themselves.
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const hasExplicitRoles = Boolean(requiredRoles && requiredRoles.length > 0);

    // The write default reads request.method, which only exists over HTTP.
    // WebSocket and RPC handlers fall back to the explicit-@Roles path.
    const isHttp = context.getType() === 'http';
    const request = isHttp
      ? context.switchToHttp().getRequest<{ user?: AuthenticatedUser; method?: string }>()
      : undefined;

    const isWrite = isHttp && WRITE_METHODS.has((request?.method ?? '').toUpperCase());

    if (!hasExplicitRoles && !isWrite) {
      return true;
    }

    const user = request?.user;
    if (!user) {
      throw new ForbiddenException('No authenticated user found');
    }

    const userRoleLevel = roleRank(user.role);

    // An unknown role on either side ranks -1, so an unrecognised *required*
    // role is not a backdoor: the caller still needs a rank of at least -1,
    // which only an equally unrecognised role has. Guard against that by
    // rejecting an unranked caller outright.
    if (userRoleLevel < 0) {
      const required = hasExplicitRoles ? (requiredRoles as string[]).join(' or ') : 'STAFF';
      throw new ForbiddenException(
        `Role '${user.role}' is not a recognised role. Required: ${required}`,
      );
    }

    if (hasExplicitRoles) {
      const hasRole = (requiredRoles as string[]).some((role) => {
        const requiredLevel = roleRank(role);
        return requiredLevel >= 0 && userRoleLevel >= requiredLevel;
      });

      if (!hasRole) {
        throw new ForbiddenException(
          `Role '${user.role}' does not have sufficient permissions. Required: ${(
            requiredRoles as string[]
          ).join(' or ')}`,
        );
      }

      return true;
    }

    // Undecorated write. Self-service routes act only on the caller's own
    // account, so any recognised role may call them; everything else needs
    // STAFF or above.
    const isSelfService = this.reflector.getAllAndOverride<boolean | undefined>(
      SELF_SERVICE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isSelfService) {
      return true;
    }

    if (userRoleLevel < MIN_WRITE_RANK) {
      throw new ForbiddenException(
        `Role '${user.role}' is read-only and cannot modify data. Required: STAFF or above`,
      );
    }

    return true;
  }
}
