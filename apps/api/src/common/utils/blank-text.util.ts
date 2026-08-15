/**
 * Is this customer-supplied text actually empty?
 *
 * `text.trim().length === 0` is the obvious answer and it is wrong twice over
 * on real traffic. `trim()` removes Unicode *whitespace*, and the characters
 * that most often make up an accidentally-empty message are not whitespace:
 * a zero-width space pasted out of a web page, a byte-order mark carried in
 * from a spreadsheet, a soft hyphen. Each one is invisible, each one makes the
 * string non-empty, and each one used to buy a full trip through the AI
 * pipeline — an intent classification and a generation, both billed — reasoning
 * over a `<customer_message>` the model sees as blank.
 *
 * The reason this is a named rule rather than a regex written twice: the naive
 * version of it is actively harmful. U+200D ZERO WIDTH JOINER is on every
 * "invisible characters" list and it is *load-bearing* inside emoji — 👨‍👩‍👧‍👦
 * is four people glued together by three of them. Stripping it to test for
 * blankness is fine; stripping it from the message is not, and the two are one
 * careless edit apart.
 *
 * So this only ever answers a question. It never returns modified text, and the
 * caller stores what the customer actually sent.
 */

/**
 * Characters that occupy no space and carry no meaning on their own.
 *
 * Deliberately a short, enumerated list rather than a Unicode category escape
 * like `\p{Cf}`: that category also contains the bidirectional-control and
 * variation-selector characters, which change how neighbouring *visible* text
 * renders. This list is only the ones that are invisible standing alone.
 */
const INVISIBLE_CHARS =
  /[​‌‍⁠﻿­᠎]/gu;

/**
 * True when `text` contains nothing a person could see.
 *
 * A string with any visible character is not blank, however much invisible
 * padding surrounds it — which is what keeps a lone `👍` (a complete turn, and
 * a very common one) and a ZWJ emoji sequence on the non-blank side.
 */
export function isBlankText(text: string): boolean {
  return text.replace(INVISIBLE_CHARS, '').trim().length === 0;
}
