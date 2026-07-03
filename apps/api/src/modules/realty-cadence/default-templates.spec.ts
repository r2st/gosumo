/**
 * Default template + cadence library tests. Guards the seed data's integrity:
 *  1. Exactly 12 templates ship (blueprint §17).
 *  2. Template names are unique and bodies declare every {{n}} placeholder.
 *  3. Every default cadence step references a real template name.
 *  4. No-response follow-ups fire on the D1/D3/D7 schedule with stop-on-reply.
 */

import { DEFAULT_TEMPLATES, DEFAULT_CADENCES } from './default-templates';
import { CadenceTrigger, CadenceStopOn, TemplateCategory } from '@gosumo/shared';

describe('DEFAULT_TEMPLATES', () => {
  it('ships exactly 12 real-estate templates', () => {
    expect(DEFAULT_TEMPLATES).toHaveLength(12);
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
