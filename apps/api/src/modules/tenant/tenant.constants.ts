/**
 * Tenant module constants — subscription plan catalog, onboarding flow
 * definition, usage metrics, and shared defaults.
 *
 * The plan catalog is the single source of truth for tier limits and
 * features. Both the subscription, usage, and tenant services read from it,
 * so quota enforcement and downgrade validation stay consistent.
 */

// ─────────────────────────────────────────────
// Subscription tiers
// ─────────────────────────────────────────────

/**
 * Canonical subscription tier identifiers.
 *
 * The platform supports five tiers. `STARTER`, `GROWTH`, and `SCALE` are the
 * historical project tiers; `FREE` and `ENTERPRISE` bracket them for trial and
 * large-account use. All plan strings are stored lowercase in
 * `businesses.plan`.
 */
export enum SubscriptionTier {
  FREE = 'free',
  STARTER = 'starter',
  GROWTH = 'growth',
  SCALE = 'scale',
  ENTERPRISE = 'enterprise',
}

/** Sentinel meaning "no limit" inside JSON-stored plan limits (Infinity is not JSON-safe). */
export const UNLIMITED = -1;

/**
 * The set of metered/limited resources a plan governs.
 *
 * `CHANNELS` and `TEAM_MEMBERS` are *resource* quotas — enforced against live
 * row counts. The remainder are *monthly* quotas — enforced against rolling
 * per-month counters stored in `businesses.profile.usage`.
 */
export enum UsageMetric {
  CHANNELS = 'channels',
  TEAM_MEMBERS = 'teamMembers',
  CONVERSATIONS = 'conversations',
  CAMPAIGNS = 'campaigns',
  AI_RESPONSES = 'aiResponses',
}

/** Metrics enforced against live row counts rather than monthly counters. */
export const RESOURCE_METRICS: readonly UsageMetric[] = [
  UsageMetric.CHANNELS,
  UsageMetric.TEAM_MEMBERS,
];

/** Metrics enforced against rolling monthly counters. */
export const MONTHLY_METRICS: readonly UsageMetric[] = [
  UsageMetric.CONVERSATIONS,
  UsageMetric.CAMPAIGNS,
  UsageMetric.AI_RESPONSES,
];

export interface PlanLimits {
  /** Max concurrently connected channel accounts. */
  maxChannels: number;
  /** Max active + invited team members. */
  maxTeamMembers: number;
  /** Max new conversations per calendar month. */
  maxConversationsPerMonth: number;
  /** Max campaigns created per calendar month. */
  maxCampaignsPerMonth: number;
  /** Max AI-generated responses per calendar month. */
  maxAiResponsesPerMonth: number;
}

export interface PlanDefinition {
  id: SubscriptionTier;
  name: string;
  /** Monthly price in paise (integer). */
  pricePaise: number;
  limits: PlanLimits;
  /** Feature flags unlocked by this tier. */
  features: string[];
}

/**
 * Plan catalog. `UNLIMITED` (-1) means no cap.
 */
export const PLAN_CATALOG: Record<SubscriptionTier, PlanDefinition> = {
  [SubscriptionTier.FREE]: {
    id: SubscriptionTier.FREE,
    name: 'Free',
    pricePaise: 0,
    limits: {
      maxChannels: 1,
      maxTeamMembers: 1,
      maxConversationsPerMonth: 100,
      maxCampaignsPerMonth: 0,
      maxAiResponsesPerMonth: 200,
    },
    features: ['ai_auto_reply'],
  },
  [SubscriptionTier.STARTER]: {
    id: SubscriptionTier.STARTER,
    name: 'Starter',
    pricePaise: 99900, // ₹999
    limits: {
      maxChannels: 1,
      maxTeamMembers: 3,
      maxConversationsPerMonth: 1000,
      maxCampaignsPerMonth: 5,
      maxAiResponsesPerMonth: 2000,
    },
    features: ['ai_auto_reply', 'campaigns', 'analytics'],
  },
  [SubscriptionTier.GROWTH]: {
    id: SubscriptionTier.GROWTH,
    name: 'Growth',
    pricePaise: 299900, // ₹2,999
    limits: {
      maxChannels: 5,
      maxTeamMembers: 10,
      maxConversationsPerMonth: 10000,
      maxCampaignsPerMonth: 50,
      maxAiResponsesPerMonth: 30000,
    },
    features: ['ai_auto_reply', 'campaigns', 'analytics', 'multi_channel', 'custom_ai_prompt'],
  },
  [SubscriptionTier.SCALE]: {
    id: SubscriptionTier.SCALE,
    name: 'Scale',
    pricePaise: 999900, // ₹9,999
    limits: {
      maxChannels: UNLIMITED,
      maxTeamMembers: UNLIMITED,
      maxConversationsPerMonth: UNLIMITED,
      maxCampaignsPerMonth: UNLIMITED,
      maxAiResponsesPerMonth: UNLIMITED,
    },
    features: [
      'ai_auto_reply',
      'campaigns',
      'analytics',
      'multi_channel',
      'custom_ai_prompt',
      'priority_support',
    ],
  },
  [SubscriptionTier.ENTERPRISE]: {
    id: SubscriptionTier.ENTERPRISE,
    name: 'Enterprise',
    pricePaise: UNLIMITED, // custom / negotiated
    limits: {
      maxChannels: UNLIMITED,
      maxTeamMembers: UNLIMITED,
      maxConversationsPerMonth: UNLIMITED,
      maxCampaignsPerMonth: UNLIMITED,
      maxAiResponsesPerMonth: UNLIMITED,
    },
    features: [
      'ai_auto_reply',
      'campaigns',
      'analytics',
      'multi_channel',
      'custom_ai_prompt',
      'priority_support',
      'sso',
      'dedicated_manager',
    ],
  },
};

/**
 * Resolve a plan definition by (case-insensitive) id, falling back to STARTER
 * for unknown plan strings.
 */
export function resolvePlan(plan: string): PlanDefinition {
  const key = plan.toLowerCase() as SubscriptionTier;
  return PLAN_CATALOG[key] ?? PLAN_CATALOG[SubscriptionTier.STARTER];
}

/** True when a limit value represents "no cap". */
export function isUnlimited(limit: number): boolean {
  return limit === UNLIMITED;
}

/** Maps a usage metric to the matching limit field on a plan. */
export function limitForMetric(plan: PlanDefinition, metric: UsageMetric): number {
  switch (metric) {
    case UsageMetric.CHANNELS:
      return plan.limits.maxChannels;
    case UsageMetric.TEAM_MEMBERS:
      return plan.limits.maxTeamMembers;
    case UsageMetric.CONVERSATIONS:
      return plan.limits.maxConversationsPerMonth;
    case UsageMetric.CAMPAIGNS:
      return plan.limits.maxCampaignsPerMonth;
    case UsageMetric.AI_RESPONSES:
      return plan.limits.maxAiResponsesPerMonth;
    default:
      return UNLIMITED;
  }
}

// ─────────────────────────────────────────────
// Onboarding flow
// ─────────────────────────────────────────────

/**
 * Ordered onboarding steps a business completes before going ACTIVE.
 * The order is meaningful — {@link ONBOARDING_STEP_ORDER} enforces it.
 */
export enum OnboardingStep {
  PROFILE = 'PROFILE',
  CHANNEL = 'CHANNEL',
  AI_CONFIG = 'AI_CONFIG',
  POLICIES = 'POLICIES',
  TEAM = 'TEAM',
}

/** Canonical step order; index defines progression. */
export const ONBOARDING_STEP_ORDER: readonly OnboardingStep[] = [
  OnboardingStep.PROFILE,
  OnboardingStep.CHANNEL,
  OnboardingStep.AI_CONFIG,
  OnboardingStep.POLICIES,
  OnboardingStep.TEAM,
];

// ─────────────────────────────────────────────
// AI config & policy defaults
// ─────────────────────────────────────────────

export const AI_CONFIG_DEFAULTS = {
  autoExecuteThreshold: 90,
  reviewThreshold: 70,
  personalityPrompt: '',
  responseLanguage: 'en',
} as const;

export const POLICIES_DEFAULTS = {
  refundWindowDays: 7,
  maxRefundAmountPaise: 500000, // ₹5,000
  slaFirstResponseMinutes: 15,
  slaResolutionMinutes: 1440, // 24 hours
  maxAutoDiscountPercent: 10,
} as const;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** 15-char GSTIN format. */
export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/**
 * Convert a business name into a URL-safe slug.
 * Lowercases, strips non-alphanumerics to single hyphens, trims edges.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/['\u2019\u2018`]/g, '') // drop apostrophes rather than splitting on them
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'business';
}

/**
 * Calendar-month period key (e.g. "2026-06") used to bucket monthly usage
 * counters. Accepts an explicit date for deterministic testing.
 */
export function usagePeriodKey(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * `audit_logs.resource_type` for team-membership changes.
 *
 * Shared between the service (invite/remove) and the controller (role change)
 * so all three land under one value and a "who touched the team" query is a
 * single indexed lookup on `(business_id, resource_type, resource_id)`.
 */
export const TEAM_MEMBER_RESOURCE = 'team_member';

/**
 * `audit_logs.resource_type` for suspending and re-activating the business
 * itself. `businesses.is_active` is one mutable flag, so without a row here
 * the only trace of a suspension is `profile.suspendedAt` — which
 * `activateBusiness` deletes.
 */
export const BUSINESS_STATUS_RESOURCE = 'business_status';

// ─────────────────────────────────────────────
// Team-member skills
// ─────────────────────────────────────────────

/**
 * Upper bound on a member's skill tags, and on the skills one routing request
 * may require. Both are arrays a client controls, so both need a ceiling; the
 * same number does for each because requiring more skills than any member can
 * hold could never match anyone.
 */
export const MAX_MEMBER_SKILLS = 32;

/** Longest single skill tag. */
export const MAX_SKILL_LENGTH = 40;

/**
 * Canonicalise skill tags: trimmed, upper-cased, blanks dropped, de-duplicated,
 * order preserved.
 *
 * The column is free-form text rather than an enum, so "hindi", "Hindi" and
 * " HINDI " are the same skill to every human and three different skills to a
 * raw string compare. Normalising on both write and match is what stops a
 * conversation requiring "BILLING" from skipping the agent tagged "billing".
 */
export function normaliseSkills(skills: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of skills) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toUpperCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}
