import { Injectable, Logger } from '@nestjs/common';
import { RealtyIntent, RealtyRoutePolicy } from '@gosumo/shared';
import { LlmClientService } from '../pipeline/llm-client.service';
import {
  REALTY_INTENT_RULES,
  REALTY_INTENT_POLICY,
  REALTY_CLASSIFY_MODEL,
  RealtyIntentRule,
} from './realty-intent.constants';
import {
  REALTY_INTENT_SYSTEM_PROMPT,
  buildRealtyIntentUserPrompt,
  RealtyLlmIntentResult,
} from './realty-intent.prompt';

/** Result of classifying one realty message. */
export interface RealtyIntentResult {
  intent: RealtyIntent;
  secondaryIntent: RealtyIntent | null;
  /** 0–1 classifier confidence (distinct from downstream response confidence). */
  confidence: number;
  /** 1 = keyword rule, 3 = LLM. */
  tier: 1 | 3;
  /** The default autonomy ceiling for this intent. */
  policy: RealtyRoutePolicy;
  entities: Record<string, unknown>;
  reasoning: string;
}

/**
 * RealtyIntentClassifierService — resolves a buyer/seller message to one of the
 * 14 realty intents (blueprint §16.1) with a two-tier cascade:
 *
 *   Tier 1 — deterministic Hinglish keyword rules (sub-millisecond).
 *   Tier 3 — a structured LLM classification for anything the rules miss.
 *
 * Every result carries the intent's default {@link RealtyRoutePolicy} so the
 * router can enforce the autonomy ceiling without a second lookup.
 */
@Injectable()
export class RealtyIntentClassifierService {
  private readonly logger = new Logger(RealtyIntentClassifierService.name);

  constructor(private readonly llm: LlmClientService) {}

  async classify(text: string): Promise<RealtyIntentResult> {
    const ruleMatch = this.classifyByRules(text);
    if (ruleMatch) {
      return this.withPolicy({
        intent: ruleMatch.intent,
        secondaryIntent: null,
        confidence: ruleMatch.score,
        tier: 1,
        entities: {},
        reasoning: `Matched a Tier-1 keyword rule for ${ruleMatch.intent}`,
      });
    }
    return this.classifyByLlm(text);
  }

  /**
   * Tier-1 rule engine. Returns the first rule whose positive pattern matches
   * and whose negative patterns do not, or `null`. Pure and synchronous.
   */
  classifyByRules(text: string): { intent: RealtyIntent; score: number } | null {
    if (!text) return null;
    for (const rule of REALTY_INTENT_RULES) {
      if (this.ruleMatches(rule, text)) {
        return { intent: rule.intent, score: rule.score };
      }
    }
    return null;
  }

  private ruleMatches(rule: RealtyIntentRule, text: string): boolean {
    if (!rule.patterns.some((p) => p.test(text))) return false;
    if (rule.negativePatterns?.some((p) => p.test(text))) return false;
    return true;
  }

  private async classifyByLlm(text: string): Promise<RealtyIntentResult> {
    try {
      const result = await this.llm.complete({
        system: REALTY_INTENT_SYSTEM_PROMPT,
        user: buildRealtyIntentUserPrompt(text),
        model: REALTY_CLASSIFY_MODEL,
        maxTokens: 256,
        temperature: 0,
      });

      const parsed = this.llm.extractJson<RealtyLlmIntentResult>(result.text);
      if (!parsed || !this.isValidIntent(parsed.primaryIntent)) {
        this.logger.warn('Realty LLM intent result missing/invalid — defaulting to GENERAL');
        return this.fallback();
      }

      return this.withPolicy({
        intent: parsed.primaryIntent as RealtyIntent,
        secondaryIntent: this.isValidIntent(parsed.secondaryIntent)
          ? (parsed.secondaryIntent as RealtyIntent)
          : null,
        confidence: clamp01(parsed.confidence),
        tier: 3,
        entities: parsed.entities ?? {},
        reasoning: parsed.reasoning ?? 'LLM realty classification',
      });
    } catch (err) {
      this.logger.error(
        `Realty LLM classification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.fallback();
    }
  }

  private isValidIntent(value: unknown): value is RealtyIntent {
    return typeof value === 'string' && Object.values(RealtyIntent).includes(value as RealtyIntent);
  }

  private withPolicy(r: Omit<RealtyIntentResult, 'policy'>): RealtyIntentResult {
    return { ...r, policy: REALTY_INTENT_POLICY[r.intent] };
  }

  private fallback(): RealtyIntentResult {
    return this.withPolicy({
      intent: RealtyIntent.GENERAL,
      secondaryIntent: null,
      confidence: 0.5,
      tier: 3,
      entities: {},
      reasoning: 'Fallback: realty intent could not be determined',
    });
  }
}

function clamp01(n: unknown): number {
  const num = typeof n === 'number' && Number.isFinite(n) ? n : 0.5;
  return Math.max(0, Math.min(1, num));
}
