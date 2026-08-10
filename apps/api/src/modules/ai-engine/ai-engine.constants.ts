import { ConfidenceMode, IntentType } from '@gosumo/shared';

/**
 * AI Engine tuning constants.
 *
 * These values implement the routing bands, model-tier routing, and the
 * deterministic rule engines described in AI_ENGINE_DESIGN.md. They are the
 * single source of truth for the module — services import from here rather
 * than hard-coding magic numbers.
 */

// ─────────────────────────────────────────────
// Confidence routing bands (0.0–1.0 scale)
// ─────────────────────────────────────────────

/** ≥ this → AUTO_PILOT (AI acts autonomously). */
export const CONFIDENCE_AUTO_EXECUTE = 0.9;
/** ≥ this (and below auto) → DRAFT (human reviews the AI draft). */
export const CONFIDENCE_DRAFT_REVIEW = 0.7;
/** ≥ this (and below draft) → GUIDED (AI asks a clarifying question). */
export const CONFIDENCE_GUIDED = 0.5;
/** Below GUIDED → ESCALATION (full hand-off to a human). */

// ─────────────────────────────────────────────
// Confidence formula weights
// confidence = (dataAvailability × W_DATA) + (policyClarity × W_POLICY)
// ─────────────────────────────────────────────

export const WEIGHT_DATA_AVAILABILITY = 0.5;
export const WEIGHT_POLICY_CLARITY = 0.5;

// ─────────────────────────────────────────────
// Pipeline limits
// ─────────────────────────────────────────────

/** Number of recent messages loaded as conversation history. */
export const CONTEXT_MESSAGE_WINDOW = 20;
/**
 * Max characters kept per message when rendering conversation history into
 * the prompt. WhatsApp/web-chat text can run to tens of thousands of
 * characters; without a cap, one oversized message stays in the window for
 * up to CONTEXT_MESSAGE_WINDOW turns and can crowd out RAG context or blow
 * the free-tier model's context limit.
 */
export const MAX_HISTORY_MESSAGE_CHARS = 500;
/** Maximum RAG chunks injected into the prompt. */
export const MAX_RAG_CHUNKS = 5;
/** Qdrant similarity floor — chunks below this are discarded. */
export const RAG_SCORE_THRESHOLD = 0.65;
/** Max tokens the LLM may produce for a customer-facing reply. */
export const LLM_MAX_TOKENS = 1024;
/** LLM call timeout (ms) before falling back to escalation. */
export const LLM_TIMEOUT_MS = 8_000;
/** Number of inbound exchanges with an unchanged intent that triggers a loop. */
export const LOOP_DETECTION_THRESHOLD = 3;

/**
 * Fallback confidence-routing thresholds (percent) when a tenant has not set
 * their own in `businesses.ai_settings`. Mirrors the band definition in
 * CLAUDE.md: >= 90 auto-executes, 70-89 drafts for review.
 */
export const DEFAULT_AUTO_EXECUTE_THRESHOLD = 90;
export const DEFAULT_DRAFT_REVIEW_THRESHOLD = 70;

// ─────────────────────────────────────────────
// Model routing — pick an OpenRouter free-tier model by intent
//
// All models are OpenRouter free slugs (":free"). LLM calls go through the
// OpenAI-compatible chat endpoint in `LlmClientService`. Swap these for any
// other OpenRouter model id (free or paid) without touching call sites.
// ─────────────────────────────────────────────

export const DEFAULT_MODEL = 'openai/gpt-oss-20b:free';
export const FAST_MODEL = 'openai/gpt-oss-20b:free';
export const REASONING_MODEL = 'openai/gpt-oss-120b:free';

/**
 * Map each intent to the most cost-appropriate model tier.
 * High-stakes intents (refunds, complaints, legal) use the larger reasoning
 * model; chit-chat and simple inquiries use the fast model.
 */
export const INTENT_MODEL_ROUTING: Record<IntentType, string> = {
  [IntentType.CHIT_CHAT]: FAST_MODEL,
  [IntentType.GENERAL_INQUIRY]: FAST_MODEL,
  [IntentType.PRICING]: DEFAULT_MODEL,
  [IntentType.BOOKING]: DEFAULT_MODEL,
  [IntentType.ORDER]: DEFAULT_MODEL,
  [IntentType.PAYMENT]: DEFAULT_MODEL,
  [IntentType.ORDER_TRACKING]: DEFAULT_MODEL,
  [IntentType.FOLLOW_UP]: DEFAULT_MODEL,
  [IntentType.PROMOTION_RESPONSE]: DEFAULT_MODEL,
  [IntentType.CANCELLATION]: DEFAULT_MODEL,
  [IntentType.RETURNS]: DEFAULT_MODEL,
  [IntentType.COMPLAINT]: REASONING_MODEL,
  [IntentType.REFUND]: REASONING_MODEL,
};

/** Temperature per intent — transactional intents stay deterministic. */
export const INTENT_TEMPERATURE: Partial<Record<IntentType, number>> = {
  [IntentType.CHIT_CHAT]: 0.7,
  [IntentType.GENERAL_INQUIRY]: 0.5,
};
export const DEFAULT_TEMPERATURE = 0.3;

// ─────────────────────────────────────────────
// Tier-1 intent keyword rules (fast, deterministic)
// Runs on normalized text — handles transliterated Hinglish.
// ─────────────────────────────────────────────

export interface IntentRule {
  intent: IntentType;
  patterns: RegExp[];
  /** Patterns that, if matched, veto this rule (e.g. "don't cancel"). */
  negativePatterns?: RegExp[];
  /** Pre-override score assigned when a pattern matches. */
  score: number;
}

/**
 * Ordered list — the first rule whose pattern matches (and whose negative
 * patterns do not) wins. Higher-priority / less-ambiguous intents come first.
 */
export const INTENT_RULES: IntentRule[] = [
  {
    intent: IntentType.REFUND,
    patterns: [/\brefund\b/i, /\bpaisa? ?wapas\b/i, /\bpaise? do\b/i, /\bmoney back\b/i],
    score: 0.95,
  },
  {
    intent: IntentType.CANCELLATION,
    patterns: [/\bcancel\b/i, /\bband karo\b/i, /\brokna hai\b/i],
    negativePatterns: [/\b(nahi|dont|do not|don't) cancel\b/i],
    score: 0.93,
  },
  {
    intent: IntentType.RETURNS,
    patterns: [/\breturn\b/i, /\bwapas karna\b/i, /\bexchange\b/i, /\bvapas lena\b/i],
    negativePatterns: [/\bpaisa? ?wapas\b/i],
    score: 0.9,
  },
  {
    intent: IntentType.ORDER_TRACKING,
    patterns: [/\btrack\b/i, /\bkahan hai\b/i, /\bdelivery status\b/i, /\bparcel\b/i, /\bshipment\b/i],
    score: 0.92,
  },
  {
    intent: IntentType.PAYMENT,
    patterns: [/\bupi\b/i, /\bpayment link\b/i, /\bpay\b/i, /\bbhugtan\b/i, /\bqr code\b/i],
    score: 0.88,
  },
  {
    intent: IntentType.BOOKING,
    patterns: [/\bbook\b/i, /\bappointment\b/i, /\bslot\b/i, /\bavailable\b/i, /\bbaje\b/i],
    score: 0.85,
  },
  {
    intent: IntentType.PRICING,
    patterns: [/\bprice\b/i, /\bkitne? ka\b/i, /\bkitna\b/i, /\bcost\b/i, /\brate\b/i, /\bdaam\b/i],
    score: 0.85,
  },
  {
    intent: IntentType.ORDER,
    patterns: [/\border\b/i, /\bchahiye\b/i, /\bkilo\b/i, /\bbuy\b/i, /\blena hai\b/i],
    score: 0.82,
  },
  {
    intent: IntentType.FOLLOW_UP,
    patterns: [/\baaya nahi\b/i, /\bstatus\b/i, /\bupdate\b/i, /\bkab tak\b/i],
    score: 0.78,
  },
  {
    intent: IntentType.COMPLAINT,
    patterns: [/\bkharab\b/i, /\bbad\b/i, /\bwrong\b/i, /\bgalat\b/i, /\bproblem\b/i, /\bcomplaint\b/i],
    score: 0.8,
  },
];

// ─────────────────────────────────────────────
// Safety pattern banks
// ─────────────────────────────────────────────

/** Prompt-injection / jailbreak heuristics — checked before the LLM call. */
export const JAILBREAK_PATTERNS: RegExp[] = [
  /ignore (the )?(previous|all|your|above) (instructions?|rules?|guidelines?|prompt)/i,
  /forget (everything|your training|what you were told|the rules)/i,
  /you are now an? (different|new|unrestricted|jailbroken) (ai|assistant|bot|model)/i,
  /pretend (you are|to be|you're) (not|an?)/i,
  /disregard (the|your|all) (above|system prompt|instructions?|rules?)/i,
  /\[\s*system\s*\]/i,
  /<\/?\s*system\s*>/i,
  /<\/?\s*instruction\s*>/i,
  /act as (a|an|the) (dan|developer mode)/i,
];

/** Legal-threat keywords (English + Hindi transliteration) — force escalation. */
export const LEGAL_THREAT_PATTERNS: RegExp[] = [
  /\bconsumer (court|forum)\b/i,
  /\bcourt\b/i,
  /\bpolice\b/i,
  /\bfir\b/i,
  /\badvocate\b/i,
  /\blawyer\b/i,
  /\blegal action\b/i,
  /\bsue\b/i,
  /\bcase (file|karunga|karoonga)\b/i,
  /\bcheating\b/i,
  /\bfraud\b/i,
  /\bgrahak (adalat|forum)\b/i,
  /\badalat\b/i,
];

/** Customer explicitly asks for a human agent — force escalation. */
export const HUMAN_REQUEST_PATTERNS: RegExp[] = [
  /\b(talk|speak|baat) (to|with|karni|karna) (a |an )?(human|person|manager|owner|agent|senior|admi|insaan)\b/i,
  /\bmanager se baat\b/i,
  /\breal person\b/i,
  /\bhuman agent\b/i,
];

/** PII detectors — flag (and redact in logs) before processing. */
export interface PiiPattern {
  type: 'AADHAAR' | 'PAN' | 'CREDIT_CARD' | 'BANK_ACCOUNT' | 'IFSC';
  pattern: RegExp;
}

export const PII_PATTERNS: PiiPattern[] = [
  { type: 'AADHAAR', pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/ },
  { type: 'PAN', pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/ },
  { type: 'CREDIT_CARD', pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/ },
  { type: 'IFSC', pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/ },
];

// ─────────────────────────────────────────────
// Hard-override codes & forced scores
// ─────────────────────────────────────────────

export const OVERRIDE = {
  JAILBREAK: { code: 'jailbreak_attempt', forceScore: 0.0, escalate: true },
  PII_DETECTED: { code: 'pii_risk_detected', forceScore: 0.1, escalate: true },
  LEGAL_THREAT: { code: 'customer_mentions_legal_action', forceScore: 0.1, escalate: true },
  HUMAN_REQUEST: { code: 'explicit_human_request', forceScore: 0.1, escalate: true },
  LOOP: { code: 'loop_detection', forceScore: 0.2, escalate: true },
  SENTIMENT_CRITICAL: { code: 'sentiment_critical', forceScore: 0.25, escalate: true },
  REFUND_OVER_LIMIT: { code: 'refund_exceeds_policy_limit', forceScore: 0.3, escalate: true },
  PAYMENT_AMOUNT_UNKNOWN: { code: 'payment_amount_unknown', forceScore: 0.45, escalate: false },
  PRICE_NOT_IN_CATALOG: { code: 'price_not_in_catalog', forceScore: 0.49, escalate: true },
  FORCE_ESCALATE: { code: 'force_escalate_requested', forceScore: 0.0, escalate: true },
} as const;

/** Sentiment below this (range -1..1) triggers the SENTIMENT_CRITICAL override. */
export const SENTIMENT_CRITICAL_THRESHOLD = -0.7;

// ─────────────────────────────────────────────
// Holding messages (sent immediately when AI does not auto-execute)
// Keyed by intent; falls back to DEFAULT.
// ─────────────────────────────────────────────

export const HOLDING_MESSAGES: Partial<Record<IntentType, string>> = {
  [IntentType.BOOKING]: "Let me check our availability and confirm your slot shortly!",
  [IntentType.REFUND]: "I'm looking into this for you — I'll get back to you within a few minutes.",
  [IntentType.COMPLAINT]:
    "I hear you, and I want to make sure this is resolved properly. Give me a moment.",
  [IntentType.ORDER]: "Just confirming the details of your order — back with you shortly!",
  [IntentType.RETURNS]: "Let me check our return policy for your item and get right back to you.",
};

export const DEFAULT_HOLDING_MESSAGE =
  "Thanks for your message — I'm looking into this and will get back to you shortly.";

/** Empathetic holding message used for hard-escalation paths (legal, etc.). */
export const ESCALATION_HOLDING_MESSAGE =
  "I want to make sure this is handled properly — connecting you with someone from our team right away.";

// ─────────────────────────────────────────────
// BullMQ
// ─────────────────────────────────────────────

export const AI_PROCESSING_QUEUE = 'ai-processing';
export const AI_PROCESS_JOB = 'ai-process';

// ─────────────────────────────────────────────
// Qdrant collections
// ─────────────────────────────────────────────

/** Per-business knowledge collection name. */
export function knowledgeCollection(businessId: string): string {
  return `gosumo_knowledge_${businessId}`;
}
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
