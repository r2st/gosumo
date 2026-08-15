/**
 * Finding every Bull queue in the container, without a hand-maintained list.
 *
 * `@nestjs/bull` registers each queue under a `BullQueue_<name>` provider
 * token, so walking the container finds every queue any module registers —
 * including ones added later. Two services need this now (telemetry and the
 * shutdown drain) and a list maintained in either of them is exactly the kind
 * that goes stale and silently drops one queue.
 */

import type { DiscoveryService } from '@nestjs/core';
import type { Queue } from 'bull';

/** Prefix `@nestjs/bull` gives its queue provider tokens. */
export const QUEUE_TOKEN_PREFIX = 'BullQueue_';

/**
 * Structural check — narrow enough to skip a same-prefix provider that is not
 * a queue, and loose enough that a hand-rolled test double satisfies it.
 */
export function isQueue(instance: unknown): instance is Queue {
  const candidate = instance as Partial<Queue> | null;
  return (
    candidate != null &&
    typeof candidate.name === 'string' &&
    typeof candidate.on === 'function' &&
    typeof candidate.getJobCounts === 'function'
  );
}

/** Every registered Bull queue in the container. */
export function discoverQueues(discovery: DiscoveryService): Queue[] {
  return discovery
    .getProviders()
    .filter(
      (wrapper) =>
        typeof wrapper.name === 'string' &&
        wrapper.name.startsWith(QUEUE_TOKEN_PREFIX) &&
        isQueue(wrapper.instance),
    )
    .map((wrapper) => wrapper.instance as Queue);
}
