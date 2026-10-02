import { currencyToPaise } from '@gosumo/shared';

describe('currencyToPaise — NaN/non-finite guard', () => {
  it('converts rupees to paise', () => {
    expect(currencyToPaise(100)).toBe(10000);
    expect(currencyToPaise(100.5)).toBe(10050);
    expect(currencyToPaise(0)).toBe(0);
    expect(currencyToPaise(0.01)).toBe(1);
    expect(currencyToPaise(99999.99)).toBe(9999999);
  });

  it('rounds to nearest paise for floating-point drift', () => {
    // 1.005 * 100 = 100.4999… in IEEE 754 — Math.round gives 100, not 101.
    // This is the expected behavior; callers must avoid sub-paise precision.
    expect(currencyToPaise(1.005)).toBe(100);
    expect(currencyToPaise(10.10)).toBe(1010);
    expect(currencyToPaise(99.99)).toBe(9999);
  });

  it('returns 0 for NaN input instead of propagating NaN', () => {
    expect(currencyToPaise(NaN)).toBe(0);
    expect(currencyToPaise(Number('abc'))).toBe(0);
    expect(currencyToPaise(Number(undefined))).toBe(0);
  });

  it('returns 0 for Infinity input', () => {
    expect(currencyToPaise(Infinity)).toBe(0);
    expect(currencyToPaise(-Infinity)).toBe(0);
  });

  it('handles negative amounts (refunds)', () => {
    expect(currencyToPaise(-100)).toBe(-10000);
    expect(currencyToPaise(-0.5)).toBe(-50);
  });
});
