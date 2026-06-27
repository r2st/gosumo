import { Injectable, Logger } from '@nestjs/common';
import { IntentType } from '@gosumo/shared';

// ─────────────────────────────────────────────
// Public interfaces
// ─────────────────────────────────────────────

export interface ParsedClassification {
  intent: IntentType;
  confidence: number;
  entities: Record<string, unknown>;
  reasoning: string;
  alternatives: Array<{ intent: IntentType; confidence: number }>;
}

export interface ParsedResponse {
  responseText: string | null;
  reasoning: string;
  suggestedActions: Array<{
    type: string;
    parameters: Record<string, unknown>;
    confidence: number;
  }>;
  profileUpdates: Record<string, unknown>;
}

// ─────────────────────────────────────────────
// Internal raw shapes (what the LLM may return)
// ─────────────────────────────────────────────

interface RawClassification {
  intent?: unknown;
  confidence?: unknown;
  entities?: unknown;
  reasoning?: unknown;
  alternatives?: unknown;
}

interface RawResponse {
  responseText?: unknown;
  response_text?: unknown;
  reasoning?: unknown;
  suggestedActions?: unknown;
  suggested_actions?: unknown;
  profileUpdates?: unknown;
  profile_updates?: unknown;
}

interface RawAlternative {
  intent?: unknown;
  confidence?: unknown;
}

interface RawAction {
  type?: unknown;
  parameters?: unknown;
  confidence?: unknown;
}

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

/**
 * ResponseParserService extracts and validates structured data from raw LLM
 * output. Parsing is intentionally defensive: malformed JSON, missing fields,
 * and wrong types all degrade to safe fallback values rather than throwing,
 * because model output is the least trustworthy input in the pipeline.
 */
@Injectable()
export class ResponseParserService {
  private readonly logger = new Logger(ResponseParserService.name);

  /**
   * Parse a raw LLM classification response into a strongly-typed
   * {@link ParsedClassification}. If the response cannot be parsed or the
   * intent is invalid, returns a safe fallback with GENERAL_INQUIRY at 0.5
   * confidence.
   */
  parseClassification(rawResponse: string): ParsedClassification {
    const fallback: ParsedClassification = {
      intent: IntentType.GENERAL_INQUIRY,
      confidence: 0.5,
      entities: {},
      reasoning: 'Failed to parse classification',
      alternatives: [],
    };

    const jsonStr = this.extractJson(rawResponse);
    if (!jsonStr) {
      this.logger.warn('Could not extract JSON from classification response');
      return fallback;
    }

    let parsed: RawClassification;
    try {
      parsed = JSON.parse(jsonStr) as RawClassification;
    } catch {
      this.logger.warn('JSON.parse failed on classification response');
      return fallback;
    }

    // Validate intent
    const intent = this.coerceIntent(parsed.intent);
    if (!intent) {
      this.logger.warn(
        `Invalid intent value in classification: ${String(parsed.intent)}`,
      );
      return fallback;
    }

    // Validate confidence
    const confidence = this.coerceConfidence(parsed.confidence);

    // Validate entities
    const entities = this.isPlainObject(parsed.entities)
      ? parsed.entities
      : {};

    // Validate reasoning
    const reasoning =
      typeof parsed.reasoning === 'string' && parsed.reasoning.length > 0
        ? parsed.reasoning
        : 'No reasoning provided';

    // Validate alternatives
    const alternatives = this.coerceAlternatives(parsed.alternatives);

    return { intent, confidence, entities, reasoning, alternatives };
  }

  /**
   * Parse a raw LLM response-generation output into a strongly-typed
   * {@link ParsedResponse}. If parsing fails entirely, the raw text is
   * used as the response text so the customer still gets something.
   */
  parseResponse(rawResponse: string): ParsedResponse {
    const fallback: ParsedResponse = {
      responseText: rawResponse,
      reasoning: 'Direct text response',
      suggestedActions: [],
      profileUpdates: {},
    };

    const jsonStr = this.extractJson(rawResponse);
    if (!jsonStr) {
      this.logger.warn(
        'Could not extract JSON from response — using raw text as responseText',
      );
      return fallback;
    }

    let parsed: RawResponse;
    try {
      parsed = JSON.parse(jsonStr) as RawResponse;
    } catch {
      this.logger.warn('JSON.parse failed on response — using raw text as responseText');
      return fallback;
    }

    // Accept both camelCase and snake_case field names
    const responseText = this.coerceString(parsed.responseText)
      ?? this.coerceString(parsed.response_text)
      ?? null;

    const reasoning = this.coerceString(parsed.reasoning) ?? 'No reasoning provided';

    const suggestedActions = this.coerceActions(
      parsed.suggestedActions ?? parsed.suggested_actions,
    );

    const profileUpdates = this.isPlainObject(parsed.profileUpdates)
      ? parsed.profileUpdates
      : this.isPlainObject(parsed.profile_updates)
        ? parsed.profile_updates
        : {};

    return { responseText, reasoning, suggestedActions, profileUpdates };
  }

  // ─────────────────────────────────────────────
  // JSON extraction
  // ─────────────────────────────────────────────

  /**
   * Try to find a JSON object in the text. Handles:
   *  1. Markdown ```json ... ``` fenced blocks
   *  2. Markdown ``` ... ``` fenced blocks (no language tag)
   *  3. Bare JSON objects (first `{` to last `}`)
   *
   * Returns `null` if no valid JSON span is found.
   */
  private extractJson(text: string): string | null {
    if (!text || text.trim().length === 0) return null;

    // Strategy 1: look for ```json ... ``` fences
    const jsonFence = text.match(/```json\s*([\s\S]*?)```/i);
    if (jsonFence?.[1]) {
      const candidate = jsonFence[1].trim();
      if (this.isValidJson(candidate)) return candidate;
    }

    // Strategy 2: look for ``` ... ``` fences (any language or none)
    const genericFence = text.match(/```\s*([\s\S]*?)```/);
    if (genericFence?.[1]) {
      const candidate = genericFence[1].trim();
      if (this.isValidJson(candidate)) return candidate;
    }

    // Strategy 3: find the outermost { ... } span
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      const candidate = text.slice(start, end + 1);
      if (this.isValidJson(candidate)) return candidate;
    }

    return null;
  }

  // ─────────────────────────────────────────────
  // Coercion & validation helpers
  // ─────────────────────────────────────────────

  private isValidJson(text: string): boolean {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  private coerceIntent(value: unknown): IntentType | null {
    if (
      typeof value === 'string' &&
      Object.values(IntentType).includes(value as IntentType)
    ) {
      return value as IntentType;
    }
    return null;
  }

  private coerceConfidence(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.min(1, value));
    }
    return 0.5;
  }

  private coerceString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private coerceAlternatives(
    value: unknown,
  ): Array<{ intent: IntentType; confidence: number }> {
    if (!Array.isArray(value)) return [];

    const result: Array<{ intent: IntentType; confidence: number }> = [];

    for (const item of value) {
      if (!this.isPlainObject(item)) continue;
      const raw = item as RawAlternative;
      const intent = this.coerceIntent(raw.intent);
      if (!intent) continue;
      result.push({
        intent,
        confidence: this.coerceConfidence(raw.confidence),
      });
    }

    return result;
  }

  private coerceActions(
    value: unknown,
  ): Array<{ type: string; parameters: Record<string, unknown>; confidence: number }> {
    if (!Array.isArray(value)) return [];

    const result: Array<{
      type: string;
      parameters: Record<string, unknown>;
      confidence: number;
    }> = [];

    for (const item of value) {
      if (!this.isPlainObject(item)) continue;
      const raw = item as RawAction;
      if (typeof raw.type !== 'string' || raw.type.length === 0) continue;
      result.push({
        type: raw.type,
        parameters: this.isPlainObject(raw.parameters) ? raw.parameters : {},
        confidence: this.coerceConfidence(raw.confidence),
      });
    }

    return result;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
