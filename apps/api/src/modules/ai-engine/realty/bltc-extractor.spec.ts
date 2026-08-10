import type { BltcProfile } from '@gosumo/shared';
import { RealtyIntent } from '@gosumo/shared';
import { BltcExtractorService } from './bltc-extractor.service';

const LAKH = 1e7; // paise per lakh

function emptyProfile(over: Partial<BltcProfile> = {}): BltcProfile {
  return {
    budgetMinPaise: null,
    budgetMaxPaise: null,
    localities: [],
    timelineMonths: null,
    config: null,
    purpose: null,
    financing: null,
    ...over,
  };
}

describe('BltcExtractorService', () => {
  const svc = new BltcExtractorService();

  describe('extract() — deterministic BLTC lifting', () => {
    it('extracts a budget range', () => {
      expect(svc.extract('my budget is 50 to 60 lakh')).toMatchObject({
        budgetMinPaise: 50 * LAKH,
        budgetMaxPaise: 60 * LAKH,
      });
    });

    it('extracts a ceiling from "under X lakh"', () => {
      expect(svc.extract('something under 80 lakh please')).toEqual({ budgetMaxPaise: 80 * LAKH });
    });

    it('extracts a crore single value as a ceiling', () => {
      expect(svc.extract('budget around 1.2 crore')).toEqual({ budgetMaxPaise: 1.2 * 1e9 });
    });

    it('extracts config, timeline, purpose and financing', () => {
      const r = svc.extract('want a 3 BHK, planning in 4 months, for investment, need a home loan');
      expect(r.config).toBe('3BHK');
      expect(r.timelineMonths).toBe(4);
      expect(r.purpose).toBe('INVEST');
      expect(r.financing).toBe('NEEDS_LOAN');
    });

    it('maps urgency words to a 1-month timeline', () => {
      expect(svc.extract('need it immediately').timelineMonths).toBe(1);
      expect(svc.extract('koi jaldi nahi, next year').timelineMonths).toBe(18);
    });

    it('extracts localities from a gazetteer', () => {
      expect(svc.extract('interested in wakad and hinjewadi', ['Wakad', 'Hinjewadi']).localities).toEqual(
        expect.arrayContaining(['Wakad', 'Hinjewadi']),
      );
    });

    it('extracts a capitalised locality after a preposition', () => {
      expect(svc.extract('looking in Baner near the highway').localities).toContain('Baner');
    });

    it('returns an empty object when nothing is mentioned', () => {
      expect(svc.extract('ok thanks bhaiya')).toEqual({});
    });
  });

  describe('runTurn() — the one-question state machine', () => {
    it('asks Budget first for a plain new enquiry', () => {
      const r = svc.runTurn({ current: emptyProfile(), text: 'hi, interested', entryIntent: RealtyIntent.NEW_ENQUIRY });
      expect(r.nextSlotToAsk).toBe('budget');
      expect(r.nextQuestion).toMatch(/budget/i);
    });

    it('adapts the slot order to the entry point (price → config first)', () => {
      const r = svc.runTurn({ current: emptyProfile(), text: 'kitne ka hai', entryIntent: RealtyIntent.PRICE_INQUIRY });
      expect(r.nextSlotToAsk).toBe('config');
    });

    it('anchors on location for a site-visit opener', () => {
      const r = svc.runTurn({ current: emptyProfile(), text: 'want to visit', entryIntent: RealtyIntent.SITE_VISIT });
      expect(r.nextSlotToAsk).toBe('location');
    });

    it('never re-asks a filled slot', () => {
      const current = emptyProfile({ budgetMaxPaise: 70 * LAKH });
      const r = svc.runTurn({ current, text: 'nothing new', entryIntent: RealtyIntent.NEW_ENQUIRY });
      expect(r.nextSlotToAsk).toBe('location'); // budget already known → skip it
    });

    it('fills a slot opportunistically and moves to the next', () => {
      const r = svc.runTurn({
        current: emptyProfile(),
        text: 'my budget is 60-75 lakh',
        entryIntent: RealtyIntent.NEW_ENQUIRY,
      });
      expect(r.filledThisTurn).toContain('budgetMinPaise');
      expect(r.nextSlotToAsk).toBe('location');
    });

    it('surfaces a contradiction instead of overwriting a filled slot', () => {
      const current = emptyProfile({ config: '2BHK' });
      const r = svc.runTurn({
        current,
        text: 'actually I need a 3 BHK',
        entryIntent: RealtyIntent.NEW_ENQUIRY,
      });
      expect(r.profile.config).toBe('2BHK'); // not silently overwritten
      expect(r.contradictions).toEqual([
        expect.objectContaining({ slot: 'config', existing: '2BHK', incoming: '3BHK' }),
      ]);
    });

    it('merges localities additively; a disjoint set is flagged but unioned', () => {
      const current = emptyProfile({ localities: ['Wakad'] });
      const r = svc.runTurn({
        current,
        text: 'also consider Kharadi',
        entryIntent: RealtyIntent.NEW_ENQUIRY,
        knownLocalities: ['Kharadi'],
      });
      expect(r.profile.localities).toEqual(expect.arrayContaining(['Wakad', 'Kharadi']));
      expect(r.contradictions.some((c) => c.slot === 'localities')).toBe(true);
    });

    it('qualifies at 4/4 core slots with a reachable contact', () => {
      const current = emptyProfile({
        budgetMaxPaise: 80 * LAKH,
        localities: ['Wakad'],
        timelineMonths: 3,
      });
      const r = svc.runTurn({
        current,
        text: 'a 2 BHK works',
        entryIntent: RealtyIntent.NEW_ENQUIRY,
        reachable: true,
      });
      expect(r.bltcComplete).toBe(true);
      expect(r.qualified).toBe(true);
      expect(r.nextSlotToAsk).toBeNull();
      expect(r.nextQuestion).toBeNull();
    });

    it('does not qualify when the contact is unreachable', () => {
      const current = emptyProfile({
        budgetMaxPaise: 80 * LAKH,
        localities: ['Wakad'],
        timelineMonths: 3,
        config: '2BHK',
      });
      const r = svc.runTurn({ current, text: 'ok', reachable: false });
      expect(r.bltcComplete).toBe(true);
      expect(r.qualified).toBe(false);
    });

    it('lets the LLM extraction win where the regexes miss', () => {
      const r = svc.runTurn({
        current: emptyProfile(),
        text: 'somewhere quiet', // no regex-extractable locality
        entryIntent: RealtyIntent.NEW_ENQUIRY,
        llmExtraction: { localities: ['Aundh'] },
      });
      expect(r.profile.localities).toEqual(['Aundh']);
      expect(r.filledThisTurn).toContain('localities');
    });
  });

  describe('unknownSlots()', () => {
    it('lists remaining slots in the entry-adapted order', () => {
      const current = emptyProfile({ config: '2BHK' });
      expect(svc.unknownSlots(current, RealtyIntent.PRICE_INQUIRY)).toEqual(['budget', 'location', 'timeline']);
    });
  });
});
