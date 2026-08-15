/**
 * The one place every circuit breaker in the process is created.
 *
 * Two things depend on breakers being registered rather than being private
 * fields on the service that uses them:
 *
 *  1. **Monitoring.** An open breaker is the single most useful signal this
 *     API produces during an incident — it names the dependency that is down
 *     and says the failure is already contained. `GET /v1/health/ready`
 *     reports every open one, which turns "payments are failing" into
 *     "Razorpay has been open for 40s" without anyone reading a log.
 *  2. **Recovery.** An operator can close a breaker that is open against a
 *     provider they have just confirmed healthy, rather than waiting out a
 *     cooldown.
 *
 * `get()` is idempotent on the name, so a module that resolves a breaker on
 * each call still shares one instance — a per-call breaker counts to five and
 * is thrown away, which looks like a breaker and protects nothing.
 */

import { Injectable } from '@nestjs/common';
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitSnapshot,
} from './circuit-breaker';

@Injectable()
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  /**
   * The breaker for `options.name`, creating it on first use.
   *
   * Options are read only when the breaker is created. A second call with
   * different thresholds returns the existing breaker unchanged — two callers
   * disagreeing about a dependency's thresholds is a bug in the callers, and
   * silently re-configuring a live breaker would reset state mid-outage.
   */
  get(options: CircuitBreakerOptions): CircuitBreaker {
    const existing = this.breakers.get(options.name);
    if (existing) return existing;

    const created = new CircuitBreaker(options);
    this.breakers.set(options.name, created);
    return created;
  }

  /** Every breaker's state, whatever it is. */
  snapshots(): CircuitSnapshot[] {
    return [...this.breakers.values()].map((breaker) => breaker.snapshot());
  }

  /**
   * Only the breakers that are not closed.
   *
   * This is what the readiness probe reports: in normal operation it is empty,
   * so its presence in a response body is itself the alert.
   */
  openCircuits(): CircuitSnapshot[] {
    return this.snapshots().filter((snapshot) => snapshot.state !== 'closed');
  }

  /** Close a named breaker. Returns false if no breaker by that name exists. */
  reset(name: string): boolean {
    const breaker = this.breakers.get(name);
    if (!breaker) return false;
    breaker.reset();
    return true;
  }
}
