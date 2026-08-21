import { MAX_SLUG_LENGTH } from './knowledge.constants';

/**
 * Derive a URL-safe slug from an article title.
 *
 * Titles here are written by Indian small-business operators, so they routinely
 * carry Devanagari, currency symbols and emoji. Stripping to `[a-z0-9-]` would
 * reduce "वापसी नीति" to the empty string, and an empty slug collides with
 * every other empty slug in the tenant — the second such article would fail a
 * unique-constraint violation the operator cannot act on. So a title that
 * survives transliteration keeps a readable slug, and one that does not falls
 * back to a caller-supplied discriminator rather than to "".
 */
export function slugify(title: string, fallback: string): string {
  const slug = title
    .normalize('NFKD')
    // Drop combining marks left behind by NFKD so "café" becomes "cafe"
    // rather than "cafe" plus a dangling accent that then becomes a hyphen.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    // The slice can leave a trailing hyphen when it lands mid-separator.
    .replace(/-+$/g, '');

  return slug.length > 0 ? slug : fallback;
}

/**
 * Append a numeric discriminator to a slug that is already taken, keeping the
 * result within `MAX_SLUG_LENGTH`.
 *
 * The suffix is appended to a *truncated* base rather than to the full slug:
 * appending to a slug already at the 160-character limit would produce a
 * 162-character value that Postgres rejects with a 22001, surfacing as a 500
 * on what is really "pick another title".
 */
export function disambiguateSlug(slug: string, attempt: number): string {
  const suffix = `-${attempt}`;
  const base = slug.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, '');
  return `${base}${suffix}`;
}
