/**
 * Deterministic money extraction from free-text customer messages.
 *
 * The confidence calculator's `REFUND_OVER_LIMIT` hard override needs a
 * `refundAmountPaise` to compare against the business policy cap. Neither
 * classifier tier supplies one: Tier-1 keyword rules return `entities: {}` by
 * construction, and the Tier-3 prompt asks for an untyped `{"<key>": "<value>"}`
 * bag whose values arrive as strings even when the model does name an amount.
 * So the override never fired and an over-limit refund scored straight into
 * AUTO_PILOT. This util closes that gap without depending on the LLM.
 *
 * Deliberately conservative: a bare number is never money. A match needs either
 * an explicit currency marker (`₹`, `Rs`, `INR`, `rupees`, `rupaye`) or an
 * Indian magnitude suffix (`k`, `lakh`, `crore`). "2 kilo aloo" and "kal 3 baje"
 * must not read as ₹2 and ₹3.
 *
 * Everything is pure and synchronous.
 */

/** Multipliers for the magnitude suffixes Indian customers actually write. */
const MAGNITUDE: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:k|thousand|hazaa?r)$/i, 1_000],
  [/^(?:l|lac|lacs|lakh|lakhs)$/i, 100_000],
  [/^(?:cr|crore|crores)$/i, 10_000_000],
];

/**
 * A number written plainly (`5000`), western-grouped (`5,000`), or
 * Indian-grouped (`85,00,000`), with an optional decimal tail.
 */
const NUMBER = String.raw`\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?`;
const MAG = String.raw`k|thousand|hazaar|hazar|lakhs|lakh|lacs|lac|l|crores|crore|cr`;
const CURRENCY = String.raw`₹|rs\.?|inr|rupees|rupee|rupaye|rupaya|rupay`;

/**
 * Three shapes, tried against every position in the message:
 *   1. marker first  — "₹5,000", "Rs. 2 lakh", "INR 500"
 *   2. marker last   — "5000 rupees", "2 lakh rs"
 *   3. magnitude only — "50k", "1.2 Cr"
 * Case-insensitive; `g` so every candidate in a message is considered.
 */
const PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(String.raw`(?:${CURRENCY})\s*(${NUMBER})\s*(${MAG})?\b`, 'gi'),
  new RegExp(String.raw`\b(${NUMBER})\s*(${MAG})?\s*(?:${CURRENCY})\b`, 'gi'),
  new RegExp(String.raw`\b(${NUMBER})\s*(${MAG})\b`, 'gi'),
];

/** Guard against overflowing an integer paise column on absurd input. */
const MAX_PAISE = Number.MAX_SAFE_INTEGER;

/**
 * Extract the largest monetary amount mentioned in `text`, in **paise**.
 *
 * The largest — not the first — because the value feeds a "does this exceed the
 * policy cap?" check. When a message names several figures ("I paid 5000, refund
 * at least 2000"), the conservative reading is the one most likely to trip the
 * cap and route the turn to a human.
 *
 * Returns `null` when the message names no amount at all.
 */
export function extractAmountPaise(text: string | null | undefined): number | null {
  if (!text) return null;

  let best: number | null = null;

  for (const pattern of PATTERNS) {
    // Each call gets a fresh cursor — these are module-level `g` regexes and
    // `lastIndex` would otherwise leak between messages.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // A zero-width match would spin forever; nothing here can produce one,
      // but the cursor nudge makes that guarantee local.
      if (match[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      const paise = toPaise(match[1], match[2]);
      if (paise !== null && (best === null || paise > best)) best = paise;
    }
  }

  return best;
}

function toPaise(rawNumber: string | undefined, rawMagnitude: string | undefined): number | null {
  if (!rawNumber) return null;

  const rupees = parseFloat(rawNumber.replace(/,/g, ''));
  if (!Number.isFinite(rupees) || rupees <= 0) return null;

  const multiplier = magnitudeOf(rawMagnitude);
  if (multiplier === null) return null;

  // Round rather than truncate: "₹500.505" is ₹500.51, and the value has to be
  // an integer — paise is the storage unit for every monetary field.
  const paise = Math.round(rupees * multiplier * 100);
  if (!Number.isFinite(paise) || paise <= 0 || paise > MAX_PAISE) return null;
  return paise;
}

/** `undefined` suffix means a plain rupee figure (×1); an unknown one is a miss. */
function magnitudeOf(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  const suffix = raw.trim();
  for (const [pattern, multiplier] of MAGNITUDE) {
    if (pattern.test(suffix)) return multiplier;
  }
  return null;
}
