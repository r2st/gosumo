import type { ExchangeMatch } from '@gosumo/shared';

/** The buyer requirement (BLTC) a network match is computed against. */
export interface ExchangeCriteria {
  budgetMinPaise?: number | null;
  budgetMaxPaise?: number | null;
  localities?: string[];
  config?: string | null;
}

/**
 * A piece of network supply flattened for pure scoring — a resale listing or an
 * EXCHANGE-visible unit from ANOTHER business, already carrying that
 * counterparty's composite reliability score.
 */
export interface ExchangeCandidate {
  listingId: string;
  sourceType: 'RESALE' | 'UNIT';
  ownerBusinessId: string;
  projectName: string | null;
  locality: string;
  config: string;
  askingPricePaise: number;
  /** 0–100 composite reliability of the owner business at match time. */
  reliabilityScore: number;
}

/** BLTC fit weights — identical to the inventory matcher so scores are comparable. */
export const EXCHANGE_FIT_WEIGHTS = {
  config: 40,
  price: 35,
  locality: 25,
} as const;

/**
 * How fit and counterparty reliability blend into the ranking key. Fit leads
 * (a wrong unit from a great broker is still the wrong unit), but reliability is
 * a heavy tiebreak — the whole point of the exchange is to route to partners who
 * show up and honour the split.
 */
export const FIT_WEIGHT = 0.7;
export const RELIABILITY_WEIGHT = 0.3;

/**
 * Rank network supply against a buyer's BLTC profile, blending fit with the
 * counterparty's reliability. Pure and deterministic. Candidates must already be
 * filtered to OTHER businesses' matchable supply by the caller (the cross-tenant
 * read lives in the repository). A fully-specified hard mismatch scores fit 0
 * and is dropped, exactly like the inventory matcher.
 */
export function matchExchange(
  criteria: ExchangeCriteria,
  candidates: ExchangeCandidate[],
  limit = 5,
): ExchangeMatch[] {
  const wantConfig = normalizeConfig(criteria.config);
  const wantLocalities = (criteria.localities ?? [])
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  const budgetMax = criteria.budgetMaxPaise ?? null;
  const budgetMin = criteria.budgetMinPaise ?? null;

  const scored = candidates.map((c) => {
    const reasons: string[] = [];

    // Config
    let configScore = 0;
    if (!wantConfig) {
      configScore = EXCHANGE_FIT_WEIGHTS.config * 0.5;
    } else if (normalizeConfig(c.config) === wantConfig) {
      configScore = EXCHANGE_FIT_WEIGHTS.config;
      reasons.push(`Config matches ${c.config}`);
    }

    // Price fit relative to the budget band
    let priceScore = 0;
    if (budgetMax == null && budgetMin == null) {
      priceScore = EXCHANGE_FIT_WEIGHTS.price * 0.5;
    } else {
      const withinCeiling = budgetMax == null || c.askingPricePaise <= budgetMax;
      const aboveFloor = budgetMin == null || c.askingPricePaise >= budgetMin;
      if (withinCeiling && aboveFloor) {
        priceScore = EXCHANGE_FIT_WEIGHTS.price;
        reasons.push('Within budget');
      } else if (!withinCeiling && budgetMax != null) {
        const over = (c.askingPricePaise - budgetMax) / budgetMax;
        priceScore = over <= 0.2 ? EXCHANGE_FIT_WEIGHTS.price * (1 - over / 0.2) * 0.6 : 0;
        if (priceScore > 0) reasons.push('Slightly over budget');
      }
    }

    // Locality overlap
    let localityScore = 0;
    if (wantLocalities.length === 0) {
      localityScore = EXCHANGE_FIT_WEIGHTS.locality * 0.5;
    } else if (
      wantLocalities.some(
        (l) => c.locality.toLowerCase().includes(l) || l.includes(c.locality.toLowerCase()),
      )
    ) {
      localityScore = EXCHANGE_FIT_WEIGHTS.locality;
      reasons.push(`In preferred locality ${c.locality}`);
    }

    const fitScore = Math.round(configScore + priceScore + localityScore);
    const reliabilityScore = clamp(c.reliabilityScore);
    const blendedScore = Math.round(fitScore * FIT_WEIGHT + reliabilityScore * RELIABILITY_WEIGHT);
    if (reliabilityScore >= 75) reasons.push('High-reliability counterparty');
    else if (reliabilityScore < 40) reasons.push('Unproven counterparty');

    return {
      listingId: c.listingId,
      sourceType: c.sourceType,
      ownerBusinessId: c.ownerBusinessId,
      projectName: c.projectName,
      locality: c.locality,
      config: c.config,
      askingPricePaise: c.askingPricePaise,
      fitScore,
      reliabilityScore: round2(reliabilityScore),
      blendedScore,
      reasons,
    } satisfies ExchangeMatch;
  });

  return scored
    .filter((m) => m.fitScore > 0)
    .sort(
      (a, b) =>
        b.blendedScore - a.blendedScore ||
        b.reliabilityScore - a.reliabilityScore ||
        a.askingPricePaise - b.askingPricePaise,
    )
    .slice(0, limit);
}

/** Normalise "2 BHK", "2bhk", "2-BHK" → "2BHK" for comparison. */
function normalizeConfig(config: string | null | undefined): string | null {
  if (!config) return null;
  return config.replace(/\s|-/g, '').toUpperCase();
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
