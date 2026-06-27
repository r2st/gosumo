import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SubscriptionTier, PlanDefinition, PlanLimits } from '../tenant.constants';

/**
 * DTO for changing a business's subscription tier (upgrade or downgrade).
 */
export class ChangePlanDto {
  @IsIn(Object.values(SubscriptionTier))
  plan!: SubscriptionTier;

  /** Optional reason recorded for audit/analytics. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Response shape describing the current subscription. */
export interface SubscriptionResponse {
  plan: SubscriptionTier;
  name: string;
  pricePaise: number;
  limits: PlanLimits;
  features: string[];
  /** Whether the tenant is currently active (not suspended). */
  isActive: boolean;
}

/** A plan catalog entry as exposed to API consumers. */
export type PlanCatalogEntry = PlanDefinition;
