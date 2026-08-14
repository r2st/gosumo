/**
 * Form-side money conversion.
 *
 * These are the inverse pair that sits between a rupees-denominated number
 * input and the paise integers the API stores (root CLAUDE.md rule 4). Every
 * bug here is a factor of 100 in a real order total, and the inputs are raw
 * strings straight from the DOM — so blanks, junk, and float artefacts all have
 * to land somewhere defined.
 */
import { describe, expect, it } from 'vitest';
import { paiseToRupeesInput, rupeesToPaise } from './money';

describe('rupeesToPaise', () => {
  it('multiplies a numeric rupee value by 100', () => {
    expect(rupeesToPaise(105)).toBe(10_500);
  });

  it('parses a rupee string from an input', () => {
    expect(rupeesToPaise('105')).toBe(10_500);
    expect(rupeesToPaise('105.50')).toBe(10_550);
  });

  it('rounds to whole paise rather than storing a fraction', () => {
    // 10.555 × 100 = 1055.4999… in binary floating point; the column is an int.
    expect(rupeesToPaise(10.555)).toBe(1056);
    expect(rupeesToPaise('0.005')).toBe(1);
    expect(Number.isInteger(rupeesToPaise('19.99'))).toBe(true);
  });

  it('survives the classic float artefact', () => {
    // 0.1 + 0.2 style error: 19.99 * 100 = 1998.9999999999998
    expect(rupeesToPaise(19.99)).toBe(1999);
    expect(rupeesToPaise(8.29)).toBe(829);
  });

  it('treats an empty input as zero', () => {
    expect(rupeesToPaise('')).toBe(0);
    expect(rupeesToPaise(null)).toBe(0);
    expect(rupeesToPaise(undefined)).toBe(0);
  });

  it('treats unparseable text as zero rather than NaN', () => {
    // NaN would reach the API and be stored or rejected downstream; 0 is the
    // value the blank field visually implies.
    expect(rupeesToPaise('abc')).toBe(0);
    expect(rupeesToPaise('₹500')).toBe(0);
  });

  it('keeps an explicit zero as zero', () => {
    expect(rupeesToPaise(0)).toBe(0);
    expect(rupeesToPaise('0')).toBe(0);
  });

  it('carries a negative through for refunds and adjustments', () => {
    expect(rupeesToPaise('-50')).toBe(-5_000);
  });

  it('parses the leading number out of a partially typed value', () => {
    // parseFloat semantics — mid-typing states must not blow up the form.
    expect(rupeesToPaise('105abc')).toBe(10_500);
    expect(rupeesToPaise('105.')).toBe(10_500);
  });
});

describe('paiseToRupeesInput', () => {
  it('divides by 100 for a number input value', () => {
    expect(paiseToRupeesInput(10_500)).toBe('105');
  });

  it('keeps the paise part when there is one', () => {
    expect(paiseToRupeesInput(10_550)).toBe('105.5');
    expect(paiseToRupeesInput(1)).toBe('0.01');
  });

  it('renders an empty string for a missing value, so the field shows blank', () => {
    expect(paiseToRupeesInput(null)).toBe('');
    expect(paiseToRupeesInput(undefined)).toBe('');
  });

  it('renders an explicit zero as "0", not blank', () => {
    // The distinction matters: a free item is priced 0, not unpriced.
    expect(paiseToRupeesInput(0)).toBe('0');
  });

  it('round-trips a value back to the same paise integer', () => {
    for (const paise of [0, 1, 999, 10_500, 123_456_789]) {
      expect(rupeesToPaise(paiseToRupeesInput(paise))).toBe(paise);
    }
  });
});
