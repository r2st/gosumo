/**
 * Deterministic BLTC extraction (blueprint §16.2).
 *
 * This is the fast pre-pass that runs before the LLM. Its whole point is that
 * the obvious cases are never missed and never wrong — a mis-parsed budget
 * silently mis-qualifies a lead and mis-matches inventory, with no LLM in the
 * loop to catch it. `bltc-extractor.spec.ts` covers the state machine on top;
 * this file pins the parsing itself.
 *
 * Money: 1 lakh = 1e7 paise, 1 crore = 1e9 paise.
 */

import { RealtyIntent } from '@gosumo/shared';
import type { BltcProfile } from '@gosumo/shared';
import {
  extractBltc,
  isSlotFilled,
  slotOrderForEntry,
  SLOT_QUESTIONS,
} from './bltc-extraction.util';

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
  } as BltcProfile;
}

describe('extractBltc', () => {
  it('returns nothing for empty text without touching the extractors', () => {
    expect(extractBltc('')).toEqual({});
  });

  it('defaults the locality gazetteer to empty when the caller omits it', () => {
    // Called with one argument by every code path that has no project list yet.
    expect(extractBltc('looking for a 3BHK')).toEqual({ config: '3BHK' });
  });

  it('leaves unmentioned slots undefined rather than null', () => {
    // The merge in realty-leads treats undefined as "not mentioned" and null as
    // "cleared" — emitting null here would wipe a known budget.
    const out = extractBltc('just browsing');
    expect(out).not.toHaveProperty('budgetMinPaise');
    expect(out).not.toHaveProperty('config');
    expect(out).not.toHaveProperty('localities');
  });

  describe('budget', () => {
    it('reads a hyphen, en-dash or "to" range', () => {
      expect(extractBltc('50-60 lakh')).toMatchObject({
        budgetMinPaise: 50 * LAKH,
        budgetMaxPaise: 60 * LAKH,
      });
      expect(extractBltc('50 – 60 lakh')).toMatchObject({ budgetMaxPaise: 60 * LAKH });
      expect(extractBltc('50 to 60 lakh')).toMatchObject({ budgetMaxPaise: 60 * LAKH });
    });

    it('reads a "between X and Y" range', () => {
      expect(extractBltc('between 1 and 1.5 crore')).toMatchObject({
        budgetMinPaise: 1 * CRORE,
        budgetMaxPaise: 1.5 * CRORE,
      });
    });

    it('reads a ceiling', () => {
      expect(extractBltc('under 80 lakh')).toEqual({ budgetMaxPaise: 80 * LAKH });
      expect(extractBltc('budget is 1.2 cr')).toEqual({ budgetMaxPaise: 1.2 * CRORE });
    });

    it('reads a floor', () => {
      // "above 50 lakh" sets only the minimum — reading it as a ceiling would
      // match the buyer to inventory strictly below what they asked for.
      expect(extractBltc('above 50 lakh')).toEqual({ budgetMinPaise: 50 * LAKH });
      expect(extractBltc('at least 75 lakhs')).toEqual({ budgetMinPaise: 75 * LAKH });
      expect(extractBltc('starting from 1 crore')).toEqual({ budgetMinPaise: 1 * CRORE });
      expect(extractBltc('minimum 60 lac')).toEqual({ budgetMinPaise: 60 * LAKH });
    });

    it('treats a bare amount with a unit as the ceiling', () => {
      expect(extractBltc('90 lakh')).toEqual({ budgetMaxPaise: 90 * LAKH });
    });

    it('ignores a bare number with no unit', () => {
      expect(extractBltc('flat number 90')).not.toHaveProperty('budgetMaxPaise');
    });
  });

  describe('config', () => {
    it('reads BHK and RK', () => {
      expect(extractBltc('2 bhk please')).toMatchObject({ config: '2BHK' });
      expect(extractBltc('1rk is fine')).toMatchObject({ config: '1RK' });
    });

    it('reads a studio', () => {
      expect(extractBltc('a studio would work')).toMatchObject({ config: 'Studio' });
    });

    it('normalises "1 bedroom" to 1BHK', () => {
      expect(extractBltc('single 1 bedroom')).toMatchObject({ config: '1BHK' });
      expect(extractBltc('1 bed is enough')).toMatchObject({ config: '1BHK' });
    });
  });

  describe('timeline', () => {
    it('reads urgency as one month, in English and Hinglish', () => {
      expect(extractBltc('need it urgent')).toMatchObject({ timelineMonths: 1 });
      expect(extractBltc('asap please')).toMatchObject({ timelineMonths: 1 });
      expect(extractBltc('turant chahiye')).toMatchObject({ timelineMonths: 1 });
      expect(extractBltc('abhi chahiye')).toMatchObject({ timelineMonths: 1 });
    });

    it('does not match inflected urgency words', () => {
      // The patterns are \b-anchored, so "urgently" and "immediately" past the
      // listed stem do not match. Documented rather than fixed: this is a
      // best-effort pre-pass and the LLM handles the nuanced cases behind it.
      expect(extractBltc('need it urgently')).not.toHaveProperty('timelineMonths');
    });

    it('reads an explicit month count', () => {
      expect(extractBltc('in 6 months')).toMatchObject({ timelineMonths: 6 });
      expect(extractBltc('3 mahine')).toMatchObject({ timelineMonths: 3 });
    });

    it('rounds weeks up to whole months, never below one', () => {
      expect(extractBltc('in 8 weeks')).toMatchObject({ timelineMonths: 2 });
      expect(extractBltc('in 6 weeks')).toMatchObject({ timelineMonths: 2 });
      // 2 weeks rounds to 1, not 0 — a zero-month timeline would read as
      // "already bought" downstream.
      expect(extractBltc('in 2 hafte')).toMatchObject({ timelineMonths: 1 });
    });

    it('converts years to months', () => {
      expect(extractBltc('in 2 years')).toMatchObject({ timelineMonths: 24 });
      expect(extractBltc('1 saal')).toMatchObject({ timelineMonths: 12 });
    });

    it('reads the relative-year phrases', () => {
      expect(extractBltc('planning this year')).toMatchObject({ timelineMonths: 12 });
      expect(extractBltc('is saal hi')).toMatchObject({ timelineMonths: 12 });
      expect(extractBltc('maybe next year')).toMatchObject({ timelineMonths: 18 });
      expect(extractBltc('agle saal dekhenge')).toMatchObject({ timelineMonths: 18 });
    });

    it('reads no-rush phrasing as two years out', () => {
      expect(extractBltc('no rush at all')).toMatchObject({ timelineMonths: 24 });
      expect(extractBltc('just exploring')).toMatchObject({ timelineMonths: 24 });
      expect(extractBltc('someday')).toMatchObject({ timelineMonths: 24 });
    });
  });

  describe('localities', () => {
    it('matches the gazetteer first', () => {
      expect(extractBltc('anything in wakad?', ['Wakad', 'Baner'])).toMatchObject({
        localities: ['Wakad'],
      });
    });

    it('picks up a capitalised proper noun after a preposition', () => {
      expect(extractBltc('looking near Hinjewadi Phase 1')).toMatchObject({
        localities: ['Hinjewadi Phase 1'],
      });
    });

    it('rejects a common word that happens to follow a preposition', () => {
      // "in Budget" and "in Flat" are not localities; without the stopword
      // list they would be matched and then fail every inventory lookup.
      expect(extractBltc('interested in Budget homes')).not.toHaveProperty('localities');
    });

    it('ignores blank gazetteer entries', () => {
      expect(extractBltc('somewhere quiet', ['', '   '])).not.toHaveProperty('localities');
    });
  });

  describe('purpose', () => {
    it('reads investment intent', () => {
      expect(extractBltc('this is for investment')).toMatchObject({ purpose: 'INVEST' });
      expect(extractBltc('good rental income?')).toMatchObject({ purpose: 'INVEST' });
    });

    it('reads end-use intent, in English and Hinglish', () => {
      expect(extractBltc('for end use')).toMatchObject({ purpose: 'END_USE' });
      expect(extractBltc('khud ke liye chahiye')).toMatchObject({ purpose: 'END_USE' });
      expect(extractBltc('for my family to live')).toMatchObject({ purpose: 'END_USE' });
    });
  });

  describe('financing', () => {
    it('reads a pre-approved loan ahead of a generic loan mention', () => {
      // "pre-approved home loan" contains both patterns; PREAPPROVED must win,
      // because it is the stronger qualification signal.
      expect(extractBltc('I have a pre-approved home loan')).toMatchObject({
        financing: 'PREAPPROVED',
      });
      expect(extractBltc('loan approved already')).toMatchObject({ financing: 'PREAPPROVED' });
    });

    it('reads a needed loan', () => {
      expect(extractBltc('will need a loan')).toMatchObject({ financing: 'NEEDS_LOAN' });
      expect(extractBltc('emi kitni hogi')).toMatchObject({ financing: 'NEEDS_LOAN' });
      expect(extractBltc('loan chahiye')).toMatchObject({ financing: 'NEEDS_LOAN' });
    });

    it('reads a cash purchase', () => {
      expect(extractBltc('paying cash')).toMatchObject({ financing: 'CASH' });
      expect(extractBltc('full payment, no loan')).toMatchObject({ financing: 'CASH' });
      expect(extractBltc('self-funded')).toMatchObject({ financing: 'CASH' });
    });
  });

  it('lifts several slots out of one realistic Hinglish message', () => {
    const out = extractBltc(
      'Hi, looking for 3BHK in Wakad, budget 90 lakh, need in 3 months, loan chahiye',
      ['Wakad'],
    );

    expect(out).toEqual({
      config: '3BHK',
      localities: ['Wakad'],
      budgetMaxPaise: 90 * LAKH,
      timelineMonths: 3,
      financing: 'NEEDS_LOAN',
    });
  });
});

describe('slotOrderForEntry', () => {
  it('anchors a product-led opener on config', () => {
    for (const intent of [
      RealtyIntent.PRICE_INQUIRY,
      RealtyIntent.AVAILABILITY,
      RealtyIntent.DOC_REQUEST,
    ]) {
      expect(slotOrderForEntry(intent)[0]).toBe('config');
    }
  });

  it('anchors a location-led opener on location', () => {
    for (const intent of [RealtyIntent.SITE_VISIT, RealtyIntent.LOCATION_AMENITY]) {
      expect(slotOrderForEntry(intent)[0]).toBe('location');
    }
  });

  it('falls back to natural B-L-T-C order', () => {
    expect(slotOrderForEntry(null)).toEqual(['budget', 'location', 'timeline', 'config']);
    expect(slotOrderForEntry(RealtyIntent.GENERAL)).toEqual([
      'budget',
      'location',
      'timeline',
      'config',
    ]);
  });

  it('returns all four core slots exactly once, whatever the entry point', () => {
    for (const intent of [null, ...Object.values(RealtyIntent)]) {
      const order = slotOrderForEntry(intent);
      expect([...order].sort()).toEqual(['budget', 'config', 'location', 'timeline']);
    }
  });
});

describe('isSlotFilled', () => {
  it('treats either budget bound as filling the budget slot', () => {
    expect(isSlotFilled(profile({ budgetMinPaise: 50 * LAKH }), 'budget')).toBe(true);
    expect(isSlotFilled(profile({ budgetMaxPaise: 50 * LAKH }), 'budget')).toBe(true);
    expect(isSlotFilled(profile(), 'budget')).toBe(false);
  });

  it('treats a zero timeline as filled rather than absent', () => {
    // The check is an explicit null comparison; `if (timelineMonths)` would
    // re-ask a buyer who already answered.
    expect(isSlotFilled(profile({ timelineMonths: 0 }), 'timeline')).toBe(true);
    expect(isSlotFilled(profile(), 'timeline')).toBe(false);
  });

  it('requires at least one locality', () => {
    expect(isSlotFilled(profile({ localities: ['Wakad'] }), 'location')).toBe(true);
    expect(isSlotFilled(profile({ localities: [] }), 'location')).toBe(false);
  });

  it('reads the config slot', () => {
    expect(isSlotFilled(profile({ config: '2BHK' }), 'config')).toBe(true);
    expect(isSlotFilled(profile(), 'config')).toBe(false);
  });
});

describe('SLOT_QUESTIONS', () => {
  it('asks exactly one question per core slot', () => {
    expect(Object.keys(SLOT_QUESTIONS).sort()).toEqual([
      'budget',
      'config',
      'location',
      'timeline',
    ]);
    for (const question of Object.values(SLOT_QUESTIONS)) {
      expect(question.trim()).not.toBe('');
      expect(question).toContain('?');
      // ≤1 question per turn is the rule; a two-question prompt breaks it.
      expect(question.split('?').length - 1).toBe(1);
    }
  });
});
