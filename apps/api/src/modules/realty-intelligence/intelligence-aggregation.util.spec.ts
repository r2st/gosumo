/**
 * Pure aggregation-util tests. No DB, no Nest — just the corridor math and the
 * anti-reconstruction (minimum-n) guarantees.
 */

import { IntelligenceMetricType, LeadStage, LeadSource } from '@gosumo/shared';
import {
  IntelLead,
  computeAggregatesForBusiness,
  groupByCorridor,
  cadenceConversion,
  objectionFrequency,
  categorizeObjection,
  priceElasticity,
  sourceQuality,
  seasonalVelocity,
  percentile,
  quantiles,
  monthKey,
  isConverted,
  isQualified,
  CadenceConversionValue,
  PriceElasticityValue,
  SourceQualityValue,
  SeasonalVelocityValue,
  ObjectionFrequencyValue,
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

describe('intelligence-aggregation.util', () => {
  describe('stage semantics', () => {
    it('treats visit-and-beyond as converted', () => {
      expect(isConverted(LeadStage.VISIT_BOOKED)).toBe(true);
      expect(isConverted(LeadStage.CLOSED_WON)).toBe(true);
      expect(isConverted(LeadStage.NEW)).toBe(false);
      expect(isConverted(LeadStage.CLOSED_LOST)).toBe(false);
    });

    it('treats qualified-and-beyond as qualified', () => {
      expect(isQualified(LeadStage.QUALIFIED)).toBe(true);
      expect(isQualified(LeadStage.VISITED)).toBe(true);
      expect(isQualified(LeadStage.CONTACTED)).toBe(false);
    });
  });

  describe('groupByCorridor', () => {
    it('attributes a lead to each distinct locality it named', () => {
      const g = groupByCorridor([
        lead({ localities: ['Whitefield', 'Sarjapur'] }),
        lead({ localities: ['Whitefield'] }),
      ]);
      expect(g.get('Whitefield')).toHaveLength(2);
      expect(g.get('Sarjapur')).toHaveLength(1);
    });

    it('drops leads with no locality and dedupes repeats within one lead', () => {
      const g = groupByCorridor([
        lead({ localities: [] }),
        lead({ localities: ['Whitefield', 'Whitefield ', ' Whitefield'] }),
      ]);
      expect(g.has('Whitefield')).toBe(true);
      expect(g.get('Whitefield')).toHaveLength(1); // one lead, deduped
    });
  });

  describe('percentile / quantiles', () => {
    it('interpolates percentiles', () => {
      expect(percentile([], 0.5)).toBe(0);
      expect(percentile([10], 0.5)).toBe(10);
      expect(percentile([10, 20, 30], 0.5)).toBe(20);
      expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    });

    it('rounds quantile triples', () => {
      const q = quantiles([100, 200, 300, 400, 500]);
      expect(q.p25).toBe(200);
      expect(q.p50).toBe(300);
      expect(q.p75).toBe(400);
    });
  });

  describe('cadenceConversion', () => {
    it('computes conversion rate and time-to-convert buckets', () => {
      const leads = [
        lead({ stage: LeadStage.VISIT_BOOKED, firstTouchAt: new Date('2026-03-10'), lastActivityAt: new Date('2026-03-10T06:00:00Z') }), // same day
        lead({ stage: LeadStage.VISITED, firstTouchAt: new Date('2026-03-10'), lastActivityAt: new Date('2026-03-15') }), // week 1
        lead({ stage: LeadStage.NEW }), // not converted
        lead({ stage: LeadStage.CLOSED_LOST }), // not converted
      ];
      const v = cadenceConversion(leads) as CadenceConversionValue;
      expect(v.total).toBe(4);
      expect(v.converted).toBe(2);
      expect(v.conversionRate).toBe(0.5);
      expect(v.medianDaysToConvert).not.toBeNull();
      const sameDay = v.buckets.find((b) => b.label === 'SAME_DAY')!;
      expect(sameDay.converted).toBe(1);
      const week1 = v.buckets.find((b) => b.label === 'WEEK_1')!;
      expect(week1.converted).toBe(1);
    });

    it('handles a corridor with zero conversions', () => {
      const v = cadenceConversion([lead({ stage: LeadStage.NEW })]) as CadenceConversionValue;
      expect(v.conversionRate).toBe(0);
      expect(v.medianDaysToConvert).toBeNull();
    });
  });

  describe('categorizeObjection', () => {
    it('maps keywords to normalized categories', () => {
      expect(categorizeObjection('too expensive for my budget')).toBe('PRICE_TOO_HIGH');
      expect(categorizeObjection('need a home loan / EMI')).toBe('LOAN_FINANCE');
      expect(categorizeObjection('possession is delayed')).toBe('POSSESSION_DELAY');
      expect(categorizeObjection('RERA approval unclear')).toBe('LEGAL_RERA');
      expect(categorizeObjection('the vibe is off')).toBe('OTHER');
    });
  });

  describe('objectionFrequency', () => {
    it('surfaces objection labels only above the minN threshold (k-anonymity)', () => {
      const leads = [
        ...Array.from({ length: 5 }, () => lead({ objections: ['too costly'] })),
        lead({ objections: ['loan issue'] }), // only 1 → suppressed
      ];
      const v = objectionFrequency(leads, 5) as ObjectionFrequencyValue;
      expect(v.totalObjections).toBe(6);
      const labels = v.topObjections.map((o) => o.label);
      expect(labels).toContain('PRICE_TOO_HIGH');
      expect(labels).not.toContain('LOAN_FINANCE'); // below minN
    });
  });

  describe('priceElasticity', () => {
    it('computes budget quantiles and a recommended band', () => {
      const leads = [
        lead({ budgetMinPaise: L(0.8), budgetMaxPaise: L(1.0) }),
        lead({ budgetMinPaise: L(0.9), budgetMaxPaise: L(1.2) }),
        lead({ budgetMinPaise: L(1.0), budgetMaxPaise: L(1.5) }),
        lead({ budgetMinPaise: null, budgetMaxPaise: null }), // no budget
      ];
      const v = priceElasticity(leads) as PriceElasticityValue;
      expect(v.withBudget).toBe(3);
      expect(v.budgetMinPaise).not.toBeNull();
      expect(v.recommendedBandPaise).not.toBeNull();
      expect(v.recommendedBandPaise!.high).toBeGreaterThanOrEqual(v.recommendedBandPaise!.low);
    });

    it('returns nulls when no budgets are present', () => {
      const v = priceElasticity([lead({ budgetMinPaise: null, budgetMaxPaise: null })]) as PriceElasticityValue;
      expect(v.withBudget).toBe(0);
      expect(v.budgetMinPaise).toBeNull();
      expect(v.recommendedBandPaise).toBeNull();
    });
  });

  describe('sourceQuality', () => {
    it('scores each source above minN and hides rare ones', () => {
      const leads = [
        ...Array.from({ length: 5 }, () =>
          lead({ source: LeadSource.PORTAL, stage: LeadStage.VISIT_BOOKED, qualScore: 80 }),
        ),
        lead({ source: LeadSource.REFERRAL, stage: LeadStage.NEW }), // only 1 → hidden
      ];
      const v = sourceQuality(leads, 5) as SourceQualityValue;
      const names = v.sources.map((s) => s.source);
      expect(names).toContain(LeadSource.PORTAL);
      expect(names).not.toContain(LeadSource.REFERRAL);
      const portal = v.sources.find((s) => s.source === LeadSource.PORTAL)!;
      expect(portal.visitRate).toBe(1);
      expect(portal.avgQualScore).toBe(80);
    });

    it('with minN=1 reports every source (own-business report)', () => {
      const v = sourceQuality([lead({ source: LeadSource.CSV })], 1) as SourceQualityValue;
      expect(v.sources).toHaveLength(1);
    });
  });

  describe('seasonalVelocity', () => {
    it('buckets leads by month with per-month conversion', () => {
      const leads = [
        lead({ firstTouchAt: new Date('2026-01-05'), stage: LeadStage.VISITED }),
        lead({ firstTouchAt: new Date('2026-01-20'), stage: LeadStage.NEW }),
        lead({ firstTouchAt: new Date('2026-02-10'), stage: LeadStage.CLOSED_WON }),
      ];
      const v = seasonalVelocity(leads) as SeasonalVelocityValue;
      expect(v.months).toHaveLength(2);
      const jan = v.months.find((m) => m.month === '2026-01')!;
      expect(jan.leads).toBe(2);
      expect(jan.converted).toBe(1);
      expect(jan.conversionRate).toBe(0.5);
    });
  });

  describe('monthKey', () => {
    it('formats YYYY-MM in UTC', () => {
      expect(monthKey(new Date('2026-07-03T00:00:00Z'))).toBe('2026-07');
    });
  });

  describe('computeAggregatesForBusiness', () => {
    it('skips corridors below minN and emits five metrics for the rest', () => {
      const leads = [
        ...Array.from({ length: 6 }, () => lead({ localities: ['Whitefield'] })),
        ...Array.from({ length: 2 }, () => lead({ localities: ['Sarjapur'] })), // below minN=5
      ];
      const aggs = computeAggregatesForBusiness(leads, 5);
      const corridors = new Set(aggs.map((a) => a.corridor));
      expect(corridors.has('Whitefield')).toBe(true);
      expect(corridors.has('Sarjapur')).toBe(false);

      const whitefield = aggs.filter((a) => a.corridor === 'Whitefield');
      expect(whitefield).toHaveLength(5);
      expect(new Set(whitefield.map((a) => a.metricType))).toEqual(
        new Set([
          IntelligenceMetricType.CADENCE_CONVERSION,
          IntelligenceMetricType.OBJECTION_FREQUENCY,
          IntelligenceMetricType.PRICE_ELASTICITY,
          IntelligenceMetricType.SOURCE_QUALITY,
          IntelligenceMetricType.SEASONAL_VELOCITY,
        ]),
      );
      expect(whitefield[0]!.sampleSize).toBe(6);
    });

    it('returns nothing when every corridor is too small', () => {
      const aggs = computeAggregatesForBusiness([lead(), lead()], 5);
      expect(aggs).toHaveLength(0);
    });
  });
});
