/**
 * Realty inventory constants.
 *
 * This module owns the grounding layer (blueprint §14), so the freshness rule
 * that decides what the AI may assert is defined here and imported by everyone
 * who enforces or describes it.
 */

/**
 * A unit's availability is only assertable within this window (blueprint §14).
 *
 * Asserting availability from a stale verification is a **no-ship** item — the
 * launch gate requires zero occurrences — so this number is deliberately in one
 * place. Three copies of it previously existed (the matcher, the repository's
 * default argument, and an unread constant in the AI engine), which is exactly
 * how one of them drifts and starts quoting units nobody re-checked.
 */
export const AVAILABILITY_FRESHNESS_HOURS = 24;
