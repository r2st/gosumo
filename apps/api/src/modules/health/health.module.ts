import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { QdrantClient } from '../ai-engine/rag/qdrant.client';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * HealthModule — liveness and readiness probes.
 *
 * Imports AuthModule purely for its shared `REDIS_CLIENT`, so the readiness
 * probe checks the same connection the app actually uses rather than opening
 * a second one that could be healthy while the real one is not.
 *
 * `QdrantClient` is provided directly rather than by importing the ai-engine
 * module, which would pull the entire AI graph — LLM client, RAG services,
 * repositories — into a module whose job is to answer a load balancer. The
 * shortcut is safe *here* specifically because the client holds no connection:
 * it is a base URL and a `fetch` per call, so a second instance is the same
 * instance in every way that matters. That reasoning does not extend to Redis
 * or Prisma above, and their imports stay as they are.
 */
@Module({
  imports: [AuthModule],
  controllers: [HealthController],
  providers: [HealthService, QdrantClient],
  exports: [HealthService],
})
export class HealthModule {}
