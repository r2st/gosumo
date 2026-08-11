/**
 * buildCorridorContext — the label vocabularies and the numeric fallbacks.
 *
 * This section is injected verbatim into the realty grounded prompt, so the
 * exact wording of each bucket and objection label is what the model sees.
 * A label that silently fell through to its `default` arm would read as
 * "after the first month" or "other concerns" — plausible enough to go
 * unnoticed in review, and wrong.
 *
 * Every arm of both switches is pinned here, along with the month-name lookup
 * (which must degrade to the raw key rather than emit `undefined`) and the
 * lakh/crore money formatter at its boundaries.
 */

import { IntelligenceMetricType } from '@gosumo/shared';
import {
  buildCorridorContext,
  type CorridorAggregate,
} from './corridor-context.util';

const CORRIDOR = 'Wakad';

function agg(
  metricType: IntelligenceMetricType,
  metricValue: unknown,
): CorridorAggregate {
  return { metricType, metricValue, sampleSize: 6 };
}

function cadenceWith(
  label: string,
  medianDaysToConvert: number | null = 9,
): CorridorAggregate {
  return agg(IntelligenceMetricType.CADENCE_CONVERSION, {
    converted: 12,
    conversionRate: 0.25,
    medianDaysToConvert,
    buckets: [
      { label, share: 0.7 },
      { label: 'OTHER', share: 0.3 },
    ],
  });
}

function objectionsWith(labels: string[]): CorridorAggregate {
  return agg(IntelligenceMetricType.OBJECTION_FREQUENCY, {
    topObjections: labels.map((label, i) => ({ label, share: 0.5 - i * 0.1 })),
  });
}

function contextFor(aggregates: CorridorAggregate[]): string {
  const out = buildCorridorContext(CORRIDOR, aggregates);
  if (out === null) throw new Error('expected a rendered corridor section');
  return out;
}

describe('buildCorridorContext — bucket phrasing', () => {
  it.each([
    ['SAME_DAY', 'within the first day'],
    ['WEEK_1', 'in the first week'],
    ['WEEK_2', 'in the second week'],
    ['MONTH_1', 'within the first month'],
  ])('renders %s as "%s"', (label, phrase) => {
    expect(contextFor([cadenceWith(label)])).toContain(phrase);
  });

  it('falls back to "after the first month" for an unrecognised bucket', () => {
    expect(contextFor([cadenceWith('QUARTER_2')])).toContain(
      'after the first month',
    );
  });

  it('omits the median clause when there is no median', () => {
    const out = contextFor([cadenceWith('WEEK_1', null)]);

    expect(out).toContain('in the first week');
    expect(out).not.toContain('median');
  });

  it('includes the median clause when one is known', () => {
    expect(contextFor([cadenceWith('WEEK_1', 9)])).toContain(
      '(median 9 days to visit)',
    );
  });
});

describe('buildCorridorContext — objection phrasing', () => {
  it.each([
    ['PRICE_TOO_HIGH', 'price sensitivity'],
    ['LOAN_FINANCE', 'home-loan/financing'],
    ['POSSESSION_DELAY', 'possession timelines'],
    ['LOCATION', 'location/connectivity'],
    ['SIZE_LAYOUT', 'size/layout'],
    ['LEGAL_RERA', 'legal/RERA'],
    ['AMENITIES', 'amenities'],
  ])('renders %s as "%s"', (label, phrase) => {
    expect(contextFor([objectionsWith([label])])).toContain(phrase);
  });

  it('falls back to "other concerns" for an unrecognised objection', () => {
    expect(contextFor([objectionsWith(['ASTROLOGY'])])).toContain(
      'other concerns',
    );
  });

  it('surfaces at most the top three objections', () => {
    const out = contextFor([
      objectionsWith([
        'PRICE_TOO_HIGH',
        'LOAN_FINANCE',
        'LOCATION',
        'AMENITIES',
      ]),
    ]);

    expect(out).toContain('price sensitivity');
    expect(out).toContain('home-loan/financing');
    expect(out).toContain('location/connectivity');
    expect(out).not.toContain('amenities');
  });
});

describe('buildCorridorContext — month labels', () => {
  function seasonal(bestMonth: string): CorridorAggregate {
    return agg(IntelligenceMetricType.SEASONAL_VELOCITY, {
      months: [
        { month: bestMonth, conversionRate: 0.4 },
        { month: '2026-02', conversionRate: 0.1 },
        { month: '2026-03', conversionRate: 0.2 },
      ],
    });
  }

  it('names the first and last months of the year correctly', () => {
    expect(contextFor([seasonal('2026-01')])).toContain('January');
    expect(contextFor([seasonal('2026-12')])).toContain('December');
  });

  it('falls back to the raw key for a month number out of range', () => {
    const out = contextFor([seasonal('2026-13')]);

    expect(out).toContain('2026-13');
    expect(out).not.toContain('undefined');
  });

  it('falls back to the raw key for an unparseable month', () => {
    const out = contextFor([seasonal('not-a-month')]);

    expect(out).toContain('not-a-month');
    expect(out).not.toContain('undefined');
  });
});

describe('buildCorridorContext — money formatting', () => {
  function price(low: number, high: number): CorridorAggregate {
    return agg(IntelligenceMetricType.PRICE_ELASTICITY, {
      recommendedBandPaise: { low, high },
      withBudget: 8,
    });
  }

  it('formats a crore-scale band', () => {
    // 1.5 Cr and 2.25 Cr, in paise.
    expect(contextFor([price(1.5e9, 2.25e9)])).toContain('₹1.5 Cr–₹2.3 Cr');
  });

  it('formats a lakh-scale band', () => {
    // 45 L and 60 L, in paise.
    expect(contextFor([price(45e7, 60e7)])).toContain('₹45 L–₹60 L');
  });

  it('formats a sub-lakh band in plain rupees', () => {
    expect(contextFor([price(50000 * 100, 99000 * 100)])).toContain(
      '₹50000–₹99000',
    );
  });
});

describe('buildCorridorContext — suppression', () => {
  it('omits the cadence line when nothing converted', () => {
    const out = buildCorridorContext(CORRIDOR, [
      agg(IntelligenceMetricType.CADENCE_CONVERSION, {
        converted: 0,
        conversionRate: 0,
        medianDaysToConvert: null,
        buckets: [{ label: 'WEEK_1', share: 1 }],
      }),
    ]);

    expect(out).toBeNull();
  });

  it('omits the cadence line when the top bucket has no share', () => {
    const out = buildCorridorContext(CORRIDOR, [
      agg(IntelligenceMetricType.CADENCE_CONVERSION, {
        converted: 5,
        conversionRate: 0.2,
        medianDaysToConvert: 4,
        buckets: [{ label: 'WEEK_1', share: 0 }],
      }),
    ]);

    expect(out).toBeNull();
  });

  it('omits seasonality below three months of history', () => {
    const out = buildCorridorContext(CORRIDOR, [
      agg(IntelligenceMetricType.SEASONAL_VELOCITY, {
        months: [
          { month: '2026-01', conversionRate: 0.4 },
          { month: '2026-02', conversionRate: 0.1 },
        ],
      }),
    ]);

    expect(out).toBeNull();
  });

  it('omits the objection line when the list is empty', () => {
    expect(buildCorridorContext(CORRIDOR, [objectionsWith([])])).toBeNull();
  });

  it('still frames the section as unquotable guidance when it does render', () => {
    const out = contextFor([cadenceWith('WEEK_1')]);

    expect(out).toContain(`<micro_market_intelligence corridor="${CORRIDOR}">`);
    expect(out).toContain('DO NOT quote these to the buyer as facts');
    expect(out).toContain('</micro_market_intelligence>');
  });
});
