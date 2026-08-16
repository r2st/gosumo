/**
 * Bounds and taxonomy for AI conversation tagging.
 */

/**
 * The canonical topic vocabulary the auto-tagger picks from.
 *
 * A closed vocabulary rather than free-form output, because an unconstrained
 * tagger is worse than no tagger: asked to describe the same delivery question
 * on three days it produces `shipping`, `shipping-query` and `delivery`, and the
 * inbox filter that made tagging worth building now has three buckets holding a
 * third of the conversations each. Tags are only useful if the same situation
 * gets the same tag every time, and the only reliable way to get that from a
 * language model is to give it the list.
 *
 * The tenant's own tags extend this at call time — see
 * `buildTaggingUserPrompt` — so a business that has invented `franchise-lead`
 * keeps getting it, without every tenant inheriting every other tenant's
 * vocabulary.
 */
export const CONVERSATION_TAG_TAXONOMY: readonly string[] = [
  // Commercial intent
  'pricing',
  'product-question',
  'availability',
  'order-status',
  'booking',
  'payment-issue',
  'refund-request',
  'cancellation',
  'return-exchange',
  'shipping',
  // Relationship
  'complaint',
  'praise',
  'escalation',
  'follow-up-needed',
  'churn-risk',
  // Operational
  'technical-issue',
  'documentation-request',
  'bulk-enquiry',
  'partnership',
  'spam',
];

/** Tags the auto-tagger may apply to one conversation in a single pass. */
export const MAX_AI_TAGS_PER_CONVERSATION = 5;

/** Total tags one conversation may carry, from all sources. */
export const MAX_TAGS_PER_CONVERSATION = 20;

/**
 * Confidence below which a proposed tag is discarded.
 *
 * Deliberately higher than the pipeline's draft-review band. A wrong draft is
 * read by an agent before it goes anywhere; a wrong tag is written straight to
 * a row that feeds inbox filters and, through segments, routing decisions —
 * nobody reviews it, and it is only noticed when somebody wonders why a
 * conversation is in the wrong bucket.
 */
export const MIN_TAG_CONFIDENCE = 0.7;

/** Messages of context the tagger reads. */
export const TAGGING_CONTEXT_MESSAGES = 20;

/** Characters of any one message passed to the tagger. */
export const MAX_TAGGING_MESSAGE_CHARS = 600;

/** Total characters of transcript. Bounds the prompt regardless of message count. */
export const MAX_TAGGING_TRANSCRIPT_CHARS = 6_000;

/** Tag length cap, matching the column. */
export const MAX_TAG_LENGTH = 100;

/**
 * Normalize a tag to its stored form.
 *
 * Lower-cased, whitespace and underscores collapsed to single hyphens, and
 * stripped of everything that is not a letter, digit or hyphen. Without this
 * `Refund Request`, `refund_request` and `refund-request` are three rows in a
 * table whose whole purpose is that they are one — and the unique index on
 * `(conversation_id, tag)` would happily hold all three.
 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG_LENGTH);
}
