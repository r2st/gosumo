import {
  matchExchange,
  FIT_WEIGHT,
  RELIABILITY_WEIGHT,
  type ExchangeCandidate,
  type ExchangeCriteria,
} from './exchange-matching.util';

const CR = 10_000_000; // ₹1 crore in paise

function candidate(overrides: Partial<ExchangeCandidate> = {}): ExchangeCandidate {
  return {
    listingId: 'l1',
    sourceType: 'RESALE',
    ownerBusinessId: 'b-other',
    projectName: null,
    locality: 'Baner',
    config: '2BHK',
    askingPricePaise: CR,
    reliabilityScore: 50,
    ...overrides,
  };
}

const CRITERIA: ExchangeCriteria = {
  budgetMinPaise: 8_000_000,
  budgetMaxPaise: 12_000_000,
  localities: ['Baner'],
  config: '2BHK',
};

describe('matchExchange', () => {
  it('scores a perfect fit at 100 and lists reasons', () => {
    const m = matchExchange(CRITERIA, [candidate()], 5)[0]!;
    expect(m.fitScore).toBe(100);
    expect(m.reasons).toEqual(expect.arrayContaining(['Config matches 2BHK', 'Within budget', 'In preferred locality Baner']));
  });

  it('normalises config spacing/case when comparing', () => {
    const m = matchExchange(CRITERIA, [candidate({ config: '2 bhk' })], 5)[0]!;
    expect(m.fitScore).toBe(100);
  });

  it('drops a fully-specified hard mismatch (fit 0)', () => {
    const out = matchExchange(
      { ...CRITERIA, config: '2BHK' },
      [candidate({ config: '4BHK', locality: 'Wakad', askingPricePaise: 50_000_000 })],
      5,
    );
    expect(out).toHaveLength(0);
  });

  it('blends fit with counterparty reliability as the ranking key', () => {
    const m = matchExchange(CRITERIA, [candidate({ reliabilityScore: 80 })], 5)[0]!;
    const expected = Math.round(100 * FIT_WEIGHT + 80 * RELIABILITY_WEIGHT);
    expect(m.blendedScore).toBe(expected);
  });

  it('ranks the more reliable counterparty first when fit ties', () => {
    const matches = matchExchange(CRITERIA, [
      candidate({ listingId: 'low', reliabilityScore: 30 }),
      candidate({ listingId: 'high', reliabilityScore: 90 }),
    ], 5);
    expect(matches[0]!.listingId).toBe('high');
    expect(matches[0]!.reasons).toContain('High-reliability counterparty');
    expect(matches[1]!.reasons).toContain('Unproven counterparty');
  });

  it('gives partial credit up to 20% over budget, none beyond', () => {
    const slightlyOver = matchExchange(CRITERIA, [candidate({ askingPricePaise: 13_000_000 })], 5);
    expect(slightlyOver[0]!.reasons).toContain('Slightly over budget');
    // >20% over budget: no "Within budget" credit, and never a "Slightly over" reason.
    const wayOver = matchExchange(
      { budgetMaxPaise: 12_000_000, budgetMinPaise: null, localities: [], config: null },
      [candidate({ askingPricePaise: 20_000_000 })],
      5,
    );
    expect(wayOver.every((m) => !m.reasons.includes('Within budget'))).toBe(true);
    expect(wayOver.every((m) => !m.reasons.includes('Slightly over budget'))).toBe(true);
  });

  it('honours the limit', () => {
    const many = Array.from({ length: 8 }, (_, i) => candidate({ listingId: `l${i}` }));
    expect(matchExchange(CRITERIA, many, 3)).toHaveLength(3);
  });

  it('caps at five matches when no limit is given', () => {
    const many = Array.from({ length: 8 }, (_, i) => candidate({ listingId: `l${i}` }));
    expect(matchExchange(CRITERIA, many)).toHaveLength(5);
  });

  /** An empty BLTC scores everything neutrally rather than dropping the board. */
  it('treats an entirely unspecified brief as no locality constraint', () => {
    const matches = matchExchange({}, [candidate({ locality: 'Kharadi' })]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.reasons).not.toContain('Locality matches Kharadi');
  });

  it('keeps units and resale listings comparable in one ranking', () => {
    const matches = matchExchange(CRITERIA, [
      candidate({ listingId: 'resale', sourceType: 'RESALE', reliabilityScore: 40 }),
      candidate({ listingId: 'unit', sourceType: 'UNIT', projectName: 'Skyline', reliabilityScore: 95 }),
    ], 5);
    expect(matches[0]!.listingId).toBe('unit');
    expect(matches[0]!.sourceType).toBe('UNIT');
  });
});
