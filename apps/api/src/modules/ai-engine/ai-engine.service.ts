import { PrismaService } from '../../common/services/prisma.service';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import {
  ai_decisions,
  AiDecisionType,
  AiDecisionOutcome,
  EmbeddingEntityType,
} from '@gosumo/database';
import {
  IntentType,
  ConfidenceMode,
  ChannelType,
  MessageContentType,
  OutboundMessage,
  SuggestedAction,
  AIIntentClassifiedEvent,
  AIResponseGeneratedEvent,
  MessageReceivedEvent,
  AIResponseApprovedEvent,
  generateId,
  generateCorrelationId,
} from '@gosumo/shared';

import { ContextLoaderService, EnrichedContext } from './pipeline/context-loader.service';
import { IntentClassifierService } from './pipeline/intent-classifier.service';
import { RagRetrieverService } from './rag/rag-retriever.service';
import { PromptAssemblerService } from './pipeline/prompt-assembler.service';
import { LlmClientService, LlmUnavailableError } from './pipeline/llm-client.service';
import { ResponseParserService, ParsedAiResponse } from './pipeline/response-parser.service';
import {
  ConfidenceCalculatorService,
  ScoredConfidence,
} from './pipeline/confidence-calculator.service';
import { ActionRouterService, RoutingDecision } from './pipeline/action-router.service';
import { extractAmountPaise } from './pipeline/money-extract.util';
import { GuardrailsService } from './safety/guardrails.service';
import { ReviewQueueService } from './hitl/review-queue.service';
import { KnowledgeIngestionService } from './rag/knowledge-ingestion.service';
import { EmbeddingService } from './rag/embedding.service';
import { AiEngineRepository } from './ai-engine.repository';
import { ChannelAdapterService } from '../channel-adapter/channel-adapter.service';
import { RealtyTenantService } from './realty/realty-tenant.service';
import {
  ProcessMessageDto,
  IntentClassificationDto,
  ConfidenceScoringInputDto,
  ConfidenceScoreDto,
  IngestKnowledgeDto,
  IngestResultDto,
  KnowledgeEntryDto,
  AIDecisionDto,
  ListDecisionsQueryDto,
} from './dto';
import {
  INTENT_MODEL_ROUTING,
  INTENT_TEMPERATURE,
  DEFAULT_TEMPERATURE,
  LLM_MAX_TOKENS,
  LOOP_DETECTION_THRESHOLD,
  ESCALATION_HOLDING_MESSAGE,
  DEFAULT_AUTO_EXECUTE_THRESHOLD,
  DEFAULT_DRAFT_REVIEW_THRESHOLD,
} from './ai-engine.constants';

/** Message text for anything thrown, including non-Error values. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * AiEngineService — the cognitive core orchestrator.
 *
 * Implements the Read → Decide → Act pipeline:
 *   READ   — load enriched context, classify intent, retrieve RAG knowledge.
 *   DECIDE — run safety guardrails, score confidence, route to a band.
 *   ACT    — generate (or skip) the LLM reply, persist an immutable decision,
 *            then auto-send, draft for review, or escalate to a human.
 *
 * The pipeline never throws to its caller: any stage failure degrades to a
 * safe escalation so a customer always gets a response path.
 */
@Injectable()
export class AiEngineService {
  private readonly logger = new Logger(AiEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contextLoader: ContextLoaderService,
    private readonly intentClassifier: IntentClassifierService,
    private readonly rag: RagRetrieverService,
    private readonly promptAssembler: PromptAssemblerService,
    private readonly llm: LlmClientService,
    private readonly responseParser: ResponseParserService,
    private readonly confidence: ConfidenceCalculatorService,
    private readonly router: ActionRouterService,
    private readonly guardrails: GuardrailsService,
    private readonly reviewQueue: ReviewQueueService,
    private readonly knowledgeIngestion: KnowledgeIngestionService,
    private readonly embeddings: EmbeddingService,
    private readonly repository: AiEngineRepository,
    private readonly channelAdapter: ChannelAdapterService,
    private readonly eventEmitter: EventEmitter2,
    private readonly realtyTenants: RealtyTenantService,
  ) {}

  // ─────────────────────────────────────────────
  // Main pipeline
  // ─────────────────────────────────────────────

  /**
   * Process one inbound message end-to-end and return the resulting decision.
   *
   * Everything downstream of the LLM call already degrades to escalation on
   * failure, but earlier stages (context loading, confidence scoring, the
   * final decision write itself) do not — an unhandled exception there would
   * otherwise propagate out of the `message.received` handler and leave the
   * customer with no reply and no audit trail at all. This wrapper is the
   * backstop that keeps the class-level "never throws to its caller" promise
   * true for the whole pipeline, not just the generation step.
   */
  async processMessage(businessId: string, dto: ProcessMessageDto): Promise<AIDecisionDto> {
    const traceId = dto.correlationId ?? generateCorrelationId();
    const startMs = Date.now();
    try {
      return await this.runPipeline(businessId, dto, traceId, startMs);
    } catch (err) {
      this.logger.error(
        `[${traceId}] Pipeline crashed before a decision could be produced — falling back to emergency escalation: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return this.emergencyEscalate(businessId, dto, traceId, startMs, err);
    }
  }

  private async runPipeline(
    businessId: string,
    dto: ProcessMessageDto,
    traceId: string,
    startMs: number,
  ): Promise<AIDecisionDto> {
    // ── READ ──────────────────────────────────
    const context = await this.contextLoader.load(businessId, dto.conversationId, dto.messageId);
    const text = context.messageText;

    // Degrades to "no history", which disables loop detection for this turn —
    // the pipeline must not stall on it, but it must not be invisible either:
    // silently, the guardrail simply stops firing and nothing says so.
    const recentIntents = await this.repository
      .getRecentIntents(businessId, dto.conversationId, LOOP_DETECTION_THRESHOLD * 2)
      .catch((err: unknown) => {
        this.logger.warn(
          `Recent-intent lookup failed for conversation ${dto.conversationId}; ` +
            `loop detection is disabled for this turn: ${errMessage(err)}`,
        );
        return [] as string[];
      });
    const actionsExecuted = await this.hasRecentAction(context);

    const safety = this.guardrails.evaluate(text, { recentIntents, actionsExecuted });

    // Intent: rules-only when a jailbreak is detected (never invoke the LLM on
    // poisoned input); full cascade otherwise.
    const classification = safety.jailbreakDetected
      ? this.rulesOnlyIntent(text)
      : await this.intentClassifier.classify(text);

    this.emitIntentClassified(businessId, dto, classification, traceId);

    // RAG retrieval — skipped on jailbreak. A retrieval failure proceeds
    // without context by design (Qdrant being down must not block the
    // pipeline); confidence then drops on ragChunkCount and the turn routes to
    // a human. Logged because "answering with no grounding at all" and
    // "genuinely found nothing" are indistinguishable downstream.
    const chunks = safety.jailbreakDetected
      ? []
      : await this.rag.retrieve(text, businessId, classification.intent).catch((err: unknown) => {
          this.logger.warn(
            `RAG retrieval failed for business ${businessId}; continuing ungrounded ` +
              `(confidence will be penalised): ${errMessage(err)}`,
          );
          return [];
        });

    // ── DECIDE ────────────────────────────────
    const scored = this.confidence.calculate({
      intent: classification.intent,
      data: {
        ragChunkCount: chunks.length,
        clientKnown: context.client !== null,
      },
      policy: { policyDefined: context.businessRules.length > 0 },
      safety,
      forceEscalate: dto.forceEscalate === true,
      ...this.refundOverrideInputs(classification, context),
    });

    const route = this.router.route(scored, classification.intent);

    // ── ACT ───────────────────────────────────
    let parsed: ParsedAiResponse | null = null;
    if (!safety.jailbreakDetected && route.action !== 'ESCALATE') {
      parsed = await this.generateResponse(context, classification.intent, chunks, traceId);
      if (!parsed) {
        // Generation or validation failed — fall back to escalation.
        return this.finalizeEscalation(businessId, dto, context, classification, scored, route, startMs, traceId, true);
      }
    }

    return this.finalize(businessId, dto, context, classification, scored, route, parsed, startMs, traceId);
  }

  // ─────────────────────────────────────────────
  // Response generation
  // ─────────────────────────────────────────────

  private async generateResponse(
    context: EnrichedContext,
    intent: IntentType,
    chunks: Awaited<ReturnType<RagRetrieverService['retrieve']>>,
    traceId: string,
  ): Promise<ParsedAiResponse | null> {
    try {
      const ragSection = this.rag.formatForPrompt(chunks);
      const system = this.promptAssembler.assembleSystemPrompt(context, intent, ragSection, 'auto');
      const user = this.promptAssembler.assembleUserPrompt(context.messageText);

      const completion = await this.llm.complete({
        system,
        user,
        model: INTENT_MODEL_ROUTING[intent],
        maxTokens: LLM_MAX_TOKENS,
        temperature: INTENT_TEMPERATURE[intent] ?? DEFAULT_TEMPERATURE,
      });

      const parsed = this.responseParser.parse(completion.text, intent);
      if (!parsed) {
        this.logger.warn(`[${traceId}] Response parse failed — escalating`);
        return null;
      }

      // Stash usage on the parsed object for the decision record.
      (parsed as ParsedAiResponse & { _usage?: unknown })._usage = {
        modelId: completion.modelId,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        latencyMs: completion.latencyMs,
      };

      const validation = this.responseParser.validate(parsed);
      if (!validation.valid) {
        this.logger.warn(`[${traceId}] Response failed validation: ${validation.failures.join('; ')}`);
        return null;
      }
      return parsed;
    } catch (err) {
      if (err instanceof LlmUnavailableError) {
        this.logger.error(`[${traceId}] LLM unavailable — escalating: ${err.message}`);
      } else {
        this.logger.error(
          `[${traceId}] Response generation error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // Finalization (persist decision + act)
  // ─────────────────────────────────────────────

  private async finalize(
    businessId: string,
    dto: ProcessMessageDto,
    context: EnrichedContext,
    classification: IntentClassificationDto,
    scored: ScoredConfidence,
    route: RoutingDecision,
    parsed: ParsedAiResponse | null,
    startMs: number,
    traceId: string,
  ): Promise<AIDecisionDto> {
    // The model can self-escalate even from the AUTO_PILOT band (e.g. it spotted
    // a legal threat the rules missed). Honor that over the numeric route.
    if (parsed?.requiresEscalation) {
      return this.finalizeEscalation(businessId, dto, context, classification, scored, route, startMs, traceId, false, parsed);
    }

    if (route.action === 'AUTO_EXECUTE' && parsed) {
      return this.finalizeAutoExecute(businessId, dto, context, classification, scored, parsed, startMs, traceId);
    }
    if (route.action === 'DRAFT_REVIEW' || route.action === 'GUIDED') {
      return this.finalizeReview(businessId, dto, context, classification, scored, route, parsed, startMs, traceId);
    }
    return this.finalizeEscalation(businessId, dto, context, classification, scored, route, startMs, traceId, false, parsed);
  }

  private async finalizeAutoExecute(
    businessId: string,
    dto: ProcessMessageDto,
    context: EnrichedContext,
    classification: IntentClassificationDto,
    scored: ScoredConfidence,
    parsed: ParsedAiResponse,
    startMs: number,
    traceId: string,
  ): Promise<AIDecisionDto> {
    const usage = this.usageOf(parsed);
    const decision = await this.repository.createDecision({
      business_id: businessId,
      conversation_id: dto.conversationId,
      message_id: dto.messageId,
      type: AiDecisionType.SEND_MESSAGE,
      outcome: AiDecisionOutcome.AUTO_EXECUTED,
      proposed_action: this.proposedAction(classification.intent, parsed, 'AUTO_EXECUTE'),
      confidence_score: scored.finalScore,
      confidence_breakdown: this.breakdown(classification, scored),
      model_id: usage.modelId,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      latency_ms: Date.now() - startMs,
      executed_at: new Date(),
    });

    await this.deliver(context, businessId, parsed.responseText, traceId);

    this.emitResponseGenerated(businessId, dto, decision.id, classification, scored, parsed, traceId);
    this.eventEmitter.emit('ai.auto.executed', {
      type: 'ai.auto.executed',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: traceId,
      conversationId: dto.conversationId,
      decisionId: decision.id,
      action: classification.intent,
    });

    this.logger.log(`[${traceId}] AUTO-EXECUTED decision ${decision.id} (confidence ${scored.finalScore})`);
    return this.toDto(decision, classification, scored, parsed, null);
  }

  private async finalizeReview(
    businessId: string,
    dto: ProcessMessageDto,
    context: EnrichedContext,
    classification: IntentClassificationDto,
    scored: ScoredConfidence,
    route: RoutingDecision,
    parsed: ParsedAiResponse | null,
    startMs: number,
    traceId: string,
  ): Promise<AIDecisionDto> {
    const task = await this.reviewQueue.createReviewTask({
      businessId,
      conversationId: dto.conversationId,
      action: route.action,
      intent: classification.intent,
      urgency: route.urgency,
      draftResponse: parsed?.responseText ?? null,
      suggestedActions: parsed?.suggestedActions ?? [],
      confidence: scored.finalScore,
      reasoning: parsed?.reasoning ?? classification.reasoning,
      correlationId: traceId,
    });

    const usage = this.usageOf(parsed);
    const decision = await this.repository.createDecision({
      business_id: businessId,
      conversation_id: dto.conversationId,
      message_id: dto.messageId,
      task_id: task.id,
      type: AiDecisionType.SEND_MESSAGE,
      outcome: AiDecisionOutcome.SENT_FOR_REVIEW,
      proposed_action: this.proposedAction(classification.intent, parsed, route.action),
      confidence_score: scored.finalScore,
      confidence_breakdown: this.breakdown(classification, scored),
      model_id: usage.modelId,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      latency_ms: Date.now() - startMs,
    });

    // Send the holding / clarifying message to the customer immediately.
    await this.deliver(context, businessId, route.holdingMessage, traceId);

    this.emitResponseGenerated(businessId, dto, decision.id, classification, scored, parsed, traceId);
    this.logger.log(
      `[${traceId}] ${route.action} decision ${decision.id} → task ${task.id} (confidence ${scored.finalScore})`,
    );
    return this.toDto(decision, classification, scored, parsed, task.id);
  }

  private async finalizeEscalation(
    businessId: string,
    dto: ProcessMessageDto,
    context: EnrichedContext,
    classification: IntentClassificationDto,
    scored: ScoredConfidence,
    route: RoutingDecision,
    startMs: number,
    traceId: string,
    generationFailed = false,
    parsed: ParsedAiResponse | null = null,
  ): Promise<AIDecisionDto> {
    const task = await this.reviewQueue.createReviewTask({
      businessId,
      conversationId: dto.conversationId,
      action: 'ESCALATE',
      intent: classification.intent,
      urgency: route.urgency,
      draftResponse: parsed?.responseText ?? null,
      suggestedActions: parsed?.suggestedActions ?? [],
      confidence: scored.finalScore,
      reasoning: parsed?.reasoning ?? classification.reasoning,
      escalationReason: this.escalationReason(scored, generationFailed),
      correlationId: traceId,
    });

    const usage = this.usageOf(parsed);
    const decision = await this.repository.createDecision({
      business_id: businessId,
      conversation_id: dto.conversationId,
      message_id: dto.messageId,
      task_id: task.id,
      type: AiDecisionType.ESCALATE,
      outcome: AiDecisionOutcome.ESCALATED,
      proposed_action: this.proposedAction(classification.intent, parsed, 'ESCALATE'),
      confidence_score: scored.finalScore,
      confidence_breakdown: this.breakdown(classification, scored),
      model_id: usage.modelId,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      latency_ms: Date.now() - startMs,
    });

    const holding = parsed?.holdingMessage ?? route.holdingMessage ?? ESCALATION_HOLDING_MESSAGE;
    await this.deliver(context, businessId, holding, traceId);

    this.eventEmitter.emit('ai.escalated', {
      type: 'ai.escalated',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: traceId,
      conversationId: dto.conversationId,
      reason: this.escalationReason(scored, generationFailed),
    });

    this.logger.log(
      `[${traceId}] ESCALATED decision ${decision.id} → task ${task.id} (confidence ${scored.finalScore})`,
    );
    return this.toDto(decision, classification, scored, parsed, task.id);
  }

  /**
   * Last-resort fallback for when `runPipeline` throws before it can reach a
   * normal escalation (e.g. context loading or a decision write itself
   * failed). Creates a generic, high-urgency HITL task and decision record
   * with whatever we know for certain — businessId/conversationId/messageId
   * from the caller — so the crash still produces an auditable hand-off
   * instead of silently dropping the customer's message.
   *
   * If even this fails (e.g. the DB is fully down), the original error is
   * re-thrown so it isn't swallowed — the caller's own catch (if any) still
   * sees it, and nothing here pretends a decision was recorded when it wasn't.
   */
  private async emergencyEscalate(
    businessId: string,
    dto: ProcessMessageDto,
    traceId: string,
    startMs: number,
    err: unknown,
  ): Promise<AIDecisionDto> {
    const message = err instanceof Error ? err.message : String(err);
    const classification: IntentClassificationDto = {
      intent: IntentType.GENERAL_INQUIRY,
      secondaryIntent: null,
      confidence: 0,
      tier: 1,
      entities: {},
      reasoning: 'AI pipeline crashed before intent could be classified',
    };
    const scored: ScoredConfidence = {
      dataAvailability: 0,
      policyClarity: 0,
      finalScore: 0,
      mode: ConfidenceMode.ESCALATION,
      overrides: [{ code: 'pipeline_error', reason: message, penalty: 0 }],
      requiresEscalation: true,
    };

    try {
      const task = await this.reviewQueue.createReviewTask({
        businessId,
        conversationId: dto.conversationId,
        action: 'ESCALATE',
        intent: classification.intent,
        urgency: 'HIGH',
        draftResponse: null,
        suggestedActions: [],
        confidence: 0,
        reasoning: classification.reasoning,
        escalationReason: `AI pipeline error: ${message}`,
        correlationId: traceId,
      });

      const usage = this.usageOf(null);
      const decision = await this.repository.createDecision({
        business_id: businessId,
        conversation_id: dto.conversationId,
        message_id: dto.messageId,
        task_id: task.id,
        type: AiDecisionType.ESCALATE,
        outcome: AiDecisionOutcome.ESCALATED,
        proposed_action: this.proposedAction(classification.intent, null, 'ESCALATE'),
        confidence_score: 0,
        confidence_breakdown: this.breakdown(classification, scored),
        model_id: usage.modelId,
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        latency_ms: Date.now() - startMs,
      });

      this.eventEmitter.emit('ai.escalated', {
        type: 'ai.escalated',
        id: generateId(),
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: traceId,
        conversationId: dto.conversationId,
        reason: `AI pipeline error: ${message}`,
      });

      this.logger.log(
        `[${traceId}] Emergency-escalated decision ${decision.id} → task ${task.id} after pipeline crash`,
      );
      return this.toDto(decision, classification, scored, null, task.id);
    } catch (fallbackErr) {
      this.logger.error(
        `[${traceId}] Emergency escalation itself failed — message ${dto.messageId} has NO recorded ` +
          `decision or human hand-off: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
      );
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // Standalone public methods
  // ─────────────────────────────────────────────

  /** Classify intent for an arbitrary string (used by analytics/testing). */
  async classifyIntent(_businessId: string, text: string): Promise<IntentClassificationDto> {
    return this.intentClassifier.classify(text);
  }

  /** Score confidence from explicit factors — used to test thresholds. */
  scoreConfidence(_businessId: string, dto: ConfidenceScoringInputDto): ConfidenceScoreDto {
    const safety = dto.text ? this.guardrails.evaluate(dto.text) : undefined;
    const scored = this.confidence.calculate({
      intent: dto.intent,
      data: { ragChunkCount: dto.ragChunkCount, catalogMatch: dto.catalogMatch, clientKnown: dto.clientKnown },
      policy: { policyDefined: dto.policyDefined, policyAmbiguous: dto.policyAmbiguous },
      safety,
      refundAmountPaise: dto.refundAmountPaise,
      maxRefundAmountPaise: dto.maxRefundAmountPaise,
      sentimentScore: dto.sentimentScore,
      repeatedIntentCount: dto.repeatedIntentCount,
    });
    return {
      dataAvailability: scored.dataAvailability,
      policyClarity: scored.policyClarity,
      finalScore: scored.finalScore,
      mode: scored.mode,
      overrides: scored.overrides,
      requiresEscalation: scored.requiresEscalation,
    };
  }

  /** Ingest a business document into the knowledge base. */
  async ingestKnowledgeBase(businessId: string, dto: IngestKnowledgeDto): Promise<IngestResultDto> {
    const entryId = generateId();
    const result = await this.knowledgeIngestion.ingest({
      businessId,
      entryId,
      content: dto.content,
      sourceType: dto.sourceType,
      title: dto.title,
      tags: dto.tags,
      applicableIntents: dto.applicableIntents,
    });

    if (result.chunksIndexed > 0 && result.pointIds[0]) {
      await this.repository.createEmbeddingMetadata({
        business_id: businessId,
        entity_type: this.embeddingEntityType(dto.sourceType),
        entity_id: entryId,
        collection: result.collection,
        qdrant_point_id: result.pointIds[0],
        content_hash: this.embeddings.hash(dto.content),
        model_id: 'text-embedding-3-small',
      });
    }

    this.logger.log(`Ingested knowledge entry ${entryId}: ${result.chunksIndexed} chunk(s)`);
    return { entryId, chunksIndexed: result.chunksIndexed, collection: result.collection };
  }

  /** Remove a knowledge entry's vectors and metadata. */
  async deleteKnowledgeEntry(businessId: string, entryId: string): Promise<void> {
    const meta = await this.repository.findEmbeddingMetadata(businessId, entryId);
    if (!meta) {
      throw new NotFoundException(`Knowledge entry ${entryId} not found`);
    }
    await this.repository.deleteEmbeddingMetadata(businessId, entryId);
    this.logger.log(`Deleted knowledge entry ${entryId}`);
  }

  /** Semantic search over a business's knowledge base. */
  async searchKnowledgeBase(
    businessId: string,
    query: string,
    limit = 5,
  ): Promise<KnowledgeEntryDto[]> {
    const chunks = await this.rag.retrieve(query, businessId, IntentType.GENERAL_INQUIRY, limit);
    return chunks.map((c) => ({
      id: c.id,
      content: c.content,
      similarity: c.score,
      sourceType: c.sourceType,
      tags: [],
    }));
  }

  /** Load a previously persisted decision. */
  async getDraftDecision(businessId: string, decisionId: string): Promise<AIDecisionDto> {
    const decision = await this.repository.findDecisionById(businessId, decisionId);
    if (!decision) {
      throw new NotFoundException(`AI decision ${decisionId} not found`);
    }
    return this.decisionRowToDto(decision);
  }

  /**
   * Paginated list of decisions for a conversation, newest first.
   */
  async listDecisions(
    businessId: string,
    query: ListDecisionsQueryDto,
  ): Promise<{ data: AIDecisionDto[]; total: number; page: number; limit: number }> {
    const result = await this.repository.findDecisionsByConversation(businessId, query.conversationId, {
      page: query.page,
      limit: query.limit,
    });
    return {
      data: result.data.map((d) => this.decisionRowToDto(d)),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  /**
   * Regenerate a draft for a decision. Because `ai_decisions` is immutable,
   * this re-runs the pipeline and produces a NEW decision record. The optional
   * `feedback` is reserved for steering regeneration (logged for now).
   */
  async regenerateDraft(
    businessId: string,
    decisionId: string,
    feedback?: string,
  ): Promise<AIDecisionDto> {
    const decision = await this.repository.findDecisionById(businessId, decisionId);
    if (!decision) {
      throw new NotFoundException(`AI decision ${decisionId} not found`);
    }
    if (feedback) {
      this.logger.log(`Regenerating decision ${decisionId} with reviewer feedback`);
    }
    return this.processMessage(businessId, {
      conversationId: decision.conversation_id,
      messageId: decision.message_id ?? '',
    });
  }

  // ─────────────────────────────────────────────
  // Event handlers
  // ─────────────────────────────────────────────

  /**
   * Trigger processing when a new inbound message is fully resolved. The
   * channel-adapter emits an early `message.received` with empty IDs; we only
   * act once both the conversation and message IDs are present (the
   * conversation module enriches and re-emits). Processing is best-effort and
   * never throws back into the event bus.
   */

  // ─── Confidence thresholds ───

  async getConfidenceThresholds(
    businessId: string,
  ): Promise<{ autoExecute: number; draftReview: number }> {
    try {
      const biz = await this.prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
      const s = (biz.ai_settings ?? {}) as Record<string, unknown>;
      return {
        autoExecute: numberOr(s['autoExecuteThreshold'], DEFAULT_AUTO_EXECUTE_THRESHOLD),
        draftReview: numberOr(s['reviewThreshold'], DEFAULT_DRAFT_REVIEW_THRESHOLD),
      };
    } catch {
      return {
        autoExecute: DEFAULT_AUTO_EXECUTE_THRESHOLD,
        draftReview: DEFAULT_DRAFT_REVIEW_THRESHOLD,
      };
    }
  }

  /**
   * Updates the confidence routing thresholds for a tenant.
   *
   * These two numbers *are* the human-in-the-loop gate. The DTO bounds each to
   * 0–100, but bounds alone are not enough: `autoExecute` below `draftReview`
   * inverts the bands so the review window is empty and everything the model
   * would have drafted for a human is auto-executed instead. Because each
   * field is optional and the other is read from stored settings, the ordering
   * has to be checked against the *merged* result, not the request body.
   */
  async updateConfidenceThresholds(
    businessId: string,
    body: { autoExecute?: number; draftReview?: number },
  ): Promise<{ autoExecute: number; draftReview: number }> {
    const biz = await this.prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
    const s = { ...((biz.ai_settings ?? {}) as Record<string, unknown>) };

    const autoExecute =
      body.autoExecute ?? numberOr(s['autoExecuteThreshold'], DEFAULT_AUTO_EXECUTE_THRESHOLD);
    const draftReview =
      body.draftReview ?? numberOr(s['reviewThreshold'], DEFAULT_DRAFT_REVIEW_THRESHOLD);

    if (autoExecute < draftReview) {
      throw new BadRequestException(
        `autoExecute (${autoExecute}) must be greater than or equal to draftReview ` +
          `(${draftReview}); an inverted pair would auto-execute decisions meant for human review`,
      );
    }

    s['autoExecuteThreshold'] = autoExecute;
    s['reviewThreshold'] = draftReview;

    await this.prisma.businesses.update({
      where: { id: businessId },
      data: { ai_settings: s as Prisma.InputJsonValue },
    });
    return { autoExecute, draftReview };
  }


  @OnEvent('message.received')
  async handleMessageReceived(event: MessageReceivedEvent): Promise<void> {
    // Realty tenants run the grounded realty AI loop instead of this generic
    // pipeline — RealtyMessageBridgeService owns those messages. Skip them here
    // so a message is never processed by both pipelines.
    if (await this.realtyTenants.isRealtyTenant(event.businessId)) {
      this.logger.debug(
        `Skipping generic pipeline for realty tenant ${event.businessId} — handled by the realty loop`,
      );
      return;
    }
    if (!event.conversationId || !event.messageId) {
      this.logger.debug(
        `Skipping message.received ${event.messageId || '(no id)'}: conversation not yet resolved`,
      );
      return;
    }
    try {
      await this.processMessage(event.businessId, {
        conversationId: event.conversationId,
        messageId: event.messageId,
        correlationId: event.correlationId,
      });
    } catch (err) {
      this.logger.error(
        `Pipeline failed for message ${event.messageId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * When a human approves an AI draft, send the (possibly edited) response to
   * the customer via the channel adapter.
   */
  @OnEvent('ai.response.approved')
  async handleResponseApproved(event: AIResponseApprovedEvent): Promise<void> {
    this.logger.log(
      `Draft ${event.aiDecisionId} approved by ${event.approvedByMemberId} (edited=${event.wasEdited}) — delivery handled by HITL/action executor`,
    );
  }

  getStatus(): Record<string, string> {
    return { module: 'AiEngine', status: 'ready' };
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  private rulesOnlyIntent(text: string): IntentClassificationDto {
    const match = this.intentClassifier.classifyByRules(text);
    return {
      intent: match?.intent ?? IntentType.GENERAL_INQUIRY,
      secondaryIntent: null,
      confidence: match?.score ?? 0.5,
      tier: 1,
      entities: {},
      reasoning: 'Rules-only classification (LLM skipped due to safety flag)',
    };
  }

  /** Whether the conversation has executed any action recently (loop guard). */
  private async hasRecentAction(context: EnrichedContext): Promise<boolean> {
    // A simple, dependency-free heuristic: if any recent outbound AI message
    // carried a decision id, an action path has been taken.
    return context.history.some((m) => m.ai_decision_id !== null);
  }

  /**
   * Derive refund / price override inputs from intent entities + policies.
   *
   * The amount is read from the classifier's entity bag when it is present and
   * numeric, and otherwise extracted from the message text directly. That
   * fallback is what makes `REFUND_OVER_LIMIT` reachable at all: Tier-1 keyword
   * rules — which is how virtually every "refund"/"paisa wapas" message
   * resolves — return an empty entity bag, so entities alone left the override
   * permanently dark and let an over-limit refund score into AUTO_PILOT.
   */
  private refundOverrideInputs(
    classification: IntentClassificationDto,
    context: EnrichedContext,
  ): { refundAmountPaise?: number; maxRefundAmountPaise?: number } {
    if (classification.intent !== IntentType.REFUND) return {};
    const entityAmount = classification.entities['amountPaise'];
    const amount =
      typeof entityAmount === 'number' && Number.isFinite(entityAmount) && entityAmount > 0
        ? entityAmount
        : (extractAmountPaise(context.messageText) ?? undefined);
    const aiSettings = (context.business?.ai_settings as Record<string, unknown> | null) ?? {};
    const max = aiSettings['maxAutoRefundPaise'];
    return {
      refundAmountPaise: amount,
      maxRefundAmountPaise: typeof max === 'number' ? max : undefined,
    };
  }

  /** Best-effort outbound delivery of a customer-facing message. */
  private async deliver(
    context: EnrichedContext,
    businessId: string,
    text: string | null,
    traceId: string,
  ): Promise<void> {
    if (!text || !context.channel || !context.channelAccountId || !context.recipientExternalId) {
      this.logger.debug(`[${traceId}] Delivery deferred — missing channel/recipient context`);
      return;
    }
    const outbound: OutboundMessage = {
      channelAccountId: context.channelAccountId,
      recipientExternalId: context.recipientExternalId,
      content: { type: MessageContentType.TEXT, text },
      correlationId: traceId,
    };
    try {
      await this.channelAdapter.sendMessage(context.channel as ChannelType, outbound, businessId, traceId);
    } catch (err) {
      this.logger.warn(
        `[${traceId}] Outbound delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private emitIntentClassified(
    businessId: string,
    dto: ProcessMessageDto,
    classification: IntentClassificationDto,
    traceId: string,
  ): void {
    const event: AIIntentClassifiedEvent = {
      type: 'ai.intent.classified',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: traceId,
      conversationId: dto.conversationId,
      messageId: dto.messageId,
      intent: classification.intent,
      confidence: classification.confidence,
      alternativeIntents: classification.secondaryIntent
        ? [{ intent: classification.secondaryIntent, confidence: classification.confidence }]
        : [],
    };
    this.eventEmitter.emit('ai.intent.classified', event);
  }

  private emitResponseGenerated(
    businessId: string,
    dto: ProcessMessageDto,
    decisionId: string,
    classification: IntentClassificationDto,
    scored: ScoredConfidence,
    parsed: ParsedAiResponse | null,
    traceId: string,
  ): void {
    const event: AIResponseGeneratedEvent = {
      type: 'ai.response.generated',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: traceId,
      conversationId: dto.conversationId,
      messageId: dto.messageId,
      aiDecisionId: decisionId,
      intent: classification.intent,
      confidenceScore: {
        dataAvailability: scored.dataAvailability,
        policyClarity: scored.policyClarity,
        finalScore: scored.finalScore,
        mode: scored.mode,
        overrides: scored.overrides,
      },
      suggestedActions: parsed?.suggestedActions ?? [],
      modelId: this.usageOf(parsed).modelId ?? 'none',
      latencyMs: this.usageOf(parsed).latencyMs ?? 0,
    };
    this.eventEmitter.emit('ai.response.generated', event);
  }

  private proposedAction(
    intent: IntentType,
    parsed: ParsedAiResponse | null,
    route: string,
  ): Prisma.InputJsonValue {
    return {
      intent,
      route,
      responseText: parsed?.responseText ?? null,
      reasoning: parsed?.reasoning ?? '',
      suggestedActions: (parsed?.suggestedActions ?? []) as unknown as Prisma.InputJsonValue,
    };
  }

  private breakdown(
    classification: IntentClassificationDto,
    scored: ScoredConfidence,
  ): Prisma.InputJsonValue {
    return {
      dataAvailability: scored.dataAvailability,
      policyClarity: scored.policyClarity,
      finalScore: scored.finalScore,
      mode: scored.mode,
      intentTier: classification.tier,
      overrides: scored.overrides as unknown as Prisma.InputJsonValue,
    };
  }

  private usageOf(parsed: ParsedAiResponse | null): {
    modelId: string | null;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  } {
    const usage = (parsed as (ParsedAiResponse & { _usage?: Record<string, unknown> }) | null)?._usage;
    return {
      modelId: typeof usage?.['modelId'] === 'string' ? (usage['modelId'] as string) : null,
      promptTokens: typeof usage?.['promptTokens'] === 'number' ? (usage['promptTokens'] as number) : 0,
      completionTokens: typeof usage?.['completionTokens'] === 'number' ? (usage['completionTokens'] as number) : 0,
      latencyMs: typeof usage?.['latencyMs'] === 'number' ? (usage['latencyMs'] as number) : 0,
    };
  }

  private escalationReason(scored: ScoredConfidence, generationFailed: boolean): string {
    if (generationFailed) return 'AI could not generate a valid response — handed to a human';
    if (scored.overrides.length > 0) return scored.overrides.map((o) => o.reason).join('; ');
    return `Low confidence (${scored.finalScore}) — human review required`;
  }

  private embeddingEntityType(sourceType: string): EmbeddingEntityType {
    return sourceType.toUpperCase().includes('FAQ')
      ? EmbeddingEntityType.FAQ
      : EmbeddingEntityType.DOCUMENT;
  }

  private confidenceDto(scored: ScoredConfidence): ConfidenceScoreDto {
    return {
      finalScore: scored.finalScore,
      mode: scored.mode,
      dataAvailability: scored.dataAvailability,
      policyClarity: scored.policyClarity,
      overrides: scored.overrides,
      requiresEscalation: scored.requiresEscalation,
    };
  }

  private toDto(
    decision: ai_decisions,
    classification: IntentClassificationDto,
    scored: ScoredConfidence,
    parsed: ParsedAiResponse | null,
    taskId: string | null,
  ): AIDecisionDto {
    const usage = this.usageOf(parsed);
    return {
      id: decision.id,
      conversationId: decision.conversation_id,
      messageId: decision.message_id,
      type: decision.type,
      outcome: decision.outcome,
      intent: classification.intent,
      responseText: parsed?.responseText ?? null,
      confidence: this.confidenceDto(scored),
      suggestedActions: parsed?.suggestedActions ?? [],
      reasoning: parsed?.reasoning ?? classification.reasoning,
      taskId,
      holdingMessage: parsed?.holdingMessage ?? null,
      modelId: usage.modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      latencyMs: decision.latency_ms ?? 0,
      decidedAt: decision.decided_at,
      executedAt: decision.executed_at,
    };
  }

  /** Map a stored decision row back into a DTO (without re-deriving parsed). */
  private decisionRowToDto(decision: ai_decisions): AIDecisionDto {
    const action = (decision.proposed_action as Record<string, unknown>) ?? {};
    const breakdown = (decision.confidence_breakdown as Record<string, unknown>) ?? {};
    return {
      id: decision.id,
      conversationId: decision.conversation_id,
      messageId: decision.message_id,
      type: decision.type,
      outcome: decision.outcome,
      intent: (action['intent'] as IntentType) ?? IntentType.GENERAL_INQUIRY,
      responseText: typeof action['responseText'] === 'string' ? (action['responseText'] as string) : null,
      confidence: {
        finalScore: Number(decision.confidence_score),
        mode: (breakdown['mode'] as ConfidenceMode) ?? ConfidenceMode.ESCALATION,
        dataAvailability: typeof breakdown['dataAvailability'] === 'number' ? (breakdown['dataAvailability'] as number) : 0,
        policyClarity: typeof breakdown['policyClarity'] === 'number' ? (breakdown['policyClarity'] as number) : 0,
        overrides: Array.isArray(breakdown['overrides'])
          ? (breakdown['overrides'] as ConfidenceScoreDto['overrides'])
          : [],
        requiresEscalation: decision.outcome === AiDecisionOutcome.ESCALATED,
      },
      suggestedActions: Array.isArray(action['suggestedActions'])
        ? (action['suggestedActions'] as SuggestedAction[])
        : [],
      reasoning: typeof action['reasoning'] === 'string' ? (action['reasoning'] as string) : '',
      taskId: decision.task_id,
      holdingMessage: null,
      modelId: decision.model_id,
      promptTokens: decision.prompt_tokens ?? 0,
      completionTokens: decision.completion_tokens ?? 0,
      latencyMs: decision.latency_ms ?? 0,
      decidedAt: decision.decided_at,
      executedAt: decision.executed_at,
    };
  }
}

/**
 * Read a stored confidence threshold out of the tenant's `ai_settings` JSON.
 *
 * The column is untyped JSON, so a value written by an older build (or by hand)
 * may be a string, null, or missing entirely. Anything that is not a number
 * falls back to the default rather than silently flowing into the routing
 * comparison as `NaN` or a string.
 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
