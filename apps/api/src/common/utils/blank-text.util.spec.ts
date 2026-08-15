/**
 * `isBlankText` — the rule for "the customer sent nothing".
 *
 * The emoji cases are the reason this is a shared helper rather than a
 * `trim()` at each call site. Every list of invisible characters includes
 * U+200D ZERO WIDTH JOINER, and U+200D is what holds a multi-person emoji
 * together — so the naive implementation of this function reports 👨‍👩‍👧‍👦
 * as an empty message and drops a real turn on the floor.
 */

import { isBlankText } from './blank-text.util';

describe('isBlankText', () => {
  describe('is blank', () => {
    it.each([
      ['an empty string', ''],
      ['spaces', '   '],
      ['a tab and a newline', '\t\n'],
      ['a non-breaking space', ' '],
      ['a zero-width space', '​'],
      ['a byte-order mark, as pasted from a spreadsheet', '﻿'],
      ['a soft hyphen', '­'],
      ['a word joiner', '⁠'],
      ['invisible characters mixed with whitespace', ' ​ \n\t﻿ '],
    ])('%s', (_label, text) => {
      expect(isBlankText(text)).toBe(true);
    });
  });

  describe('is not blank', () => {
    it.each([
      ['ordinary text', 'hello'],
      ['text with invisible padding around it', '​ hello ﻿'],
      ['a lone thumbs-up, which is a complete answer', '👍'],
      ['a ZWJ emoji sequence, whose joiners must survive the test', '👨‍👩‍👧‍👦'],
      ['a flag, which is two regional indicators', '🇮🇳'],
      ['Devanagari', 'नमस्ते'],
      ['a single punctuation mark', '?'],
      ['a zero', '0'],
    ])('%s', (_label, text) => {
      expect(isBlankText(text)).toBe(false);
    });
  });

  it('does not modify anything — it only answers a question', () => {
    // The caller stores what the customer actually sent. Stripping U+200D out
    // of a message would take 👨‍👩‍👧‍👦 apart into four separate people.
    const family = '👨‍👩‍👧‍👦';
    isBlankText(family);
    expect(family).toBe('👨‍👩‍👧‍👦');
    expect([...family].length).toBe(7);
  });
});
