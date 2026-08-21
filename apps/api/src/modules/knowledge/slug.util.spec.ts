/**
 * Slug derivation.
 *
 * Two failure modes drive these cases, and both are silent rather than loud:
 *
 *  - A title with no ASCII letters — Devanagari, an emoji, punctuation only —
 *    reduces to the empty string under a naive `[^a-z0-9]` strip. Every such
 *    title in a tenant then collides on `""` against the `(business_id, slug)`
 *    unique index, and the second article fails a P2002 the operator cannot
 *    act on. GoSumo's users are Indian small businesses, so this is the normal
 *    case, not an edge one.
 *  - Appending a `-2` discriminator to a slug already at the 160-character
 *    column limit produces a 162-character value. Postgres answers 22001,
 *    which surfaces as a 500 on what is really "two articles share a title".
 */
import { disambiguateSlug, slugify } from './slug.util';
import { MAX_SLUG_LENGTH } from './knowledge.constants';

describe('slugify', () => {
  it('lowercases and hyphenates a plain title', () => {
    expect(slugify('Refund Policy', 'fallback')).toBe('refund-policy');
  });

  it('collapses runs of punctuation and whitespace into one hyphen', () => {
    expect(slugify('Cash  on   delivery -- rules!', 'fallback')).toBe(
      'cash-on-delivery-rules',
    );
  });

  it('strips leading and trailing separators', () => {
    expect(slugify('  ...Shipping...  ', 'fallback')).toBe('shipping');
  });

  it('folds accents rather than dropping the letters', () => {
    expect(slugify('Café menu', 'fallback')).toBe('cafe-menu');
  });

  it('falls back rather than returning an empty slug for a non-Latin title', () => {
    expect(slugify('वापसी नीति', 'article-x')).toBe('article-x');
  });

  it('falls back for a title made only of punctuation', () => {
    expect(slugify('!!! ???', 'article-x')).toBe('article-x');
  });

  it('truncates to the column width without leaving a trailing hyphen', () => {
    const title = `${'word '.repeat(80)}`;
    const slug = slugify(title, 'fallback');

    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('disambiguateSlug', () => {
  it('appends the attempt number', () => {
    expect(disambiguateSlug('refund-policy', 2)).toBe('refund-policy-2');
  });

  it('keeps the result inside the column width for a maximum-length slug', () => {
    const long = 'a'.repeat(MAX_SLUG_LENGTH);

    const result = disambiguateSlug(long, 12);

    expect(result.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(result.endsWith('-12')).toBe(true);
  });

  it('does not produce a double hyphen when the truncation lands on one', () => {
    const long = `${'ab-'.repeat(MAX_SLUG_LENGTH)}`.slice(0, MAX_SLUG_LENGTH);

    const result = disambiguateSlug(long, 3);

    expect(result).not.toContain('--');
  });
});
