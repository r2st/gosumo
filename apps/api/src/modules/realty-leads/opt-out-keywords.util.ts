/**
 * Inbound opt-out detection.
 *
 * The DPDPA notice every realty tenant sends says "Reply STOP to opt out
 * anytime" (`compliance/dpdpa.util.ts`). Until this existed, nothing read that
 * reply: `opt_out` was only ever set by the operator endpoint or by an erasure
 * request, so a buyer who typed STOP kept receiving cadence follow-ups and AI
 * answers — a promise made in writing and then broken.
 *
 * Deliberately a whole-message exact match on a small list, not a substring
 * scan: "can we stop by the site on Sunday?" is a site-visit request, and a
 * false positive here silences a buyer for good. Punctuation, emoji and case
 * are stripped first so "STOP!" and "Stop." still count.
 */

const OPT_OUT_PHRASES: ReadonlySet<string> = new Set([
  // English (the phrase the notice teaches, plus the industry-standard set)
  'stop',
  'stop all',
  'stop it',
  'stop messaging',
  'stop messaging me',
  'stop messages',
  'stop texting',
  'stop texting me',
  'unsubscribe',
  'opt out',
  'optout',
  'dnd',
  'do not disturb',
  'remove me',
  'dont message me',
  'do not message me',
  'dont contact me',
  'do not contact me',
  'no more messages',
  // Hinglish (Roman script — what a WhatsApp buyer in India actually types)
  'band karo',
  'msg band karo',
  'message band karo',
  'message mat karo',
  'msg mat karo',
  'mat bhejo',
  'message mat bhejo',
  'msg mat bhejo',
  'mujhe message mat karo',
  'mujhe msg mat karo',
]);

/**
 * Lower-case, drop apostrophes ("don't" → "dont"), turn every other
 * non-letter/digit into a space, collapse whitespace.
 */
export function normalizeOptOutText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the buyer's whole message is an opt-out instruction. */
export function isOptOutMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = normalizeOptOutText(text);
  if (!normalized) return false;
  // "please stop" / "stop please" / "pls stop" are the same instruction.
  const stripped = normalized.replace(/\b(please|pls|plz)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return OPT_OUT_PHRASES.has(stripped);
}
