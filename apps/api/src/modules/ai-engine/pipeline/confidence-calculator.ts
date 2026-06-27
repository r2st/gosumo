import { Injectable, Logger } from '@nestjs/common';
import {
  IntentType,
  ConfidenceMode,
  ConfidenceScore,
  ConfidenceOverride,
} from '@gosumo/shared';
import {
  WEIGHT_DATA_AVAILABILITY,
  WEIGHT_POLICY_CLARITY,
  CONFIDENCE_AUTO_EXECUTE,
  CONFIDENCE_DRAFT_REVIEW,
  CONFIDENCE_GUIDED,
  OVERRIDE,
  LEGAL_THREAT_PATTERNS,
  SENTIMENT_CRITICAL_THRESHOLD,
  LOOP_DETECTION_THRESHOLD,
} from '../ai-engine.constants';
import type { RAGChunk } from './prompt-assembler';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Input parameters for the deterministic confidence calculation.
 */
export interface ConfidenceCalculateParams {
  /** Raw LLM confidence (0–1) from the classification stage. */
  llmConfidence: number;
  /** Number of relevant RAG chunks retrieved for the query. */
  ragChunkCount: number;
  /** Safety / business overrides already identified (e.g. by the classifier). */
  overrides: Array<{
    code: string;
    reason: string;
    forceScore: number;
    escalate: boolean;
  }>;
  /** Count of consecutive decisions with the same intent on this conversation. */
  loopCount: number;
  /** Customer sentiment score (-1 to 1). Omit when unavailable. */
  sentiment?: number;
  /** True when a pricing question cannot be answered because the item is not in the catalog. */
  priceRequestedButMissing?: boolean;
  /** True when the requested refund amount exceeds the business policy limit. */
  refundExceedsPolicy?: boolean;
}

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

/**
 * ConfidenceCalculatorService — converts raw classification signals and
 * contextual factors into a deterministic {@link ConfidenceScore} that the
 * action router uses to decide between AUTO_PILOT, DRAFT, GUIDED, and
 * ESCALATION paths.
 *
 * Algorithm:
 *   1. `dataAvailability` — quantifies how much supporting data is present
 *      (RAG chunks).
 *   2. `policyClarity` — uses the LLM's own confidence as a proxy for how
 *      unambiguous the applicable rules are.
 *   3. `composite = data * W_DATA + policy * W_POLICY`.
 *   4. Hard overrides are evaluated: each matched override **caps** the
 *      score at its `forceScore` (overrides can only lower, never raise).
 *   5. The final score maps to one of the four confidence modes.
 *
 * Everything is pure and deterministic — no I/O, no randomness — so it is
 * exhaustively unit-testable.
 */
@Injectable()
export class ConfidenceCalculatorService {
  private readonly logger = new Logger(ConfidenceCalculatorService.name);

  /**
   * Calculate the confidence score from all available signals.
   *
   * @returns A fully populated {@link ConfidenceScore} with all values on
   *   the 0–1 scale.
   */
  calculate(params: ConfidenceCalculateParams): ConfidenceScore {
    // ── 1. Data availability ────────────────────
    const dataAvailability = this.scoreDataAvailability(params.ragChunkCount);

    // ── 2. Policy clarity (LLM confidence as proxy) ──
    const policyClarity = clamp(params.llmConfidence);

    // ── 3. Composite score ──────────────────────
    const composite = round(
      dataAvailability * WEIGHT_DATA_AVAILABILITY +
        policyClarity * WEIGHT_POLICY_CLARITY,
    );

    // ── 4. Collect all overrides ────────────────
    const allOverrides = [...params.overrides];

    if (params.priceRequestedButMissing) {
      allOverrides.push({
        code: OVERRIDE.PRICE_NOT_IN_CATALOG.code,
        reason: 'Price requested for an item not in the catalog',
        forceScore: OVERRIDE.PRICE_NOT_IN_CATALOG.forceScore,
        escalate: OVERRIDE.PRICE_NOT_IN_CATALOG.escalate,
      });
    }

    if (params.refundExceedsPolicy) {
      allOverrides.push({
        code: OVERRIDE.REFUND_OVER_LIMIT.code,
        reason: 'Refund amount exceeds the configured policy limit',
        forceScore: OVERRIDE.REFUND_OVER_LIMIT.forceScore,
        escalate: OVERRIDE.REFUND_OVER_LIMIT.escalate,
      });
    }

    if (params.loopCount > LOOP_DETECTION_THRESHOLD) {
      allOverrides.push({
        code: OVERRIDE.LOOP.code,
        reason: `Conversation loop detected — same intent ${params.loopCount} times in a row`,
        forceScore: OVERRIDE.LOOP.forceScore,
        escalate: OVERRIDE.LOOP.escalate,
      });
    }

    if (
      params.sentiment !== undefined &&
      params.sentiment < SENTIMENT_CRITICAL_THRESHOLD
    ) {
      allOverrides.push({
        code: OVERRIDE.SENTIMENT_CRITICAL.code,
        reason: 'Highly negative sentiment — human empathy required',
        forceScore: OVERRIDE.SENTIMENT_CRITICAL.forceScore,
        escalate: OVERRIDE.SENTIMENT_CRITICAL.escalate,
      });
    }

    // ── 5. Apply override ceilings ──────────────
    let finalScore = composite;
    const scoredOverrides: ConfidenceOverride[] = [];

    if (allOverrides.length > 0) {
      // Find the lowest forceScore among all overrides.
      let lowestCeiling = composite;

      for (const override of allOverrides) {
        const penalty = Math.max(0, round(composite - override.forceScore));
        scoredOverrides.push({
          code: override.code,
          reason: override.reason,
          penalty,
        });
        lowestCeiling = Math.min(lowestCeiling, override.forceScore);
      }

      // The final score is the MINIMUM of the composite and the lowest
      // override ceiling.
      finalScore = Math.min(composite, lowestCeiling);
    }

    finalScore = clamp(round(finalScore));

    // ── 6. Determine routing mode ───────────────
    const mode = this.toMode(finalScore);

    if (scoredOverrides.length > 0) {
      this.logger.debug(
        `Confidence overridden: ${composite} -> ${finalScore} (${scoredOverrides.map((o) => o.code).join(', ')})`,
      );
    }

    return {
      dataAvailability,
      policyClarity,
      finalScore,
      mode,
      overrides: scoredOverrides,
    };
  }

  // ─────────────────────────────────────────────
  // Component scoring
  // ─────────────────────────────────────────────

  /**
   * Score data availability on a 0–1 scale based on the number of relevant
   * RAG chunks retrieved.
   *
   * - 3+ chunks  -> 1.0 (strong knowledge match)
   * - 1-2 chunks -> 0.7 (partial match)
   * - 0 chunks   -> 0.3 (no supporting data)
   */
  private scoreDataAvailability(ragChunkCount: number): number {
    if (ragChunkCount >= 3) return 1.0;
    if (ragChunkCount >= 1) return 0.7;
    return 0.3;
  }

  /**
   * Map a final score to its routing mode. Exported via public access so
   * the action router can reuse the exact band boundaries.
   */
  toMode(score: number): ConfidenceMode {
    if (score >= CONFIDENCE_AUTO_EXECUTE) return ConfidenceMode.AUTO_PILOT;
    if (score >= CONFIDENCE_DRAFT_REVIEW) return ConfidenceMode.DRAFT;
    if (score >= CONFIDENCE_GUIDED) return ConfidenceMode.GUIDED;
    return ConfidenceMode.ESCALATION;
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
