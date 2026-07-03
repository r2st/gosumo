import type { BltcProfile, LeadScoreResult } from '@gosumo/shared';

/**
 * Qualification-score weights (blueprint §16.2, per-business tunable defaults):
 *   budget-fit 35 · timeline 25 · engagement velocity 20 · financing 10 · purpose 10
 */
export const SCORE_WEIGHTS = {
  budgetFit: 35,
  timeline: 25,
  engagement: 20,
  financing: 10,
  purpose: 10,
} as const;

/** Temperature thresholds on the 0–100 composite score. */
export const TEMPERATURE_THRESHOLDS = {
  HOT: 75,
  WARM: 50,
  COLD: 25,
} as const;

/** A lead at or above this score triggers the broker hot-dossier alert. */
export const HOT_SCORE_THRESHOLD = TEMPERATURE_THRESHOLDS.HOT;

/**
 * Score a lead from its BLTC profile plus an engagement signal (buyer turns).
 * Pure — no I/O, deterministic. Every filled slot contributes its full weight;
 * budget and timeline are graded on quality, not mere presence.
 *
 * @param profile   the current BLTC requirement profile
 * @param engagementTurns number of buyer turns observed so far
 */
export function scoreLead(
  profile: BltcProfile,
  engagementTurns: number,
): LeadScoreResult {
  // Budget fit — full credit when both bounds are known and sane; half when
  // only one bound is known.
  let budgetFit = 0;
  const hasMin = profile.budgetMinPaise != null;
  const hasMax = profile.budgetMaxPaise != null;
  if (hasMin && hasMax) {
    const min = profile.budgetMinPaise as number;
    const max = profile.budgetMaxPaise as number;
    budgetFit = max >= min && max > 0 ? SCORE_WEIGHTS.budgetFit : SCORE_WEIGHTS.budgetFit / 2;
  } else if (hasMin || hasMax) {
    budgetFit = SCORE_WEIGHTS.budgetFit / 2;
  }

  // Timeline — sooner is hotter. <=3 mo full, <=6 mo 80%, <=12 mo 55%, else 30%.
  let timeline = 0;
  if (profile.timelineMonths != null) {
    const t = profile.timelineMonths;
    if (t <= 3) timeline = SCORE_WEIGHTS.timeline;
    else if (t <= 6) timeline = SCORE_WEIGHTS.timeline * 0.8;
    else if (t <= 12) timeline = SCORE_WEIGHTS.timeline * 0.55;
    else timeline = SCORE_WEIGHTS.timeline * 0.3;
  }

  // Engagement velocity — saturates at 5 buyer turns.
  const engagement = Math.min(engagementTurns / 5, 1) * SCORE_WEIGHTS.engagement;

  // Financing clarity — any known posture is full credit (cash/pre-approved/loan).
  const financing = profile.financing != null ? SCORE_WEIGHTS.financing : 0;

  // Purpose — known end-use/investment is full credit.
  const purpose = profile.purpose != null ? SCORE_WEIGHTS.purpose : 0;

  const raw = budgetFit + timeline + engagement + financing + purpose;
  const score = Math.round(Math.max(0, Math.min(100, raw)));

  return {
    score,
    temperature: temperatureForScore(score),
    breakdown: {
      budgetFit: Math.round(budgetFit),
      timeline: Math.round(timeline),
      engagement: Math.round(engagement),
      financing: Math.round(financing),
      purpose: Math.round(purpose),
    },
  };
}

/** Map a 0–100 score onto a temperature band. */
export function temperatureForScore(
  score: number,
): 'HOT' | 'WARM' | 'COLD' | 'JUNK' {
  if (score >= TEMPERATURE_THRESHOLDS.HOT) return 'HOT';
  if (score >= TEMPERATURE_THRESHOLDS.WARM) return 'WARM';
  if (score >= TEMPERATURE_THRESHOLDS.COLD) return 'COLD';
  return 'JUNK';
}

/** How many of the six BLTC(+) slots are filled. 4/4 core BLTC ⇒ qualifiable. */
export function countFilledCoreSlots(profile: BltcProfile): number {
  let n = 0;
  if (profile.budgetMinPaise != null || profile.budgetMaxPaise != null) n++;
  if (profile.localities.length > 0) n++;
  if (profile.timelineMonths != null) n++;
  if (profile.config != null) n++;
  return n;
}

/** True when all four core BLTC slots are filled (blueprint §16.2). */
export function isBltcComplete(profile: BltcProfile): boolean {
  return countFilledCoreSlots(profile) === 4;
}
