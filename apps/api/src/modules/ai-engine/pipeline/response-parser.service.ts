import { Injectable, Logger } from '@nestjs/common';
import { IntentType, SuggestedAction } from '@gosumo/shared';
import { LlmClientService } from './llm-client.service';

export type Urgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Raw snake_case shape the LLM is instructed to return. */
interface LlmResponseShape {
  response_text?: string | null;
  intent?: string;
  reasoning?: string;
  suggested_actions?: Array<{ type?: string; parameters?: Record<string, unknown>; confidence?: number }>;
  profile_updates?: Record<string, unknown>;
  requires_escalation?: boolean;
  escalation_reason?: string | null;
  urgency?: string | null;
  holding_message?: string | null;
  jailbreak_detected?: boolean;
  pii_detected?: boolean;
  language_used?: string;
}

/** Normalized camelCase response used by the rest of the pipeline. */
export interface ParsedAiResponse {
  responseText: string | null;
  intent: IntentType;
  reasoning: string;
  suggestedActions: SuggestedAction[];
  profileUpdates: Record<string, unknown>;
  requiresEscalation: boolean;
  escalationReason: string | null;
  urgency: Urgency | null;
  holdingMessage: string | null;
  jailbreakDetected: boolean;
  piiDetected: boolean;
  languageUsed: string;
}

export interface ValidationResult {
  valid: boolean;
  failures: string[];
}

const VALID_URGENCY: Urgency[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * Length ceiling applied when the caller does not know the channel.
 *
 * 4096 is WhatsApp's limit specifically, and it was hardcoded here as though it
 * were every channel's. It is the most permissive of the real ones bar email,
 * so using it as the default keeps the old behaviour for callers with no
 * channel in hand while letting the ones that do pass the true limit.
 */
export const DEFAULT_MAX_RESPONSE_CHARS = 4096;

/**
 * ResponseParserService — turns the LLM's raw text into a strongly-typed,
 * sanitized {@link ParsedAiResponse}, then validates it before the pipeline
 * is allowed to act on it.
 *
 * Parsing is defensive: malformed JSON, missing fields, and wrong types all
 * degrade gracefully rather than throwing, because the model output is the
 * least trustworthy input in the pipeline.
 */
@Injectable()
export class ResponseParserService {
  private readonly logger = new Logger(ResponseParserService.name);

  constructor(private readonly llm: LlmClientService) {}

  /**
   * Parse a raw model completion. Returns `null` only when no JSON object can
   * be recovered at all — callers treat that as a parse failure and escalate.
   */
  parse(rawText: string, fallbackIntent: IntentType): ParsedAiResponse | null {
    const json = this.llm.extractJson<LlmResponseShape>(rawText);
    if (!json) {
      this.logger.warn('Could not extract a JSON object from the LLM response');
      return null;
    }

    const intent = this.coerceIntent(json.intent, fallbackIntent);

    return {
      responseText: typeof json.response_text === 'string' ? json.response_text : null,
      intent,
      reasoning: typeof json.reasoning === 'string' ? json.reasoning : '',
      suggestedActions: this.coerceActions(json.suggested_actions),
      profileUpdates: this.isPlainObject(json.profile_updates) ? json.profile_updates : {},
      requiresEscalation: json.requires_escalation === true,
      escalationReason: typeof json.escalation_reason === 'string' ? json.escalation_reason : null,
      urgency: this.coerceUrgency(json.urgency),
      holdingMessage: typeof json.holding_message === 'string' ? json.holding_message : null,
      jailbreakDetected: json.jailbreak_detected === true,
      piiDetected: json.pii_detected === true,
      languageUsed: typeof json.language_used === 'string' ? json.language_used : 'en',
    };
  }

  /**
   * Structural / safety validation applied before a response is dispatched.
   * Any failure forces the pipeline to escalate rather than send.
   *
   * @param maxChars The target channel's own ceiling. Defaults to
   *   {@link DEFAULT_MAX_RESPONSE_CHARS} for callers that have no channel.
   */
  validate(response: ParsedAiResponse, maxChars: number = DEFAULT_MAX_RESPONSE_CHARS): ValidationResult {
    const failures: string[] = [];

    // A non-escalation decision must carry something to say.
    if (!response.requiresEscalation && (!response.responseText || response.responseText.trim() === '')) {
      failures.push('non-escalation response has empty response_text');
    }
    // An escalation must tell the customer something while they wait.
    if (response.requiresEscalation && !response.holdingMessage && !response.responseText) {
      failures.push('escalation response has neither a holding message nor response_text');
    }
    // The model self-reporting a jailbreak or PII is itself a hard failure.
    if (response.jailbreakDetected) {
      failures.push('model reported jailbreak_detected');
    }
    if (response.piiDetected) {
      failures.push('model reported pii_detected');
    }
    // Customer-facing text must fit the channel it is going out on. This was
    // pinned at 4096 — WhatsApp's limit — for every channel, so a 2000-character
    // answer passed here and was then refused by Instagram (1000) or Twilio
    // (1600) at send time, which surfaces as a delivery failure rather than as
    // a response the pipeline could have escalated to a human who would have
    // shortened it.
    if (response.responseText && response.responseText.length > maxChars) {
      failures.push(
        `response_text is ${response.responseText.length} chars, over the ${maxChars}-char channel limit`,
      );
    }
    // Every suggested action needs a type.
    for (const action of response.suggestedActions) {
      if (!action.type) {
        failures.push('a suggested action is missing its type');
        break;
      }
    }

    return { valid: failures.length === 0, failures };
  }

  // ─────────────────────────────────────────────
  // Coercion helpers
  // ─────────────────────────────────────────────

  private coerceIntent(value: unknown, fallback: IntentType): IntentType {
    if (typeof value === 'string' && Object.values(IntentType).includes(value as IntentType)) {
      return value as IntentType;
    }
    return fallback;
  }

  private coerceActions(value: LlmResponseShape['suggested_actions']): SuggestedAction[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((a) => a && typeof a.type === 'string')
      .map((a) => ({
        type: a.type as string,
        parameters: this.isPlainObject(a.parameters) ? a.parameters : {},
        confidence: typeof a.confidence === 'number' ? Math.max(0, Math.min(1, a.confidence)) : 0.5,
      }));
  }

  private coerceUrgency(value: unknown): Urgency | null {
    return typeof value === 'string' && VALID_URGENCY.includes(value as Urgency)
      ? (value as Urgency)
      : null;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
