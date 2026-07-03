import type { UnitMatch } from '@gosumo/shared';

/** The buyer requirement a match is computed against (all optional). */
export interface MatchCriteria {
  budgetMinPaise?: number | null;
  budgetMaxPaise?: number | null;
  localities?: string[];
  config?: string | null;
}

/** A candidate unit flattened with its project context, for pure scoring. */
export interface MatchCandidate {
  unitId: string;
  projectId: string;
  projectName: string;
  locality: string;
  config: string;
  allInPricePaise: number;
}

/** Fit-score weights — config and price dominate; locality is a strong tiebreak. */
export const MATCH_WEIGHTS = {
  config: 40,
  price: 35,
  locality: 25,
} as const;

/**
 * Rank candidate units against a BLTC requirement. Pure and deterministic.
 * Candidates should already be filtered to AVAILABLE + verified-fresh units by
 * the caller (the freshness/availability hard rule lives in the query layer).
 *
 * A unit with a hard mismatch on a *specified* config never scores config points;
 * a unit priced above the budget ceiling is penalised proportionally to how far over.
 */
export function matchUnits(
  criteria: MatchCriteria,
  candidates: MatchCandidate[],
  limit = 3,
): UnitMatch[] {
  const wantConfig = normalizeConfig(criteria.config);
  const wantLocalities = (criteria.localities ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);
  const budgetMax = criteria.budgetMaxPaise ?? null;
  const budgetMin = criteria.budgetMinPaise ?? null;

  const scored = candidates.map((c) => {
    const reasons: string[] = [];

    // Config
    let configScore = 0;
    if (!wantConfig) {
      configScore = MATCH_WEIGHTS.config * 0.5; // no preference stated → neutral-positive
    } else if (normalizeConfig(c.config) === wantConfig) {
      configScore = MATCH_WEIGHTS.config;
      reasons.push(`Config matches ${c.config}`);
    }

    // Price fit relative to the budget band
    let priceScore = 0;
    if (budgetMax == null && budgetMin == null) {
      priceScore = MATCH_WEIGHTS.price * 0.5;
    } else {
      const withinCeiling = budgetMax == null || c.allInPricePaise <= budgetMax;
      const aboveFloor = budgetMin == null || c.allInPricePaise >= budgetMin;
      if (withinCeiling && aboveFloor) {
        priceScore = MATCH_WEIGHTS.price;
        reasons.push('Within budget');
      } else if (!withinCeiling && budgetMax != null) {
        // Penalise proportionally, up to 20% over still partially credited.
        const over = (c.allInPricePaise - budgetMax) / budgetMax;
        priceScore = over <= 0.2 ? MATCH_WEIGHTS.price * (1 - over / 0.2) * 0.6 : 0;
        if (priceScore > 0) reasons.push('Slightly over budget');
      }
    }

    // Locality overlap
    let localityScore = 0;
    if (wantLocalities.length === 0) {
      localityScore = MATCH_WEIGHTS.locality * 0.5;
    } else if (wantLocalities.some((l) => c.locality.toLowerCase().includes(l) || l.includes(c.locality.toLowerCase()))) {
      localityScore = MATCH_WEIGHTS.locality;
      reasons.push(`In preferred locality ${c.locality}`);
    }

    const fitScore = Math.round(configScore + priceScore + localityScore);
    return {
      unitId: c.unitId,
      projectId: c.projectId,
      projectName: c.projectName,
      config: c.config,
      allInPricePaise: c.allInPricePaise,
      locality: c.locality,
      fitScore,
      reasons,
    } satisfies UnitMatch;
  });

  return scored
    .filter((m) => m.fitScore > 0)
    .sort((a, b) => b.fitScore - a.fitScore || a.allInPricePaise - b.allInPricePaise)
    .slice(0, limit);
}

/** Normalise "2 BHK", "2bhk", "2-BHK" → "2BHK" for comparison. */
function normalizeConfig(config: string | null | undefined): string | null {
  if (!config) return null;
  return config.replace(/\s|-/g, '').toUpperCase();
}
