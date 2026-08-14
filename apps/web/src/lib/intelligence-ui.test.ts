import { describe, expect, it } from 'vitest';
import {
  bucketLabel,
  getCadence,
  getObjections,
  getPrice,
  getSeasonal,
  monthLabel,
  objectionLabel,
  pickMetric,
  ratioPct,
  sourceLabel,
} from './intelligence-ui';
import type {
  CadenceConversionValue,
  IntelligenceAggregate,
  IntelligenceMetricType,
  ObjectionFrequencyValue,
  PriceElasticityValue,
  SeasonalVelocityValue,
} from './intelligence-types';

function aggregate(metricType: IntelligenceMetricType, metricValue: unknown): IntelligenceAggregate {
  return {
    id: `agg-${metricType}`,
    corridor: 'Powai',
    metricType,
    metricValue,
    sampleSize: 120,
    minNThreshold: 25,
    periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

const cadence: CadenceConversionValue = {
  total: 200,
  converted: 64,
  conversionRate: 0.32,
  medianDaysToConvert: 9,
  buckets: [{ label: 'SAME_DAY', converted: 12, share: 0.19 }],
};

const objections: ObjectionFrequencyValue = {
  totalObjections: 88,
  topObjections: [{ label: 'PRICE_TOO_HIGH', count: 40, share: 0.45 }],
  byConfig: [{ config: '2BHK', topObjection: 'PRICE_TOO_HIGH', count: 22 }],
};

const price: PriceElasticityValue = {
  withBudget: 140,
  budgetMinPaise: { p25: 50_00_000_00, p50: 65_00_000_00, p75: 80_00_000_00 },
  budgetMaxPaise: null,
  recommendedBandPaise: { low: 60_00_000_00, high: 85_00_000_00 },
};

const seasonal: SeasonalVelocityValue = {
  months: [{ month: '2026-07', leads: 45, converted: 12, conversionRate: 0.27 }],
};

describe('pickMetric', () => {
  const aggregates = [
    aggregate('CADENCE_CONVERSION', cadence),
    aggregate('OBJECTION_FREQUENCY', objections),
    aggregate('PRICE_ELASTICITY', price),
    aggregate('SEASONAL_VELOCITY', seasonal),
  ];

  it('returns the payload of the matching metric', () => {
    expect(pickMetric<CadenceConversionValue>(aggregates, 'CADENCE_CONVERSION')).toBe(cadence);
  });

  it('returns null when the metric is absent from the list', () => {
    expect(pickMetric(aggregates, 'SOURCE_QUALITY')).toBeNull();
  });

  it('returns null for an undefined list, so a still-loading page renders empty', () => {
    expect(pickMetric(undefined, 'CADENCE_CONVERSION')).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(pickMetric([], 'CADENCE_CONVERSION')).toBeNull();
  });

  describe('typed accessors', () => {
    it('each pulls its own metric', () => {
      expect(getCadence(aggregates)).toBe(cadence);
      expect(getObjections(aggregates)).toBe(objections);
      expect(getPrice(aggregates)).toBe(price);
      expect(getSeasonal(aggregates)).toBe(seasonal);
    });

    it('each returns null when no aggregates have loaded', () => {
      expect(getCadence(undefined)).toBeNull();
      expect(getObjections(undefined)).toBeNull();
      expect(getPrice(undefined)).toBeNull();
      expect(getSeasonal(undefined)).toBeNull();
    });
  });
});

describe('objectionLabel', () => {
  it('renders the backend code in the requested language', () => {
    expect(objectionLabel('PRICE_TOO_HIGH', 'en')).toBe('Price too high');
    expect(objectionLabel('PRICE_TOO_HIGH', 'hi')).toBe('कीमत ज़्यादा');
  });

  it('falls back to the raw code for an objection the UI does not know', () => {
    // The backend can add an OBJECTION_RULES category before the dashboard
    // ships a label for it; showing the code beats showing nothing.
    expect(objectionLabel('VAASTU', 'en')).toBe('VAASTU');
    expect(objectionLabel('VAASTU', 'hi')).toBe('VAASTU');
  });

  it('covers every category in both languages', () => {
    const codes = [
      'PRICE_TOO_HIGH',
      'LOAN_FINANCE',
      'POSSESSION_DELAY',
      'LOCATION',
      'SIZE_LAYOUT',
      'LEGAL_RERA',
      'AMENITIES',
      'OTHER',
    ];
    for (const code of codes) {
      expect(objectionLabel(code, 'en')).not.toBe(code);
      expect(objectionLabel(code, 'hi')).not.toBe(code);
    }
  });
});

describe('bucketLabel', () => {
  it('renders time-to-visit buckets in both languages', () => {
    expect(bucketLabel('SAME_DAY', 'en')).toBe('Same day');
    expect(bucketLabel('SAME_DAY', 'hi')).toBe('उसी दिन');
    expect(bucketLabel('LATER', 'en')).toBe('Later');
  });

  it('falls back to the raw bucket code', () => {
    expect(bucketLabel('QUARTER_2', 'en')).toBe('QUARTER_2');
  });

  it('covers every bucket in both languages', () => {
    for (const code of ['SAME_DAY', 'WEEK_1', 'WEEK_2', 'MONTH_1', 'LATER']) {
      expect(bucketLabel(code, 'en')).not.toBe(code);
      expect(bucketLabel(code, 'hi')).not.toBe(code);
    }
  });
});

describe('sourceLabel', () => {
  it('renders lead sources in both languages', () => {
    expect(sourceLabel('CTWA', 'en')).toBe('WhatsApp');
    expect(sourceLabel('CTWA', 'hi')).toBe('व्हाट्सऐप');
    expect(sourceLabel('EXCHANGE_INBOUND', 'en')).toBe('Exchange');
  });

  it('keeps acronym sources identical across languages', () => {
    expect(sourceLabel('IVR', 'en')).toBe('IVR');
    expect(sourceLabel('IVR', 'hi')).toBe('IVR');
  });

  it('falls back to the raw source for an enum value the UI has not learned', () => {
    expect(sourceLabel('BILLBOARD', 'en')).toBe('BILLBOARD');
  });

  it('covers every LeadSource value in both languages', () => {
    const sources = [
      'PORTAL',
      'META_LEAD_AD',
      'CTWA',
      'IVR',
      'REFERRAL',
      'CSV',
      'WALK_IN',
      'EXCHANGE_INBOUND',
      'MANUAL',
    ];
    for (const source of sources) {
      expect(sourceLabel(source, 'en')).toBeTruthy();
      expect(sourceLabel(source, 'hi')).toBeTruthy();
    }
  });
});

describe('monthLabel', () => {
  it('renders a YYYY-MM as an abbreviated month and two-digit year', () => {
    expect(monthLabel('2026-07', 'en')).toBe("Jul '26");
    expect(monthLabel('2026-07', 'hi')).toBe("जुल '26");
  });

  it('handles January and December, the off-by-one boundaries', () => {
    expect(monthLabel('2026-01', 'en')).toBe("Jan '26");
    expect(monthLabel('2026-12', 'en')).toBe("Dec '26");
  });

  it('falls back to the raw month number when the index is out of range', () => {
    // Month 13 has no name; showing "13 '26" is wrong-looking enough to notice
    // but does not blow up the chart axis.
    expect(monthLabel('2026-13', 'en')).toBe("13 '26");
    expect(monthLabel('2026-00', 'en')).toBe("00 '26");
  });

  it('does not throw on a malformed month string', () => {
    expect(monthLabel('', 'en')).toBe("undefined '");
    expect(monthLabel('2026', 'en')).toBe("undefined '26");
  });
});

describe('ratioPct', () => {
  it('renders a 0..1 ratio as a whole percentage', () => {
    expect(ratioPct(0.42)).toBe('42%');
    expect(ratioPct(0)).toBe('0%');
    expect(ratioPct(1)).toBe('100%');
  });

  it('rounds to the nearest whole percent', () => {
    expect(ratioPct(0.425)).toBe('43%');
    expect(ratioPct(0.4249)).toBe('42%');
  });
});
