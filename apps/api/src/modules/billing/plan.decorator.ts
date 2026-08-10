import { SetMetadata } from '@nestjs/common';
import type { PlanResource } from './billing.constants';

/** Metadata key carrying the plan-gated resource for a route. */
export const PLAN_LIMIT_RESOURCE = 'plan_limit_resource';

/**
 * `@PlanLimit('leads')` — gate a route behind the business's subscription tier.
 *
 *  - `'leads'`    — 429 (with an upgrade prompt) when the monthly allotment is
 *                   exhausted, unless the plan auto-bills overage.
 *  - `'seats'`    — 403 when the seat limit is reached (team member addition).
 *  - `'exchange'` — 403 when the tier does not include the co-broking exchange
 *                   (SOLO is blocked).
 *
 * The global {@link PlanGuard} reads this metadata; undecorated routes pass through.
 */
export const PlanLimit = (resource: PlanResource): MethodDecorator & ClassDecorator =>
  SetMetadata(PLAN_LIMIT_RESOURCE, resource);
