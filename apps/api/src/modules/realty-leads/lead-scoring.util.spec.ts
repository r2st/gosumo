/**
 * Unit tests for the pure lead-scoring helpers (blueprint §16.2 weights).
 */
import type { BltcProfile } from '@gosumo/shared';
import {
  scoreLead,
  temperatureForScore,
  countFilledCoreSlots,
  isBltcComplete,
  SCORE_WEIGHTS,
} from './lead-scoring.util';

const EMPTY: BltcProfile = {
  budgetMinPaise: null,
  budgetMaxPaise: null,
  localities: [],
  timelineMonths: null,
  config: null,
  purpose: null,
  financing: null,
};

describe('scoreLead', () => {
  it('scores an empty profile at 0 / JUNK', () => {
    const r = scoreLead(EMPTY, 0);
    expect(r.score).toBe(0);
    expect(r.temperature).toBe('JUNK');
  });

  it('awards full budget-fit for a sane band and half for a single bound', () => {
    const band = scoreLead({ ...EMPTY, budgetMinPaise: 900000000, budgetMaxPaise: 950000000 }, 0);
    expect(band.breakdown.budgetFit).toBe(SCORE_WEIGHTS.budgetFit);
    const single = scoreLead({ ...EMPTY, budgetMaxPaise: 950000000 }, 0);
    expect(single.breakdown.budgetFit).toBe(Math.round(SCORE_WEIGHTS.budgetFit / 2));
  });

  it('rewards a near-term timeline more than a distant one', () => {
    const soon = scoreLead({ ...EMPTY, timelineMonths: 3 }, 0);
    const later = scoreLead({ ...EMPTY, timelineMonths: 24 }, 0);
    expect(soon.breakdown.timeline).toBeGreaterThan(later.breakdown.timeline);
    expect(soon.breakdown.timeline).toBe(SCORE_WEIGHTS.timeline);
  });

  it('saturates engagement at 5 buyer turns', () => {
    const five = scoreLead({ ...EMPTY }, 5);
    const ten = scoreLead({ ...EMPTY }, 10);
    expect(five.breakdown.engagement).toBe(SCORE_WEIGHTS.engagement);
    expect(ten.breakdown.engagement).toBe(SCORE_WEIGHTS.engagement);
  });

  it('rates a fully-qualified, engaged, near-term buyer HOT', () => {
    const r = scoreLead(
      {
        budgetMinPaise: 900000000,
        budgetMaxPaise: 950000000,
        localities: ['Baner'],
        timelineMonths: 3,
        config: '2BHK',
        purpose: 'END_USE',
        financing: 'PREAPPROVED',
      },
      5,
    );
    expect(r.score).toBeGreaterThanOrEqual(75);
    expect(r.temperature).toBe('HOT');
  });

  it('clamps to 0–100', () => {
    const r = scoreLead(
      {
        budgetMinPaise: 1,
        budgetMaxPaise: 2,
        localities: ['x'],
        timelineMonths: 1,
        config: 'a',
        purpose: 'INVEST',
        financing: 'CASH',
      },
      100,
    );
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});

describe('temperatureForScore', () => {
  it('maps bands correctly', () => {
    expect(temperatureForScore(80)).toBe('HOT');
    expect(temperatureForScore(60)).toBe('WARM');
    expect(temperatureForScore(30)).toBe('COLD');
    expect(temperatureForScore(10)).toBe('JUNK');
  });
});

describe('countFilledCoreSlots / isBltcComplete', () => {
  it('counts the four core BLTC slots', () => {
    expect(countFilledCoreSlots(EMPTY)).toBe(0);
    const three: BltcProfile = { ...EMPTY, budgetMaxPaise: 1, localities: ['x'], timelineMonths: 6 };
    expect(countFilledCoreSlots(three)).toBe(3);
    expect(isBltcComplete(three)).toBe(false);
    const full: BltcProfile = { ...three, config: '2BHK' };
    expect(countFilledCoreSlots(full)).toBe(4);
    expect(isBltcComplete(full)).toBe(true);
  });
});
