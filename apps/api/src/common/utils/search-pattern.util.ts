/**
 * Making a user's search term mean itself.
 *
 * Every free-text search in this codebase reaches Postgres through a Prisma
 * `contains`, which compiles to `ILIKE '%' || term || '%'` with the term as a
 * bound parameter. The binding is what makes SQL injection structurally
 * impossible here — `' OR 1=1 --` arrives as $2 and is compared as text, never
 * parsed — and that part is fine.
 *
 * What is not fine is that Prisma passes `%`, `_` and `\` through untouched, so
 * they keep their LIKE meaning inside the pattern it builds. The term stops
 * being a string the caller is looking for and becomes a pattern they are
 * executing:
 *
 *   q=%      ->  ILIKE '%%%'    matches every row in the tenant
 *   q=_      ->  ILIKE '%_%'    matches every non-empty row
 *   q=50%    ->  ILIKE '%50%%'  matches "500 rupees", not just "50% off"
 *   q=\      ->  ILIKE '%\%'    matches a literal %, so the term is unfindable
 *
 * Two things go wrong at once. Results are wrong — "50% off" is an ordinary
 * thing to type into an inbox search for an Indian retail business, and it
 * silently returns the wrong set. And the cost is wrong: a pattern whose
 * leading characters are wildcards has no usable trigram to look up, so the GIN
 * indexes migration 0034 added are skipped and the query degrades to a
 * sequential scan of `messages` — the largest, append-only table in the schema.
 * `q=%` is the worst case, returning the tenant's entire message history from a
 * full scan.
 *
 * Measured on 40k rows with the 0034 index in place:
 *
 *   term "50%" unescaped   Seq Scan            1622 rows (wrong)  16.69 ms
 *   term "50%" escaped     Bitmap Index Scan     25 rows (right)   0.35 ms
 *   term "%"   unescaped   Seq Scan           40025 rows (all)    15.59 ms
 *
 * Escaping is what R49's length cap could not do: the cap bounds how expensive
 * one abusive term can be, but a single character was already enough.
 *
 * This is deliberately applied at each repository call site rather than in a
 * Prisma middleware. A middleware cannot tell a user-supplied search term from
 * a `contains` a caller built on purpose, and double-escaping is silent — it
 * turns a working search into one that finds nothing.
 */

/**
 * `term` with LIKE's metacharacters neutralised, ready to hand to a Prisma
 * `contains` / `startsWith` / `endsWith`.
 *
 * Backslash is Postgres's default LIKE escape character, which is why it has to
 * be escaped too and why all three are replaced in a single pass — escaping `%`
 * first and `\` second would re-escape the backslashes just added, and the user
 * would be searching for backslashes they never typed.
 *
 * The result is only meaningful inside a LIKE/ILIKE pattern. Do not use it for
 * equality filters, and do not store it.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The optional-parameter form, for the many list filters that are
 * `search?: string`.
 *
 * Returns `undefined` unchanged so a call site can keep spelling the filter as
 * `contains: escapeOptionalLikeTerm(filters.search)` without first testing for
 * presence — Prisma treats an undefined `contains` as "no constraint", which is
 * exactly the intent when no search was typed.
 */
export function escapeOptionalLikeTerm(term: string | undefined): string | undefined {
  return term === undefined ? undefined : escapeLikeTerm(term);
}
