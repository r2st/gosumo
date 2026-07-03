/**
 * Broker voice-command parsing (pure, unit-tested).
 *
 * Brokers dictate quick instructions as WhatsApp voice notes from the field —
 * "pause follow-ups for Rahul", "Serene Heights 2BHK now 94L", "assign Priya to
 * Amit", "book visit for Neha tomorrow 5pm" (blueprint §5.3). The AI transcribes
 * the note, then this lifts a structured, routable command out of the transcript
 * with deterministic regex/keyword rules (no LLM round-trip — a misheard command
 * must fail closed, never guess a price or a lead).
 *
 * Everything here is pure so the command grammar can be exhaustively tested.
 */

export type BrokerCommand =
  | { kind: 'PAUSE_FOLLOWUPS'; leadName: string }
  | { kind: 'RESUME_FOLLOWUPS'; leadName: string }
  | { kind: 'ASSIGN_LEAD'; leadName: string; agentName: string }
  | { kind: 'BOOK_VISIT'; leadName: string; when: string }
  | { kind: 'UPDATE_PRICE'; project: string; config: string; pricePaise: number };

const PAUSE_WORDS = ['pause', 'stop', 'hold', 'snooze'];
const RESUME_WORDS = ['resume', 'restart', 'continue', 'start'];

/**
 * Parse a broker command from a transcript. Returns null when nothing matches
 * confidently — the caller surfaces that as "not understood" rather than acting.
 * More specific commands are tried before the loose price pattern so a "for" /
 * "to" instruction is never mistaken for a price edit.
 */
export function parseBrokerCommand(transcript: string): BrokerCommand | null {
  const text = transcript.trim().replace(/\s+/g, ' ');
  if (!text) return null;

  return (
    matchFollowups(text) ??
    matchAssign(text) ??
    matchBookVisit(text) ??
    matchPriceUpdate(text) ??
    null
  );
}

// ─────────────────────────────────────────────
// pause / resume follow-ups for [name]
// ─────────────────────────────────────────────

function matchFollowups(text: string): BrokerCommand | null {
  const m = text.match(
    /\b(pause|stop|hold|snooze|resume|restart|continue|start)\b\s+(?:the\s+)?follow[-\s]?ups?\s+(?:for\s+)?(.+)/i,
  );
  if (!m) return null;
  const verb = m[1]!.toLowerCase();
  const leadName = cleanName(m[2]!);
  if (!leadName) return null;
  if (PAUSE_WORDS.includes(verb)) return { kind: 'PAUSE_FOLLOWUPS', leadName };
  if (RESUME_WORDS.includes(verb)) return { kind: 'RESUME_FOLLOWUPS', leadName };
  return null;
}

// ─────────────────────────────────────────────
// assign [name] to [agent]
// ─────────────────────────────────────────────

function matchAssign(text: string): BrokerCommand | null {
  const m = text.match(/\bassign\s+(?:lead\s+)?(.+?)\s+to\s+(.+)/i);
  if (!m) return null;
  const leadName = cleanName(m[1]!);
  const agentName = cleanName(m[2]!);
  if (!leadName || !agentName) return null;
  return { kind: 'ASSIGN_LEAD', leadName, agentName };
}

// ─────────────────────────────────────────────
// book visit for [name] [date/time]
// ─────────────────────────────────────────────

const WHEN_TOKENS =
  /\b(today|tomorrow|tonight|day after|next|this|on|at|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}(?:st|nd|rd|th))\b/i;

function matchBookVisit(text: string): BrokerCommand | null {
  const m = text.match(/\bbook\s+(?:a\s+)?(?:site\s+)?visit\s+for\s+(.+)/i);
  if (!m) return null;
  const tail = m[1]!.trim();

  // Split the tail into "<name> <when>" at the first temporal token.
  const whenMatch = tail.match(WHEN_TOKENS);
  let leadName = tail;
  let when = '';
  if (whenMatch && whenMatch.index != null && whenMatch.index > 0) {
    leadName = tail.slice(0, whenMatch.index).trim();
    when = tail.slice(whenMatch.index).trim();
  }
  leadName = cleanName(leadName);
  if (!leadName) return null;
  return { kind: 'BOOK_VISIT', leadName, when };
}

// ─────────────────────────────────────────────
// [project] [config] now [price]
// ─────────────────────────────────────────────

const CONFIG_RE = /(\d(?:\.\d)?\s?(?:bhk|rk)|studio)/i;

function matchPriceUpdate(text: string): BrokerCommand | null {
  const m = text.match(
    new RegExp(
      // project (lazy) · config · optional connector · optional currency · amount
      `^(.+?)\\s+${CONFIG_RE.source}\\s+(?:is\\s+)?(?:now|at|=|to|for|updated to|revised to)?\\s*` +
        `(?:₹|rs\\.?|inr)?\\s*([\\d.,]+\\s?(?:l|lakh|lac|cr|crore|k)?)\\b`,
      'i',
    ),
  );
  if (!m) return null;
  const project = cleanName(m[1]!);
  const config = normalizeConfig(m[2]!);
  const pricePaise = parseIndianMoneyToPaise(m[3]!);
  if (!project || !config || pricePaise == null) return null;
  return { kind: 'UPDATE_PRICE', project, config, pricePaise };
}

// ─────────────────────────────────────────────
// Shared money / config helpers
// ─────────────────────────────────────────────

/**
 * Parse an Indian money phrase to integer paise. Handles lakh/crore/thousand
 * shorthand ("94L", "1.2 Cr", "50k"), spelled-out units, and plain rupee
 * amounts. Returns null when nothing numeric parses.
 */
export function parseIndianMoneyToPaise(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim().toLowerCase();
  const m = cleaned.match(/^([\d.]+)\s*(l|lakh|lac|lakhs|cr|crore|crores|k|thousand)?$/);
  if (!m) return null;
  const value = parseFloat(m[1]!);
  if (Number.isNaN(value)) return null;

  const unit = m[2] ?? '';
  let rupees: number;
  if (/^(l|lakh|lac|lakhs)$/.test(unit)) rupees = value * 1e5;
  else if (/^(cr|crore|crores)$/.test(unit)) rupees = value * 1e7;
  else if (/^(k|thousand)$/.test(unit)) rupees = value * 1e3;
  else rupees = value;

  return Math.round(rupees * 100);
}

/** Normalize a unit config to the compact canonical form, e.g. "2 bhk" → "2BHK". */
function normalizeConfig(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** Trim trailing punctuation / filler that trailing-capture regexes pick up. */
function cleanName(raw: string): string {
  return raw
    .replace(/["'.,!?]+$/g, '')
    .replace(/\s+(please|now|asap|thanks|thank you)$/i, '')
    .trim();
}
