import { RealtyPlan } from '@prisma/client';

/**
 * GoSumo Realty pricing tiers (business plan §9). Money in paise (integer).
 * A `null` limit means "unlimited" (DEVELOPER).
 */
export interface PlanDefinition {
  plan: RealtyPlan;
  /** Display label. */
  label: string;
  /** Recurring price in paise. */
  pricePaise: number;
  /** Included leads per billing cycle; null = unlimited. */
  monthlyLeadLimit: number | null;
  /** Included seats (team members); null = unlimited. */
  seatLimit: number | null;
  /** Whether the tier unlocks the co-broking exchange. */
  exchangeEnabled: boolean;
  /** Whether the tier unlocks CRM sync (Sell.Do / LeadSquared / Privyr push). */
  crmSyncEnabled: boolean;
  /** Short feature bullets (surfaced on the billing page). */
  features: string[];
}

/** Per-lead overage charge once the included allotment is exhausted (₹8 = 800 paise). */
export const OVERAGE_RATE_PAISE = 800;

/** The default tier a business lands on before choosing a plan. */
export const DEFAULT_PLAN = RealtyPlan.SOLO;

/**
 * Canonical plan definitions (business plan §9):
 *  - Solo:      ₹3,999/mo · 1 seat · 300 leads/mo
 *  - Team:      ₹9,999/mo · 5 seats · 1,500 leads/mo · routing + analytics
 *  - Developer: ₹24,999/mo per project · unlimited seats + leads · CRM sync, IVR, priority
 */
export const PLAN_DEFINITIONS: Record<RealtyPlan, PlanDefinition> = {
  [RealtyPlan.SOLO]: {
    plan: RealtyPlan.SOLO,
    label: 'Solo',
    pricePaise: 399900,
    monthlyLeadLimit: 300,
    seatLimit: 1,
    exchangeEnabled: false,
    crmSyncEnabled: false,
    features: ['1 WhatsApp number', '300 leads/mo', 'AI lead manager', '1 seat'],
  },
  [RealtyPlan.TEAM]: {
    plan: RealtyPlan.TEAM,
    label: 'Team',
    pricePaise: 999900,
    monthlyLeadLimit: 1500,
    seatLimit: 5,
    exchangeEnabled: true,
    crmSyncEnabled: false,
    features: ['5 seats', '1,500 leads/mo', 'Lead routing', 'Analytics', 'Co-broking exchange'],
  },
  [RealtyPlan.DEVELOPER]: {
    plan: RealtyPlan.DEVELOPER,
    label: 'Developer',
    pricePaise: 2499900,
    monthlyLeadLimit: null,
    seatLimit: null,
    exchangeEnabled: true,
    crmSyncEnabled: true,
    features: [
      'Unlimited leads',
      'Unlimited seats',
      'CRM sync',
      'IVR',
      'Priority support',
      'Co-broking exchange',
    ],
  },
};

/** Resolve a plan definition; throws on an unknown plan value. */
export function planDefinition(plan: RealtyPlan): PlanDefinition {
  const def = PLAN_DEFINITIONS[plan];
  if (!def) {
    throw new Error(`Unknown realty plan: ${plan}`);
  }
  return def;
}

/** The resources a plan gates. */
export type PlanResource = 'leads' | 'seats' | 'exchange' | 'crm_sync';
