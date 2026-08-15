import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { QueueCorrelationService } from './queue-correlation.service';
import { QueueDrainService } from './queue-drain.service';
import { QueueTelemetryService } from './queue-telemetry.service';

/**
 * Global so the health probe can read queue depth without importing whichever
 * feature module happens to own a given queue — the service watches all of
 * them, so tying it to one would be arbitrary.
 *
 * `QueueDrainService` rides along for the same reason: it acts on every queue
 * in the container, so it belongs to none of them. It is not exported — nothing
 * calls it; Nest does, on `beforeApplicationShutdown`.
 *
 * `QueueCorrelationService` is the third of the same kind: it wraps every
 * discovered queue's producer and consumer so a correlation id survives Redis,
 * and is likewise driven by a lifecycle hook rather than by a caller.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [QueueTelemetryService, QueueDrainService, QueueCorrelationService],
  exports: [QueueTelemetryService],
})
export class QueueTelemetryModule {}
