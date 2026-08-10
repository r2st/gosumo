import { IntelligenceMetricType, LeadStage } from '@gosumo/shared';

/**
 * Pure micro-market aggregation (L1, blueprint §18).
 *
 * Given the minimal per-lead projection an opted-in business exposes, group leads
 * by corridor (locality) and compute the five corridor-pattern metrics. Every
 * function here is deterministic and side-effect free — the service layer owns
 * fetching, persistence, and consent; this file owns the math.
 *
 * Anti-reconstruction is enforced in two places:
 *   1. a corridor is only aggregated at all when it has ≥ minN leads;
 *   2. named sub-groups (a lead source, an objection label) are only surfaced
 *      when that sub-group itself has ≥ minN leads — rates/quantiles over the
 *      whole corridor are safe, but naming a rare attribute is not.
 */

// ─────────────────────────────────────────────
// Input projection
// ─────────────────────────────────────────────

/** The minimal, already-anonymized view of a lead the aggregator consumes. */
export interface IntelLead {
  source: string; // LeadSource
  stage: string; // LeadStage
  qualScore: number;
  localities: string[];
  budgetMinPaise: number | null;
  budgetMaxPaise: number | null;
  config: string | null;
  /** Raw objection texts captured in lead memory. */
  objections: string[];
  firstTouchAt: Date;
  lastActivityAt: Date | null;
}

// ─────────────────────────────────────────────
// Metric-value payload shapes (stored in metric_value JSONB)
// ─────────────────────────────────────────────

export interface CadenceConversionValue {
  total: number;
  converted: number;
  conversionRate: number; // 0..1
  medianDaysToConvert: number | null;
  /** When conversions land, relative to first touch. */
  buckets: Array<{ label: string; converted: number; share: number }>;
}

export interface ObjectionFrequencyValue {
  totalObjections: number;
  topObjections: Array<{ label: string; count: number; share: number }>;
  /** Objection mix per unit configuration (project-type proxy). */
  byConfig: Array<{ config: string; topObjection: string; count: number }>;
}

export interface QuantileTriple {
  p25: number;
  p50: number;
  p75: number;
}

export interface PriceElasticityValue {
  withBudget: number;
  budgetMinPaise: QuantileTriple | null;
  budgetMaxPaise: QuantileTriple | null;
  /** The realistic band to anchor on: p25(min) → p75(max). */
  recommendedBandPaise: { low: number; high: number } | null;
}

export interface SourceQualityValue {
  sources: Array<{
    source: string;
    leads: number;
    qualifiedRate: number; // 0..1
    visitRate: number; // 0..1 reached a site visit or beyond
    avgQualScore: number;
  }>;
}

export interface SeasonalVelocityValue {
  months: Array<{
    month: string; // YYYY-MM
    leads: number;
    converted: number;
    conversionRate: number; // 0..1
  }>;
}

export type MetricValue =
  | CadenceConversionValue
  | ObjectionFrequencyValue
  | PriceElasticityValue
  | SourceQualityValue
  | SeasonalVelocityValue;

/** One computed aggregate, ready for the repository to persist. */
export interface ComputedAggregate {
  corridor: string;
  metricType: IntelligenceMetricType;
  metricValue: MetricValue;
  sampleSize: number;
}

// ─────────────────────────────────────────────
// Stage semantics
// ─────────────────────────────────────────────

/** Stages that mean the buyer reached (or passed) a site visit — "converted". */
const CONVERTED_STAGES: ReadonlySet<string> = new Set([
  LeadStage.VISIT_BOOKED,
  LeadStage.VISITED,
  LeadStage.NEGOTIATING,
  LeadStage.CLOSED_WON,
]);

/** Stages at or beyond BLTC qualification. */
const QUALIFIED_STAGES: ReadonlySet<string> = new Set([
  LeadStage.QUALIFIED,
  LeadStage.VISIT_BOOKED,
  LeadStage.VISITED,
  LeadStage.NEGOTIATING,
  LeadStage.CLOSED_WON,
]);

export function isConverted(stage: string): boolean {
  return CONVERTED_STAGES.has(stage);
}

export function isQualified(stage: string): boolean {
  return QUALIFIED_STAGES.has(stage);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────
// Grouping
// ─────────────────────────────────────────────

/**
 * Group leads by corridor. A lead attributes to every locality it named, so a
 * buyer weighing two corridors informs both. Leads with no locality are dropped
 * (they cannot be attributed to a micro-market).
 */
export function groupByCorridor(leads: IntelLead[]): Map<string, IntelLead[]> {
  const byCorridor = new Map<string, IntelLead[]>();
  for (const lead of leads) {
    const seen = new Set<string>();
    for (const raw of lead.localities) {
      const corridor = normalizeCorridor(raw);
      if (!corridor || seen.has(corridor)) continue;
      seen.add(corridor);
      const bucket = byCorridor.get(corridor);
      if (bucket) bucket.push(lead);
      else byCorridor.set(corridor, [lead]);
    }
  }
  return byCorridor;
}

/** Canonicalize a locality string into a corridor key (trim + collapse case). */
export function normalizeCorridor(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

// ─────────────────────────────────────────────
// Top-level: compute every corridor's aggregates
// ─────────────────────────────────────────────

/**
 * Build all corridor aggregates for one business. Corridors with fewer than
 * `minN` leads are skipped entirely (anti-reconstruction). Returns a flat list
 * across corridors × metrics.
 */
export function computeAggregatesForBusiness(
  leads: IntelLead[],
  minN: number,
): ComputedAggregate[] {
  const out: ComputedAggregate[] = [];
  for (const [corridor, corridorLeads] of groupByCorridor(leads)) {
    if (corridorLeads.length < minN) continue;
    const sampleSize = corridorLeads.length;
    out.push(
      {
        corridor,
        metricType: IntelligenceMetricType.CADENCE_CONVERSION,
        metricValue: cadenceConversion(corridorLeads),
        sampleSize,
      },
      {
        corridor,
        metricType: IntelligenceMetricType.OBJECTION_FREQUENCY,
        metricValue: objectionFrequency(corridorLeads, minN),
        sampleSize,
      },
      {
        corridor,
        metricType: IntelligenceMetricType.PRICE_ELASTICITY,
        metricValue: priceElasticity(corridorLeads),
        sampleSize,
      },
      {
        corridor,
        metricType: IntelligenceMetricType.SOURCE_QUALITY,
        metricValue: sourceQuality(corridorLeads, minN),
        sampleSize,
      },
      {
        corridor,
        metricType: IntelligenceMetricType.SEASONAL_VELOCITY,
        metricValue: seasonalVelocity(corridorLeads),
        sampleSize,
      },
    );
  }
  return out;
}

// ─────────────────────────────────────────────
// 1. Cadence conversion — which follow-up timing works
// ─────────────────────────────────────────────

const CADENCE_BUCKETS: Array<{ label: string; maxDays: number }> = [
  { label: 'SAME_DAY', maxDays: 1 },
  { label: 'WEEK_1', maxDays: 7 },
  { label: 'WEEK_2', maxDays: 14 },
  { label: 'MONTH_1', maxDays: 30 },
  { label: 'LATER', maxDays: Infinity },
];

export function cadenceConversion(leads: IntelLead[]): CadenceConversionValue {
  const total = leads.length;
  const daysToConvert: number[] = [];
  const bucketCounts = new Map<string, number>(CADENCE_BUCKETS.map((b) => [b.label, 0]));

  for (const lead of leads) {
    if (!isConverted(lead.stage)) continue;
    const end = lead.lastActivityAt ?? lead.firstTouchAt;
    const days = Math.max(0, (end.getTime() - lead.firstTouchAt.getTime()) / DAY_MS);
    daysToConvert.push(days);
    const bucket = CADENCE_BUCKETS.find((b) => days <= b.maxDays)!;
    bucketCounts.set(bucket.label, (bucketCounts.get(bucket.label) ?? 0) + 1);
  }

  const converted = daysToConvert.length;
  return {
    total,
    converted,
    conversionRate: total ? round4(converted / total) : 0,
    medianDaysToConvert: converted ? round1(median(daysToConvert)) : null,
    buckets: CADENCE_BUCKETS.map((b) => {
      const c = bucketCounts.get(b.label) ?? 0;
      return { label: b.label, converted: c, share: converted ? round4(c / converted) : 0 };
    }),
  };
}

// ─────────────────────────────────────────────
// 2. Objection frequency — recurring objections, by project type
// ─────────────────────────────────────────────

/** Keyword → normalized objection category. First match wins. */
const OBJECTION_RULES: Array<{ label: string; patterns: RegExp }> = [
  { label: 'PRICE_TOO_HIGH', patterns: /\b(price|costly|expensive|budget|meheng|mahang|rate)\b/i },
  { label: 'LOAN_FINANCE', patterns: /\b(loan|emi|finance|down\s?payment|mortgage|bank)\b/i },
  { label: 'POSSESSION_DELAY', patterns: /\b(possession|delay|ready|handover|construction|late)\b/i },
  { label: 'LOCATION', patterns: /\b(location|far|distance|connectivity|commute|metro|traffic)\b/i },
  { label: 'SIZE_LAYOUT', patterns: /\b(size|small|carpet|layout|area|sqft|square)\b/i },
  { label: 'LEGAL_RERA', patterns: /\b(rera|legal|approval|title|clearance|dispute)\b/i },
  { label: 'AMENITIES', patterns: /\b(amenit|parking|lift|club|gym|pool|facilit)\b/i },
];

export function categorizeObjection(text: string): string {
  for (const rule of OBJECTION_RULES) {
    if (rule.patterns.test(text)) return rule.label;
  }
  return 'OTHER';
}

export function objectionFrequency(leads: IntelLead[], minN: number): ObjectionFrequencyValue {
  const counts = new Map<string, number>();
  const perConfig = new Map<string, Map<string, number>>();
  let total = 0;

  for (const lead of leads) {
    const config = (lead.config ?? 'UNKNOWN').toUpperCase();
    for (const raw of lead.objections) {
      if (!raw || !raw.trim()) continue;
      const label = categorizeObjection(raw);
      counts.set(label, (counts.get(label) ?? 0) + 1);
      total++;
      const cfg = perConfig.get(config) ?? new Map<string, number>();
      cfg.set(label, (cfg.get(label) ?? 0) + 1);
      perConfig.set(config, cfg);
    }
  }

  // k-anonymity: only surface objection labels seen ≥ minN times across the corridor.
  const topObjections = [...counts.entries()]
    .filter(([, count]) => count >= minN)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count, share: total ? round4(count / total) : 0 }));

  const byConfig = [...perConfig.entries()]
    .map(([config, m]) => {
      const [topObjection, count] = [...m.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['OTHER', 0];
      return { config, topObjection, count };
    })
    .filter((r) => r.count >= minN)
    .sort((a, b) => b.count - a.count);

  return { totalObjections: total, topObjections, byConfig };
}

// ─────────────────────────────────────────────
// 3. Price-band elasticity — realistic budgets by locality
// ─────────────────────────────────────────────

export function priceElasticity(leads: IntelLead[]): PriceElasticityValue {
  const mins = leads.map((l) => l.budgetMinPaise).filter((v): v is number => v != null && v > 0);
  const maxs = leads.map((l) => l.budgetMaxPaise).filter((v): v is number => v != null && v > 0);
  const withBudget = leads.filter(
    (l) => (l.budgetMinPaise != null && l.budgetMinPaise > 0) ||
      (l.budgetMaxPaise != null && l.budgetMaxPaise > 0),
  ).length;

  const minQ = mins.length ? quantiles(mins) : null;
  const maxQ = maxs.length ? quantiles(maxs) : null;

  let recommendedBandPaise: { low: number; high: number } | null = null;
  const low = minQ?.p25 ?? maxQ?.p25 ?? null;
  const high = maxQ?.p75 ?? minQ?.p75 ?? null;
  if (low != null && high != null && high >= low) {
    recommendedBandPaise = { low, high };
  }

  return {
    withBudget,
    budgetMinPaise: minQ,
    budgetMaxPaise: maxQ,
    recommendedBandPaise,
  };
}

// ─────────────────────────────────────────────
// 4. Source quality — downstream quality of each lead source
// ─────────────────────────────────────────────

export function sourceQuality(leads: IntelLead[], minN: number): SourceQualityValue {
  const bySource = new Map<string, IntelLead[]>();
  for (const lead of leads) {
    const bucket = bySource.get(lead.source);
    if (bucket) bucket.push(lead);
    else bySource.set(lead.source, [lead]);
  }

  const sources = [...bySource.entries()]
    // k-anonymity: never name a source represented by fewer than minN leads.
    .filter(([, group]) => group.length >= minN)
    .map(([source, group]) => {
      const leadsCount = group.length;
      const qualified = group.filter((l) => isQualified(l.stage)).length;
      const visited = group.filter((l) => isConverted(l.stage)).length;
      const scoreSum = group.reduce((s, l) => s + l.qualScore, 0);
      return {
        source,
        leads: leadsCount,
        qualifiedRate: round4(qualified / leadsCount),
        visitRate: round4(visited / leadsCount),
        avgQualScore: round1(scoreSum / leadsCount),
      };
    })
    .sort((a, b) => b.visitRate - a.visitRate);

  return { sources };
}

// ─────────────────────────────────────────────
// 5. Seasonal velocity — lead inflow + conversion curve, by month
// ─────────────────────────────────────────────

export function seasonalVelocity(leads: IntelLead[]): SeasonalVelocityValue {
  const byMonth = new Map<string, { leads: number; converted: number }>();
  for (const lead of leads) {
    const month = monthKey(lead.firstTouchAt);
    const entry = byMonth.get(month) ?? { leads: 0, converted: 0 };
    entry.leads++;
    if (isConverted(lead.stage)) entry.converted++;
    byMonth.set(month, entry);
  }

  const months = [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, v]) => ({
      month,
      leads: v.leads,
      converted: v.converted,
      conversionRate: v.leads ? round4(v.converted / v.leads) : 0,
    }));

  return { months };
}

// ─────────────────────────────────────────────
// Numeric helpers
// ─────────────────────────────────────────────

/** YYYY-MM in UTC. */
export function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function median(values: number[]): number {
  return percentile(values, 0.5);
}

export function quantiles(values: number[]): QuantileTriple {
  return {
    p25: Math.round(percentile(values, 0.25)),
    p50: Math.round(percentile(values, 0.5)),
    p75: Math.round(percentile(values, 0.75)),
  };
}

/** Linear-interpolated percentile (q in 0..1). Returns 0 for an empty input. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
