import type { clients } from '@prisma/client';

/**
 * Duplicate scoring for contacts.
 *
 * Pure and synchronous, so the rules can be argued with in a test rather than
 * inferred from query plans. Every function here is about *suggesting* a
 * duplicate; nothing in this file merges anything.
 */

export interface DuplicateSignal {
  /** Machine-readable reason, e.g. `phone-exact`. */
  code: string;
  /** What a person reads in the review screen. */
  label: string;
  /** Contribution to the score, 0–1. */
  weight: number;
}

export interface DuplicateScore {
  score: number;
  signals: DuplicateSignal[];
  /** One-line summary for `contact_merges.match_reason`. */
  reason: string;
}

/**
 * Weights.
 *
 * Phone and email are near-decisive because the tenant already enforces
 * `(business_id, phone)` and `(business_id, email)` as unique — two live rows
 * cannot share one, so an exact match only happens across a null, a formatting
 * difference, or a channel identity. Name is deliberately weak on its own:
 * "Sharma" is not evidence, and a name-only pair never reaches the suggest
 * threshold without something else agreeing.
 */
const WEIGHTS = {
  phoneExact: 0.65,
  phoneSuffix: 0.45,
  emailExact: 0.65,
  emailLocalPart: 0.2,
  nameExact: 0.3,
  nameNormalized: 0.2,
  channelIdentity: 0.55,
} as const;

/** A contact plus the channel identities that belong to it. */
export interface DedupCandidate {
  client: Pick<clients, 'id' | 'name' | 'email' | 'phone' | 'created_at'>;
  /** `external_id` values from `channel_contacts`, lower-cased. */
  externalIds?: string[];
}

/**
 * Score how likely two contacts are the same person.
 *
 * Signals are additive and the total is clamped to 1. Additive rather than
 * "strongest signal wins" because agreement across independent identifiers is
 * the whole point: a shared phone is common in an Indian household, a shared
 * phone *and* a matching name is not.
 */
export function scoreDuplicate(a: DedupCandidate, b: DedupCandidate): DuplicateScore {
  const signals: DuplicateSignal[] = [];

  const phoneA = normalizePhone(a.client.phone);
  const phoneB = normalizePhone(b.client.phone);
  if (phoneA && phoneB) {
    if (phoneA === phoneB) {
      signals.push({ code: 'phone-exact', label: 'Same phone number', weight: WEIGHTS.phoneExact });
    } else if (sharesSubscriberNumber(phoneA, phoneB)) {
      // The same subscriber number written with and without a country code.
      // Common where one row came from a webchat form and another from
      // WhatsApp, which always delivers the full international form.
      signals.push({
        code: 'phone-suffix',
        label: 'Same number, different country-code formatting',
        weight: WEIGHTS.phoneSuffix,
      });
    }
  }

  const emailA = normalizeEmail(a.client.email);
  const emailB = normalizeEmail(b.client.email);
  if (emailA && emailB) {
    if (emailA === emailB) {
      signals.push({ code: 'email-exact', label: 'Same email address', weight: WEIGHTS.emailExact });
    } else if (localPart(emailA) === localPart(emailB)) {
      // Weak on purpose: `info@` at two domains is two businesses.
      signals.push({
        code: 'email-local-part',
        label: 'Same email name at a different domain',
        weight: WEIGHTS.emailLocalPart,
      });
    }
  }

  const nameA = normalizeName(a.client.name);
  const nameB = normalizeName(b.client.name);
  if (nameA && nameB) {
    if (a.client.name?.trim() === b.client.name?.trim()) {
      signals.push({ code: 'name-exact', label: 'Identical name', weight: WEIGHTS.nameExact });
    } else if (nameA === nameB) {
      signals.push({
        code: 'name-normalized',
        label: 'Same name, different spacing or case',
        weight: WEIGHTS.nameNormalized,
      });
    }
  }

  const sharedIdentity = intersect(a.externalIds ?? [], b.externalIds ?? []);
  if (sharedIdentity.length > 0) {
    // The strongest signal available: the same channel account resolved to both
    // rows, which means the provider considers them one person.
    signals.push({
      code: 'channel-identity',
      label: 'Same channel identity',
      weight: WEIGHTS.channelIdentity,
    });
  }

  const score = Math.min(
    1,
    signals.reduce((sum, s) => sum + s.weight, 0),
  );

  return {
    score: round4(score),
    signals,
    reason: signals.length > 0 ? signals.map((s) => s.label).join('; ') : 'No matching identifiers',
  };
}

/**
 * Which of two contacts should survive a merge.
 *
 * The older record wins by default. It is the one other systems, exports and
 * the customer's own prior receipts already reference, and keeping the id that
 * more things point at is what makes the merge least visible from outside.
 * Completeness breaks the tie only when the ages are equal, because "has more
 * fields filled in" is a property that flips as soon as anyone edits either row.
 */
export function chooseSurvivor(a: DedupCandidate, b: DedupCandidate): DedupCandidate {
  const ageDelta = a.client.created_at.getTime() - b.client.created_at.getTime();
  if (ageDelta !== 0) return ageDelta < 0 ? a : b;
  return completeness(b.client) > completeness(a.client) ? b : a;
}

/** Filled identity fields, 0–3. */
function completeness(c: Pick<clients, 'name' | 'email' | 'phone'>): number {
  return [c.name, c.email, c.phone].filter((v) => v != null && String(v).trim() !== '').length;
}

/** Digits only. Keeps a leading `+` out of the comparison entirely. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 6 ? digits : null;
}

/**
 * Whether two numbers share a subscriber number.
 *
 * Compares the last ten digits, which is the Indian subscriber-number length
 * and the case this exists for: `9876543210` and `+919876543210` are the same
 * person reaching the business through two channels. Requires both to be long
 * enough, so two short numbers are never called equal by accident.
 */
export function sharesSubscriberNumber(a: string, b: string): boolean {
  if (a.length < 10 || b.length < 10) return false;
  return a.slice(-10) === b.slice(-10);
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function localPart(email: string): string {
  return email.split('@')[0] ?? email;
}

/**
 * Lower-cased, punctuation dropped, whitespace collapsed.
 *
 * `\p{M}` is in the keep-set alongside letters and digits, and it is not
 * optional here. Devanagari and every other Indic script writes vowels as
 * combining marks, which Unicode classes as `M` and not `L` — so a keep-set of
 * letters alone turns "आशा" into "आश" and "ਸਿੰਘ" into "ਸਘ". That does not merely
 * weaken the comparison: it mangles the names of most of this product's users
 * while leaving Latin ones untouched, so the damage is invisible to anyone
 * testing in English.
 */
export function normalizeName(name: string | null | undefined): string | null {
  const cleaned = (name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned : null;
}

function intersect(a: string[], b: string[]): string[] {
  const set = new Set(a.map((v) => v.toLowerCase()));
  return b.filter((v) => set.has(v.toLowerCase()));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
