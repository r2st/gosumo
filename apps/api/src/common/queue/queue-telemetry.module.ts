import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { QueueTelemetryService } from './queue-telemetry.service';

/**
 * Global so the health probe can read queue depth without importing whichever
 * feature module happens to own a given queue — the service watches all of
 * them, so tying it to one would be arbitrary.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [QueueTelemetryService],
  exports: [QueueTelemetryService],
})
export class QueueTelemetryModule {}
