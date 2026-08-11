/**
 * Contract tests for the `@gosumo/shared` public barrel.
 *
 * Two things are asserted here:
 *
 *  1. Symbols deleted as dead exports stay deleted. `packages/shared/src`
 *     ships committed `.js`/`.d.ts` artifacts that Jest resolves ahead of the
 *     `.ts` sources, so a stale artifact can keep a "removed" export alive at
 *     runtime long after the source is gone. Asserting on the *resolved*
 *     barrel catches that, and catches an unthinking re-add.
 *
 *  2. Every runtime enum the barrel still exports is reachable and
 *     self-consistent (`Enum.KEY === 'KEY'`), which is what the DTO validators
 *     and Prisma mappings assume throughout the API.
 */

import * as shared from '@gosumo/shared';

/**
 * Exports removed in the R19 dead-export sweep. Each had zero references
 * outside its own declaration across `apps/` and `packages/`.
 */
const REMOVED_EXPORTS = [
  // interfaces — superseded by module-local pipeline types
  'AIResponse',
  'BltcSlotState',
  'CadenceStepDefinition',
  // string-literal enum mirrors nothing consumed
  'CadenceTriggerValue',
  'CadenceStopOnValue',
  'TemplateCategoryValue',
  // enums with no consumer — the DB columns they mirrored are not modelled
  'ConversationPriority',
  'RefundType',
  'RefundMethod',
  'LeadExchangeStatus',
  // util superseded by frontend rupee formatting
  'paiseToCurrency',
] as const;

describe('@gosumo/shared barrel contract', () => {
  describe('removed dead exports', () => {
    it.each(REMOVED_EXPORTS)('does not re-export %s', (name) => {
      expect(shared as Record<string, unknown>).not.toHaveProperty(name);
    });

    it('keeps the surviving currency util', () => {
      // paiseToCurrency (display formatting) was dropped — the dashboard owns
      // rupee formatting. The paise-normalising direction is still shared.
      expect(typeof shared.currencyToPaise).toBe('function');
      expect(shared.currencyToPaise(100.5)).toBe(10050);
    });

    it('keeps CadenceStepCondition consumers working', () => {
      // The type is erased at runtime, but the enums the cadence engine pairs
      // it with must survive the sweep.
      expect(shared.CadenceTrigger.NO_RESPONSE).toBe('NO_RESPONSE');
      expect(shared.CadenceStopOn.REPLY).toBe('REPLY');
      expect(shared.TemplateCategory.UTILITY).toBe('UTILITY');
    });
  });

  describe('runtime enum integrity', () => {
    const enumEntries = Object.entries(shared as Record<string, unknown>).filter(
      ([, value]) =>
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string'),
    ) as Array<[string, Record<string, string>]>;

    it('exports at least one runtime enum', () => {
      expect(enumEntries.length).toBeGreaterThan(0);
    });

    /**
     * `Enum.KEY === 'KEY'` everywhere except where the wire value is not a
     * legal TS identifier. Each exception is the *wire* spelling, so a typo in
     * one still fails.
     */
    const VALUE_EXCEPTIONS: Record<string, Record<string, string>> = {
      RealtyPortal: { NINETYNINE_ACRES: '99ACRES' },
    };

    it.each(enumEntries)('%s has string keys equal to their values', (name, members) => {
      const exceptions = VALUE_EXCEPTIONS[name] ?? {};
      for (const [key, value] of Object.entries(members)) {
        expect(value).toBe(exceptions[key] ?? key);
      }
    });

    it.each(enumEntries)('%s has no empty members', (_name, members) => {
      expect(Object.keys(members).length).toBeGreaterThan(0);
      for (const value of Object.values(members)) {
        expect(value).not.toBe('');
      }
    });

    it.each(enumEntries)('%s has no duplicate values', (_name, members) => {
      const values = Object.values(members);
      expect(new Set(values).size).toBe(values.length);
    });
  });
});
