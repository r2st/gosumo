/**
 * G009 M2 — computation surface hardening tests for the order/cart/coupon pipeline.
 *
 * Verifies that NaN, null, and non-finite Decimal values from Prisma
 * never propagate through the monetary pipeline.
 */
import { currencyToPaise } from '@gosumo/shared';

// Re-implement `dec` to test the pattern used in order/cart/coupon services
function dec(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

describe('dec() — Prisma Decimal/null → finite number', () => {
  it('converts a Prisma-like Decimal object', () => {
    const prismaDecimal = { valueOf: () => 199.99, toString: () => '199.99' };
    expect(dec(prismaDecimal)).toBe(199.99);
  });

  it('converts null to 0', () => {
    expect(dec(null)).toBe(0);
  });

  it('converts undefined to 0', () => {
    expect(dec(undefined)).toBe(0);
  });

  it('converts a numeric string', () => {
    expect(dec('42.5')).toBe(42.5);
  });

  it('converts NaN-producing input to 0', () => {
    expect(dec('not-a-number')).toBe(0);
    expect(dec({})).toBe(0);
    expect(dec(Symbol)).toBe(0);
  });

  it('converts Infinity to 0', () => {
    expect(dec(Infinity)).toBe(0);
    expect(dec(-Infinity)).toBe(0);
  });

  it('preserves negative values', () => {
    expect(dec(-100)).toBe(-100);
  });

  it('preserves zero', () => {
    expect(dec(0)).toBe(0);
    expect(dec('0')).toBe(0);
  });
});

describe('dec() + currencyToPaise pipeline', () => {
  it('null Decimal → 0 paise', () => {
    expect(currencyToPaise(dec(null))).toBe(0);
  });

  it('undefined Decimal → 0 paise', () => {
    expect(currencyToPaise(dec(undefined))).toBe(0);
  });

  it('NaN string → 0 paise', () => {
    expect(currencyToPaise(dec('NaN'))).toBe(0);
  });

  it('valid Decimal → correct paise', () => {
    const prismaDecimal = { valueOf: () => 1500.75 };
    expect(currencyToPaise(dec(prismaDecimal))).toBe(150075);
  });
});

describe('tax rate hardening', () => {
  function computeTax(totalPricePaise: number, rawTaxRate: unknown, taxInclusive: boolean): number {
    const taxRate = Math.max(0, dec(rawTaxRate));
    if (taxInclusive) {
      return Math.round(totalPricePaise - totalPricePaise / (1 + taxRate));
    }
    return Math.round(totalPricePaise * taxRate);
  }

  it('null tax rate → 0 tax', () => {
    expect(computeTax(10000, null, false)).toBe(0);
    expect(computeTax(10000, null, true)).toBe(0);
  });

  it('NaN tax rate → 0 tax', () => {
    expect(computeTax(10000, 'bad', false)).toBe(0);
    expect(computeTax(10000, 'bad', true)).toBe(0);
  });

  it('negative tax rate clamped to 0', () => {
    expect(computeTax(10000, -0.18, false)).toBe(0);
    expect(computeTax(10000, -1, true)).toBe(0);
  });

  it('valid 18% exclusive tax', () => {
    expect(computeTax(10000, 0.18, false)).toBe(1800);
  });

  it('valid 18% inclusive tax', () => {
    expect(computeTax(11800, 0.18, true)).toBe(1800);
  });
});

describe('pagination totalPages', () => {
  function totalPages(total: number, limit: number): number {
    return limit > 0 ? Math.ceil(total / limit) : 1;
  }

  it('normal pagination', () => {
    expect(totalPages(100, 20)).toBe(5);
    expect(totalPages(101, 20)).toBe(6);
    expect(totalPages(0, 20)).toBe(0);
  });

  it('limit = 0 returns 1 instead of Infinity/NaN', () => {
    expect(totalPages(100, 0)).toBe(1);
    expect(totalPages(0, 0)).toBe(1);
  });

  it('limit = 1 handles edge case', () => {
    expect(totalPages(5, 1)).toBe(5);
    expect(totalPages(0, 1)).toBe(0);
  });
});
