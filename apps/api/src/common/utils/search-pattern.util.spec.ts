/**
 * The assertions here are written against Postgres LIKE semantics, which were
 * checked against a real Postgres 16 before the escaping was written. The
 * patterns in the comments are exactly what Prisma builds — `'%' || term || '%'`
 * — so a reader can map each case back to the query that runs.
 */

import { escapeLikeTerm, escapeOptionalLikeTerm } from './search-pattern.util';

/**
 * A minimal LIKE evaluator, used only to state the *intent* of each escape in
 * terms a reader can check: after escaping, the term must match exactly the
 * subjects that contain it literally.
 *
 * Implemented by translating the LIKE pattern to a RegExp the same way Postgres
 * reads it — backslash escapes the next character, `%` is `.*`, `_` is `.`.
 */
function likeMatches(pattern: string, subject: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') {
      const next = pattern[++i];
      if (next === undefined) throw new Error('pattern ends with a dangling escape');
      re += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(subject);
}

/** What Prisma sends for `contains: term`. */
const contains = (term: string) => `%${term}%`;

describe('escapeLikeTerm', () => {
  it('leaves an ordinary search term untouched', () => {
    // The common case by far. If escaping altered these, every search in the
    // product would change behaviour.
    expect(escapeLikeTerm('priya sharma')).toBe('priya sharma');
    expect(escapeLikeTerm('Order #4471')).toBe('Order #4471');
    expect(escapeLikeTerm('')).toBe('');
  });

  it('escapes the three characters LIKE treats as syntax', () => {
    expect(escapeLikeTerm('%')).toBe('\\%');
    expect(escapeLikeTerm('_')).toBe('\\_');
    expect(escapeLikeTerm('\\')).toBe('\\\\');
  });

  it('escapes backslashes exactly once, not twice', () => {
    // The ordering trap: escaping % first and \ second would turn the newly
    // added backslashes into escaped backslashes, and the user would be
    // searching for characters they never typed.
    expect(escapeLikeTerm('50%')).toBe('50\\%');
    expect(escapeLikeTerm('C:\\tmp')).toBe('C:\\\\tmp');
    expect(escapeLikeTerm('a\\%b')).toBe('a\\\\\\%b');
  });

  it('escapes every occurrence, not just the first', () => {
    expect(escapeLikeTerm('%a%b%')).toBe('\\%a\\%b\\%');
  });

  it('is idempotent in effect but not in text', () => {
    // Applying it twice is a bug, and a silent one — this pins that the second
    // application visibly changes the string, so a double-escape shows up in
    // any test that asserts on the pattern rather than passing unnoticed.
    expect(escapeLikeTerm(escapeLikeTerm('50%'))).toBe('50\\\\\\%');
  });
});

describe('escaped terms match literally', () => {
  it('stops "50%" from matching "500"', () => {
    // The wrong-results half of the bug: an Indian retailer searching their
    // inbox for a discount finds every order whose amount starts with 50.
    expect(likeMatches(contains('50%'), '500 rupees paid')).toBe(true);
    expect(likeMatches(contains(escapeLikeTerm('50%')), '500 rupees paid')).toBe(false);
  });

  it('still finds the term the user meant', () => {
    // A cap that breaks the legitimate search is not a fix.
    expect(likeMatches(contains(escapeLikeTerm('50%')), 'Diwali sale 50% off')).toBe(true);
  });

  it('stops a bare "%" from matching everything', () => {
    // The cost half: this pattern has no leading trigram, so the GIN index is
    // skipped and Postgres sequentially scans the tenant's whole message table
    // — then returns all of it.
    expect(likeMatches(contains('%'), 'any message at all')).toBe(true);
    expect(likeMatches(contains(escapeLikeTerm('%')), 'any message at all')).toBe(false);
    expect(likeMatches(contains(escapeLikeTerm('%')), 'a 100% refund')).toBe(true);
  });

  it('stops a bare "_" from matching every non-empty row', () => {
    expect(likeMatches(contains('_'), 'any message')).toBe(true);
    expect(likeMatches(contains(escapeLikeTerm('_')), 'any message')).toBe(false);
    expect(likeMatches(contains(escapeLikeTerm('_')), 'order_id 55')).toBe(true);
  });

  it('makes a literal backslash findable', () => {
    // Unescaped, `contains: '\'` builds `%\%`, whose trailing `\%` Postgres
    // reads as an escaped percent — so the term matches a literal % and never
    // the backslash the user typed.
    expect(likeMatches(contains('\\'), 'path C:\\tmp')).toBe(false);
    expect(likeMatches(contains(escapeLikeTerm('\\')), 'path C:\\tmp')).toBe(true);
  });

  it('never produces a pattern ending in a dangling escape', () => {
    // A pattern whose last character is an unpaired backslash is a runtime
    // error in Postgres, not empty results. The evaluator above throws on one,
    // so this asserts the escaping cannot build one out of hostile input.
    for (const term of ['\\', 'abc\\', '\\\\', '%\\', '\\%', '_\\_']) {
      expect(() => likeMatches(contains(escapeLikeTerm(term)), 'subject')).not.toThrow();
    }
  });
});

describe('escaped terms carry no SQL meaning', () => {
  // Injection is already impossible — the term is a bound parameter, verified
  // against Postgres by reading the generated SQL, which is `text_content ILIKE
  // $2` with the term in $2. These pin that the escaping neither introduces a
  // way to break out nor mangles such input into something unsearchable.
  it.each([
    "' OR 1=1 --",
    "'; DROP TABLE messages; --",
    "%' OR '1'='1",
    "\\'; DELETE FROM messages WHERE '1'='1",
    'UNION SELECT null, version()',
  ])('leaves %j as ordinary searchable text', (payload) => {
    const escaped = escapeLikeTerm(payload);

    // No quote is added or removed: the value's SQL-relevant characters are
    // untouched, because they were never the mechanism.
    expect(escaped.replace(/\\(?=[\\%_])/g, '')).toBe(payload);

    // And it still behaves as a plain substring search against itself.
    expect(likeMatches(contains(escaped), `note: ${payload} was typed`)).toBe(true);
  });
});

describe('escapeOptionalLikeTerm', () => {
  it('passes undefined through so an absent filter stays absent', () => {
    // Prisma reads `contains: undefined` as "no constraint". Turning it into
    // an empty string would instead match every row.
    expect(escapeOptionalLikeTerm(undefined)).toBeUndefined();
  });

  it('escapes a present term', () => {
    expect(escapeOptionalLikeTerm('50%')).toBe('50\\%');
  });

  it('preserves an empty string rather than dropping it', () => {
    expect(escapeOptionalLikeTerm('')).toBe('');
  });
});
