/**
 * BLTC contradiction (data-consistency) unit tests — Phase 7 hardening.
 *
 * Pure functions, no Nest. Covers:
 *  1. A fully-consistent profile → no contradictions.
 *  2. ERROR-severity impossibilities (min>max, negatives, negative timeline).
 *  3. WARN-severity implausibilities (unit-error budget, absurd timeline,
 *     duplicate/blank localities, budget below the config floor).
 *  4. config normalization.
 *  5. Merge-time conflict surfacing + merged-profile internal errors.
 */

import type { BltcProfile } from '@gosumo/shared';
import {
  validateBltcProfile,
  validateBltcMerge,
  normalizeConfig,
} from './bltc-contradiction.util';

const LAKH = 1e7;
const CRORE = 1e9;

function profile(overrides: Partial<BltcProfile> = {}): BltcProfile {
  return {
    budgetMinPaise: null,
    budgetMaxPaise: null,
    localities: [],
    timelineMonths: null,
    config: null,
    purpose: null,
    financing: null,
    ...overrides,
  };
}

function codes(result: { contradictions: { code: string }[] }): string[] {
  return result.contradictions.map((c) => c.code);
}

describe('validateBltcProfile', () => {
  it('reports a fully-consistent profile as consistent', () => {
    const res = validateBltcProfile(
      profile({
        budgetMinPaise: 40 * LAKH,
        budgetMaxPaise: 60 * LAKH,
        localities: ['Wakad', 'Baner'],
        timelineMonths: 6,
        config: '2BHK',
        purpose: 'END_USE',
        financing: 'PREAPPROVED',
      }),
    );
    expect(res.consistent).toBe(true);
    expect(res.hasErrors).toBe(false);
    expect(res.contradictions).toHaveLength(0);
  });

  it('flags budget floor above ceiling as an ERROR', () => {
    const res = validateBltcProfile(
      profile({ budgetMinPaise: 80 * LAKH, budgetMaxPaise: 50 * LAKH }),
    );
    expect(res.hasErrors).toBe(true);
    expect(codes(res)).toContain('budget_min_gt_max');
    expect(res.contradictions.find((c) => c.code === 'budget_min_gt_max')?.severity).toBe(
      'ERROR',
    );
  });

  it('flags negative budgets and timeline as ERRORs', () => {
    const res = validateBltcProfile(
      profile({ budgetMinPaise: -1, budgetMaxPaise: -5, timelineMonths: -3 }),
    );
    expect(codes(res)).toEqual(
      expect.arrayContaining(['budget_min_negative', 'budget_max_negative', 'timeline_negative']),
    );
    expect(res.hasErrors).toBe(true);
  });

  it('does not double-count min>max when a value is negative', () => {
    // min is negative (ERROR) but min(-1) is not > max(50L), so no gt_max.
    const res = validateBltcProfile(
      profile({ budgetMinPaise: -1, budgetMaxPaise: 50 * LAKH }),
    );
    expect(codes(res)).toContain('budget_min_negative');
    expect(codes(res)).not.toContain('budget_min_gt_max');
  });

  it('warns on an implausibly high (unit-error) budget', () => {
    const res = validateBltcProfile(profile({ budgetMaxPaise: 200 * CRORE }));
    expect(codes(res)).toContain('budget_implausibly_high');
    expect(res.hasErrors).toBe(false); // WARN only
  });

  it('warns on an absurd timeline beyond the 120-month horizon', () => {
    const res = validateBltcProfile(profile({ timelineMonths: 240 }));
    expect(codes(res)).toContain('timeline_implausible');
    expect(res.hasErrors).toBe(false);
  });

  it('warns on duplicate and blank localities', () => {
    const dup = validateBltcProfile(profile({ localities: ['Baner', 'baner '] }));
    expect(codes(dup)).toContain('locality_duplicate');

    const blank = validateBltcProfile(profile({ localities: ['Baner', '  '] }));
    expect(codes(blank)).toContain('locality_blank');
  });

  it('warns when the budget is below the config floor (4BHK in ₹20L)', () => {
    const res = validateBltcProfile(
      profile({ config: '4 bhk', budgetMaxPaise: 20 * LAKH }),
    );
    expect(codes(res)).toContain('budget_below_config_floor');
    expect(res.hasErrors).toBe(false);
  });

  it('does not flag a config floor when the budget clears it', () => {
    const res = validateBltcProfile(
      profile({ config: '2BHK', budgetMaxPaise: 60 * LAKH }),
    );
    expect(codes(res)).not.toContain('budget_below_config_floor');
  });
});

describe('normalizeConfig', () => {
  it('canonicalizes spacing and case', () => {
    expect(normalizeConfig('2 bhk')).toBe('2BHK');
    expect(normalizeConfig('3BHK')).toBe('3BHK');
    expect(normalizeConfig('1 rk')).toBe('1RK');
  });

  it('returns null for empty input and passes through unknown shapes', () => {
    expect(normalizeConfig(null)).toBeNull();
    expect(normalizeConfig('')).toBeNull();
    expect(normalizeConfig('penthouse')).toBe('PENTHOUSE');
  });
});

describe('validateBltcMerge', () => {
  const existing = profile({
    budgetMaxPaise: 60 * LAKH,
    config: '2BHK',
    localities: ['Wakad'],
  });

  it('surfaces a slot-overwrite conflict without mutating', () => {
    const res = validateBltcMerge(existing, { config: '3BHK' });
    const conflict = res.contradictions.find((c) => c.code === 'slot_overwrite_conflict');
    expect(conflict).toBeDefined();
    expect(conflict?.slots).toContain('config');
  });

  it('does not conflict when the incoming value matches the existing slot', () => {
    const res = validateBltcMerge(existing, { config: '2BHK' });
    expect(codes(res)).not.toContain('slot_overwrite_conflict');
  });

  it('folds the merged profile through the internal validator (surfaces min>max)', () => {
    const res = validateBltcMerge(profile({ budgetMaxPaise: 50 * LAKH }), {
      budgetMinPaise: 80 * LAKH,
    });
    expect(codes(res)).toContain('budget_min_gt_max');
    expect(res.hasErrors).toBe(true);
  });

  it('ignores undefined incoming slots', () => {
    const res = validateBltcMerge(existing, { config: undefined });
    expect(res.consistent).toBe(true);
  });

  /**
   * Every slot, not just `config`.
   *
   * Each slot passes its own "is it filled" and "does it differ" pair into the
   * shared `conflict()` helper, and a wrong pair only misbehaves for that one
   * slot — a `!=` where `!==` belongs, or a `localities` check that treats the
   * empty array as filled. Testing one slot proved the helper worked and left
   * the other six predicates unexecuted, so this walks all of them.
   */
  describe.each([
    ['budgetMinPaise', 30 * LAKH, 45 * LAKH],
    ['budgetMaxPaise', 60 * LAKH, 90 * LAKH],
    ['timelineMonths', 6, 12],
    ['config', '2BHK', '3BHK'],
    ['purpose', 'END_USE', 'INVEST'],
    ['financing', 'CASH', 'NEEDS_LOAN'],
    ['localities', ['Wakad'], ['Baner']],
  ] as ReadonlyArray<readonly [keyof BltcProfile, unknown, unknown]>)(
    '%s',
    (slot, filled, other) => {
      const withSlot = profile({ [slot]: filled } as Partial<BltcProfile>);

      it('conflicts when the incoming value differs from the filled slot', () => {
        const res = validateBltcMerge(withSlot, { [slot]: other } as Partial<BltcProfile>);
        const conflict = res.contradictions.find((c) => c.code === 'slot_overwrite_conflict');
        expect(conflict?.slots).toEqual([slot]);
        // A conflicting overwrite is a WARN, never a hard error: the newer
        // value may simply be the customer changing their mind.
        expect(conflict?.severity).toBe('WARN');
      });

      it('stays quiet when the incoming value repeats the filled slot', () => {
        const res = validateBltcMerge(withSlot, { [slot]: filled } as Partial<BltcProfile>);
        expect(codes(res)).not.toContain('slot_overwrite_conflict');
      });

      it('stays quiet when the existing slot is empty', () => {
        // Filling a blank is not an overwrite. `localities` makes the point:
        // its empty state is `[]`, not null, so a length check is the only
        // thing that distinguishes "unknown" from "known to be nothing".
        const res = validateBltcMerge(profile(), { [slot]: other } as Partial<BltcProfile>);
        expect(codes(res)).not.toContain('slot_overwrite_conflict');
      });
    },
  );

  it('reorders localities without calling it a conflict only when the values match exactly', () => {
    // The localities comparison is a JSON.stringify, so order is significant.
    // That is a deliberate conservatism — ['Wakad','Baner'] arriving as
    // ['Baner','Wakad'] is surfaced for a human rather than silently merged.
    const twoAreas = profile({ localities: ['Wakad', 'Baner'] });
    expect(codes(validateBltcMerge(twoAreas, { localities: ['Wakad', 'Baner'] }))).not.toContain(
      'slot_overwrite_conflict',
    );
    expect(codes(validateBltcMerge(twoAreas, { localities: ['Baner', 'Wakad'] }))).toContain(
      'slot_overwrite_conflict',
    );
  });
});
