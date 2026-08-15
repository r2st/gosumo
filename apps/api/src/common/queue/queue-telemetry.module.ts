import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
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
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [QueueTelemetryService, QueueDrainService],
  exports: [QueueTelemetryService],
})
export class QueueTelemetryModule {}
