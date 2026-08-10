/** Pure corridor-context formatter tests — the AI prompt-injection string. */

import { IntelligenceMetricType } from '@gosumo/shared';
import { buildCorridorContext, CorridorAggregate } from './corridor-context.util';

function agg(metricType: IntelligenceMetricType, metricValue: unknown): CorridorAggregate {
  return { metricType, metricValue, sampleSize: 6 };
}

describe('buildCorridorContext', () => {
  it('returns null when there are no aggregates', () => {
    expect(buildCorridorContext('Whitefield', [])).toBeNull();
  });

  it('renders a budget band from price elasticity', () => {
    const out = buildCorridorContext('Whitefield', [
      agg(IntelligenceMetricType.PRICE_ELASTICITY, {
        withBudget: 6,
        recommendedBandPaise: { low: 80_00_000 * 100, high: 1_20_00_000 * 100 },
      }),
    ]);
    expect(out).toContain('Typical budget band in Whitefield');
    expect(out).toContain('Cr'); // crore-scale label
    expect(out).toContain('DO NOT quote');
  });

  it('renders cadence, objection and seasonal guidance', () => {
    const out = buildCorridorContext('Sarjapur', [
      agg(IntelligenceMetricType.CADENCE_CONVERSION, {
        total: 10,
        converted: 4,
        conversionRate: 0.4,
        medianDaysToConvert: 6,
        buckets: [
          { label: 'WEEK_1', converted: 3, share: 0.75 },
          { label: 'SAME_DAY', converted: 1, share: 0.25 },
        ],
      }),
      agg(IntelligenceMetricType.OBJECTION_FREQUENCY, {
        totalObjections: 8,
        topObjections: [{ label: 'PRICE_TOO_HIGH', count: 5, share: 0.62 }],
        byConfig: [],
      }),
      agg(IntelligenceMetricType.SEASONAL_VELOCITY, {
        months: [
          { month: '2026-01', leads: 5, converted: 1, conversionRate: 0.2 },
          { month: '2026-02', leads: 6, converted: 3, conversionRate: 0.5 },
          { month: '2026-03', leads: 4, converted: 0, conversionRate: 0 },
        ],
      }),
    ]);
    expect(out).toContain('Site-visit conversion here runs ~40%');
    expect(out).toContain('first week');
    expect(out).toContain('price sensitivity');
    expect(out).toContain('February'); // strongest month
  });

  it('returns null when aggregates carry nothing worth saying', () => {
    const out = buildCorridorContext('Empty', [
      agg(IntelligenceMetricType.PRICE_ELASTICITY, { withBudget: 0, recommendedBandPaise: null }),
      agg(IntelligenceMetricType.CADENCE_CONVERSION, { total: 3, converted: 0, conversionRate: 0, medianDaysToConvert: null, buckets: [] }),
    ]);
    expect(out).toBeNull();
  });
});
