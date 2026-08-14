import { SetMetadata } from '@nestjs/common';

export const SELF_SERVICE_KEY = 'selfService';

/**
 * @SelfService() — marks a write route that acts on the caller's *own* account
 * rather than on business data.
 *
 * RolesGuard denies writes to VIEWER by default (see the guard for why). A
 * handful of routes must stay open to every authenticated role regardless:
 * logging out, revoking your own session, changing your own password. Without
 * this escape hatch a VIEWER could sign in but never sign out.
 *
 * This is not a general "let anyone write" marker. Use it only where the
 * handler is scoped to `@CurrentUser()` and cannot touch another user's or the
 * business's state.
 */
export const SelfService = () => SetMetadata(SELF_SERVICE_KEY, true);
