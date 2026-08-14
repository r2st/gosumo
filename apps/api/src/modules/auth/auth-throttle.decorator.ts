import { SetMetadata } from '@nestjs/common';

/** Metadata key carrying the throttle bucket for a public auth route. */
export const AUTH_THROTTLE_BUCKET = 'auth_throttle_bucket';

/**
 * `@AuthThrottle('register')` — ration an unauthenticated auth route under a
 * named bucket from `AUTH_THROTTLE_BUCKETS`.
 *
 * Routes without the decorator are not throttled by `AuthThrottleGuard` at
 * all, which is safe for the authenticated majority (a caller needs a token to
 * reach them) and is exactly what `auth-throttle-contract.spec.ts` refuses to
 * let happen to a `@Public()` auth route.
 */
export const AuthThrottle = (bucket: string): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTH_THROTTLE_BUCKET, bucket);
