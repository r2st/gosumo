import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ConfigModule } from '@nestjs/config';
import { AiEngineService } from './ai-engine.service';
import { AiEngineController } from './ai-engine.controller';
import { AiEngineRepository } from './ai-engine.repository';
import { ContextLoaderService } from './pipeline/context-loader.service';
import { IntentClassifierService } from './pipeline/intent-classifier.service';
import { PromptAssemblerService } from './pipeline/prompt-assembler.service';
import { LlmClientService } from './pipeline/llm-client.service';
import { ResponseParserService } from './pipeline/response-parser.service';
import { ConfidenceCalculatorService } from './pipeline/confidence-calculator.service';
import { ActionRouterService } from './pipeline/action-router.service';
import { GuardrailsService } from './safety/guardrails.service';
import { ReviewQueueService } from './hitl/review-queue.service';
import { QdrantClient } from './rag/qdrant.client';
import { EmbeddingService } from './rag/embedding.service';
import { RagRetrieverService } from './rag/rag-retriever.service';
import { KnowledgeIngestionService } from './rag/knowledge-ingestion.service';
import { ChannelAdapterModule } from '../channel-adapter/channel-adapter.module';
import { RealtyTenantModule } from './realty/realty-tenant.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogMatchService } from './pipeline/catalog-match.service';
import { AiQualityController } from './quality/ai-quality.controller';
import { AiQualityService } from './quality/ai-quality.service';
import { AiQualityRepository } from './quality/ai-quality.repository';
import { AiQualityProcessor } from './quality/ai-quality.processor';
import {
  AI_QUALITY_JOBS,
  AI_QUALITY_QUEUE,
  AI_QUALITY_REPEAT_JOB_ID,
  AI_QUALITY_ROLLUP_CRON,
} from './quality/ai-quality.constants';

/**
 * AiEngineModule — the cognitive core of GoSumo.
 *
 * Wires the Read → Decide → Act pipeline:
 *   - context loading, intent classification, RAG retrieval (READ)
 *   - guardrails + confidence scoring + routing (DECIDE)
 *   - LLM generation, decision persistence, HITL review queue, delivery (ACT)
 *
 * Depends on ChannelAdapterModule for outbound delivery. It listens to
 * `message.received` (via the global EventEmitter) and exposes its service to
 * the HITL module for draft management.
 *
 * Also owns the AI response-quality rollup (`quality/`), which reads the
 * decisions this pipeline writes and aggregates them into `ai_quality_metrics`
 * on an hourly repeatable job.
 */
@Module({
  imports: [
    ConfigModule,
    ChannelAdapterModule,
    RealtyTenantModule,
    CatalogModule,
    BullModule.registerQueue({ name: AI_QUALITY_QUEUE }),
  ],
  controllers: [AiEngineController, AiQualityController],
  providers: [
    AiEngineService,
    AiEngineRepository,
    ContextLoaderService,
    IntentClassifierService,
    PromptAssemblerService,
    LlmClientService,
    ResponseParserService,
    ConfidenceCalculatorService,
    ActionRouterService,
    CatalogMatchService,
    GuardrailsService,
    ReviewQueueService,
    QdrantClient,
    EmbeddingService,
    RagRetrieverService,
    KnowledgeIngestionService,
    AiQualityService,
    AiQualityRepository,
    AiQualityProcessor,
  ],
  exports: [AiEngineService, AiQualityService],
})
export class AiEngineModule implements OnModuleInit {
  private readonly logger = new Logger(AiEngineModule.name);

  constructor(@InjectQueue(AI_QUALITY_QUEUE) private readonly queue: Queue) {}

  /**
   * Register the hourly quality rollup as a repeatable job. Stable job id, and
   * any prior repeatable carrying a *different* cron is removed first, so a
   * redeploy that changes the schedule replaces it instead of running both.
   */
  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.queue.getRepeatableJobs();
      await Promise.all(
        existing
          .filter(
            (job) =>
              job.id === AI_QUALITY_REPEAT_JOB_ID &&
              job.cron !== AI_QUALITY_ROLLUP_CRON,
          )
          .map((job) => this.queue.removeRepeatableByKey(job.key)),
      );
      await this.queue.add(
        AI_QUALITY_JOBS.ROLLUP,
        {},
        {
          jobId: AI_QUALITY_REPEAT_JOB_ID,
          repeat: { cron: AI_QUALITY_ROLLUP_CRON },
          removeOnComplete: true,
          // Kept on purpose: a failed rollup is the only trace that a bucket
          // was never computed. See the queue notes in apps/api/CLAUDE.md.
          removeOnFail: false,
        },
      );
      this.logger.log(
        `Scheduled AI quality rollup (${AI_QUALITY_ROLLUP_CRON})`,
      );
    } catch (err) {
      // Redis is not available in every context (unit tests, CI): never block boot.
      this.logger.warn(
        `Could not schedule AI quality rollup: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
