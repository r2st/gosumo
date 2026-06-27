import { Injectable, Logger } from '@nestjs/common';
import { IntentType } from '@gosumo/shared';
import { INTENT_RULES, IntentRule, FAST_MODEL } from '../ai-engine.constants';
import { LlmClientService } from './llm-client.service';
import {
  INTENT_CLASSIFICATION_SYSTEM_PROMPT,
  buildIntentUserPrompt,
  LlmIntentResult,
} from '../prompts/intent.prompt';
import { IntentClassificationDto } from '../dto';

/**
 * IntentClassifierService — resolves a customer message to one of the 13
 * GoSumo intents using a two-tier cascade:
 *
 *   Tier 1 — deterministic keyword rules (sub-millisecond, Hinglish-aware).
 *   Tier 3 — a structured LLM classification call for anything the rules miss.
 *
 * (Tier 2, embedding similarity, is provided by the RAG layer and can be
 * slotted in between these two; the cascade is written so it composes.)
 */
@Injectable()
export class IntentClassifierService {
  private readonly logger = new Logger(IntentClassifierService.name);

  constructor(private readonly llm: LlmClientService) {}

  /**
   * Classify a message. Tries the fast rule engine first; only falls through
   * to the LLM when no rule matches confidently.
   */
  async classify(text: string): Promise<IntentClassificationDto> {
    const ruleMatch = this.classifyByRules(text);
    if (ruleMatch) {
      return {
        intent: ruleMatch.intent,
        secondaryIntent: null,
        confidence: ruleMatch.score,
        tier: 1,
        entities: {},
        reasoning: `Matched a Tier-1 keyword rule for ${ruleMatch.intent}`,
      };
    }

    return this.classifyByLlm(text);
  }

  /**
   * Tier-1 rule engine. Returns the first rule whose positive pattern matches
   * and whose negative patterns do not, or `null` if nothing matches.
   * Pure and synchronous — exported for direct unit testing.
   */
  classifyByRules(text: string): { intent: IntentType; score: number } | null {
    if (!text) return null;

    for (const rule of INTENT_RULES) {
      if (this.ruleMatches(rule, text)) {
        return { intent: rule.intent, score: rule.score };
      }
    }
    return null;
  }

  private ruleMatches(rule: IntentRule, text: string): boolean {
    const positive = rule.patterns.some((p) => p.test(text));
    if (!positive) return false;
    if (rule.negativePatterns?.some((p) => p.test(text))) return false;
    return true;
  }

  /**
   * Tier-3 LLM classification. Falls back to GENERAL_INQUIRY @ 0.5 when the
   * model is unavailable or returns an unparseable / invalid result, so the
   * pipeline always gets a usable intent.
   */
  private async classifyByLlm(text: string): Promise<IntentClassificationDto> {
    try {
      const result = await this.llm.complete({
        system: INTENT_CLASSIFICATION_SYSTEM_PROMPT,
        user: buildIntentUserPrompt(text),
        model: FAST_MODEL,
        maxTokens: 256,
        temperature: 0,
      });

      const parsed = this.llm.extractJson<LlmIntentResult>(result.text);
      if (!parsed || !this.isValidIntent(parsed.primaryIntent)) {
        this.logger.warn('LLM intent result was missing or invalid — defaulting to GENERAL_INQUIRY');
        return this.fallback();
      }

      return {
        intent: parsed.primaryIntent,
        secondaryIntent: this.isValidIntent(parsed.secondaryIntent) ? parsed.secondaryIntent : null,
        confidence: clampConfidence(parsed.confidence),
        tier: 3,
        entities: parsed.entities ?? {},
        reasoning: parsed.reasoning ?? 'LLM classification',
      };
    } catch (err) {
      this.logger.error(
        `LLM intent classification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.fallback();
    }
  }

  private isValidIntent(value: unknown): value is IntentType {
    return typeof value === 'string' && Object.values(IntentType).includes(value as IntentType);
  }

  private fallback(): IntentClassificationDto {
    return {
      intent: IntentType.GENERAL_INQUIRY,
      secondaryIntent: null,
      confidence: 0.5,
      tier: 3,
      entities: {},
      reasoning: 'Fallback: intent could not be determined',
    };
  }
}

function clampConfidence(n: unknown): number {
  const num = typeof n === 'number' && Number.isFinite(n) ? n : 0.5;
  return Math.max(0, Math.min(1, num));
}
