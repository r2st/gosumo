import { IntelligenceMetricType } from '@gosumo/shared';
import type {
  CadenceConversionValue,
  ObjectionFrequencyValue,
  PriceElasticityValue,
  SeasonalVelocityValue,
} from './intelligence-aggregation.util';

/** One aggregate row, as the formatter consumes it (metric + its JSONB value). */
export interface CorridorAggregate {
  metricType: IntelligenceMetricType;
  metricValue: unknown;
  sampleSize: number;
}

/**
 * Format a corridor's aggregates into a prompt section for the grounded matching
 * prompt (blueprint §16 / §18). Returns null when there is nothing useful to say
 * so the caller can omit the section entirely.
 *
 * CRITICAL: these are anonymized *statistical priors* about the micro-market —
 * they are NOT verified facts and MUST NOT be quoted to the buyer as such. The
 * section is explicitly framed as guidance for qualifying/steering the buyer,
 * never as a source the AI may cite (the verified fact sheets remain the only
 * quotable ground truth). This preserves the no-invented-facts guarantee.
 */
export function buildCorridorContext(
  corridor: string,
  aggregates: CorridorAggregate[],
): string | null {
  if (!aggregates.length) return null;

  const lines: string[] = [];

  const price = find<PriceElasticityValue>(aggregates, IntelligenceMetricType.PRICE_ELASTICITY);
  if (price?.recommendedBandPaise) {
    lines.push(
      `- Typical budget band in ${corridor}: ${paiseLabel(price.recommendedBandPaise.low)}–${paiseLabel(
        price.recommendedBandPaise.high,
      )} (from ${price.withBudget} comparable buyers).`,
    );
  }

  const cadence = find<CadenceConversionValue>(
    aggregates,
    IntelligenceMetricType.CADENCE_CONVERSION,
  );
  if (cadence && cadence.converted > 0) {
    const topBucket = [...cadence.buckets].sort((a, b) => b.share - a.share)[0];
    if (topBucket && topBucket.share > 0) {
      lines.push(
        `- Site-visit conversion here runs ~${pct(cadence.conversionRate)}; most conversions happen ${bucketPhrase(
          topBucket.label,
        )}${cadence.medianDaysToConvert != null ? ` (median ${cadence.medianDaysToConvert} days to visit)` : ''}. Keep following up in that window.`,
      );
    }
  }

  const objections = find<ObjectionFrequencyValue>(
    aggregates,
    IntelligenceMetricType.OBJECTION_FREQUENCY,
  );
  if (objections && objections.topObjections.length) {
    const top = objections.topObjections
      .slice(0, 3)
      .map((o) => `${objectionPhrase(o.label)} (${pct(o.share)})`)
      .join(', ');
    lines.push(`- Common objections in this corridor: ${top}. Be ready to address these.`);
  }

  const seasonal = find<SeasonalVelocityValue>(
    aggregates,
    IntelligenceMetricType.SEASONAL_VELOCITY,
  );
  if (seasonal && seasonal.months.length >= 3) {
    const best = [...seasonal.months].sort((a, b) => b.conversionRate - a.conversionRate)[0];
    if (best) {
      lines.push(
        `- Seasonality: ${monthLabel(best.month)} has historically been the strongest month for conversions in ${corridor}.`,
      );
    }
  }

  if (!lines.length) return null;

  return [
    `<micro_market_intelligence corridor="${corridor}">`,
    'Anonymized corridor priors (statistical guidance only — DO NOT quote these to the buyer as facts; the verified fact sheets remain the only quotable source). Use them to qualify, price-anchor, and time your follow-ups:',
    ...lines,
    '</micro_market_intelligence>',
  ].join('\n');
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function find<T>(aggregates: CorridorAggregate[], metric: IntelligenceMetricType): T | null {
  const row = aggregates.find((a) => a.metricType === metric);
  return row ? (row.metricValue as T) : null;
}

function bucketPhrase(label: string): string {
  switch (label) {
    case 'SAME_DAY':
      return 'within the first day';
    case 'WEEK_1':
      return 'in the first week';
    case 'WEEK_2':
      return 'in the second week';
    case 'MONTH_1':
      return 'within the first month';
    default:
      return 'after the first month';
  }
}

function objectionPhrase(label: string): string {
  switch (label) {
    case 'PRICE_TOO_HIGH':
      return 'price sensitivity';
    case 'LOAN_FINANCE':
      return 'home-loan/financing';
    case 'POSSESSION_DELAY':
      return 'possession timelines';
    case 'LOCATION':
      return 'location/connectivity';
    case 'SIZE_LAYOUT':
      return 'size/layout';
    case 'LEGAL_RERA':
      return 'legal/RERA';
    case 'AMENITIES':
      return 'amenities';
    default:
      return 'other concerns';
  }
}

function monthLabel(monthKey: string): string {
  const [, m] = monthKey.split('-');
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const idx = Number(m) - 1;
  return names[idx] ?? monthKey;
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Format paise into an Indian lakh/crore label (mirrors the grounded prompt). */
function paiseLabel(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 1e7) return `₹${round1(rupees / 1e7)} Cr`;
  if (rupees >= 1e5) return `₹${round1(rupees / 1e5)} L`;
  return `₹${Math.round(rupees)}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
