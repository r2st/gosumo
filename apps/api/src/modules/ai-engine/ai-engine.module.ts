import { Module } from '@nestjs/common';
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
import { PrismaService } from '../../common/services/prisma.service';
import { ChannelAdapterModule } from '../channel-adapter/channel-adapter.module';
import { RealtyTenantModule } from './realty/realty-tenant.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogMatchService } from './pipeline/catalog-match.service';

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
 */
@Module({
  imports: [ConfigModule, ChannelAdapterModule, RealtyTenantModule, CatalogModule],
  controllers: [AiEngineController],
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
    PrismaService,
  ],
  exports: [AiEngineService],
})
export class AiEngineModule {}
