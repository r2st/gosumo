import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * @Roles('OWNER', 'MANAGER') — restricts access to users with the specified roles.
 * Works with the RolesGuard. Role hierarchy: OWNER > MANAGER > STAFF > VIEWER.
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
