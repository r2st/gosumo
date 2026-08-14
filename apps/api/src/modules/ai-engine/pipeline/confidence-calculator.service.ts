import { Injectable, Logger } from '@nestjs/common';
import { ConfidenceMode, ConfidenceOverride, ConfidenceScore, IntentType } from '@gosumo/shared';
import {
  CONFIDENCE_AUTO_EXECUTE,
  CONFIDENCE_DRAFT_REVIEW,
  CONFIDENCE_GUIDED,
  MIN_AUTO_EXECUTE_BAND,
  MIN_DRAFT_REVIEW_BAND,
  WEIGHT_DATA_AVAILABILITY,
  WEIGHT_POLICY_CLARITY,
  SENTIMENT_CRITICAL_THRESHOLD,
  LOOP_DETECTION_THRESHOLD,
  OVERRIDE,
} from '../ai-engine.constants';
import { SafetySignals } from '../safety/guardrails.service';

export interface DataFactors {
  /** Count of high-quality RAG chunks retrieved for the query. */
  ragChunkCount: number;
  /** A catalog item with a concrete price was matched. `false` = looked, none found. */
  catalogMatch?: boolean;
  /** The client has a known profile (`false` = confirmed first contact). */
  clientKnown?: boolean;
}

export interface PolicyFactors {
  /** An explicit business policy covers this exact situation. */
  policyDefined?: boolean;
  /** The applicable policy is ambiguous for the current case. */
  policyAmbiguous?: boolean;
}

export interface ConfidenceCalculationInput {
  intent: IntentType;
  data: DataFactors;
  policy: PolicyFactors;
  safety?: SafetySignals;
  /** True when a price was requested but no catalog item exists. */
  priceNotInCatalog?: boolean;
  /** True when a payment is requested but the amount cannot be determined. */
  paymentAmountUnknown?: boolean;
  refundAmountPaise?: number;
  maxRefundAmountPaise?: number;
  sentimentScore?: number;
  repeatedIntentCount?: number;
  /** Operator/caller forced the escalation path. */
  forceEscalate?: boolean;
  /**
   * The tenant's own routing bands, in percent, as stored in
   * `businesses.ai_settings`. Omitted (or unusable) falls back to the module
   * defaults. See {@link resolveBands}.
   */
  thresholds?: { autoExecute?: number; draftReview?: number };
}

/** Routing band edges on the calculator's own 0–1 scale. */
export interface ConfidenceBands {
  autoExecute: number;
  draftReview: number;
  guided: number;
}

export const DEFAULT_BANDS: ConfidenceBands = {
  autoExecute: CONFIDENCE_AUTO_EXECUTE,
  draftReview: CONFIDENCE_DRAFT_REVIEW,
  guided: CONFIDENCE_GUIDED,
};

/**
 * Turn a tenant's stored thresholds into band edges the calculator can use.
 *
 * Two scales meet here and the conversion is the whole point: `ai_settings`
 * holds percentages (90, 70) because that is what the settings page and the
 * onboarding wizard collect, while every score in this file is 0–1. A missing
 * conversion does not fail loudly — it silently sets the auto-execute gate to
 * 90.0, which no score can reach, so nothing would ever auto-execute.
 *
 * Anything that would remove a human from the loop — at either end of the
 * scale — is rejected rather than clamped. The update DTO bounds each field to
 * 0–100 but permits a stored 0 at both ends, and settings written before that
 * DTO existed were not bounded at all. `autoExecute: 0` hands every decision
 * to the AI and removes human *review*; `draftReview: 0` drags the derived
 * GUIDED edge to 0, and since scores are clamped to 0–1 that makes ESCALATION
 * unreachable and removes human *hand-off*. A pair we cannot make sense of
 * falls back to the defaults, which are safe by construction.
 */
export function resolveBands(thresholds?: {
  autoExecute?: number;
  draftReview?: number;
}): ConfidenceBands {
  const pct = (value: number | undefined, fallback: number): number | null => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    // Percent → fraction. Out of range is a corrupt setting, not a clamp case.
    if (value < 0 || value > 100) return null;
    return value / 100;
  };

  const autoExecute = pct(thresholds?.autoExecute, CONFIDENCE_AUTO_EXECUTE);
  const draftReview = pct(thresholds?.draftReview, CONFIDENCE_DRAFT_REVIEW);

  if (autoExecute === null || draftReview === null) return DEFAULT_BANDS;
  // An inverted pair empties the review window: everything the model would
  // have drafted for a human gets auto-executed instead.
  if (draftReview > autoExecute) return DEFAULT_BANDS;
  // A floor on the gate itself. `autoExecute: 0` passes every check above and
  // every ordering check in the service, and means "never ask a human".
  if (autoExecute < MIN_AUTO_EXECUTE_BAND) return DEFAULT_BANDS;
  // And the mirror image at the other end. The GUIDED edge below is derived
  // from `draftReview`, so a stored 0 drags it to 0 as well — and since scores
  // are clamped to 0–1, `score >= 0` always holds and ESCALATION becomes
  // unreachable. That is the same failure as `autoExecute: 0`, read from the
  // other end: the band that hands a conversation to a human disappears.
  if (draftReview < MIN_DRAFT_REVIEW_BAND) return DEFAULT_BANDS;

  return {
    autoExecute,
    draftReview,
    // GUIDED is not tenant-configurable, but it must never sit above the draft
    // edge or the band ordering inverts and DRAFT becomes unreachable.
    guided: Math.min(CONFIDENCE_GUIDED, draftReview),
  };
}

export interface ScoredConfidence extends ConfidenceScore {
  /** A hard override (or a sub-GUIDED score) demands a human takes over. */
  requiresEscalation: boolean;
}

/**
 * ConfidenceCalculatorService — turns context signals into a single 0–1
 * confidence score and a routing mode.
 *
 * Algorithm:
 *   1. `dataAvailability`  — weighted blend of RAG depth, catalog match, and
 *      client familiarity.
 *   2. `policyClarity`     — derived from whether a policy exists and how
 *      ambiguous it is.
 *   3. `base = data·0.5 + policy·0.5`.
 *   4. Hard overrides are evaluated. Each matched override CAPS the score at
 *      its `forceScore` (an override can only ever lower confidence — never
 *      raise it). The final score is the minimum of the base and every
 *      matched override's ceiling.
 *
 * Everything here is pure and deterministic for exhaustive unit testing.
 */
@Injectable()
export class ConfidenceCalculatorService {
  private readonly logger = new Logger(ConfidenceCalculatorService.name);

  calculate(input: ConfidenceCalculationInput): ScoredConfidence {
    const dataAvailability = this.scoreDataAvailability(input.data);
    const policyClarity = this.scorePolicyClarity(input.policy);

    const base = round(
      dataAvailability * WEIGHT_DATA_AVAILABILITY +
        policyClarity * WEIGHT_POLICY_CLARITY,
    );

    const { finalScore, overrides, requiresEscalation } = this.applyOverrides(base, input);

    const bands = resolveBands(input.thresholds);
    const mode = this.toMode(finalScore, bands);

    return {
      dataAvailability,
      policyClarity,
      finalScore,
      mode,
      overrides,
      // Anything that drops below the GUIDED floor is, by definition, a human hand-off.
      requiresEscalation: requiresEscalation || finalScore < bands.guided,
    };
  }

  /**
   * Map a final score to its routing mode. Public so the action router and
   * tests can reuse the exact band boundaries.
   *
   * `bands` defaults to the module constants, so callers that do not know the
   * tenant (the standalone scoring helper's original form, and every existing
   * test) keep the documented 0.90 / 0.70 / 0.50 behaviour.
   */
  toMode(score: number, bands: ConfidenceBands = DEFAULT_BANDS): ConfidenceMode {
    if (score >= bands.autoExecute) return ConfidenceMode.AUTO_PILOT;
    if (score >= bands.draftReview) return ConfidenceMode.DRAFT;
    if (score >= bands.guided) return ConfidenceMode.GUIDED;
    return ConfidenceMode.ESCALATION;
  }

  // ─────────────────────────────────────────────
  // Component scoring
  // ─────────────────────────────────────────────

  private scoreDataAvailability(data: DataFactors): number {
    const rag = data.ragChunkCount >= 3 ? 1 : data.ragChunkCount >= 1 ? 0.6 : 0.2;
    const catalog = data.catalogMatch === true ? 1 : data.catalogMatch === false ? 0.2 : 0.5;
    const client = data.clientKnown === true ? 1 : data.clientKnown === false ? 0.4 : 0.6;
    return round(rag * 0.5 + catalog * 0.3 + client * 0.2);
  }

  private scorePolicyClarity(policy: PolicyFactors): number {
    if (policy.policyDefined === true) {
      return policy.policyAmbiguous === true ? 0.6 : 1;
    }
    if (policy.policyDefined === false) return 0.4;
    return 0.5;
  }

  // ─────────────────────────────────────────────
  // Hard overrides
  // ─────────────────────────────────────────────

  private applyOverrides(
    base: number,
    input: ConfidenceCalculationInput,
  ): { finalScore: number; overrides: ConfidenceOverride[]; requiresEscalation: boolean } {
    const overrides: ConfidenceOverride[] = [];
    let ceiling = base;
    let requiresEscalation = false;

    const apply = (
      def: { code: string; forceScore: number; escalate: boolean },
      reason: string,
    ): void => {
      const penalty = Math.max(0, round(base - def.forceScore));
      overrides.push({ code: def.code, reason, penalty });
      ceiling = Math.min(ceiling, def.forceScore);
      if (def.escalate) requiresEscalation = true;
    };

    const safety = input.safety;

    if (input.forceEscalate) {
      apply(OVERRIDE.FORCE_ESCALATE, 'Escalation explicitly forced by caller');
    }
    if (safety?.jailbreakDetected) {
      apply(OVERRIDE.JAILBREAK, 'Prompt-injection / jailbreak attempt detected');
    }
    if (safety?.pii.hasPii) {
      apply(
        OVERRIDE.PII_DETECTED,
        `Sensitive PII detected: ${safety.pii.detected.map((d) => d.type).join(', ')}`,
      );
    }
    if (safety?.legalThreatDetected) {
      apply(OVERRIDE.LEGAL_THREAT, 'Customer mentioned legal action — must escalate to a human');
    }
    if (safety?.humanRequested) {
      apply(OVERRIDE.HUMAN_REQUEST, 'Customer explicitly requested a human agent');
    }
    if (safety?.loopDetected) {
      apply(OVERRIDE.LOOP, 'Conversation loop detected — AI is not resolving the need');
    }
    if (
      input.repeatedIntentCount !== undefined &&
      input.repeatedIntentCount >= LOOP_DETECTION_THRESHOLD &&
      !safety?.loopDetected
    ) {
      apply(OVERRIDE.LOOP, `Intent unchanged across ${input.repeatedIntentCount} exchanges`);
    }
    if (input.sentimentScore !== undefined && input.sentimentScore < SENTIMENT_CRITICAL_THRESHOLD) {
      apply(OVERRIDE.SENTIMENT_CRITICAL, 'Highly negative sentiment — human empathy required');
    }
    if (
      input.refundAmountPaise !== undefined &&
      input.maxRefundAmountPaise !== undefined &&
      input.refundAmountPaise > input.maxRefundAmountPaise
    ) {
      apply(
        OVERRIDE.REFUND_OVER_LIMIT,
        `Refund of ${input.refundAmountPaise} paise exceeds the configured limit of ${input.maxRefundAmountPaise}`,
      );
    }
    if (input.priceNotInCatalog) {
      apply(OVERRIDE.PRICE_NOT_IN_CATALOG, 'Price requested for an item not in the catalog');
    }
    if (input.paymentAmountUnknown) {
      apply(OVERRIDE.PAYMENT_AMOUNT_UNKNOWN, 'Cannot collect payment for an unknown amount');
    }

    const finalScore = clamp(round(ceiling));

    if (overrides.length > 0) {
      this.logger.debug(
        `Confidence overridden ${base} → ${finalScore} (${overrides.map((o) => o.code).join(', ')})`,
      );
    }

    return { finalScore, overrides, requiresEscalation };
  }
}

// ─────────────────────────────────────────────
// Numeric helpers
// ─────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
