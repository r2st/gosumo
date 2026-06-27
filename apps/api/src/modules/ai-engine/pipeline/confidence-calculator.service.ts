import { Injectable, Logger } from '@nestjs/common';
import { ConfidenceMode, ConfidenceOverride, ConfidenceScore, IntentType } from '@gosumo/shared';
import {
  CONFIDENCE_AUTO_EXECUTE,
  CONFIDENCE_DRAFT_REVIEW,
  CONFIDENCE_GUIDED,
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

    const mode = this.toMode(finalScore);

    return {
      dataAvailability,
      policyClarity,
      finalScore,
      mode,
      overrides,
      // Anything that drops below the GUIDED floor is, by definition, a human hand-off.
      requiresEscalation: requiresEscalation || finalScore < CONFIDENCE_GUIDED,
    };
  }

  /**
   * Map a final score to its routing mode. Public so the action router and
   * tests can reuse the exact band boundaries.
   */
  toMode(score: number): ConfidenceMode {
    if (score >= CONFIDENCE_AUTO_EXECUTE) return ConfidenceMode.AUTO_PILOT;
    if (score >= CONFIDENCE_DRAFT_REVIEW) return ConfidenceMode.DRAFT;
    if (score >= CONFIDENCE_GUIDED) return ConfidenceMode.GUIDED;
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
