import { SetMetadata } from '@nestjs/common';

/** Metadata key carrying the rate-limit bucket for a realty route. */
export const REALTY_RATE_LIMIT_BUCKET = 'realty_rate_limit_bucket';

/**
 * `@RealtyRateLimit('ai-turn')` — opt a route into a named rate-limit bucket
 * (see `REALTY_RATE_LIMIT_BUCKETS`). Routes without the decorator fall back to
 * the default realty ceiling. The guard reads this metadata per request.
 */
export const RealtyRateLimit = (bucket: string): MethodDecorator & ClassDecorator =>
  SetMetadata(REALTY_RATE_LIMIT_BUCKET, bucket);
