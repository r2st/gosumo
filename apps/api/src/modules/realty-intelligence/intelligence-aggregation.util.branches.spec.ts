/**
 * Branch-focused companion to `intelligence-aggregation.util.spec.ts`.
 *
 * The corridor math and the minimum-n guarantees are pinned there; this file
 * covers the degenerate inputs a real tenant's data eventually produces — a
 * converted lead that was never touched again, a corridor with no leads at
 * all, a lead with no unit config, a blank objection string, a one-sided
 * budget, and a corridor spanning several months.
 */

import { LeadStage, LeadSource } from '@gosumo/shared';
import {
  IntelLead,
  cadenceConversion,
  objectionFrequency,
  priceElasticity,
  seasonalVelocity,
} from './intelligence-aggregation.util';

const L = (crore: number) => crore * 1e7 * 100; // crore rupees → paise

function lead(overrides: Partial<IntelLead> = {}): IntelLead {
  return {
    source: LeadSource.PORTAL,
    stage: LeadStage.NEW,
    qualScore: 40,
    localities: ['Whitefield'],
    budgetMinPaise: L(0.8),
    budgetMaxPaise: L(1.0),
    config: '2BHK',
    objections: [],
    firstTouchAt: new Date('2026-03-10T00:00:00Z'),
    lastActivityAt: new Date('2026-03-12T00:00:00Z'),
    ...overrides,
  };
}

describe('cadenceConversion — degenerate inputs', () => {
  it('measures zero days for a converted lead with no recorded follow-up', () => {
    // A walk-in that books on first contact never gets a lastActivityAt.
    const result = cadenceConversion([
      lead({ stage: LeadStage.VISIT_BOOKED, lastActivityAt: null }),
    ]);

    expect(result.total).toBe(1);
    expect(result.converted).toBe(1);
    expect(result.conversionRate).toBe(1);
    expect(result.medianDaysToConvert).toBe(0);
    expect(result.buckets.find((b) => b.label === 'SAME_DAY')).toEqual({
      label: 'SAME_DAY',
      converted: 1,
      share: 1,
    });
  });

  it('returns a zeroed shape for an empty corridor rather than NaN', () => {
    const result = cadenceConversion([]);

    expect(result).toEqual({
      total: 0,
      converted: 0,
      conversionRate: 0,
      medianDaysToConvert: null,
      buckets: [
        { label: 'SAME_DAY', converted: 0, share: 0 },
        { label: 'WEEK_1', converted: 0, share: 0 },
        { label: 'WEEK_2', converted: 0, share: 0 },
        { label: 'MONTH_1', converted: 0, share: 0 },
        { label: 'LATER', converted: 0, share: 0 },
      ],
    });
  });

  it('clamps a lastActivityAt that predates first touch to zero days', () => {
    const result = cadenceConversion([
      lead({
        stage: LeadStage.CLOSED_WON,
        firstTouchAt: new Date('2026-03-10T00:00:00Z'),
        lastActivityAt: new Date('2026-03-01T00:00:00Z'),
      }),
    ]);

    expect(result.medianDaysToConvert).toBe(0);
  });
});

describe('objectionFrequency — degenerate inputs', () => {
  it('buckets a lead with no unit config under UNKNOWN', () => {
    const leads = Array.from({ length: 3 }, () =>
      lead({ config: null, objections: ['price is too high'] }),
    );

    const result = objectionFrequency(leads, 2);

    expect(result.totalObjections).toBe(3);
    expect(result.byConfig).toEqual([
      { config: 'UNKNOWN', topObjection: 'PRICE_TOO_HIGH', count: 3 },
    ]);
  });

  it('uppercases a lowercase config so 2bhk and 2BHK are one bucket', () => {
    const result = objectionFrequency(
      [
        lead({ config: '2bhk', objections: ['loan approval pending'] }),
        lead({ config: '2BHK', objections: ['emi is high'] }),
      ],
      2,
    );

    expect(result.byConfig).toEqual([
      { config: '2BHK', topObjection: 'LOAN_FINANCE', count: 2 },
    ]);
  });

  it('drops empty and whitespace-only objection strings', () => {
    const result = objectionFrequency(
      [lead({ objections: ['', '   ', 'possession keeps slipping'] })],
      1,
    );

    expect(result.totalObjections).toBe(1);
    expect(result.topObjections).toEqual([
      { label: 'POSSESSION_DELAY', count: 1, share: 1 },
    ]);
  });

  it('returns empty lists when no lead recorded an objection', () => {
    const result = objectionFrequency([lead(), lead()], 1);

    expect(result).toEqual({ totalObjections: 0, topObjections: [], byConfig: [] });
  });
});

describe('priceElasticity — one-sided budgets', () => {
  it('counts a lead that named only a ceiling', () => {
    const result = priceElasticity([
      lead({ budgetMinPaise: null, budgetMaxPaise: L(1.2) }),
    ]);

    expect(result.withBudget).toBe(1);
    expect(result.budgetMinPaise).toBeNull();
    expect(result.budgetMaxPaise).toEqual({
      p25: L(1.2),
      p50: L(1.2),
      p75: L(1.2),
    });
    // With no min quantiles, the band anchors on the max triple alone.
    expect(result.recommendedBandPaise).toEqual({ low: L(1.2), high: L(1.2) });
  });

  it('counts a lead that named only a floor', () => {
    const result = priceElasticity([
      lead({ budgetMinPaise: L(0.9), budgetMaxPaise: null }),
    ]);

    expect(result.withBudget).toBe(1);
    expect(result.budgetMaxPaise).toBeNull();
    expect(result.recommendedBandPaise).toEqual({ low: L(0.9), high: L(0.9) });
  });

  it('ignores a zero budget as "not stated"', () => {
    const result = priceElasticity([lead({ budgetMinPaise: 0, budgetMaxPaise: 0 })]);

    expect(result.withBudget).toBe(0);
    expect(result.budgetMinPaise).toBeNull();
    expect(result.budgetMaxPaise).toBeNull();
    expect(result.recommendedBandPaise).toBeNull();
  });

  it('suppresses an inverted band', () => {
    // p25 of the mins above p75 of the maxes is not a band anyone should anchor on.
    const result = priceElasticity([
      lead({ budgetMinPaise: L(3.0), budgetMaxPaise: L(0.5) }),
      lead({ budgetMinPaise: L(3.0), budgetMaxPaise: L(0.5) }),
    ]);

    expect(result.recommendedBandPaise).toBeNull();
  });
});

describe('seasonalVelocity — ordering', () => {
  it('sorts months ascending regardless of input order', () => {
    const result = seasonalVelocity([
      lead({ firstTouchAt: new Date('2026-05-02T00:00:00Z'), stage: LeadStage.VISITED }),
      lead({ firstTouchAt: new Date('2026-01-15T00:00:00Z') }),
      lead({ firstTouchAt: new Date('2026-03-20T00:00:00Z'), stage: LeadStage.CLOSED_WON }),
      lead({ firstTouchAt: new Date('2026-01-28T00:00:00Z') }),
    ]);

    expect(result.months.map((m) => m.month)).toEqual(['2026-01', '2026-03', '2026-05']);
    expect(result.months[0]).toEqual({
      month: '2026-01',
      leads: 2,
      converted: 0,
      conversionRate: 0,
    });
    expect(result.months[2]).toEqual({
      month: '2026-05',
      leads: 1,
      converted: 1,
      conversionRate: 1,
    });
  });

  it('returns no months for an empty corridor', () => {
    expect(seasonalVelocity([])).toEqual({ months: [] });
  });
});
