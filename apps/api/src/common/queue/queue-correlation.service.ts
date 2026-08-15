/**
 * Carries the correlation id across the one boundary `AsyncLocalStorage`
 * cannot: Redis.
 *
 * A request that enqueues work is where tracing usually goes dark. The HTTP
 * side logs an id and returns 202; the job runs later — different tick, often
 * a different process — and logs under nothing, so the two halves of one
 * user-visible action cannot be joined. That gap covers most of what this API
 * actually does: inbound webhooks queue conversation processing, sends are
 * queued, notifications are queued, compliance sweeps are queued.
 *
 * Closing it needs two halves, and both are done here rather than at the ~14
 * call sites:
 *
 *   producer — `queue.add()` stamps the active correlation id into the job
 *              payload.
 *   consumer — the registered handler is re-entered inside a context carrying
 *              the id back out of the payload.
 *
 * Doing it centrally is the point. A convention applied at each call site is
 * one someone forgets on the fifteenth, and the failure is invisible: the job
 * still runs, it just logs under no id, and nobody discovers that until they
 * are mid-incident trying to follow one.
 *
 * Both halves reuse `discoverQueues`, so a queue added by a future module is
 * covered the moment it is registered, with no list to update.
 */

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { Queue } from 'bull';
import { newCorrelationId } from '../context/correlation-id.util';
import { getCorrelationId, runWithRequestContext } from '../context/request-context';
import { discoverQueues } from './queue-discovery.util';

/**
 * Where the id rides inside the job payload.
 *
 * Double-underscored to say "infrastructure, not domain data" to anyone
 * reading a job in Redis or in Bull Board. No processor destructures it and
 * nothing spreads `job.data` into a write, so an extra key is inert — that was
 * checked before choosing the payload over `job.opts`, which Bull treats as
 * its own and which a future Bull version is far more likely to start
 * validating.
 */
export const CORRELATION_JOB_KEY = '__correlationId';

/** Marks an already-wrapped queue, so a double bootstrap cannot double-wrap. */
const WRAPPED = Symbol('gosumo.correlationWrapped');

/** Job payload shape this service cares about — anything object-like. */
type JobPayload = Record<string, unknown>;

/** A payload can be stamped only if it is a plain object we can add a key to. */
function isStampable(data: unknown): data is JobPayload {
  return typeof data === 'object' && data !== null && !Array.isArray(data);
}

/**
 * Read a correlation id back out of a payload, if it carries a usable one.
 *
 * Not run through `sanitizeCorrelationId`: this value was written by the
 * producer half below, not by a caller. It is only checked for being a
 * non-empty string, which is what distinguishes "stamped" from "job predates
 * this feature" — jobs already sitting in Redis at deploy time have no key,
 * and must keep running.
 */
function payloadCorrelationId(data: unknown): string | undefined {
  if (!isStampable(data)) return undefined;
  const value = data[CORRELATION_JOB_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

@Injectable()
export class QueueCorrelationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueCorrelationService.name);

  constructor(private readonly discovery: DiscoveryService) {}

  /**
   * Runs at `onApplicationBootstrap` — after every `onModuleInit`, which is
   * where `@nestjs/bull`'s explorer registers the processors. Wrapping the
   * consumer side any earlier would find `queue.handlers` empty and silently
   * do nothing.
   */
  onApplicationBootstrap(): void {
    const queues = discoverQueues(this.discovery);
    let wrapped = 0;

    for (const queue of queues) {
      const marked = queue as Queue & { [WRAPPED]?: boolean };
      if (marked[WRAPPED]) continue;

      this.wrapProducer(queue);
      this.wrapConsumer(queue);
      marked[WRAPPED] = true;
      wrapped += 1;
    }

    this.logger.log(
      `Correlation id propagation active on ${wrapped} queue(s): ${
        queues.map((q) => q.name).join(', ') || 'none'
      }`,
    );
  }

  /**
   * Stamp the active correlation id onto every job this queue enqueues.
   *
   * Bull's `add` is overloaded — `add(data, opts?)` and `add(name, data, opts?)`
   * — and both forms are used in this codebase, so the data argument is located
   * by shape rather than by position being assumed.
   */
  private wrapProducer(queue: Queue): void {
    const original = queue.add.bind(queue);

    const wrapper = (...args: unknown[]): unknown => {
      // A job enqueued outside any request (a cron registration at boot) has
      // nothing to inherit. It is left unstamped rather than given a fresh id
      // here, because an id minted on the producer side of a boot-time
      // registration joins nothing — the consumer mints its own instead.
      const id = getCorrelationId();
      if (id) {
        const dataIndex = typeof args[0] === 'string' ? 1 : 0;
        const data = args[dataIndex];
        if (isStampable(data)) {
          // Copied, not mutated: the caller may still hold and reuse the object
          // it passed, and Bull serializes this argument immediately.
          // `??=` semantics by hand — an id already present wins, so a job
          // re-enqueued by a retry keeps its original request's id.
          args[dataIndex] = { [CORRELATION_JOB_KEY]: id, ...data };
        }
      }
      return (original as (...a: unknown[]) => unknown)(...args);
    };

    (queue as { add: unknown }).add = wrapper;
  }

  /**
   * Re-enter the request context around each registered handler.
   *
   * Bull resolves `this.handlers[job.name] || this.handlers['*']` at the moment
   * it runs a job (see `bull/lib/queue.js`), not once at registration — so
   * replacing the entries here applies to every job processed afterwards.
   *
   * That is an internal field. It is guarded structurally and a queue that does
   * not expose one is skipped with a warning rather than crashing boot: losing
   * correlation ids inside jobs is a degraded log, while a failed bootstrap is
   * an outage, and this feature is not worth trading one for the other.
   */
  private wrapConsumer(queue: Queue): void {
    const handlers = (queue as unknown as { handlers?: Record<string, unknown> }).handlers;

    if (typeof handlers !== 'object' || handlers === null) {
      this.logger.warn(
        `Queue "${queue.name}" exposes no handler table — jobs will run without a correlation id`,
      );
      return;
    }

    for (const [name, handler] of Object.entries(handlers)) {
      if (typeof handler !== 'function') continue;

      const original = handler as (...args: unknown[]) => unknown;

      handlers[name] = function correlatedHandler(this: unknown, ...args: unknown[]) {
        const job = args[0] as { data?: unknown } | undefined;
        // A job with no stamp still gets an id, minted here. Its lines then
        // join each other even though they join no request — which is the
        // whole ask for cron-triggered work, and for jobs enqueued before
        // this feature shipped.
        const id = payloadCorrelationId(job?.data) ?? newCorrelationId();

        return runWithRequestContext({ correlationId: id }, () =>
          original.apply(this, args),
        );
      };
    }
  }
}
