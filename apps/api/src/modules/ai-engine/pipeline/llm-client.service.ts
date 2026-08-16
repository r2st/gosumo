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
  LLM_FALLBACK_MODELS,
  LLM_FALLBACK_MAX_MODELS,
  LLM_FALLBACK_BUDGET_MS,
  isModelScopedFailure,
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
  /**
   * Every model slug this turn asked, in order, ending with the one that
   * answered. Length > 1 means the primary refused and a backup served it.
   *
   * Recorded separately from `modelId` because `modelId` is what OpenRouter
   * says it used, which is the *last* entry and carries no trace of the ones
   * before it. Without this a cascade is invisible: the turn succeeds, the
   * decision row names a model nobody configured for that intent, and the
   * primary's failure rate — the thing that says a free slug has been retired
   * or is permanently rationed — is never counted anywhere.
   */
  attemptedModels: string[];
  /** True when a model other than the requested one produced this text. */
  usedFallback: boolean;
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
    // The breaker wraps the *whole* cascade, not each attempt or each model:
    // every model this turn tried is one piece of evidence about OpenRouter,
    // and counting them separately would divide the effective threshold by the
    // chain length. It also means a turn a backup rescued is a *success* here
    // — which is right, because the gateway answered.
    return this.breaker.run(() => this.completeWithFallback(request, apiKey));
  }

  /**
   * Try the requested model, then each backup in {@link LLM_FALLBACK_MODELS},
   * stopping at the first one that answers.
   *
   * Two rules decide whether the cascade continues, and both are about not
   * spending a customer's wait on a call that cannot succeed:
   *
   *  - **The failure has to be about the model.** {@link isModelScopedFailure}
   *    draws that line. A `401` is the account, not the slug, and asking two
   *    more models with the same bad key just makes one clear error take three
   *    times as long to surface.
   *  - **The budget has to cover a whole attempt.** Starting a call with four
   *    seconds left buys a turn that fails on the deadline instead of failing
   *    now, and pays {@link LLM_TIMEOUT_MS} of a BullMQ worker slot for it.
   *
   * Only the primary keeps its two attempts. A backup gets one: the reason to
   * retry a model is that nothing better is available, and here something is.
   */
  private async completeWithFallback(
    request: LlmCompletionRequest,
    apiKey: string,
  ): Promise<LlmCompletionResult> {
    const primary = request.model ?? DEFAULT_MODEL;
    const chain = this.buildChain(primary);
    const startedAt = Date.now();
    const attempted: string[] = [];
    let lastError: LlmUnavailableError | undefined;

    for (let i = 0; i < chain.length; i++) {
      const model = chain[i]!;

      // Budget is checked before every model *except the first*: the primary
      // is not a fallback and must always get its attempt, or a
      // misconfiguration here would silently disable the LLM entirely.
      if (i > 0) {
        const elapsed = Date.now() - startedAt;
        if (elapsed + LLM_TIMEOUT_MS > LLM_FALLBACK_BUDGET_MS) {
          this.logger.warn(
            `LLM fallback budget exhausted after ${elapsed}ms and ` +
              `${attempted.length} model(s); not trying ${model}`,
          );
          break;
        }
      }

      attempted.push(model);
      try {
        const result = await this.completeWithRetries(
          request,
          apiKey,
          model,
          // The primary is the only one worth re-asking; see the doc comment.
          i === 0 ? this.maxAttempts : 1,
        );
        if (i > 0) {
          // WARN, not LOG: the turn succeeded, but the model the tenant's
          // intent routing chose did not serve it. Sustained, this line is how
          // anyone learns a free slug has been retired or permanently
          // rationed — the success would otherwise hide it completely.
          this.logger.warn(
            `LLM fallback served this turn: ${primary} failed, ${model} answered ` +
              `(tried ${attempted.join(' → ')})`,
          );
        }
        return { ...result, attemptedModels: [...attempted], usedFallback: i > 0 };
      } catch (err) {
        // completeWithRetries only ever throws LlmUnavailableError; anything
        // else escaping it is a bug here, not a provider failure, and must not
        // be re-routed onto a backup model.
        if (!(err instanceof LlmUnavailableError)) throw err;
        lastError = err;

        const status = err.context['status'];
        const numericStatus = typeof status === 'number' ? status : undefined;
        if (!isModelScopedFailure(numericStatus)) {
          // Not the model's fault — every entry in the chain would answer the
          // same way. Surface it now, unchanged, so the status the operator
          // needs to see is the one they get.
          throw err;
        }

        const isLast = i === chain.length - 1;
        if (!isLast) {
          this.logger.warn(
            `LLM model ${model} failed (${numericStatus ?? 'no status'}); ` +
              `falling back to ${chain[i + 1]}`,
          );
        }
      }
    }

    // Every model in the chain refused. The error thrown is the *last* one, so
    // its status still drives `isOutageFailure` and the breaker sees the real
    // provider signal rather than a synthetic one; the chain is carried in
    // context for the log.
    throw new LlmUnavailableError(
      `every model failed (${attempted.join(', ')}): ` +
        `${lastError?.message ?? 'no completion'}`,
      {
        cause: lastError,
        status:
          typeof lastError?.context['status'] === 'number'
            ? (lastError.context['status'] as number)
            : undefined,
        context: { attemptedModels: attempted, elapsedMs: Date.now() - startedAt },
      },
    );
  }

  /**
   * The models one turn may try, in order: the requested one first, then the
   * configured backups, capped at {@link LLM_FALLBACK_MAX_MODELS}.
   *
   * The primary is removed from the backup list rather than left to be tried
   * twice — the intent routing already picks a chain member as the primary for
   * some intents, and re-asking the slug that just refused is the one call
   * guaranteed not to help.
   */
  private buildChain(primary: string): string[] {
    const backups = LLM_FALLBACK_MODELS.filter((m) => m !== primary);
    return [primary, ...backups].slice(0, Math.max(1, LLM_FALLBACK_MAX_MODELS));
  }

  /**
   * One model's attempts, with no breaker state of its own — the breaker
   * observes the whole cascade's outcome from the outside.
   *
   * `model` is passed explicitly rather than read off `request.model` because
   * the cascade calls this once per model in the chain; `maxAttempts` is a
   * parameter for the same reason (the primary retries, a backup does not).
   */
  private async completeWithRetries(
    request: LlmCompletionRequest,
    apiKey: string,
    model: string = request.model ?? DEFAULT_MODEL,
    maxAttempts: number = this.maxAttempts,
  ): Promise<Omit<LlmCompletionResult, 'attemptedModels' | 'usedFallback'>> {
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

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
        const isLast = attempt === maxAttempts;
        if (isLast) {
          // WARN, not ERROR: the cascade above may still rescue this turn, and
          // an ERROR line for a failure the tenant never saw is exactly the
          // noise that trains people to ignore the level. The genuinely
          // terminal case — every model gone — is what `complete()`'s callers
          // report on.
          this.logger.warn(
            `OpenRouter model ${model} failed after ${attempt} attempt(s): ${lastError.message}`,
          );
        } else {
          this.logger.warn(
            `OpenRouter completion attempt ${attempt} for ${model} failed, retrying: ${lastError.message}`,
          );
          await this.sleep(1000);
        }
      }
    }

    // Every attempt was a transport failure, a timeout, or a 5xx — the shape of
    // an outage rather than a bad request. Deliberately carries no `status`,
    // which is how `isOutageFailure` recognises it.
    throw new LlmUnavailableError(
      lastError?.message ?? `OpenRouter completion failed for ${model} after all retries`,
      { cause: lastError, context: { model } },
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
