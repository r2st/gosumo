import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError, type GoSumoErrorOptions } from '@gosumo/shared';
import { fetchWithTimeout } from '../../../common/utils/http-timeout.util';
import {
  CircuitBreaker,
  defaultIsOutage,
} from '../../../common/resilience/circuit-breaker';
import { CircuitBreakerRegistry } from '../../../common/resilience/circuit-breaker.registry';
import {
  LLM_MAX_TOKENS,
  LLM_TIMEOUT_MS,
  DEFAULT_MODEL,
  LLM_BREAKER_FAILURE_THRESHOLD,
  LLM_BREAKER_COOLDOWN_MS,
} from '../ai-engine.constants';

/**
 * Options for a single LLM completion (served by OpenRouter).
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

/**
 * Thrown when the LLM cannot produce a usable completion after retries.
 *
 * Terminal by construction: the client has already exhausted its own retries by
 * the time this is raised, so `retryable` is false and a queue consumer that
 * sees one should route to the DLQ rather than re-run the turn.
 */
export class LlmUnavailableError extends ExternalServiceError {
  constructor(message: string, options: GoSumoErrorOptions & { status?: number } = {}) {
    super('OpenRouter', message, { ...options, retryable: false });
  }
}

/** OpenAI-compatible chat-completions response (as returned by OpenRouter). */
interface OpenRouterChatResponse {
  choices: Array<{ message?: { content?: string }; finish_reason?: string }>;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Thin LLM client built on `fetch`, targeting OpenRouter's OpenAI-compatible
 * chat-completions API (https://openrouter.ai/api/v1/chat/completions).
 *
 * Responsibilities:
 *  - Call the chat API with a system + single user turn.
 *  - Enforce a per-call timeout ({@link LLM_TIMEOUT_MS}).
 *  - Retry once on 5xx / network / timeout errors with a short backoff.
 *  - Trip a circuit breaker once the provider is failing consistently, so a
 *    sustained outage costs one fast failure per turn instead of two full
 *    timeouts (see {@link LLM_BREAKER_FAILURE_THRESHOLD}).
 *  - Surface token usage and latency for cost tracking on every call.
 *
 * The default models are OpenRouter free-tier slugs (see `ai-engine.constants`).
 * No provider SDK dependency — it compiles and unit-tests with a mocked
 * `global.fetch`, exactly like the channel adapters do for the Meta API.
 */
@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);
  private readonly defaultApiUrl = 'https://openrouter.ai/api/v1/chat/completions';
  private readonly maxAttempts = 2;

  /**
   * The shared breaker (`common/resilience/`), configured with this client's
   * two departures from the default behaviour:
   *
   *  - **`openError`.** Everywhere else an open circuit is a "later"
   *    (`retryable: true`) so a BullMQ attempt re-runs after the cooldown. Here
   *    it is a "never": the callers all treat an unavailable LLM as a reason to
   *    escalate to a human, and re-queuing the turn would delay that escalation
   *    rather than fix it. `LlmUnavailableError` is terminal by construction.
   *  - **`isOutage`.** The default classifier trusts the taxonomy's `retryable`
   *    flag, which `LlmUnavailableError` sets to false for *every* failure —
   *    including the exhausted-retries case that is exactly what should open
   *    the breaker. {@link isOutageFailure} reads the provider status instead.
   *
   * `@Optional()` on the registry so a spec gets a private breaker: a
   * process-wide one shared across a describe block would carry a deliberately
   * tripped circuit into the next test.
   */
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly configService: ConfigService,
    @Optional() registry?: CircuitBreakerRegistry,
  ) {
    const options = {
      name: 'OpenRouter',
      failureThreshold: LLM_BREAKER_FAILURE_THRESHOLD,
      cooldownMs: LLM_BREAKER_COOLDOWN_MS,
      isOutage: (error: unknown) => this.isOutageFailure(error),
      openError: (name: string, openForMs: number, consecutiveFailures: number) =>
        new LlmUnavailableError(
          `${name} circuit is open after repeated failures; not attempting a call`,
          { context: { openForMs, consecutiveFailures } },
        ),
    };
    this.breaker = registry ? registry.get(options) : new CircuitBreaker(options);
  }

  /**
   * Whether the breaker is currently rejecting calls. Exposed for the health
   * probe and for tests; callers route on the thrown error, not on this.
   */
  get circuitOpen(): boolean {
    return this.breaker.isOpen;
  }

  /**
   * Run a completion. Retries transient failures; throws
   * {@link LlmUnavailableError} when all attempts are exhausted so the
   * pipeline can fall back to escalation.
   */
  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const apiKey = this.configService.get<string>('openrouter.apiKey', '');
    if (!apiKey) {
      throw new LlmUnavailableError('OPENROUTER_API_KEY is not configured');
    }

    // Fail fast while the provider is known to be down. The callers all treat
    // an unavailable LLM as a reason to escalate or fall back, so this changes
    // when they find out, not what they do about it.
    //
    // The breaker wraps the *whole* retry loop, not each attempt: the two
    // attempts of one turn are one piece of evidence about the provider, and
    // counting them separately would halve the effective threshold.
    return this.breaker.run(() => this.completeWithRetries(request, apiKey));
  }

  /**
   * The two-attempt completion itself, with no breaker state of its own — the
   * breaker observes this method's outcome from the outside.
   */
  private async completeWithRetries(
    request: LlmCompletionRequest,
    apiKey: string,
  ): Promise<LlmCompletionResult> {
    const model = request.model ?? DEFAULT_MODEL;
    const body = {
      model,
      max_tokens: request.maxTokens ?? LLM_MAX_TOKENS,
      temperature: request.temperature ?? 0.3,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    };

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const startMs = Date.now();
      try {
        const response = await this.fetchWithTimeout(apiKey, body);

        if (!response.ok) {
          const errText = await this.safeText(response);
          // 4xx are non-retryable (bad request, auth) — fail fast. Whether one
          // counts against the breaker is decided by `isOutageFailure` from
          // the status carried on the error, not here.
          if (response.status < 500) {
            throw new LlmUnavailableError(`API error ${response.status}`, {
              status: response.status,
              context: { body: errText },
            });
          }
          // 5xx — retryable; the loop below re-runs it.
          throw new ExternalServiceError('OpenRouter', `API ${response.status}`, {
            status: response.status,
            context: { body: errText },
          });
        }

        const json = (await response.json()) as OpenRouterChatResponse;
        const text = (json.choices ?? [])
          .map((choice) => choice.message?.content ?? '')
          .join('')
          .trim();

        return {
          text,
          modelId: json.model ?? model,
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
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
            `OpenRouter completion failed after ${attempt} attempt(s): ${lastError.message}`,
          );
        } else {
          this.logger.warn(
            `OpenRouter completion attempt ${attempt} failed, retrying: ${lastError.message}`,
          );
          await this.sleep(1000);
        }
      }
    }

    // Every attempt was a transport failure, a timeout, or a 5xx — the shape of
    // an outage rather than a bad request. Deliberately carries no `status`,
    // which is how `isOutageFailure` recognises it.
    throw new LlmUnavailableError(
      lastError?.message ?? 'OpenRouter completion failed after all retries',
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
  // Circuit breaker
  // ─────────────────────────────────────────────

  /**
   * Whether a failure escaping {@link completeWithRetries} is evidence that
   * OpenRouter is down, rather than evidence about this one request.
   *
   * The taxonomy cannot answer this: every failure here is an
   * `LlmUnavailableError`, which is terminal by construction (`retryable:
   * false`) because the client has already spent its own retries. So the
   * status on the error is what decides, and its *absence* is the strongest
   * signal there is — the exhausted-retries throw carries no status precisely
   * because nothing ever answered.
   *
   *   - no status  → two attempts, both transport failures / timeouts / 5xx.
   *   - 408 / 429  → the provider saying "not now" to everyone. Hammering a
   *                  rate-limited endpoint is what keeps it rate-limited.
   *   - other 4xx  → this caller's request is wrong. One oversized prompt must
   *                  never take the AI pipeline down for every tenant.
   */
  private isOutageFailure(error: unknown): boolean {
    if (!(error instanceof LlmUnavailableError)) return defaultIsOutage(error);

    const status = error.context?.['status'];
    if (typeof status !== 'number') return true;
    return status >= 500 || status === 408 || status === 429;
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  /**
   * POST the completion request under a {@link LLM_TIMEOUT_MS} deadline that
   * spans the response body, not just the headers.
   *
   * The deadline has to outlive `fetch` resolving, because at that moment only
   * the headers have arrived. A provider that returns `200 OK` and then stalls
   * mid-body — the ordinary shape of an overloaded inference host, and the
   * reason OpenRouter's own gateway sends keep-alive comments — leaves
   * `response.json()` awaiting forever. That is worse than a refused
   * connection: the turn never fails, so the retry never happens, the breaker
   * never records a failure and never opens, and in the `ai-process` worker the
   * job holds its concurrency slot until the pod restarts. Every tenant's AI
   * replies stop, and nothing reports an error.
   *
   * {@link fetchWithTimeout} is what keeps the timer armed across the body
   * read; the local implementation this replaced cleared it in a `finally`, so
   * the documented 8s deadline only ever bounded the headers.
   */
  private async fetchWithTimeout(
    apiKey: string,
    body: unknown,
  ): Promise<Response> {
    const url = this.configService.get<string>('openrouter.baseUrl', this.defaultApiUrl);
    return fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          // OpenRouter attribution headers (optional but recommended).
          'http-referer': this.configService.get<string>('openrouter.referer', 'https://gosumo.aiknol.com'),
          'x-title': this.configService.get<string>('openrouter.title', 'GoSumo'),
        },
        body: JSON.stringify(body),
      },
      { service: 'OpenRouter', timeoutMs: LLM_TIMEOUT_MS },
    );
  }

  /**
   * The error body, or a placeholder if it cannot be read.
   *
   * Reading it is bounded by the same deadline as the request — a failing
   * provider is exactly the one likely to stall mid-body, and this runs on the
   * error path where a hang is least likely to be noticed.
   */
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
