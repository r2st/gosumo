import { RealtyIntent, RealtyRoutePolicy } from '@gosumo/shared';
import { FAST_MODEL, DEFAULT_MODEL, REASONING_MODEL } from '../ai-engine.constants';

/**
 * Realty AI-loop tuning constants (blueprint §16).
 *
 * Mirrors the general `ai-engine.constants` shape but for the 14 real-estate
 * intents. These are the single source of truth for the realty classifier,
 * confidence router, and guardrails.
 */

// ─────────────────────────────────────────────
// Realty confidence bands (0–100 scale)
// ─────────────────────────────────────────────

/** ≥ this → AUTO (AI sends autonomously). */
export const REALTY_AUTO = 90;
/** ≥ this (and below auto) → DRAFT (human reviews the AI draft). */
export const REALTY_DRAFT = 70;
/** ≥ this (and below draft) → GUIDED (AI asks one clarifying question). */
export const REALTY_GUIDED = 50;
/** Below GUIDED → ESCALATE (full hand-off to the broker). */

/** confidence = dataAvailability × W + policyClarity × W. */
export const REALTY_WEIGHT_DATA = 0.5;
export const REALTY_WEIGHT_POLICY = 0.5;

// The availability-freshness window that decides what the AI may assert lives
// with the module that enforces it: AVAILABILITY_FRESHNESS_HOURS in
// `realty-inventory/realty-inventory.constants.ts`. It is not redeclared here.

// ─────────────────────────────────────────────
// Default routing policy per intent (the autonomy ceiling)
// ─────────────────────────────────────────────

/**
 * Each intent's default autonomy ceiling. High-stakes intents (money, legal,
 * abuse) can never be auto-sent regardless of confidence; informational intents
 * grounded in verified data may auto-execute.
 */
export const REALTY_INTENT_POLICY: Record<RealtyIntent, RealtyRoutePolicy> = {
  [RealtyIntent.NEW_ENQUIRY]: RealtyRoutePolicy.AUTO_ALLOWED,
  [RealtyIntent.AVAILABILITY]: RealtyRoutePolicy.AUTO_ALLOWED,
  [RealtyIntent.DOC_REQUEST]: RealtyRoutePolicy.AUTO_ALLOWED,
  [RealtyIntent.LOCATION_AMENITY]: RealtyRoutePolicy.AUTO_ALLOWED,
  [RealtyIntent.SITE_VISIT]: RealtyRoutePolicy.AUTO_ALLOWED,
  [RealtyIntent.REACTIVATION_REPLY]: RealtyRoutePolicy.AUTO_ALLOWED,
  [RealtyIntent.GENERAL]: RealtyRoutePolicy.AUTO_ALLOWED,
  // Price must always be a verified, human-checked quote — never auto-sent.
  [RealtyIntent.PRICE_INQUIRY]: RealtyRoutePolicy.DRAFT_ONLY,
  [RealtyIntent.RENTAL]: RealtyRoutePolicy.DRAFT_ONLY,
  // Full human hand-off — the AI must not transact, advise, or argue.
  [RealtyIntent.NEGOTIATION]: RealtyRoutePolicy.ESCALATE,
  [RealtyIntent.LOAN_QUERY]: RealtyRoutePolicy.ESCALATE,
  [RealtyIntent.LEGAL_RERA]: RealtyRoutePolicy.ESCALATE,
  [RealtyIntent.SELLER_LEAD]: RealtyRoutePolicy.ESCALATE,
  [RealtyIntent.COMPLAINT_ABUSE]: RealtyRoutePolicy.ESCALATE,
};

// ─────────────────────────────────────────────
// Model routing — pick an OpenRouter free-model tier by intent
// ─────────────────────────────────────────────

/** Classification + BLTC extraction is cheap; run it on the fast tier every turn. */
export const REALTY_CLASSIFY_MODEL = FAST_MODEL;

/**
 * Customer-facing generation tier. High-stakes intents get the reasoning model;
 * simple informational replies get the default tier.
 */
export const REALTY_INTENT_MODEL: Record<RealtyIntent, string> = {
  [RealtyIntent.NEW_ENQUIRY]: DEFAULT_MODEL,
  [RealtyIntent.PRICE_INQUIRY]: DEFAULT_MODEL,
  [RealtyIntent.AVAILABILITY]: DEFAULT_MODEL,
  [RealtyIntent.SITE_VISIT]: DEFAULT_MODEL,
  [RealtyIntent.DOC_REQUEST]: FAST_MODEL,
  [RealtyIntent.LOCATION_AMENITY]: FAST_MODEL,
  [RealtyIntent.REACTIVATION_REPLY]: DEFAULT_MODEL,
  [RealtyIntent.RENTAL]: DEFAULT_MODEL,
  [RealtyIntent.GENERAL]: FAST_MODEL,
  [RealtyIntent.NEGOTIATION]: REASONING_MODEL,
  [RealtyIntent.LOAN_QUERY]: REASONING_MODEL,
  [RealtyIntent.LEGAL_RERA]: REASONING_MODEL,
  [RealtyIntent.SELLER_LEAD]: REASONING_MODEL,
  [RealtyIntent.COMPLAINT_ABUSE]: REASONING_MODEL,
};

// ─────────────────────────────────────────────
// Tier-1 keyword rules (fast, deterministic, Hinglish-aware)
// ─────────────────────────────────────────────

export interface RealtyIntentRule {
  intent: RealtyIntent;
  patterns: RegExp[];
  /** Patterns that, if matched, veto this rule. */
  negativePatterns?: RegExp[];
  /** Pre-override confidence (0–1) assigned when a pattern matches. */
  score: number;
}

/**
 * Ordered list — first rule whose positive pattern matches (and whose negative
 * patterns do not) wins. High-stakes / less-ambiguous intents are ordered first
 * so, e.g., an abuse report or a negotiation is never misread as a price query.
 */
export const REALTY_INTENT_RULES: RealtyIntentRule[] = [
  {
    intent: RealtyIntent.COMPLAINT_ABUSE,
    patterns: [
      /\b(spam|stop messaging|dont message|bakwaas|nonsense|fraud|cheat|scam)\b/i,
      /\b(complaint|complain|report kar)\b/i,
      /\b(bekar|ghatiya|worst)\b/i,
    ],
    score: 0.9,
  },
  {
    intent: RealtyIntent.NEGOTIATION,
    patterns: [
      /\b(discount|kam kar|kam karo|price drop|lower price|best price|negotiat|bargain)\b/i,
      /\b(rate kam|thoda kam|sasta|last price|final price)\b/i,
    ],
    score: 0.9,
  },
  {
    intent: RealtyIntent.LOAN_QUERY,
    patterns: [
      /\b(home ?loan|emi|loan eligib|down ?payment|interest rate|finance kar|bank loan|pre-?approv)\b/i,
      /\b(loan milega|kitni emi)\b/i,
    ],
    score: 0.9,
  },
  {
    intent: RealtyIntent.LEGAL_RERA,
    patterns: [
      /\b(rera|possession date|when possession|kab possession|oc|occupancy certificate|approval|title|legal|registry|registration)\b/i,
    ],
    negativePatterns: [/\bregister (my )?interest\b/i],
    score: 0.88,
  },
  {
    intent: RealtyIntent.SELLER_LEAD,
    patterns: [
      /\b(i want to sell|sell my (flat|property|house)|list my property|bechna hai|owner here|i am the owner)\b/i,
    ],
    score: 0.9,
  },
  {
    intent: RealtyIntent.RENTAL,
    patterns: [/\b(rent|rental|kiraya|kiraye|lease|pg\b|paying guest)\b/i],
    negativePatterns: [/\b(buy|purchase|khareed)\b/i],
    score: 0.85,
  },
  {
    intent: RealtyIntent.SITE_VISIT,
    patterns: [
      /\b(site visit|visit|dekhna hai|dekhne|come and see|schedule a visit|book.*visit|when can i visit|milne)\b/i,
    ],
    score: 0.85,
  },
  {
    intent: RealtyIntent.DOC_REQUEST,
    patterns: [
      /\b(brochure|floor ?plan|price ?sheet|price ?list|cost sheet|send.*(details|pdf|document)|share.*(brochure|plan))\b/i,
    ],
    score: 0.85,
  },
  {
    intent: RealtyIntent.AVAILABILITY,
    patterns: [
      /\b(available|availab|in stock|any units|units left|inventory|khaali hai|milega kya|is it still)\b/i,
    ],
    score: 0.82,
  },
  {
    intent: RealtyIntent.PRICE_INQUIRY,
    patterns: [
      /\b(price|cost|rate|kitne? ka|kitna|daam|budget kitna|per sq ?ft|per square)\b/i,
    ],
    score: 0.82,
  },
  {
    intent: RealtyIntent.LOCATION_AMENITY,
    patterns: [
      /\b(where is|location|kahan hai|address|nearby|amenit|clubhouse|gym|swimming|school nearby|metro|connectivity|distance)\b/i,
    ],
    score: 0.8,
  },
  {
    intent: RealtyIntent.REACTIVATION_REPLY,
    patterns: [
      /\b(still (available|interested)|following up|your (message|last message)|reminder ke baare|abhi bhi)\b/i,
    ],
    score: 0.7,
  },
  {
    intent: RealtyIntent.NEW_ENQUIRY,
    patterns: [
      /\b(interested in|enquir|inquir|looking for|details about|tell me about|info about|jaankari|want a? ?\d ?bhk)\b/i,
    ],
    score: 0.72,
  },
];
