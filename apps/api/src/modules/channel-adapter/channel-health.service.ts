/**
 * Per-adapter health, so one sick channel is visible as one sick channel.
 *
 * The module already isolates channels *structurally* — each provider posts to
 * its own endpoint, each outbound send has its own circuit breaker, and a
 * failed inbound delivery is dead-lettered per message rather than per batch.
 * What it had no answer for was the question an operator actually asks during
 * an incident: **which** channel is broken, and since when.
 *
 * `getStatus()` answered "five adapters are registered", which is true of a
 * process where Instagram has rejected every webhook for an hour. The circuit
 * breakers know about outbound sends and nothing about inbound: a Meta
 * signature misconfiguration, a parser that throws on a payload shape, a tenant
 * whose `channel_accounts` row was deleted — all of those fail every inbound
 * message on that channel while every breaker stays closed, because no outbound
 * call was ever made. That is the failure mode that lasted longest unnoticed,
 * because from the provider's side it looks fine: we answer 200 to everything.
 *
 * So this counts both directions, per channel, and grades them.
 *
 * ## Consecutive, not a rate
 *
 * Same reasoning as {@link CircuitBreaker}: a channel that is up produces
 * successes continuously, so a genuine fault shows as an unbroken run of
 * failures. A ratio over a window would rate a channel with heavy traffic and
 * 5% junk payloads the same as one that is refusing everything, and the second
 * is the only one worth waking up for.
 *
 * ## Bounded by construction
 *
 * One record per `ChannelType`, allocated up front. Nothing here grows with
 * traffic, and a channel name that is not a known type is ignored rather than
 * added — `/webhooks/:channel` puts a caller-supplied string one validation
 * away from this map, and an unbounded map keyed on it is a memory leak with a
 * URL.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ChannelType } from '@gosumo/shared';

/**
 * DI token for the clock, so the constructor parameter has one Nest can resolve.
 *
 * A bare `constructor(private readonly now: () => Date = () => new Date())` does
 * not work here even though the default makes it look self-sufficient: this is
 * an `@Injectable()` provider, so Nest reads `design:paramtypes` and sees the
 * function type erased to `Function`, then tries to resolve a provider under
 * that token and fails the whole graph — `ChannelAdapterModule` stops
 * instantiating, and with it every module that imports it. Default parameter
 * values are invisible to the injector.
 *
 * Nothing registers this token, which is the point: `@Optional()` then hands the
 * constructor `undefined` and the default fires. Tests keep passing a clock
 * positionally, and a Nest testing module can override the token if it ever
 * needs to.
 */
export const CHANNEL_HEALTH_CLOCK = Symbol('CHANNEL_HEALTH_CLOCK');

/** Consecutive failures before a channel is called degraded. */
export const CHANNEL_DEGRADED_AFTER = 3;

/**
 * Consecutive failures before a channel is called failing.
 *
 * Ten rather than five: unlike a breaker, nothing acts on this number — it
 * changes no behaviour, it only changes what an operator reads. So it is set
 * where "this is not a bad payload, this channel is broken" is no longer a
 * judgement call.
 */
export const CHANNEL_FAILING_AFTER = 10;

export type ChannelHealthState = 'healthy' | 'degraded' | 'failing';

/** One direction's tally. */
export interface DirectionHealth {
  ok: number;
  failed: number;
  consecutiveFailures: number;
  lastOkAt: string | null;
  lastFailureAt: string | null;
  /**
   * The most recent failure's message.
   *
   * Present only on the authenticated snapshot. It can carry a provider's own
   * error text, a tenant id, or a recipient — see the 200-body disclosure rule
   * in the app's CLAUDE.md — so {@link ChannelHealthService.publicSnapshots}
   * omits it.
   */
  lastError: string | null;
}

export interface ChannelHealthSnapshot {
  channel: ChannelType;
  state: ChannelHealthState;
  inbound: DirectionHealth;
  outbound: DirectionHealth;
}

/** The same thing minus anything a stranger should not read. */
export interface PublicChannelHealth {
  channel: ChannelType;
  state: ChannelHealthState;
  inboundConsecutiveFailures: number;
  outboundConsecutiveFailures: number;
}

function emptyDirection(): DirectionHealth {
  return {
    ok: 0,
    failed: 0,
    consecutiveFailures: 0,
    lastOkAt: null,
    lastFailureAt: null,
    lastError: null,
  };
}

/** How a run of consecutive failures grades. */
export function gradeChannel(consecutiveFailures: number): ChannelHealthState {
  if (consecutiveFailures >= CHANNEL_FAILING_AFTER) return 'failing';
  if (consecutiveFailures >= CHANNEL_DEGRADED_AFTER) return 'degraded';
  return 'healthy';
}

@Injectable()
export class ChannelHealthService {
  private readonly logger = new Logger(ChannelHealthService.name);

  private readonly inbound = new Map<ChannelType, DirectionHealth>();
  private readonly outbound = new Map<ChannelType, DirectionHealth>();

  /** Injectable clock, so tests state times rather than waiting for them. */
  constructor(
    @Optional()
    @Inject(CHANNEL_HEALTH_CLOCK)
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const channel of Object.values(ChannelType)) {
      this.inbound.set(channel, emptyDirection());
      this.outbound.set(channel, emptyDirection());
    }
  }

  recordInboundSuccess(channel: ChannelType): void {
    this.recordSuccess(this.inbound.get(channel), channel, 'inbound');
  }

  recordInboundFailure(channel: ChannelType, error: unknown): void {
    this.recordFailure(this.inbound.get(channel), channel, 'inbound', error);
  }

  recordOutboundSuccess(channel: ChannelType): void {
    this.recordSuccess(this.outbound.get(channel), channel, 'outbound');
  }

  recordOutboundFailure(channel: ChannelType, error: unknown): void {
    this.recordFailure(this.outbound.get(channel), channel, 'outbound', error);
  }

  /** One channel's full state, or null for a name that is not a channel. */
  snapshot(channel: ChannelType): ChannelHealthSnapshot | null {
    const inbound = this.inbound.get(channel);
    const outbound = this.outbound.get(channel);
    if (!inbound || !outbound) return null;

    return {
      channel,
      state: gradeChannel(
        Math.max(inbound.consecutiveFailures, outbound.consecutiveFailures),
      ),
      inbound: { ...inbound },
      outbound: { ...outbound },
    };
  }

  /** Every channel, healthy or not. For the authenticated status route. */
  snapshots(): ChannelHealthSnapshot[] {
    return Object.values(ChannelType)
      .map((channel) => this.snapshot(channel))
      .filter((snapshot): snapshot is ChannelHealthSnapshot => snapshot !== null);
  }

  /**
   * Only the channels that are not healthy, with no error text.
   *
   * This is what the readiness probe publishes: empty in normal operation, so
   * its presence is the signal, and it names the channel without describing the
   * deployment to whoever curled it.
   */
  publicSnapshots(): PublicChannelHealth[] {
    return this.snapshots()
      .filter((snapshot) => snapshot.state !== 'healthy')
      .map((snapshot) => ({
        channel: snapshot.channel,
        state: snapshot.state,
        inboundConsecutiveFailures: snapshot.inbound.consecutiveFailures,
        outboundConsecutiveFailures: snapshot.outbound.consecutiveFailures,
      }));
  }

  /** True while this channel's inbound path is failing run after run. */
  isInboundFailing(channel: ChannelType): boolean {
    const inbound = this.inbound.get(channel);
    return (inbound?.consecutiveFailures ?? 0) >= CHANNEL_FAILING_AFTER;
  }

  /** Clear one channel's counters, or every channel's. For tests and operators. */
  reset(channel?: ChannelType): void {
    const channels = channel ? [channel] : Object.values(ChannelType);
    for (const target of channels) {
      if (!this.inbound.has(target)) continue;
      this.inbound.set(target, emptyDirection());
      this.outbound.set(target, emptyDirection());
    }
  }

  // ─────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────

  private recordSuccess(
    direction: DirectionHealth | undefined,
    channel: ChannelType,
    label: string,
  ): void {
    if (!direction) return;

    const wasFailing = direction.consecutiveFailures >= CHANNEL_DEGRADED_AFTER;
    direction.ok += 1;
    direction.consecutiveFailures = 0;
    direction.lastOkAt = this.now().toISOString();

    if (wasFailing) {
      this.logger.log(`${channel} ${label} recovered`);
    }
  }

  private recordFailure(
    direction: DirectionHealth | undefined,
    channel: ChannelType,
    label: string,
    error: unknown,
  ): void {
    if (!direction) return;

    direction.failed += 1;
    direction.consecutiveFailures += 1;
    direction.lastFailureAt = this.now().toISOString();
    direction.lastError = error instanceof Error ? error.message : String(error);

    // Logged only at the two grade boundaries, not per failure. Every failure
    // already produced a line where it happened; a second one here would double
    // the volume of an incident's logs to say something the first line implied.
    // The transitions are what is new information.
    if (direction.consecutiveFailures === CHANNEL_DEGRADED_AFTER) {
      this.logger.warn(
        `${channel} ${label} degraded — ${CHANNEL_DEGRADED_AFTER} consecutive failures ` +
          `(last: ${direction.lastError})`,
      );
    } else if (direction.consecutiveFailures === CHANNEL_FAILING_AFTER) {
      this.logger.error(
        `${channel} ${label} failing — ${CHANNEL_FAILING_AFTER} consecutive failures ` +
          `(last: ${direction.lastError}). Other channels are unaffected.`,
      );
    }
  }
}
