import { Global, Module } from '@nestjs/common';
import { CircuitBreakerRegistry } from './circuit-breaker.registry';

/**
 * Global for the same reason {@link PrismaModule} is: a breaker is only a
 * breaker if every caller of a dependency shares one.
 *
 * If `CircuitBreakerRegistry` were listed in each feature module's `providers`
 * array, Nest would build one registry per module — so the payment module and
 * the realty-integrations module, which both call Razorpay, would each count
 * to five independently and neither would ever protect the other. Nothing
 * would fail loudly; the breakers would simply take twice as long to open.
 *
 * `resilience.module.spec.ts` pins the `@Global()` decorator and asserts that
 * no feature module re-provides the registry.
 */
@Global()
@Module({
  providers: [CircuitBreakerRegistry],
  exports: [CircuitBreakerRegistry],
})
export class ResilienceModule {}
