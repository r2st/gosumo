import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  availableCount,
  bltcComponents,
  bltcCompletion,
  budgetLabel,
  configRange,
  freshness,
  latestVerifiedAt,
  matchBorder,
  matchTone,
  PIPELINE_COLUMNS,
  sourceLabel,
  sourceTone,
  unitPriceRange,
} from './realty-ui';
import type {
  BltcProfile,
  Lead,
  LeadSource,
  LeadStage,
  RealtyUnit,
} from './realty-types';

/**
 * `realty-ui.test.ts` covers the pipeline filters. This covers the display
 * half: source labelling, budget/BLTC formatting, unit aggregation and the
 * 24-hour freshness rule (blueprint §14).
 */

const LAKH = 10_000_000; // paise in ₹1 lakh
const CRORE = 100 * LAKH;

const bltc = (overrides: Partial<BltcProfile> = {}): BltcProfile => ({
  budgetMinPaise: null,
  budgetMaxPaise: null,
  localities: [],
  timelineMonths: null,
  config: null,
  purpose: null,
  financing: null,
  ...overrides,
});

const unit = (overrides: Partial<RealtyUnit> = {}): RealtyUnit =>
  ({
    config: '2BHK',
    allInPricePaise: 80 * LAKH,
    availability: 'AVAILABLE',
    verifiedAt: null,
    ...overrides,
  }) as RealtyUnit;

describe('sourceLabel', () => {
  const lead = (source: LeadSource, subSource: string | null = null) =>
    ({ source, subSource }) as Pick<Lead, 'source' | 'subSource'>;

  it('prefers the portal sub-source over the generic label', () => {
    expect(sourceLabel(lead('PORTAL', '99acres'))).toBe('99acres');
  });

  it('falls back to the source label when the sub-source is blank', () => {
    expect(sourceLabel(lead('PORTAL', '   '))).toBe('Portal');
  });

  it('falls back when there is no sub-source at all', () => {
    expect(sourceLabel(lead('META_LEAD_AD'))).toBe('Meta Ad');
    expect(sourceLabel(lead('CTWA'))).toBe('WhatsApp');
    expect(sourceLabel(lead('EXCHANGE_INBOUND'))).toBe('Exchange');
  });

  it('reports Unknown for a source outside the enum', () => {
    expect(sourceLabel(lead('SMOKE_SIGNAL' as LeadSource))).toBe('Unknown');
  });
});

describe('sourceTone', () => {
  it('tones each known source', () => {
    expect(sourceTone({ source: 'PORTAL' })).toBe('info');
    expect(sourceTone({ source: 'META_LEAD_AD' })).toBe('primary');
    expect(sourceTone({ source: 'WALK_IN' })).toBe('warning');
  });

  it('falls back to neutral for an unknown source', () => {
    expect(sourceTone({ source: 'SMOKE_SIGNAL' as LeadSource })).toBe('neutral');
  });
});

describe('budgetLabel', () => {
  it('returns null when the buyer has shared no budget', () => {
    expect(budgetLabel({ budgetMinPaise: null, budgetMaxPaise: null })).toBeNull();
  });

  it('renders a range when both ends are known', () => {
    expect(
      budgetLabel({ budgetMinPaise: 80 * LAKH, budgetMaxPaise: 1.2 * CRORE }),
    ).toBe('₹80.00L–₹1.20Cr');
  });

  it('renders the single known end when only the ceiling is shared', () => {
    expect(budgetLabel({ budgetMinPaise: null, budgetMaxPaise: CRORE })).toBe(
      '₹1.00Cr',
    );
  });

  it('renders the single known end when only the floor is shared', () => {
    expect(budgetLabel({ budgetMinPaise: 45 * LAKH, budgetMaxPaise: null })).toBe(
      '₹45.00L',
    );
  });

  it('treats a zero floor as shared, not as missing', () => {
    expect(budgetLabel({ budgetMinPaise: 0, budgetMaxPaise: null })).not.toBeNull();
  });
});

describe('bltcComponents', () => {
  it('marks every component unfilled for an empty profile', () => {
    const parts = bltcComponents(bltc());
    expect(parts.map((p) => p.key)).toEqual(['B', 'L', 'T', 'C']);
    expect(parts.every((p) => !p.filled)).toBe(true);
    expect(parts.every((p) => p.value === 'Not shared')).toBe(true);
  });

  it('joins multiple localities into one value', () => {
    const [, location] = bltcComponents(
      bltc({ localities: ['Whitefield', 'Sarjapur'] }),
    );
    expect(location).toMatchObject({
      filled: true,
      value: 'Whitefield, Sarjapur',
    });
  });

  it('renders the timeline in months', () => {
    const [, , timeline] = bltcComponents(bltc({ timelineMonths: 6 }));
    expect(timeline).toMatchObject({ filled: true, value: '6 months' });
  });

  it('treats a zero-month timeline as shared', () => {
    const [, , timeline] = bltcComponents(bltc({ timelineMonths: 0 }));
    expect(timeline).toMatchObject({ filled: true, value: '0 months' });
  });

  it('carries the config through verbatim', () => {
    const [, , , config] = bltcComponents(bltc({ config: '3BHK' }));
    expect(config).toMatchObject({ filled: true, value: '3BHK' });
  });
});

describe('bltcCompletion', () => {
  it('reports empty at 0%', () => {
    expect(bltcCompletion(bltc())).toEqual({
      filled: 0,
      total: 4,
      pct: 0,
      state: 'empty',
    });
  });

  it('reports partial once anything is captured', () => {
    expect(bltcCompletion(bltc({ config: '2BHK' }))).toMatchObject({
      filled: 1,
      pct: 25,
      state: 'partial',
    });
  });

  it('reports confirmed only when all four are captured', () => {
    expect(
      bltcCompletion(
        bltc({
          budgetMaxPaise: CRORE,
          localities: ['Whitefield'],
          timelineMonths: 3,
          config: '3BHK',
        }),
      ),
    ).toEqual({ filled: 4, total: 4, pct: 100, state: 'confirmed' });
  });

  it('rounds the percentage rather than truncating it', () => {
    expect(
      bltcCompletion(bltc({ localities: ['Indiranagar'], timelineMonths: 2 })).pct,
    ).toBe(50);
  });
});

describe('match scoring', () => {
  it.each([
    [100, 'border-l-emerald-500', 'success'],
    [85, 'border-l-emerald-500', 'success'],
    [84, 'border-l-amber-400', 'warning'],
    [70, 'border-l-amber-400', 'warning'],
    [69, 'border-l-slate-300', 'neutral'],
    [0, 'border-l-slate-300', 'neutral'],
  ])('scores %i as %s / %s', (score, border, tone) => {
    expect(matchBorder(score)).toBe(border);
    expect(matchTone(score)).toBe(tone);
  });
});

describe('configRange', () => {
  it('returns null when no unit config carries a number', () => {
    expect(configRange([unit({ config: 'Penthouse' })])).toBeNull();
  });

  it('returns null for an empty project', () => {
    expect(configRange([])).toBeNull();
  });

  it('collapses a single config to one label', () => {
    expect(configRange([unit({ config: '2BHK' }), unit({ config: '2 BHK' })])).toBe(
      '2 BHK',
    );
  });

  it('spans the min and max BHK across units', () => {
    expect(
      configRange([
        unit({ config: '3BHK' }),
        unit({ config: '1 BHK' }),
        unit({ config: '2BHK' }),
      ]),
    ).toBe('1–3 BHK');
  });

  it('handles fractional configs like 2.5BHK', () => {
    expect(configRange([unit({ config: '2.5BHK' }), unit({ config: '4BHK' })])).toBe(
      '2.5–4 BHK',
    );
  });

  it('ignores unparseable configs rather than dropping the whole range', () => {
    expect(configRange([unit({ config: 'Studio' }), unit({ config: '3BHK' })])).toBe(
      '3 BHK',
    );
  });
});

describe('unitPriceRange', () => {
  const noFallback = { min: null, max: null };

  it('spans the cheapest and dearest unit', () => {
    expect(
      unitPriceRange(
        [
          unit({ allInPricePaise: 1.5 * CRORE }),
          unit({ allInPricePaise: 80 * LAKH }),
        ],
        noFallback,
      ),
    ).toBe('₹80.00L–₹1.50Cr');
  });

  it('collapses to a single price when every unit costs the same', () => {
    expect(
      unitPriceRange([unit({ allInPricePaise: CRORE })], noFallback),
    ).toBe('₹1.00Cr');
  });

  it('ignores unpriced units', () => {
    expect(
      unitPriceRange(
        [unit({ allInPricePaise: 0 }), unit({ allInPricePaise: 90 * LAKH })],
        noFallback,
      ),
    ).toBe('₹90.00L');
  });

  it('falls back to the project price band when no unit is priced', () => {
    expect(
      unitPriceRange([unit({ allInPricePaise: 0 })], {
        min: 60 * LAKH,
        max: CRORE,
      }),
    ).toBe('₹60.00L–₹1.00Cr');
  });

  it('uses the fallback for an empty unit list', () => {
    expect(unitPriceRange([], { min: null, max: 2 * CRORE })).toBe('₹2.00Cr');
  });

  it('returns null when neither units nor the band carry a price', () => {
    expect(unitPriceRange([], noFallback)).toBeNull();
  });
});

describe('availableCount', () => {
  it('counts only AVAILABLE units', () => {
    expect(
      availableCount([
        unit({ availability: 'AVAILABLE' }),
        unit({ availability: 'HELD' }),
        unit({ availability: 'SOLD' }),
        unit({ availability: 'UNVERIFIED' }),
        unit({ availability: 'AVAILABLE' }),
      ]),
    ).toBe(2);
  });

  it('counts nothing in an empty project', () => {
    expect(availableCount([])).toBe(0);
  });
});

describe('freshness (24-hour rule)', () => {
  const NOW = new Date('2026-08-14T12:00:00.000Z');
  const hoursAgo = (h: number): string =>
    new Date(NOW.getTime() - h * 3_600_000).toISOString();

  afterEach(() => vi.useRealTimers());

  const at = (iso: string | null | undefined) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    return freshness(iso);
  };

  it('returns null when nothing has been verified', () => {
    expect(freshness(null)).toBeNull();
    expect(freshness(undefined)).toBeNull();
    expect(freshness('')).toBeNull();
  });

  it('returns null for an unparseable timestamp', () => {
    expect(freshness('not-a-date')).toBeNull();
  });

  it('reads a just-verified unit as verified now', () => {
    expect(at(NOW.toISOString())).toEqual({
      label: 'Verified now',
      stale: false,
      tone: 'info',
    });
  });

  it('reports the age in hours inside the window', () => {
    expect(at(hoursAgo(2))).toEqual({
      label: 'Verified 2h ago',
      stale: false,
      tone: 'info',
    });
  });

  it('stays fresh at 23 hours', () => {
    expect(at(hoursAgo(23))?.stale).toBe(false);
  });

  it('goes stale at exactly 24 hours', () => {
    expect(at(hoursAgo(24))).toEqual({
      label: 'Stale 24h',
      stale: true,
      tone: 'danger',
    });
  });

  it('keeps counting past the window', () => {
    expect(at(hoursAgo(26))?.label).toBe('Stale 26h');
  });

  it('clamps a future timestamp to "verified now" rather than a negative age', () => {
    expect(at(hoursAgo(-5))).toEqual({
      label: 'Verified now',
      stale: false,
      tone: 'info',
    });
  });
});

describe('latestVerifiedAt', () => {
  it('returns null when no unit is both available and verified', () => {
    expect(
      latestVerifiedAt([
        unit({ availability: 'AVAILABLE', verifiedAt: null }),
        unit({ availability: 'SOLD', verifiedAt: '2026-08-14T00:00:00.000Z' }),
      ]),
    ).toBeNull();
  });

  it('returns null for an empty project', () => {
    expect(latestVerifiedAt([])).toBeNull();
  });

  it('picks the most recent stamp among available units', () => {
    expect(
      latestVerifiedAt([
        unit({ verifiedAt: '2026-08-10T00:00:00.000Z' }),
        unit({ verifiedAt: '2026-08-14T09:00:00.000Z' }),
        unit({ verifiedAt: '2026-08-12T00:00:00.000Z' }),
      ]),
    ).toBe('2026-08-14T09:00:00.000Z');
  });

  it('ignores a newer stamp on a sold unit — freshness is about sellable stock', () => {
    expect(
      latestVerifiedAt([
        unit({ availability: 'AVAILABLE', verifiedAt: '2026-08-10T00:00:00.000Z' }),
        unit({ availability: 'SOLD', verifiedAt: '2026-08-14T00:00:00.000Z' }),
      ]),
    ).toBe('2026-08-10T00:00:00.000Z');
  });
});

describe('PIPELINE_COLUMNS', () => {
  it('drops terminal stages off the board', () => {
    const onBoard = PIPELINE_COLUMNS.flatMap((c) => c.stages);
    expect(onBoard).not.toContain('CLOSED_LOST' as LeadStage);
    expect(onBoard).not.toContain('DORMANT' as LeadStage);
  });

  it('folds each stage into exactly one column', () => {
    const onBoard = PIPELINE_COLUMNS.flatMap((c) => c.stages);
    expect(new Set(onBoard).size).toBe(onBoard.length);
  });

  it('runs new → qualified → visit → negotiating → won', () => {
    expect(PIPELINE_COLUMNS.map((c) => c.key)).toEqual([
      'NEW',
      'QUALIFIED',
      'VISIT_BOOKED',
      'NEGOTIATING',
      'CLOSED_WON',
    ]);
  });
});
