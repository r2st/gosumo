/**
 * Building the result snippet in TypeScript rather than with `ts_headline`.
 *
 * Postgres has a purpose-built function for this and it is deliberately not
 * used, for one reason: `ts_headline` returns *markup*. Its `StartSel`/`StopSel`
 * options wrap matches in whatever the caller asks for — `<mark>` by default —
 * and it does no escaping of the document it is highlighting.
 *
 * The document here is `messages.text_content`: text a customer typed and sent
 * over WhatsApp. A customer who sends `<img src=x onerror=…>` gets that string
 * stored verbatim (correctly — messages are append-only and unmodified), and
 * `ts_headline` would hand it back inside a field the dashboard has just been
 * told contains HTML. The one place in the product where an attacker chooses
 * the bytes is the one place a highlighted snippet gets rendered.
 *
 * So the API returns plain text and the match offsets, and the client decides
 * how to draw the highlight against text it escapes itself. That also makes the
 * snippet window testable without a database, and skips `ts_headline`'s cost —
 * it re-parses the whole document per row, which a ranked search over a large
 * `messages` table pays once for every hit on the page.
 */

/** How much text to show around the first match. */
export const SNIPPET_RADIUS = 80;

/** Hard cap on the returned snippet, whatever the radius produces. */
export const SNIPPET_MAX_LENGTH = 240;

/** Marks the snippet as clipped, on whichever side it was clipped. */
const ELLIPSIS = '…';

export interface SearchSnippet {
  /** Plain text — never markup. Safe to escape and render. */
  text: string;
  /**
   * Where the matched terms fall **within `text`**, as `[start, end)` pairs
   * over UTF-16 code units, ready for the client to wrap.
   *
   * Offsets are into the snippet, not the original message, because the client
   * only ever has the snippet.
   */
  matches: { start: number; end: number }[];
}

/**
 * Split a user's query into the words a snippet should highlight.
 *
 * Deliberately crude, and deliberately not the same tokenizer Postgres used to
 * match the row. The database decides *whether* a message matched; this only
 * decides where to point in it, so a highlight that misses a stem is a cosmetic
 * miss and not a wrong result. Quotes and `websearch_to_tsquery`'s operators
 * are stripped rather than interpreted — `-word` is a term the query excluded,
 * so highlighting it would point at the opposite of what was searched for.
 */
export function snippetTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .replace(/\bor\b|\band\b/gi, ' ')
        // `\p{M}` matters as much as `\p{L}` here. Devanagari vowel signs — the
        // मात्रा in "वापसी" — are combining marks, not letters, so a class of
        // letters and digits alone splits an ordinary Hindi word into fragments
        // and highlights the wrong span of a message the search matched
        // correctly. The same applies to every Indic script this inbox carries.
        .split(/[^\p{L}\p{N}\p{M}]+/u)
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 1),
    ),
  );
}

/**
 * A window of `text` around its first matching term, plus the offsets of every
 * term occurrence inside that window.
 *
 * Falls back to the head of the message when no term is found — which happens
 * whenever Postgres matched on a stem this function's tokenizer does not
 * reproduce. An empty snippet would be worse than an unhighlighted one.
 */
export function buildSnippet(
  text: string | null | undefined,
  query: string,
  radius: number = SNIPPET_RADIUS,
): SearchSnippet {
  if (!text) return { text: '', matches: [] };

  const terms = snippetTerms(query);
  const haystack = text.toLowerCase();

  let firstAt = -1;
  for (const term of terms) {
    const at = haystack.indexOf(term);
    if (at !== -1 && (firstAt === -1 || at < firstAt)) firstAt = at;
  }

  // No term located: show the head of the message rather than nothing.
  const centre = firstAt === -1 ? 0 : firstAt;
  let start = Math.max(0, centre - radius);
  let end = Math.min(text.length, centre + radius);

  // Grow to the cap when the match sits near one edge, so a hit at the very
  // start of a long message still shows the context that follows it.
  if (end - start < SNIPPET_MAX_LENGTH) {
    end = Math.min(text.length, start + SNIPPET_MAX_LENGTH);
    start = Math.max(0, end - SNIPPET_MAX_LENGTH);
  }

  const clippedStart = start > 0;
  const clippedEnd = end < text.length;
  const body = text.slice(start, end);
  const prefix = clippedStart ? ELLIPSIS : '';

  const matches: { start: number; end: number }[] = [];
  const bodyLower = body.toLowerCase();
  for (const term of terms) {
    let at = bodyLower.indexOf(term);
    while (at !== -1) {
      matches.push({ start: at + prefix.length, end: at + term.length + prefix.length });
      at = bodyLower.indexOf(term, at + term.length);
    }
  }

  // Sorted and merged so overlapping terms ("pay" and "payment") do not produce
  // nested ranges the client has to reconcile.
  matches.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const m of matches) {
    const last = merged[merged.length - 1];
    if (last && m.start <= last.end) {
      last.end = Math.max(last.end, m.end);
    } else {
      merged.push({ ...m });
    }
  }

  return {
    text: `${prefix}${body}${clippedEnd ? ELLIPSIS : ''}`,
    matches: merged,
  };
}
