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

describe('scoreLead — the degenerate profiles', () => {
  // A buyer whose stated bounds are inverted, or whose ceiling is zero, has
  // "answered" the budget question without giving an answer anyone can search
  // inventory with. Awarding full budget-fit there pushes a lead that cannot be
  // matched to any unit over the HOT threshold and into a broker's alert queue.
  it('halves budget-fit for an inverted band rather than trusting both bounds', () => {
    const inverted: BltcProfile = { ...EMPTY, budgetMinPaise: 9_000_000, budgetMaxPaise: 5_000_000 };

    expect(scoreLead(inverted, 0).breakdown.budgetFit).toBe(
      Math.round(SCORE_WEIGHTS.budgetFit / 2),
    );
  });

  it('halves budget-fit when the ceiling is zero', () => {
    const zeroCeiling: BltcProfile = { ...EMPTY, budgetMinPaise: 0, budgetMaxPaise: 0 };

    expect(scoreLead(zeroCeiling, 0).breakdown.budgetFit).toBe(
      Math.round(SCORE_WEIGHTS.budgetFit / 2),
    );
  });

  it('still credits a sane band whose floor is zero', () => {
    const openFloor: BltcProfile = { ...EMPTY, budgetMinPaise: 0, budgetMaxPaise: 5_000_000 };

    expect(scoreLead(openFloor, 0).breakdown.budgetFit).toBe(SCORE_WEIGHTS.budgetFit);
  });

  it('gives a beyond-a-year timeline the floor weight, not zero', () => {
    const distant: BltcProfile = { ...EMPTY, timelineMonths: 24 };

    // A buyer 24 months out is still a buyer — they must outrank someone who
    // never answered the timeline question at all.
    expect(scoreLead(distant, 0).breakdown.timeline).toBe(
      Math.round(SCORE_WEIGHTS.timeline * 0.3),
    );
    expect(scoreLead(distant, 0).breakdown.timeline).toBeGreaterThan(
      scoreLead(EMPTY, 0).breakdown.timeline,
    );
  });

  it('grades the timeline bands in descending order', () => {
    const at = (m: number) => scoreLead({ ...EMPTY, timelineMonths: m }, 0).breakdown.timeline;

    expect(at(3)).toBeGreaterThan(at(6));
    expect(at(6)).toBeGreaterThan(at(12));
    expect(at(12)).toBeGreaterThan(at(13));
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
