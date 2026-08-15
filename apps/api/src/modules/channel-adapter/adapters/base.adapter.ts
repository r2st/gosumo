import { Logger } from '@nestjs/common';
import {
  ChannelAdapter,
  ChannelCapabilities,
  NormalizedMessage,
  OutboundMessage,
  SendResult,
  TemplateMessage,
  InteractiveMessage,
  RawRequest,
  ChannelType,
  isRetryableError,
  UnsupportedOperationError,
} from '@gosumo/shared';
import { CircuitBreaker, CircuitOpenError } from '../../../common/resilience/circuit-breaker';

/**
 * Abstract base class for all channel adapters.
 *
 * Provides:
 * - Structured logging with channel-scoped logger
 * - Standardised error wrapping for outbound calls
 * - Exponential-backoff retry for transient failures
 * - Default (unimplemented) media methods so adapters that don't support
 *   media can skip the boilerplate
 *
 * Concrete adapters extend this class and implement the abstract methods.
 * They can also override retry config via the constructor.
 */
export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract readonly channelType: ChannelType;

  protected readonly logger: Logger;

  /** Maximum number of send attempts (initial + retries) */
  protected readonly maxAttempts: number;

  /** Initial delay in ms before the first retry */
  protected readonly retryDelayMs: number;

  /**
   * Guards the provider this adapter talks to, when one was supplied.
   *
   * Optional because a breaker is process-global stateful and a unit test is
   * not. A spec that drives three consecutive failures to assert the backoff
   * is indistinguishable, to a shared breaker, from a real outage — so with a
   * registry wired in by default, two such specs in a row would leave the
   * breaker open and every later spec in the file would fail on a call that
   * never happened. Adapters constructed without a registry therefore run
   * unguarded; the DI path (see each adapter's constructor) always has one.
   */
  protected readonly breaker?: CircuitBreaker;

  constructor(
    loggerContext: string,
    options: {
      maxAttempts?: number;
      retryDelayMs?: number;
      breaker?: CircuitBreaker;
    } = {},
  ) {
    this.logger = new Logger(loggerContext);
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.breaker = options.breaker;
  }

  // ─────────────────────────────────────────────
  // Abstract — must be implemented by each adapter
  // ─────────────────────────────────────────────

  abstract validateWebhook(req: RawRequest): boolean;
  abstract parseInbound(req: RawRequest): NormalizedMessage;
  abstract getCapabilities(): ChannelCapabilities;

  /**
   * Send a single message. Implementations should call
   * `this.sendWithRetry()` rather than making HTTP calls directly,
   * so retry and error-wrapping logic is applied consistently.
   */
  abstract sendMessage(message: OutboundMessage): Promise<SendResult>;

  /**
   * Send a pre-approved template message. Implementations should call
   * `this.sendWithRetry()` similarly.
   */
  abstract sendTemplate(template: TemplateMessage): Promise<SendResult>;

  /**
   * Send an interactive message (buttons, list). Implementations should
   * call `this.sendWithRetry()`.
   */
  abstract sendInteractive(interactive: InteractiveMessage): Promise<SendResult>;

  // ─────────────────────────────────────────────
  // Default media stubs — override if the channel supports media
  // ─────────────────────────────────────────────

  /**
   * Download a media asset by its channel-side ID.
   * Override in adapters that support media.
   */
  async downloadMedia(_mediaId: string): Promise<Buffer> {
    throw new UnsupportedOperationError(
      `${this.channelType} adapter does not support downloadMedia`,
      { context: { channelType: this.channelType, operation: 'downloadMedia' } },
    );
  }

  /**
   * Upload a binary buffer and return a channel-side media URL / ID.
   * Override in adapters that support media.
   */
  async uploadMedia(_buffer: Buffer, _mimeType: string): Promise<string> {
    throw new UnsupportedOperationError(
      `${this.channelType} adapter does not support uploadMedia`,
      { context: { channelType: this.channelType, operation: 'uploadMedia' } },
    );
  }

  // ─────────────────────────────────────────────
  // Protected helpers
  // ─────────────────────────────────────────────

  /**
   * Execute an async operation with exponential-backoff retries.
   *
   * Only retries what could plausibly succeed on a re-run. A failure arrives
   * either as a `success: false` result or as a throw; both are surfaced
   * immediately when non-retryable, and for a throw that verdict comes from
   * the error taxonomy's `retryable` flag. An unclassified throwable is
   * treated as retryable — a caller that asked for retries should not lose
   * them to an error we could not classify.
   *
   * ## Where the breaker sits
   *
   * Around **each attempt**, not around the loop. This is the site of the
   * amplification: a provider that accepts connections and then stalls costs
   * one `fetchWithTimeout` deadline *per attempt*, so a single send against a
   * dead Meta edge parks a BullMQ worker for 30s with two backoff sleeps in
   * between. Wrapping the loop would leave that first 30s intact on every
   * send until the threshold was reached; wrapping the attempt means the
   * second and third attempts of the send that trips the breaker already cost
   * nothing.
   *
   * The consequence is that the threshold in `circuit-breaker.constants.ts`
   * counts **attempts, not sends** — which is why the channel thresholds are
   * set to two full attempt budgets rather than to a number of messages.
   *
   * An open breaker ends the loop immediately rather than sleeping through
   * the remaining backoffs: retrying in-process against a breaker that will
   * not admit a call for another 30s is pure latency. The send is already
   * durable — BullMQ retries it, and `message.failed` is emitted — so "later"
   * is a decision the queue makes, not this loop.
   *
   * @param operation - The async function to execute
   * @param label     - Human-readable label for logging (e.g. "sendMessage")
   */
  protected async sendWithRetry(
    operation: () => Promise<SendResult>,
    label: string,
  ): Promise<SendResult> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const result = await (this.breaker ? this.breaker.run(operation) : operation());

        if (result.success) {
          if (attempt > 1) {
            this.logger.log(`${label} succeeded on attempt ${attempt}`);
          }
          return { ...result, attempts: attempt };
        }

        // Non-retryable business error returned by the adapter
        this.logger.warn(`${label} failed (non-retryable): ${result.error ?? 'unknown'}`);
        return { ...result, attempts: attempt };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // The breaker refused the call. Nothing about the next 500ms changes
        // that verdict, so surface it now rather than sleeping through the
        // rest of the budget to be told the same thing.
        if (err instanceof CircuitOpenError) {
          this.logger.warn(`${label} short-circuited: ${lastError.message}`);
          return {
            success: false,
            attempts: attempt,
            error: lastError.message,
          };
        }

        // A thrown error used to burn the whole attempt budget regardless of
        // what it was, so a "this channel can't send locations" failure slept
        // through two backoffs before surfacing. The taxonomy answers this
        // directly; anything unclassified stays retryable, as before.
        if (!isRetryableError(err)) {
          this.logger.warn(`${label} failed (non-retryable): ${lastError.message}`);
          return {
            success: false,
            attempts: attempt,
            error: lastError.message,
          };
        }

        const isLastAttempt = attempt === this.maxAttempts;

        if (isLastAttempt) {
          this.logger.error(
            `${label} failed after ${attempt} attempt(s): ${lastError.message}`,
            lastError.stack,
          );
        } else {
          const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
          this.logger.warn(
            `${label} attempt ${attempt} failed, retrying in ${delay}ms: ${lastError.message}`,
          );
          await this.sleep(delay);
        }
      }
    }

    return {
      success: false,
      attempts: this.maxAttempts,
      error: lastError?.message ?? 'Unknown error after all retry attempts',
    };
  }

  /**
   * Wrap a failed send attempt into a structured SendResult.
   * Use this in catch blocks to avoid re-throwing when callers
   * expect a result object.
   */
  protected buildFailedResult(err: unknown, context?: string): SendResult {
    const message = err instanceof Error ? err.message : String(err);
    const fullMessage = context ? `${context}: ${message}` : message;
    this.logger.error(fullMessage, err instanceof Error ? err.stack : undefined);
    return { success: false, error: fullMessage };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
