import { SetMetadata } from '@nestjs/common';

/** Metadata key carrying the per-tenant rate-limit bucket for a route. */
export const TENANT_RATE_LIMIT_BUCKET = 'tenant_rate_limit_bucket';

/**
 * `@TenantRateLimit('ai-invoke')` — ration this route per business against a
 * named bucket in `TENANT_RATE_LIMIT_BUCKETS`.
 *
 * Applies to a method or a whole controller; the method wins when both carry
 * one, which is what lets a controller declare a default and a single
 * expensive route tighten it.
 *
 * A route with no decorator is not rationed. There is no implicit default on
 * purpose — see the note in `tenant-rate-limit.constants.ts`.
 */
export const TenantRateLimit = (bucket: string): MethodDecorator & ClassDecorator =>
  SetMetadata(TENANT_RATE_LIMIT_BUCKET, bucket);
