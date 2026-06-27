import { Injectable, Logger } from '@nestjs/common';
import { IntentType } from '@gosumo/shared';
import { LlmClientService } from './llm-client.service';
import { PromptAssemblerService } from './prompt-assembler';
import { ResponseParserService } from './response-parser.service';
import type { ConversationContextData } from './prompt-assembler';
import {
  INTENT_RULES,
  INTENT_MODEL_ROUTING,
  JAILBREAK_PATTERNS,
  LEGAL_THREAT_PATTERNS,
  HUMAN_REQUEST_PATTERNS,
  PII_PATTERNS,
  OVERRIDE,
  FAST_MODEL,
} from '../ai-engine.constants';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Result of a deterministic keyword-rule match, used as an early return
 * when the LLM is not needed.
 */
export interface ParsedClassification {
  intent: IntentType;
  confidence: number;
  entities: Record<string, unknown>;
  reasoning: string;
  alternatives: Array<{ intent: IntentType; confidence: number }>;
}

/**
 * Full classification result including safety overrides, token usage, and
 * model metadata. This is the canonical output of the classification stage.
 */
export interface ClassificationResult {
  intent: IntentType;
  confidence: number;
  entities: Record<string, unknown>;
  reasoning: string;
  alternatives: Array<{ intent: IntentType; confidence: number }>;
  /** Safety overrides triggered by the raw message text. */
  overrides: Array<{
    code: string;
    reason: string;
    forceScore: number;
    escalate: boolean;
  }>;
  promptTokens: number;
  completionTokens: number;
  modelId: string;
  latencyMs: number;
}

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

/**
 * IntentClassifierService — resolves an inbound customer message to one of
 * the 13 GoSumo intents via a two-tier cascade:
 *
 *   1. **Safety checks** — detect jailbreaks, legal threats, explicit human
 *      requests, and PII. Each hit produces an override that the confidence
 *      calculator will later apply.
 *   2. **Tier-1 keyword rules** — deterministic, sub-millisecond regex
 *      matching (Hinglish-aware). If a rule fires the LLM is skipped.
 *   3. **Tier-3 LLM classification** — a structured Claude call using the
 *      fast model (Haiku).
 *
 * The service always returns a usable {@link ClassificationResult}; LLM
 * failures degrade to `GENERAL_INQUIRY` at 0.5 confidence.
 */
@Injectable()
export class IntentClassifierService {
  private readonly logger = new Logger(IntentClassifierService.name);

  constructor(
    private readonly llm: LlmClientService,
    private readonly promptAssembler: PromptAssemblerService,
    private readonly responseParser: ResponseParserService,
  ) {}

  /**
   * Classify a customer message. Runs safety checks first, then attempts a
   * fast keyword match before falling through to the LLM.
   */
  async classify(
    text: string,
    context: ConversationContextData,
  ): Promise<ClassificationResult> {
    const startMs = Date.now();

    // ── 1. Safety checks ─────────────────────────
    const overrides = this.checkSafetyPatterns(text);

    // ── 2. Deterministic keyword rules ───────────
    const keywordMatch = this.matchKeywordRules(text);

    if (keywordMatch) {
      this.logger.debug(
        `Tier-1 keyword match: ${keywordMatch.intent} (${keywordMatch.confidence})`,
      );

      return {
        intent: keywordMatch.intent,
        confidence: keywordMatch.confidence,
        entities: keywordMatch.entities,
        reasoning: keywordMatch.reasoning,
        alternatives: keywordMatch.alternatives,
        overrides,
        promptTokens: 0,
        completionTokens: 0,
        modelId: 'keyword-rules',
        latencyMs: Date.now() - startMs,
      };
    }

    // ── 3. LLM classification ────────────────────
    try {
      const { systemPrompt, userPrompt } =
        this.promptAssembler.assembleClassificationPrompt(text, context);

      const llmResult = await this.llm.complete({
        system: systemPrompt,
        user: userPrompt,
        model: FAST_MODEL,
        maxTokens: 256,
        temperature: 0,
      });

      const parsed = this.llm.extractJson<LlmClassificationShape>(llmResult.text);

      if (!parsed || !this.isValidIntent(parsed.intent)) {
        this.logger.warn(
          'LLM classification returned an unparseable or invalid result — falling back to GENERAL_INQUIRY',
        );
        return this.fallbackResult(overrides, llmResult.latencyMs);
      }

      return {
        intent: parsed.intent as IntentType,
        confidence: clampConfidence(parsed.confidence),
        entities: isPlainObject(parsed.entities) ? parsed.entities : {},
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'LLM classification',
        alternatives: this.coerceAlternatives(parsed.alternatives),
        overrides,
        promptTokens: llmResult.promptTokens,
        completionTokens: llmResult.completionTokens,
        modelId: llmResult.modelId,
        latencyMs: llmResult.latencyMs,
      };
    } catch (err) {
      this.logger.error(
        `LLM intent classification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.fallbackResult(overrides, Date.now() - startMs);
    }
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  /**
   * Run all safety pattern banks against the raw message text. Returns an
   * array of override descriptors that will later be fed into the confidence
   * calculator to cap the score.
   */
  private checkSafetyPatterns(
    text: string,
  ): Array<{ code: string; reason: string; forceScore: number; escalate: boolean }> {
    const overrides: Array<{
      code: string;
      reason: string;
      forceScore: number;
      escalate: boolean;
    }> = [];

    if (!text) return overrides;

    // Jailbreak / prompt-injection
    if (JAILBREAK_PATTERNS.some((p) => p.test(text))) {
      overrides.push({
        code: OVERRIDE.JAILBREAK.code,
        reason: 'Prompt-injection / jailbreak attempt detected in customer message',
        forceScore: OVERRIDE.JAILBREAK.forceScore,
        escalate: OVERRIDE.JAILBREAK.escalate,
      });
    }

    // Legal threats
    if (LEGAL_THREAT_PATTERNS.some((p) => p.test(text))) {
      overrides.push({
        code: OVERRIDE.LEGAL_THREAT.code,
        reason: 'Customer mentioned legal action — must escalate to a human',
        forceScore: OVERRIDE.LEGAL_THREAT.forceScore,
        escalate: OVERRIDE.LEGAL_THREAT.escalate,
      });
    }

    // Explicit human request
    if (HUMAN_REQUEST_PATTERNS.some((p) => p.test(text))) {
      overrides.push({
        code: OVERRIDE.HUMAN_REQUEST.code,
        reason: 'Customer explicitly requested to speak with a human',
        forceScore: OVERRIDE.HUMAN_REQUEST.forceScore,
        escalate: OVERRIDE.HUMAN_REQUEST.escalate,
      });
    }

    // PII detected
    if (PII_PATTERNS.some(({ pattern }) => pattern.test(text))) {
      const types = PII_PATTERNS.filter(({ pattern }) => pattern.test(text)).map((p) => p.type);
      overrides.push({
        code: OVERRIDE.PII_DETECTED.code,
        reason: `Sensitive PII detected in message: ${types.join(', ')}`,
        forceScore: OVERRIDE.PII_DETECTED.forceScore,
        escalate: OVERRIDE.PII_DETECTED.escalate,
      });
    }

    return overrides;
  }

  /**
   * Attempt to match the message text against the ordered Tier-1 keyword
   * rules. Returns a {@link ParsedClassification} if a rule fires, or
   * `null` when the text should fall through to the LLM.
   */
  private matchKeywordRules(text: string): ParsedClassification | null {
    if (!text) return null;

    for (const rule of INTENT_RULES) {
      const positiveMatch = rule.patterns.some((p) => p.test(text));
      if (!positiveMatch) continue;

      if (rule.negativePatterns?.some((p) => p.test(text))) continue;

      return {
        intent: rule.intent,
        confidence: rule.score,
        entities: {},
        reasoning: `Matched a Tier-1 keyword rule for ${rule.intent}`,
        alternatives: [],
      };
    }

    return null;
  }

  /**
   * Build a safe fallback result when the LLM is unavailable or returns
   * garbage. Ensures the pipeline always has something to work with.
   */
  private fallbackResult(
    overrides: Array<{ code: string; reason: string; forceScore: number; escalate: boolean }>,
    latencyMs: number,
  ): ClassificationResult {
    return {
      intent: IntentType.GENERAL_INQUIRY,
      confidence: 0.5,
      entities: {},
      reasoning: 'Fallback: intent could not be determined by LLM',
      alternatives: [],
      overrides,
      promptTokens: 0,
      completionTokens: 0,
      modelId: FAST_MODEL,
      latencyMs,
    };
  }

  private isValidIntent(value: unknown): value is IntentType {
    return (
      typeof value === 'string' &&
      Object.values(IntentType).includes(value as IntentType)
    );
  }

  /**
   * Coerce the LLM's `alternatives` array to a typed shape, dropping any
   * entries with invalid intents.
   */
  private coerceAlternatives(
    value: unknown,
  ): Array<{ intent: IntentType; confidence: number }> {
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (alt): alt is { intent: string; confidence: number } =>
          alt != null &&
          typeof alt === 'object' &&
          this.isValidIntent((alt as Record<string, unknown>).intent),
      )
      .map((alt) => ({
        intent: alt.intent as IntentType,
        confidence: clampConfidence(alt.confidence),
      }));
  }
}

// ─────────────────────────────────────────────
// Raw LLM output shape
// ─────────────────────────────────────────────

interface LlmClassificationShape {
  intent?: string;
  confidence?: number;
  entities?: Record<string, unknown>;
  reasoning?: string;
  alternatives?: unknown;
}

// ─────────────────────────────────────────────
// Numeric helpers
// ─────────────────────────────────────────────

function clampConfidence(n: unknown): number {
  const num = typeof n === 'number' && Number.isFinite(n) ? n : 0.5;
  return Math.max(0, Math.min(1, num));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
