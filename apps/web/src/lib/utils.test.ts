import { describe, expect, it } from 'vitest';
import { cn, colorFromString, initials, toQuery } from './utils';

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('drops falsy entries so conditional classes stay inline', () => {
    expect(cn('a', false && 'b', null, undefined, 'c')).toBe('a c');
  });

  it('resolves conflicting Tailwind utilities in favour of the last one', () => {
    // This is the whole reason `cn` exists rather than a plain join — a
    // component's default padding has to lose to a caller's override.
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('accepts arrays and objects', () => {
    expect(cn(['a', 'b'], { c: true, d: false })).toBe('a b c');
  });

  it('returns an empty string when given nothing', () => {
    expect(cn()).toBe('');
  });
});

describe('toQuery', () => {
  it('returns an empty string when every param is omitted', () => {
    // Must be '' and not '?', or every request URL grows a bare question mark.
    expect(toQuery({})).toBe('');
    expect(toQuery({ a: undefined, b: null, c: '' })).toBe('');
  });

  it('builds a leading-? query string', () => {
    expect(toQuery({ page: 2 })).toBe('?page=2');
  });

  it('omits null, undefined and empty-string values', () => {
    expect(toQuery({ a: 1, b: null, c: undefined, d: '' })).toBe('?a=1');
  });

  it('keeps zero and false, which are meaningful filter values', () => {
    // A truthiness check here would silently drop `page=0` and `active=false`.
    expect(toQuery({ page: 0, active: false })).toBe('?page=0&active=false');
  });

  it('joins array values with commas', () => {
    expect(toQuery({ stages: ['NEW', 'QUALIFIED'] })).toBe('?stages=NEW%2CQUALIFIED');
  });

  it('omits an empty array rather than sending an empty value', () => {
    expect(toQuery({ stages: [], page: 1 })).toBe('?page=1');
  });

  it('percent-encodes values', () => {
    expect(toQuery({ q: 'Powai & Andheri' })).toBe('?q=Powai+%26+Andheri');
  });

  it('stringifies non-string scalars', () => {
    expect(toQuery({ n: 42, b: true })).toBe('?n=42&b=true');
  });
});

describe('colorFromString', () => {
  it('is deterministic for the same input', () => {
    // Avatars must not change colour between renders or across a page reload.
    expect(colorFromString('Asha Rao')).toBe(colorFromString('Asha Rao'));
  });

  it('always returns a class from the palette', () => {
    const palette = new Set([
      'bg-indigo-500',
      'bg-emerald-500',
      'bg-amber-500',
      'bg-rose-500',
      'bg-sky-500',
      'bg-violet-500',
      'bg-teal-500',
      'bg-orange-500',
    ]);
    for (const name of ['', 'a', 'Asha Rao', 'Ravi', 'ॠषि', 'x'.repeat(200)]) {
      expect(palette.has(colorFromString(name))).toBe(true);
    }
  });

  it('spreads different names across more than one colour', () => {
    const names = ['Asha', 'Ravi', 'Meena', 'Sunil', 'Priya', 'Karan', 'Divya', 'Arjun'];
    const used = new Set(names.map(colorFromString));
    expect(used.size).toBeGreaterThan(1);
  });

  it('handles the empty string without throwing', () => {
    expect(colorFromString('')).toBe('bg-indigo-500');
  });
});

describe('initials', () => {
  it('takes the first and last initial of a full name', () => {
    expect(initials('Asha Rao')).toBe('AR');
  });

  it('skips middle names', () => {
    expect(initials('Asha Kumari Rao')).toBe('AR');
  });

  it('takes the first two letters of a single name', () => {
    expect(initials('Asha')).toBe('AS');
  });

  it('uppercases a lowercase name', () => {
    expect(initials('asha rao')).toBe('AR');
  });

  it('returns ? for an empty or whitespace-only name', () => {
    // The avatar still has to render something when a lead arrives nameless.
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });

  it('collapses runs of whitespace rather than producing a blank initial', () => {
    expect(initials('  Asha    Rao  ')).toBe('AR');
  });

  it('handles a single-character name', () => {
    expect(initials('A')).toBe('A');
  });

  it('handles non-Latin scripts', () => {
    expect(initials('आशा राव')).toBe('आर');
  });
});
