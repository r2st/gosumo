/**
 * A circuit breaker for calls to a dependency this process does not control.
 *
 * `fetchWithTimeout` already bounds how long *one* call to a sick provider
 * costs. What it cannot do is stop us making the call at all, and that is the
 * difference between a slow dependency and a cascade:
 *
 *   - Every inbound WhatsApp message takes the Razorpay path when it mentions a
 *     payment. With Razorpay hard down, each one parks for the full 10s
 *     deadline, three BullMQ attempts deep, holding a concurrency slot the
 *     whole time. The queue's throughput collapses for *every* tenant and every
 *     unrelated job behind it — because one gateway is down.
 *   - The API shares a 50-connection Postgres with another service. A request
 *     holding a Prisma connection while it waits 10s on Stripe is a connection
 *     nobody else can have, and 50 of those is a total outage caused by an
 *     entirely external fault.
 *
 * After enough consecutive outage-shaped failures the breaker opens and calls
 * fail immediately. The dependency stops being asked (which is also what lets
 * it recover), and the caller learns in microseconds instead of seconds — the
 * same verdict, at 1/10,000th of the cost.
 *
 * ## What counts as a failure
 *
 * Only *outage-shaped* failures, decided by {@link defaultIsOutage} or a
 * caller-supplied classifier. A 400 from Stripe because the amount was
 * negative is this request's fault and must never open a breaker shared by
 * every tenant; a 503, a timeout, or a refused connection is the provider
 * being unavailable to everyone. A failure that is neither counted nor
 * outage-shaped leaves the counter untouched — it is not evidence either way.
 *
 * Only a success resets the counter. `consecutiveFailures` is deliberately not
 * a rate over a window: a provider that is up returns *something* quickly, so
 * a genuine outage produces an unbroken run, and a run is both cheaper to
 * track and harder to trip by accident during a traffic spike.
 *
 * ## Recovery
 *
 * After `cooldownMs` the breaker goes half-open and lets exactly **one** call
 * through to test the water. Letting every waiting caller through at once puts
 * the full stalled load back onto a dependency that has just come up, which is
 * how a recovering provider gets knocked straight back over. If the probe
 * fails the breaker re-opens with a *fresh* clock — otherwise it would sit
 * open-but-elapsed and admit the next caller immediately, which is no breaker
 * at all.
 *
 * ## Scope
 *
 * One breaker per process per dependency, not per tenant. The failure it
 * models is the provider being down, which is not a per-tenant property. The
 * corollary is that state does **not** span instances: with three API pods a
 * dead provider is discovered three times. That is deliberate — a shared
 * breaker in Redis makes one instance's network partition everyone's outage,
 * and adds a Redis round-trip to the hot path it exists to keep fast.
 */

import { Logger } from '@nestjs/common';
import { ExternalServiceError, GoSumoError } from '@gosumo/shared';

/** Consecutive outage-shaped failures before the circuit opens. */
export const DEFAULT_FAILURE_THRESHOLD = 5;

/** How long the circuit stays open before one probe is allowed through. */
export const DEFAULT_COOLDOWN_MS = 30_000;

export type CircuitState = 'closed' | 'open' | 'half_open';

/** What a caller decides an outage looks like. */
export type OutageClassifier = (error: unknown) => boolean;

/**
 * Node/undici error codes for a call that never reached the provider. These
 * are transport failures by definition, so they are outages regardless of what
 * the taxonomy would have said about them.
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** The `code` on an error or any error in its `cause` chain. */
function errorCodeChain(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  return errorCodeChain((error as { cause?: unknown }).cause, depth + 1);
}

/**
 * The default verdict: an outage is something the taxonomy already calls
 * retryable, or a transport failure that never reached the provider.
 *
 * Anything else — a validation error, a 404, a bug in our own mapping code —
 * returns false on purpose. A breaker that opens on `TypeError: cannot read
 * property of undefined` takes a working dependency offline for everyone
 * because of a bug on one code path, and the fast-fail then hides the stack
 * that would have shown you the bug.
 */
export function defaultIsOutage(error: unknown): boolean {
  if (error instanceof GoSumoError && error.retryable) return true;

  const code = errorCodeChain(error);
  return code !== undefined && NETWORK_ERROR_CODES.has(code);
}

/**
 * Thrown instead of calling a dependency the breaker has given up on.
 *
 * `retryable: true` — the provider is expected back, and every consumer that
 * sees one (a BullMQ attempt, the outbound send path) should treat it as a
 * "later", not a "never". Callers that need the opposite verdict pass their
 * own `openError` factory; {@link LlmClientService} does, because an AI turn
 * that cannot be answered escalates to a human rather than waiting.
 */
export class CircuitOpenError extends ExternalServiceError {
  constructor(service: string, openForMs: number, consecutiveFailures: number) {
    super(
      service,
      `circuit is open after ${consecutiveFailures} consecutive failures; not attempting a call`,
      {
        status: 503,
        retryable: true,
        context: { openForMs, consecutiveFailures },
      },
    );
  }
}

export interface CircuitBreakerOptions {
  /** Dependency name, as it appears in logs, errors, and the health probe. */
  name: string;
  failureThreshold?: number;
  cooldownMs?: number;
  /** Overrides {@link defaultIsOutage}. */
  isOutage?: OutageClassifier;
  /** Overrides {@link CircuitOpenError} for callers needing other semantics. */
  openError?: (name: string, openForMs: number, consecutiveFailures: number) => Error;
  /** Injectable clock. Tests drive this rather than the event loop. */
  now?: () => number;
}

/** A breaker's state, for the health probe and for tests. */
export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  /** How long the circuit has been open, in ms. Absent while closed. */
  openForMs?: number;
}

export class CircuitBreaker {
  private readonly logger: Logger;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly isOutage: OutageClassifier;
  private readonly buildOpenError: NonNullable<CircuitBreakerOptions['openError']>;
  private readonly now: () => number;

  /** Consecutive outage-shaped failures. Reset by any success. */
  private consecutiveFailures = 0;
  /** When the circuit opened, or null while it is closed. */
  private openedAtMs: number | null = null;
  /** True while the single post-cooldown probe is in flight. */
  private probing = false;

  constructor(readonly options: CircuitBreakerOptions) {
    this.logger = new Logger(`CircuitBreaker:${options.name}`);
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.isOutage = options.isOutage ?? defaultIsOutage;
    this.buildOpenError =
      options.openError ??
      ((name, openForMs, failures) => new CircuitOpenError(name, openForMs, failures));
    this.now = options.now ?? (() => Date.now());
  }

  get name(): string {
    return this.options.name;
  }

  get state(): CircuitState {
    if (this.openedAtMs === null) return 'closed';
    return this.probing ? 'half_open' : 'open';
  }

  /** True while the breaker is rejecting calls outright. */
  get isOpen(): boolean {
    return this.openedAtMs !== null;
  }

  snapshot(): CircuitSnapshot {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.openedAtMs === null ? {} : { openForMs: this.now() - this.openedAtMs }),
    };
  }

  /**
   * Run `fn` under the breaker.
   *
   * Throws the open-circuit error without calling `fn` while the breaker is
   * open. Otherwise `fn`'s result and its errors pass through untouched — the
   * breaker observes, it never rewrites what the caller would have seen.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.assertClosed();

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      if (this.isOutage(error)) {
        this.recordFailure();
      } else if (this.probing) {
        // The probe reached the provider and got a real answer — the outage is
        // over even though this particular call failed. Leaving `probing` set
        // would strand the breaker: no further call is admitted (it is still
        // open with an elapsed clock, and `probing` blocks the next probe),
        // and nothing would ever clear it but a success that can never happen.
        this.recordSuccess();
      }
      throw error;
    }
  }

  /** Force the breaker closed. For tests and for an operator-driven reset. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
    this.probing = false;
  }

  // ─────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────

  private assertClosed(): void {
    if (this.openedAtMs === null) return;

    const openForMs = this.now() - this.openedAtMs;
    if (openForMs >= this.cooldownMs && !this.probing) {
      this.probing = true;
      this.logger.log(`${this.name} circuit half-open — probing with one call`);
      return;
    }

    throw this.buildOpenError(this.name, openForMs, this.consecutiveFailures);
  }

  private recordSuccess(): void {
    if (this.openedAtMs !== null) {
      this.logger.log(`${this.name} recovered — circuit closed`);
    }
    this.reset();
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;

    if (this.probing) {
      this.probing = false;
      this.openedAtMs = this.now();
      this.logger.warn(`${this.name} probe failed — circuit re-opened`);
      return;
    }

    if (this.openedAtMs === null && this.consecutiveFailures >= this.failureThreshold) {
      this.openedAtMs = this.now();
      this.logger.error(
        `${this.name} circuit opened after ${this.consecutiveFailures} consecutive ` +
          `failures; failing fast for ${this.cooldownMs}ms`,
      );
    }
  }
}
