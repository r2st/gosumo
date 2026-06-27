import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLM_MAX_TOKENS, LLM_TIMEOUT_MS, DEFAULT_MODEL } from '../ai-engine.constants';

/**
 * Options for a single Claude completion.
 */
export interface LlmCompletionRequest {
  system: string;
  /** The user-turn content (already wrapped/fenced by the caller). */
  user: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmCompletionResult {
  text: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

/** Thrown when the LLM cannot produce a usable completion after retries. */
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

interface AnthropicMessagesResponse {
  content: Array<{ type: string; text?: string }>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Thin Anthropic Claude client built on `fetch`.
 *
 * Responsibilities:
 *  - Call the Messages API with a system prompt + single user turn.
 *  - Enforce a per-call timeout ({@link LLM_TIMEOUT_MS}).
 *  - Retry once on 5xx / network / timeout errors with a short backoff.
 *  - Surface token usage and latency for cost tracking on every call.
 *
 * It deliberately avoids the `@anthropic-ai/sdk` runtime dependency so the
 * module compiles and unit-tests with a mocked `global.fetch`, exactly like
 * the channel adapters do for the Meta API.
 */
@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);
  private readonly apiUrl = 'https://api.anthropic.com/v1/messages';
  private readonly apiVersion = '2023-06-01';
  private readonly maxAttempts = 2;

  constructor(private readonly configService: ConfigService) {}

  /**
   * Run a completion. Retries transient failures; throws
   * {@link LlmUnavailableError} when all attempts are exhausted so the
   * pipeline can fall back to escalation.
   */
  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const apiKey = this.configService.get<string>('anthropic.apiKey', '');
    if (!apiKey) {
      throw new LlmUnavailableError('ANTHROPIC_API_KEY is not configured');
    }

    const model = request.model ?? DEFAULT_MODEL;
    const body = {
      model,
      max_tokens: request.maxTokens ?? LLM_MAX_TOKENS,
      temperature: request.temperature ?? 0.3,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    };

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const startMs = Date.now();
      try {
        const response = await this.fetchWithTimeout(apiKey, body);

        if (!response.ok) {
          const errText = await this.safeText(response);
          // 4xx are non-retryable (bad request, auth) — fail fast.
          if (response.status < 500) {
            throw new LlmUnavailableError(
              `Claude API error ${response.status}: ${errText}`,
            );
          }
          // 5xx — retryable
          throw new Error(`Claude API ${response.status}: ${errText}`);
        }

        const json = (await response.json()) as AnthropicMessagesResponse;
        const text = (json.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
          .trim();

        return {
          text,
          modelId: json.model ?? model,
          promptTokens: json.usage?.input_tokens ?? 0,
          completionTokens: json.usage?.output_tokens ?? 0,
          latencyMs: Date.now() - startMs,
        };
      } catch (err) {
        // Non-retryable client errors propagate immediately.
        if (err instanceof LlmUnavailableError) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        const isLast = attempt === this.maxAttempts;
        if (isLast) {
          this.logger.error(
            `Claude completion failed after ${attempt} attempt(s): ${lastError.message}`,
          );
        } else {
          this.logger.warn(
            `Claude completion attempt ${attempt} failed, retrying: ${lastError.message}`,
          );
          await this.sleep(1000);
        }
      }
    }

    throw new LlmUnavailableError(
      lastError?.message ?? 'Claude completion failed after all retries',
    );
  }

  /**
   * Extract a JSON object from a model response that may include stray prose
   * or markdown code fences around it. Returns `null` if no object parses.
   */
  extractJson<T = Record<string, unknown>>(text: string): T | null {
    if (!text) return null;

    // Strip ```json fences if present.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1] ?? text;

    // Find the outermost {...} span.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;

    const slice = candidate.slice(start, end + 1);
    try {
      return JSON.parse(slice) as T;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  private async fetchWithTimeout(
    apiKey: string,
    body: unknown,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      return await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': this.apiVersion,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return `status ${response.status}`;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
