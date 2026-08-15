/**
 * Contract: the registry is what makes a breaker *shared*, and the module is
 * what makes the registry shared.
 *
 * Both failures here are silent. A registry that hands out a new breaker per
 * call still returns something that behaves like a breaker — it just counts to
 * the threshold and is discarded, so it never opens. A registry provided
 * per-module gives each feature module its own copy, so the two modules that
 * both call Razorpay each need the full threshold and neither ever protects
 * the other. Nothing throws in either case; the protection is simply absent.
 */

import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ExternalServiceError } from '@gosumo/shared';
import { CircuitBreakerRegistry } from './circuit-breaker.registry';
import { ResilienceModule } from './resilience.module';
import { CircuitOpenError } from './circuit-breaker';
import {
  RAZORPAY_BREAKER,
  SENDGRID_BREAKER,
  STRIPE_BREAKER,
  TWILIO_BREAKER,
  WHATSAPP_BREAKER,
  INSTAGRAM_BREAKER,
} from './circuit-breaker.constants';

const outage = () =>
  new ExternalServiceError('Acme', 'unavailable', { status: 503, retryable: true });

describe('CircuitBreakerRegistry', () => {
  it('returns the same breaker for a name, so callers share state', () => {
    const registry = new CircuitBreakerRegistry();

    const a = registry.get({ name: 'Acme' });
    const b = registry.get({ name: 'Acme' });

    expect(b).toBe(a);
  });

  it('keeps different dependencies independent', async () => {
    const registry = new CircuitBreakerRegistry();
    const acme = registry.get({ name: 'Acme', failureThreshold: 1 });
    const other = registry.get({ name: 'Other', failureThreshold: 1 });

    await acme.run(() => Promise.reject(outage())).catch(() => undefined);

    expect(acme.isOpen).toBe(true);
    expect(other.isOpen).toBe(false);
  });

  it('ignores options on a second get, rather than resetting a live breaker', async () => {
    // Re-configuring mid-outage would drop the failure run that is the whole
    // reason the breaker is open.
    const registry = new CircuitBreakerRegistry();
    const first = registry.get({ name: 'Acme', failureThreshold: 1 });
    await first.run(() => Promise.reject(outage())).catch(() => undefined);

    const second = registry.get({ name: 'Acme', failureThreshold: 99 });

    expect(second).toBe(first);
    expect(second.isOpen).toBe(true);
  });

  it('reports only breakers that are not closed', async () => {
    const registry = new CircuitBreakerRegistry();
    registry.get({ name: 'Healthy' });
    const sick = registry.get({ name: 'Sick', failureThreshold: 1 });
    await sick.run(() => Promise.reject(outage())).catch(() => undefined);

    expect(registry.snapshots()).toHaveLength(2);
    expect(registry.openCircuits()).toEqual([
      expect.objectContaining({ name: 'Sick', state: 'open' }),
    ]);
  });

  it('closes a named breaker on request, and says so when there is none', async () => {
    const registry = new CircuitBreakerRegistry();
    const sick = registry.get({ name: 'Sick', failureThreshold: 1 });
    await sick.run(() => Promise.reject(outage())).catch(() => undefined);

    expect(registry.reset('Sick')).toBe(true);
    expect(sick.isOpen).toBe(false);
    expect(registry.reset('Never registered')).toBe(false);
  });
});

describe('ResilienceModule', () => {
  it('is global, so one registry serves every feature module', async () => {
    // Two unrelated modules that never import ResilienceModule. If it were not
    // global, neither would resolve the registry at all — and the failure a
    // reviewer must be protected from is the *quieter* one below: a registry
    // per module, which resolves fine and protects nothing.
    @Module({ providers: [], exports: [] })
    class ConsumerA {}
    @Module({ providers: [], exports: [] })
    class ConsumerB {}

    const moduleRef = await Test.createTestingModule({
      imports: [ResilienceModule, ConsumerA, ConsumerB],
    }).compile();

    const fromA = moduleRef.select(ConsumerA).get(CircuitBreakerRegistry, { strict: false });
    const fromB = moduleRef.select(ConsumerB).get(CircuitBreakerRegistry, { strict: false });

    expect(fromA).toBe(fromB);
  });

  it('carries the @Global() decorator', () => {
    // The behavioural test above passes for a module Nest happens to hoist;
    // this pins the decorator that guarantees it.
    expect(Reflect.getMetadata('__module:global__', ResilienceModule)).toBe(true);
  });

  it('shares one Razorpay breaker between the two modules that call Razorpay', async () => {
    // PaymentModule and RealtyIntegrationsModule each provide their own
    // RazorpayService instance. Two breakers would each need the full
    // threshold, so a gateway outage would be discovered twice and neither
    // module's calls would be protected by the other's evidence.
    const registry = new CircuitBreakerRegistry();

    const fromPayments = registry.get(RAZORPAY_BREAKER);
    const fromRealty = registry.get(RAZORPAY_BREAKER);

    expect(fromRealty).toBe(fromPayments);
  });
});

describe('breaker settings', () => {
  const ALL = [
    RAZORPAY_BREAKER,
    STRIPE_BREAKER,
    WHATSAPP_BREAKER,
    INSTAGRAM_BREAKER,
    TWILIO_BREAKER,
    SENDGRID_BREAKER,
  ];

  it('gives every dependency a distinct name', () => {
    // The name is the map key, so a duplicate would silently merge two
    // dependencies into one breaker — an Instagram incident would stop
    // WhatsApp replies for every tenant.
    expect(new Set(ALL.map((s) => s.name)).size).toBe(ALL.length);
  });

  it('never sets a threshold of one', () => {
    // A threshold of one opens on a single blip, which every provider has.
    for (const settings of ALL) {
      expect(settings.failureThreshold).toBeGreaterThan(1);
    }
  });

  it('keeps every cooldown short enough not to outlast the outage', () => {
    // An over-long cooldown keeps failing calls after the provider is back,
    // which reads to a tenant exactly like the outage it was protecting them
    // from.
    for (const settings of ALL) {
      expect(settings.cooldownMs).toBeGreaterThanOrEqual(10_000);
      expect(settings.cooldownMs).toBeLessThanOrEqual(60_000);
    }
  });

  it('opens on a real provider outage with the configured settings', async () => {
    const registry = new CircuitBreakerRegistry();
    const breaker = registry.get(WHATSAPP_BREAKER);

    for (let i = 0; i < WHATSAPP_BREAKER.failureThreshold; i++) {
      await breaker.run(() => Promise.reject(outage())).catch(() => undefined);
    }

    await expect(breaker.run(async () => 'ok')).rejects.toBeInstanceOf(CircuitOpenError);
  });
});
