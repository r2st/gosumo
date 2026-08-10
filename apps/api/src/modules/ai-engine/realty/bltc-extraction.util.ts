import type {
  BltcExtraction,
  BltcProfile,
  BltcSlot,
  FinancingStatusValue,
  LeadPurposeValue,
} from '@gosumo/shared';
import { RealtyIntent } from '@gosumo/shared';

/**
 * Pure BLTC extraction + slot-ordering heuristics (blueprint §16.2).
 *
 * The deterministic extractor is a fast, fully-testable pre-pass that lifts
 * Budget / Location / Timeline / Config (plus purpose & financing) out of a
 * Hinglish message. The LLM does the nuanced extraction in production; this
 * layer guarantees the obvious cases are never missed and is the source of
 * truth for *which one* slot to ask about next.
 *
 * Money: rupees → paise is ×100. 1 lakh = ₹1,00,000 ⇒ 1e7 paise;
 * 1 crore = ₹1,00,00,000 ⇒ 1e9 paise.
 */

const LAKH_PAISE = 1e7;
const CRORE_PAISE = 1e9;

/** The natural B-L-T-C order and the entry-point-adapted variants. */
const DEFAULT_ORDER: BltcSlot[] = ['budget', 'location', 'timeline', 'config'];
const PRODUCT_FIRST_ORDER: BltcSlot[] = ['config', 'budget', 'location', 'timeline'];
const LOCATION_FIRST_ORDER: BltcSlot[] = ['location', 'config', 'budget', 'timeline'];

/**
 * The slot the state machine asks about first adapts to the entry point — a
 * buyer who opened with a price/availability question is already product-led,
 * so we anchor on config; a site-visit or location opener anchors on locality.
 */
export function slotOrderForEntry(entry: RealtyIntent | null): BltcSlot[] {
  switch (entry) {
    case RealtyIntent.PRICE_INQUIRY:
    case RealtyIntent.AVAILABILITY:
    case RealtyIntent.DOC_REQUEST:
      return PRODUCT_FIRST_ORDER;
    case RealtyIntent.SITE_VISIT:
    case RealtyIntent.LOCATION_AMENITY:
      return LOCATION_FIRST_ORDER;
    default:
      return DEFAULT_ORDER;
  }
}

/** Whether a given core slot is already filled on the profile. */
export function isSlotFilled(profile: BltcProfile, slot: BltcSlot): boolean {
  switch (slot) {
    case 'budget':
      return profile.budgetMinPaise != null || profile.budgetMaxPaise != null;
    case 'location':
      return profile.localities.length > 0;
    case 'timeline':
      return profile.timelineMonths != null;
    case 'config':
      return profile.config != null;
  }
}

/** The one question the AI should ask for a slot (≤1 per turn). */
export const SLOT_QUESTIONS: Record<BltcSlot, string> = {
  budget: 'What budget range are you working with? (for example, 60–75 lakh)',
  location: 'Which areas or localities are you considering?',
  timeline: 'When are you looking to buy — in the next few months, or a little later?',
  config: 'What configuration suits you best — 2BHK, 3BHK, or something else?',
};

// ─────────────────────────────────────────────
// Text extraction
// ─────────────────────────────────────────────

/**
 * Extract BLTC candidate values from a single message. Only slots the buyer
 * actually mentioned appear in the result — absent slots are left undefined so
 * the merge never clobbers known values with nulls.
 */
export function extractBltc(
  text: string,
  knownLocalities: string[] = [],
): BltcExtraction {
  const out: BltcExtraction = {};
  if (!text) return out;

  const lower = text.toLowerCase();

  const budget = extractBudget(lower);
  if (budget.budgetMinPaise !== undefined) out.budgetMinPaise = budget.budgetMinPaise;
  if (budget.budgetMaxPaise !== undefined) out.budgetMaxPaise = budget.budgetMaxPaise;

  const config = extractConfig(lower);
  if (config) out.config = config;

  const timeline = extractTimeline(lower);
  if (timeline != null) out.timelineMonths = timeline;

  const localities = extractLocalities(text, knownLocalities);
  if (localities.length) out.localities = localities;

  const purpose = extractPurpose(lower);
  if (purpose) out.purpose = purpose;

  const financing = extractFinancing(lower);
  if (financing) out.financing = financing;

  return out;
}

const UNIT = /(lakh|lac|lacs|lakhs|cr|crore|crores|l)\b/;

function unitToPaise(value: number, unit: string): number {
  return unit.startsWith('cr') ? Math.round(value * CRORE_PAISE) : Math.round(value * LAKH_PAISE);
}

function extractBudget(lower: string): { budgetMinPaise?: number; budgetMaxPaise?: number } {
  // Range: "50-60 lakh", "50 to 60 lakh", "between 50 and 70 lakh"
  const range =
    lower.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(lakh|lac|lacs|lakhs|cr|crore|crores|l)\b/) ||
    lower.match(/between\s*(\d+(?:\.\d+)?)\s*(?:and|to|-)\s*(\d+(?:\.\d+)?)\s*(lakh|lac|lacs|lakhs|cr|crore|crores|l)\b/);
  if (range) {
    const unit = range[3]!;
    return {
      budgetMinPaise: unitToPaise(parseFloat(range[1]!), unit),
      budgetMaxPaise: unitToPaise(parseFloat(range[2]!), unit),
    };
  }

  // Ceiling: "under/below/upto/max 80 lakh"
  const ceil = lower.match(
    /(?:under|below|upto|up to|max|maximum|within|budget is|budget)\s*₹?\s*(\d+(?:\.\d+)?)\s*(lakh|lac|lacs|lakhs|cr|crore|crores|l)\b/,
  );
  if (ceil) {
    return { budgetMaxPaise: unitToPaise(parseFloat(ceil[1]!), ceil[2]!) };
  }

  // Floor: "above/over/minimum 50 lakh"
  const floor = lower.match(
    /(?:above|over|minimum|min|at least|starting(?: from)?)\s*₹?\s*(\d+(?:\.\d+)?)\s*(lakh|lac|lacs|lakhs|cr|crore|crores|l)\b/,
  );
  if (floor) {
    return { budgetMinPaise: unitToPaise(parseFloat(floor[1]!), floor[2]!) };
  }

  // Bare single value with an explicit unit → treat as the ceiling.
  const single = lower.match(/₹?\s*(\d+(?:\.\d+)?)\s*(lakh|lac|lacs|lakhs|cr|crore|crores)\b/);
  if (single) {
    return { budgetMaxPaise: unitToPaise(parseFloat(single[1]!), single[2]!) };
  }
  return {};
}

function extractConfig(lower: string): string | null {
  const bhk = lower.match(/(\d+)\s*(bhk|rk)\b/);
  if (bhk) return `${bhk[1]}${bhk[2]!.toUpperCase()}`;
  if (/\bstudio\b/.test(lower)) return 'Studio';
  if (/\b1\s*bed(room)?\b/.test(lower)) return '1BHK';
  return null;
}

function extractTimeline(lower: string): number | null {
  if (/\b(immediate|immediately|urgent|asap|turant|abhi|right now|this month|is mahine)\b/.test(lower)) {
    return 1;
  }
  const months = lower.match(/(?:in\s*)?(\d+)\s*(month|months|mahine|mahina)\b/);
  if (months) return parseInt(months[1]!, 10);
  const weeks = lower.match(/(?:in\s*)?(\d+)\s*(week|weeks|hafte)\b/);
  if (weeks) return Math.max(1, Math.ceil(parseInt(weeks[1]!, 10) / 4));
  const years = lower.match(/(\d+)\s*(year|years|saal)\b/);
  if (years) return parseInt(years[1]!, 10) * 12;
  if (/\b(this year|is saal)\b/.test(lower)) return 12;
  if (/\b(next year|agle saal)\b/.test(lower)) return 18;
  if (/\b(no rush|no hurry|just (looking|exploring|browsing)|future|someday|later)\b/.test(lower)) {
    return 24;
  }
  return null;
}

const LOCALITY_STOPWORDS = new Set([
  'the', 'a', 'an', 'my', 'your', 'this', 'that', 'it', 'me', 'you', 'i',
  'looking', 'interested', 'buy', 'buying', 'want', 'need', 'area', 'areas',
  'flat', 'apartment', 'property', 'house', 'home', 'project', 'budget',
  'bhk', 'rk', 'month', 'months', 'year', 'lakh', 'crore', 'rent',
]);

function extractLocalities(original: string, known: string[]): string[] {
  const found = new Set<string>();
  const lower = original.toLowerCase();

  // Gazetteer match first — highest precision.
  for (const loc of known) {
    const l = loc.trim();
    if (l && new RegExp(`\\b${escapeRegExp(l.toLowerCase())}\\b`).test(lower)) {
      found.add(l);
    }
  }

  // Preposition + Capitalized proper noun ("in Wakad", "near Hinjewadi Phase 1").
  const re = /\b(?:in|at|near|around|towards)\s+([A-Z][a-zA-Z]+(?:\s+(?:[A-Z][a-zA-Z]+|Phase|phase)\s*\d*)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(original)) !== null) {
    const candidate = m[1]!.trim();
    const head = candidate.split(/\s+/)[0]!.toLowerCase();
    if (!LOCALITY_STOPWORDS.has(head)) found.add(candidate);
  }

  return [...found];
}

function extractPurpose(lower: string): LeadPurposeValue | null {
  if (/\b(invest|investment|rental income|roi|second home|returns?|appreciat)\b/.test(lower)) {
    return 'INVEST';
  }
  if (/\b(end use|end-use|rehne|rehna|family|to live|stay|self use|khud ke liye|apne liye)\b/.test(lower)) {
    return 'END_USE';
  }
  return null;
}

function extractFinancing(lower: string): FinancingStatusValue | null {
  if (/\b(pre-?approved|pre-?sanction|sanctioned|approved loan|loan approved)\b/.test(lower)) {
    return 'PREAPPROVED';
  }
  if (/\b(home ?loan|need(s)? (a )?loan|emi|finance|mortgage|loan chahiye|loan lena)\b/.test(lower)) {
    return 'NEEDS_LOAN';
  }
  if (/\b(cash|full payment|outright|self funded|self-funded|no loan)\b/.test(lower)) {
    return 'CASH';
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
