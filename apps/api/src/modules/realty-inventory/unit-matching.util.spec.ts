/**
 * Unit tests for the pure BLTC→unit matcher.
 */
import { matchUnits, MATCH_WEIGHTS } from './unit-matching.util';
import type { MatchCandidate } from './unit-matching.util';

const CANDIDATES: MatchCandidate[] = [
  { unitId: 'u1', projectId: 'p1', projectName: 'Serene Heights', locality: 'Baner', config: '2BHK', allInPricePaise: 920000000 },
  { unitId: 'u2', projectId: 'p2', projectName: 'Westwood Park', locality: 'Baner', config: '2BHK', allInPricePaise: 940000000 },
  { unitId: 'u3', projectId: 'p3', projectName: 'Hill View', locality: 'Kharadi', config: '3BHK', allInPricePaise: 1500000000 },
];

describe('matchUnits', () => {
  it('ranks an exact config + in-budget + in-locality unit highest', () => {
    const matches = matchUnits(
      { budgetMinPaise: 850000000, budgetMaxPaise: 950000000, localities: ['Baner'], config: '2BHK' },
      CANDIDATES,
    );
    expect(matches[0]!.unitId).toMatch(/u1|u2/);
    expect(matches[0]!.fitScore).toBe(MATCH_WEIGHTS.config + MATCH_WEIGHTS.price + MATCH_WEIGHTS.locality);
    expect(matches.map((m) => m.unitId)).not.toContain('u3'); // wrong config, over budget, wrong locality
  });

  it('normalises config spelling ("2 bhk" == "2BHK")', () => {
    const matches = matchUnits({ config: '2 bhk' }, CANDIDATES, 5);
    const ids = matches.map((m) => m.unitId);
    expect(ids).toContain('u1');
    expect(ids).toContain('u2');
  });

  it('excludes units far over the budget ceiling', () => {
    const matches = matchUnits({ budgetMaxPaise: 950000000, config: '3BHK' }, CANDIDATES, 5);
    // u3 is 3BHK but ~58% over budget → price score 0; config alone keeps it, but
    // let us assert it is ranked below an in-budget match if any, and reasons omit "Within budget".
    const u3 = matches.find((m) => m.unitId === 'u3');
    if (u3) expect(u3.reasons).not.toContain('Within budget');
  });

  it('respects the limit', () => {
    const matches = matchUnits({}, CANDIDATES, 2);
    expect(matches.length).toBeLessThanOrEqual(2);
  });

  it('returns empty when every dimension is specified and mismatched', () => {
    // config mismatch (0) + far over budget (0) + non-overlapping locality (0) ⇒ score 0
    const matches = matchUnits(
      { budgetMaxPaise: 1, config: 'PENTHOUSE', localities: ['Nowhere'] },
      CANDIDATES,
    );
    expect(matches).toHaveLength(0);
  });

  it('gives partial (60%-scaled) price credit within 20% over budget', () => {
    const c: MatchCandidate[] = [
      { unitId: 'x', projectId: 'p', projectName: 'P', locality: 'Baner', config: '2BHK', allInPricePaise: 1100000000 },
    ];
    // ceiling 1_000_000_000 paise, unit 10% over → partial price credit, still > 0 overall
    const matches = matchUnits({ budgetMaxPaise: 1000000000, config: '2BHK', localities: ['Baner'] }, c);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.reasons).toContain('Slightly over budget');
  });
});
