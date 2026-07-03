/**
 * Default template + cadence library tests. Guards the seed data's integrity:
 *  1. Every template type ships in English + Hindi (blueprint §17).
 *  2. Template names are unique and bodies declare every {{n}} placeholder.
 *  3. Each Hindi variant mirrors its English base (name/category/vars) in Devanagari.
 *  4. The operational template types the plan requires all exist.
 *  5. Every default cadence step references a real template name.
 *  6. No-response follow-ups fire on the D1/D3/D7 schedule with stop-on-reply.
 */

import { DEFAULT_TEMPLATES, DEFAULT_CADENCES } from './default-templates';
import { CadenceTrigger, CadenceStopOn, TemplateCategory } from '@gosumo/shared';

/** Matches any Devanagari code point — the script Hindi variants must be written in. */
const DEVANAGARI = /[ऀ-ॿ]/;

describe('DEFAULT_TEMPLATES', () => {
  const english = DEFAULT_TEMPLATES.filter((t) => t.language === 'en');
  const hindi = DEFAULT_TEMPLATES.filter((t) => t.language === 'hi');

  it('ships an English and a Hindi variant for every template type', () => {
    expect(english.length).toBeGreaterThan(0);
    expect(hindi).toHaveLength(english.length);
    expect(DEFAULT_TEMPLATES).toHaveLength(english.length + hindi.length);
  });

  it('only uses the en and hi languages', () => {
    for (const t of DEFAULT_TEMPLATES) expect(['en', 'hi']).toContain(t.language);
  });

  it('has unique names', () => {
    const names = DEFAULT_TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('declares a variable for every {{n}} placeholder in the body', () => {
    for (const t of DEFAULT_TEMPLATES) {
      const placeholders = new Set((t.body.match(/\{\{(\d+)\}\}/g) ?? []).map((m) => m));
      // The highest placeholder index must not exceed the variable count.
      const maxIndex = Math.max(
        0,
        ...[...placeholders].map((p) => Number(p.replace(/[^\d]/g, ''))),
      );
      expect(t.variables.length).toBeGreaterThanOrEqual(maxIndex);
    }
  });

  it('only uses valid categories', () => {
    const valid = new Set(Object.values(TemplateCategory));
    for (const t of DEFAULT_TEMPLATES) expect(valid.has(t.category)).toBe(true);
  });

  it('pairs each Hindi variant to its English base as `<name>_hi`, mirroring category and variables', () => {
    const byName = new Map(DEFAULT_TEMPLATES.map((t) => [t.name, t]));
    for (const hi of hindi) {
      expect(hi.name.endsWith('_hi')).toBe(true);
      const base = byName.get(hi.name.slice(0, -'_hi'.length));
      expect(base).toBeDefined();
      expect(base!.language).toBe('en');
      // Same audience/policy category and the same ordered placeholders as the English base.
      expect(hi.category).toBe(base!.category);
      expect(hi.variables).toEqual(base!.variables);
    }
  });

  it('gives every English template exactly one Hindi variant', () => {
    const hindiNames = new Set(hindi.map((t) => t.name));
    for (const en of english) expect(hindiNames.has(`${en.name}_hi`)).toBe(true);
  });

  it('writes Hindi bodies in Devanagari, not transliteration', () => {
    for (const hi of hindi) expect(hi.body).toMatch(DEVANAGARI);
  });

  it('never writes English bodies in Devanagari', () => {
    for (const en of english) expect(en.body).not.toMatch(DEVANAGARI);
  });

  it('includes the operational template types the plan requires, in both languages', () => {
    const names = new Set(DEFAULT_TEMPLATES.map((t) => t.name));
    const requiredTypes = [
      'price_update',
      'milestone_update',
      'opt_out_confirm',
      'site_visit_reminder_24h',
      'site_visit_reminder_2h',
    ];
    for (const type of requiredTypes) {
      expect(names.has(type)).toBe(true);
      expect(names.has(`${type}_hi`)).toBe(true);
    }
  });
});

describe('DEFAULT_CADENCES', () => {
  it('covers all three triggers', () => {
    const triggers = DEFAULT_CADENCES.map((c) => c.trigger);
    expect(triggers).toEqual(
      expect.arrayContaining([CadenceTrigger.NO_RESPONSE, CadenceTrigger.POST_VISIT, CadenceTrigger.DORMANT]),
    );
  });

  it('references only real template names', () => {
    const names = new Set(DEFAULT_TEMPLATES.map((t) => t.name));
    for (const c of DEFAULT_CADENCES) {
      for (const step of c.steps) {
        expect(names.has(step.templateName)).toBe(true);
      }
    }
  });

  it('fires the no-response cadence on D1 / D3 / D7 and stops on reply', () => {
    const noResponse = DEFAULT_CADENCES.find((c) => c.trigger === CadenceTrigger.NO_RESPONSE)!;
    expect(noResponse.steps.map((s) => s.dayOffset)).toEqual([1, 3, 7]);
    for (const step of noResponse.steps) {
      expect(step.stopOn).toContain(CadenceStopOn.REPLY);
      expect(step.stopOn).toContain(CadenceStopOn.OPTOUT);
    }
  });

  it('keeps step orders contiguous from 0 within each cadence', () => {
    for (const c of DEFAULT_CADENCES) {
      const orders = c.steps.map((s) => s.order).sort((a, b) => a - b);
      expect(orders).toEqual(orders.map((_, i) => i));
    }
  });
});
