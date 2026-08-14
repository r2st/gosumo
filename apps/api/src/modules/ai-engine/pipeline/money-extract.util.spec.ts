import { extractAmountPaise } from './money-extract.util';

/**
 * `extractAmountPaise` is the only thing standing between an over-limit refund
 * and the AUTO_PILOT band, so both directions matter: a miss re-opens the hole
 * the util was written to close, and a false positive escalates innocent
 * traffic ("2 kilo aloo") to a human for no reason.
 */
describe('extractAmountPaise', () => {
  describe('currency-marked amounts', () => {
    it.each([
      ['₹5000', 500_000],
      ['₹5,000', 500_000],
      ['Rs 5000', 500_000],
      ['Rs. 5000', 500_000],
      ['RS.5000', 500_000],
      ['INR 5000', 500_000],
      ['5000 rupees', 500_000],
      ['5000 rupee', 500_000],
      ['5000 rupaye', 500_000],
      ['5000 rs', 500_000],
      ['5000 INR', 500_000],
    ])('reads %s as %d paise', (text, expected) => {
      expect(extractAmountPaise(text)).toBe(expected);
    });

    it('reads an amount out of a full sentence, not just a bare token', () => {
      expect(extractAmountPaise('bhaiya please refund my ₹2,500 for the last order')).toBe(250_000);
    });

    it('keeps the sub-rupee part of a decimal amount', () => {
      expect(extractAmountPaise('refund Rs 500.50')).toBe(50_050);
    });

    it('rounds a third decimal place rather than truncating it', () => {
      // Paise is the storage unit; the value must land on an integer, and
      // rounding down would quietly under-report the amount being checked.
      expect(extractAmountPaise('refund Rs 500.505')).toBe(50_051);
    });
  });

  describe('Indian magnitude suffixes', () => {
    it.each([
      ['50k', 5_000_000],
      ['50 thousand', 5_000_000],
      ['5 hazaar', 500_000],
      ['2 lakh', 20_000_000],
      ['2 lakhs', 20_000_000],
      ['2L', 20_000_000],
      ['2 lac', 20_000_000],
      ['1.2 Cr', 1_200_000_000],
      ['1.2 crore', 1_200_000_000],
    ])('reads %s as %d paise', (text, expected) => {
      expect(extractAmountPaise(text)).toBe(expected);
    });

    it('combines a currency marker with a magnitude suffix', () => {
      expect(extractAmountPaise('₹2 lakh wapas chahiye')).toBe(20_000_000);
    });

    it('handles Indian comma grouping', () => {
      expect(extractAmountPaise('Rs 85,00,000')).toBe(850_000_000);
    });
  });

  describe('conservatism — what must NOT read as money', () => {
    it.each([
      ['2 kilo aloo chahiye'],
      ['kal 3 baje available hai?'],
      ['my order number is 4471'],
      ['call me on 9876543210'],
      ['delivery on 10.5.2024 please'],
      ['refund karo'],
      [''],
    ])('finds nothing in %p', (text) => {
      expect(extractAmountPaise(text)).toBeNull();
    });

    it('returns null for nullish input', () => {
      expect(extractAmountPaise(null)).toBeNull();
      expect(extractAmountPaise(undefined)).toBeNull();
    });

    it('rejects a zero or negative figure', () => {
      // "refund ₹0" is not an amount worth comparing against a cap. A negative
      // one is malformed rather than a credit, and the sign character breaks
      // the marker-to-digit adjacency, so it reads as no amount at all — which
      // is the conservative outcome for input nobody can interpret.
      expect(extractAmountPaise('refund ₹0')).toBeNull();
      expect(extractAmountPaise('refund Rs -500')).toBeNull();
    });
  });

  describe('several amounts in one message', () => {
    it('takes the largest, not the first', () => {
      // The value feeds a "does this exceed the cap?" test, so the reading most
      // likely to route the turn to a human is the safe one.
      expect(extractAmountPaise('I paid Rs 5000 but only want Rs 2000 back')).toBe(500_000);
    });

    it('compares across notations, not just within one', () => {
      expect(extractAmountPaise('was ₹500, actually 2 lakh')).toBe(20_000_000);
    });
  });

  describe('regex hygiene', () => {
    it('does not leak a cursor between calls', () => {
      // The patterns are module-level and /g; a stale `lastIndex` would make
      // the second identical call silently return null.
      const text = 'refund ₹5000 please';
      expect(extractAmountPaise(text)).toBe(500_000);
      expect(extractAmountPaise(text)).toBe(500_000);
      expect(extractAmountPaise(text)).toBe(500_000);
    });

    it('survives an absurdly large figure without overflowing', () => {
      expect(extractAmountPaise('refund 999999999 crore')).toBeNull();
    });
  });
});
