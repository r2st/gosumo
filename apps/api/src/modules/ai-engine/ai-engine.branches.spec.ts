/**
 * Branch-coverage suite for AiEngineService.
 *
 * `ai-engine.service.spec.ts` exercises the pipeline through the *real*
 * confidence calculator, router and guardrails, which is the right shape for
 * behavioural tests but leaves the rare combinations unreachable (a DRAFT band
 * reached with no parsed response, an AUTO_EXECUTE route with a null holding
 * message, generation failures of every flavour).
 *
 * Here every collaborator is a stub so each conditional edge can be dialled in
 * directly: generation/validation failures, self-escalation, the emergency
 * fallback, and the `message.received` guards.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChannelType, IntentType } from '@gosumo/shared';
import type { MessageReceivedEvent } from '@gosumo/shared';

import { AiEngineService } from './ai-engine.service';
import { ContextLoaderService, EnrichedContext } from './pipeline/context-loader.service';
import { IntentClassifierService } from './pipeline/intent-classifier.service';
import { RagRetrieverService } from './rag/rag-retriever.service';
import { PromptAssemblerService } from './pipeline/prompt-assembler.service';
import { LlmClientService, LlmUnavailableError } from './pipeline/llm-client.service';
import {
  ResponseParserService,
  ParsedAiResponse,
} from './pipeline/response-parser.service';
import {
  ConfidenceCalculatorService,
  ScoredConfidence,
} from './pipeline/confidence-calculator.service';
import {
  ActionRouterService,
  RoutingDecision,
} from './pipeline/action-router.service';
import { GuardrailsService, SafetySignals } from './safety/guardrails.service';
import { ReviewQueueService } from './hitl/review-queue.service';
import { KnowledgeIngestionService } from './rag/knowledge-ingestion.service';
import { EmbeddingService } from './rag/embedding.service';
import { AiEngineRepository } from './ai-engine.repository';
import { ChannelAdapterService } from '../channel-adapter/channel-adapter.service';
import { RealtyTenantService } from './realty/realty-tenant.service';
import { PrismaService } from '../../common/services/prisma.service';
import { ConfidenceMode } from '@gosumo/shared';

const dto = { conversationId: 'c1', messageId: 'm1' };

function makeContext(overrides: Partial<EnrichedContext> = {}): EnrichedContext {
  return {
    conversation: { id: 'c1', client_id: 'cl1' } as never,
    triggerMessage: { id: 'm1', ai_decision_id: null } as never,
    history: [],
    business: { name: 'Priya Salon', ai_settings: {} } as never,
    client: null,
    businessRules: [],
    messageText: 'kal 3 baje slot hai?',
    channel: ChannelType.WHATSAPP,
    channelAccountId: 'acc1',
    recipientExternalId: '919999900001',
    ...overrides,
  } as EnrichedContext;
}

function safety(overrides: Partial<SafetySignals> = {}): SafetySignals {
  return {
    jailbreakDetected: false,
    legalThreatDetected: false,
    humanRequested: false,
    loopDetected: false,
    pii: { hasPii: false, detected: [], redactedText: '' },
    ...overrides,
  };
}

function scored(overrides: Partial<ScoredConfidence> = {}): ScoredConfidence {
  return {
    dataAvailability: 0.9,
    policyClarity: 0.9,
    finalScore: 0.9,
    mode: ConfidenceMode.AUTO_PILOT,
    overrides: [],
    requiresEscalation: false,
    ...overrides,
  } as ScoredConfidence;
}

function route(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    action: 'AUTO_EXECUTE',
    holdingMessage: null,
    urgency: 'LOW',
    ...overrides,
  } as RoutingDecision;
}

function parsedResponse(overrides: Partial<ParsedAiResponse> = {}): ParsedAiResponse {
  return {
    responseText: 'Ji haan, kal 3 baje slot available hai.',
    intent: IntentType.BOOKING,
    reasoning: 'slot lookup succeeded',
    suggestedActions: [],
    profileUpdates: {},
    requiresEscalation: false,
    escalationReason: null,
    urgency: null,
    holdingMessage: null,
    jailbreakDetected: false,
    piiDetected: false,
    languageUsed: 'hi',
    ...overrides,
  };
}

function makeHarness() {
  const load = jest.fn().mockResolvedValue(makeContext());
  const contextLoader = { load } as unknown as ContextLoaderService;

  const classify = jest.fn().mockResolvedValue({
    intent: IntentType.BOOKING,
    secondaryIntent: null,
    confidence: 0.9,
    tier: 2,
    entities: {},
    reasoning: 'tier-2 classification',
  });
  const classifyByRules = jest.fn().mockReturnValue(null);
  const intentClassifier = {
    classify,
    classifyByRules,
  } as unknown as IntentClassifierService;

  const retrieve = jest.fn().mockResolvedValue([]);
  const rag = {
    retrieve,
    formatForPrompt: jest.fn().mockReturnValue('rag context'),
  } as unknown as RagRetrieverService;

  const promptAssembler = {
    assembleSystemPrompt: jest.fn().mockReturnValue('system'),
    assembleUserPrompt: jest.fn().mockReturnValue('user'),
  } as unknown as PromptAssemblerService;

  const complete = jest.fn().mockResolvedValue({
    text: '{}',
    modelId: 'openai/gpt-oss-20b:free',
    promptTokens: 40,
    completionTokens: 12,
    latencyMs: 33,
  });
  const llm = { complete } as unknown as LlmClientService;

  const parse = jest.fn().mockReturnValue(parsedResponse());
  const validate = jest.fn().mockReturnValue({ valid: true, failures: [] });
  const responseParser = { parse, validate } as unknown as ResponseParserService;

  const calculate = jest.fn().mockReturnValue(scored());
  const confidence = { calculate } as unknown as ConfidenceCalculatorService;

  const routeFn = jest.fn().mockReturnValue(route());
  const router = { route: routeFn } as unknown as ActionRouterService;

  const evaluate = jest.fn().mockReturnValue(safety());
  const guardrails = { evaluate } as unknown as GuardrailsService;

  const createReviewTask = jest.fn().mockResolvedValue({ id: 'task-1' });
  const reviewQueue = { createReviewTask } as unknown as ReviewQueueService;

  const createDecision = jest.fn().mockImplementation((d: Record<string, unknown>) => ({
    id: 'dec-1',
    conversation_id: d['conversation_id'],
    message_id: d['message_id'] ?? null,
    task_id: d['task_id'] ?? null,
    type: d['type'],
    outcome: d['outcome'],
    confidence_score: d['confidence_score'],
    confidence_breakdown: d['confidence_breakdown'],
    proposed_action: d['proposed_action'],
    model_id: d['model_id'] ?? null,
    prompt_tokens: d['prompt_tokens'] ?? null,
    completion_tokens: d['completion_tokens'] ?? null,
    latency_ms: null,
    decided_at: new Date('2026-06-27T00:00:00Z'),
    executed_at: d['executed_at'] ?? null,
  }));
  const getRecentIntents = jest.fn().mockResolvedValue([]);
  const repository = {
    getRecentIntents,
    createDecision,
    findDecisionById: jest.fn().mockResolvedValue(null),
    findDecisionsByConversation: jest.fn(),
    createEmbeddingMetadata: jest.fn(),
    findEmbeddingMetadata: jest.fn(),
    deleteEmbeddingMetadata: jest.fn(),
  } as unknown as AiEngineRepository;

  const sendMessage = jest.fn().mockResolvedValue({ success: true });
  const channelAdapter = { sendMessage } as unknown as ChannelAdapterService;

  const emit = jest.fn();
  const eventEmitter = { emit } as unknown as EventEmitter2;

  const isRealtyTenant = jest.fn().mockResolvedValue(false);
  const realtyTenants = { isRealtyTenant } as unknown as RealtyTenantService;

  const prisma = { businesses: {} } as unknown as PrismaService;

  const service = new AiEngineService(
    prisma,
    contextLoader,
    intentClassifier,
    rag,
    promptAssembler,
    llm,
    responseParser,
    confidence,
    router,
    guardrails,
    reviewQueue,
    { ingest: jest.fn() } as unknown as KnowledgeIngestionService,
    { hash: jest.fn() } as unknown as EmbeddingService,
    repository,
    channelAdapter,
    eventEmitter,
    realtyTenants,
  );

  return {
    service,
    load,
    classify,
    classifyByRules,
    retrieve,
    complete,
    parse,
    validate,
    calculate,
    routeFn,
    evaluate,
    createReviewTask,
    createDecision,
    getRecentIntents,
    sendMessage,
    emit,
    isRealtyTenant,
  };
}

describe('AiEngineService — generation failures', () => {
  it('escalates when the response cannot be parsed', async () => {
    const h = makeHarness();
    h.parse.mockReturnValue(null);

    const result = await h.service.processMessage('b1', dto);

    expect(result.outcome).toBe('ESCALATED');
    expect(h.createReviewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ESCALATE',
        escalationReason: 'AI could not generate a valid response — handed to a human',
      }),
    );
  });

  it('escalates when the parsed response fails validation', async () => {
    const h = makeHarness();
    h.validate.mockReturnValue({ valid: false, failures: ['response_text empty'] });

    const result = await h.service.processMessage('b1', dto);

    expect(result.outcome).toBe('ESCALATED');
    expect(result.responseText).toBeNull();
  });

  it('escalates when the LLM is unavailable', async () => {
    const h = makeHarness();
    h.complete.mockRejectedValue(new LlmUnavailableError('all providers down'));

    const result = await h.service.processMessage('b1', dto);

    expect(result.outcome).toBe('ESCALATED');
  });

  it('escalates on a generic generation error', async () => {
    const h = makeHarness();
    h.complete.mockRejectedValue(new Error('socket hang up'));

    await expect(h.service.processMessage('b1', dto)).resolves.toMatchObject({
      outcome: 'ESCALATED',
    });
  });

  it('escalates when a non-Error escapes generation', async () => {
    const h = makeHarness();
    h.complete.mockRejectedValue('kaboom');

    await expect(h.service.processMessage('b1', dto)).resolves.toMatchObject({
      outcome: 'ESCALATED',
    });
  });

  it('reports the confidence overrides as the escalation reason when generation succeeded', async () => {
    const h = makeHarness();
    h.calculate.mockReturnValue(
      scored({
        finalScore: 0.2,
        mode: ConfidenceMode.ESCALATION,
        requiresEscalation: true,
        overrides: [{ code: 'legal_threat', reason: 'Legal threat detected', penalty: 1 }],
      }),
    );
    h.routeFn.mockReturnValue(route({ action: 'ESCALATE', holdingMessage: 'Ek minute…' }));

    await h.service.processMessage('b1', dto);

    expect(h.createReviewTask).toHaveBeenCalledWith(
      expect.objectContaining({ escalationReason: 'Legal threat detected' }),
    );
  });

  it('falls back to the low-confidence reason when nothing else explains it', async () => {
    const h = makeHarness();
    h.calculate.mockReturnValue(scored({ finalScore: 0.4, mode: ConfidenceMode.ESCALATION }));
    h.routeFn.mockReturnValue(route({ action: 'ESCALATE', holdingMessage: 'Ek minute…' }));

    await h.service.processMessage('b1', dto);

    expect(h.createReviewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        escalationReason: 'Low confidence (0.4) — human review required',
      }),
    );
  });
});

describe('AiEngineService — routing edges', () => {
  it('honours the model self-escalating out of the AUTO_PILOT band', async () => {
    const h = makeHarness();
    h.parse.mockReturnValue(
      parsedResponse({ requiresEscalation: true, holdingMessage: 'Team se check karke bataata hoon' }),
    );

    const result = await h.service.processMessage('b1', dto);

    expect(result.outcome).toBe('ESCALATED');
    // The model's own holding message wins over the route's.
    expect(h.sendMessage).toHaveBeenCalledWith(
      ChannelType.WHATSAPP,
      expect.objectContaining({
        content: expect.objectContaining({ text: 'Team se check karke bataata hoon' }),
      }),
      'b1',
      expect.any(String),
    );
  });

  it('uses the canned holding message when neither the model nor the route supplies one', async () => {
    const h = makeHarness();
    // Jailbreak → no generation at all, but the route still says AUTO_EXECUTE,
    // which has a null holding message.
    h.evaluate.mockReturnValue(safety({ jailbreakDetected: true }));
    h.classifyByRules.mockReturnValue({ intent: IntentType.COMPLAINT, score: 0.8 });

    const result = await h.service.processMessage('b1', dto);

    expect(result.outcome).toBe('ESCALATED');
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    const [, outbound] = h.sendMessage.mock.calls[0]!;
    expect(typeof outbound.content.text).toBe('string');
    expect(outbound.content.text.length).toBeGreaterThan(0);
  });

  it('falls back to GENERAL_INQUIRY when no rule matches a jailbreak attempt', async () => {
    const h = makeHarness();
    h.evaluate.mockReturnValue(safety({ jailbreakDetected: true }));
    h.classifyByRules.mockReturnValue(null);

    const result = await h.service.processMessage('b1', dto);

    expect(result.intent).toBe(IntentType.GENERAL_INQUIRY);
    expect(h.classify).not.toHaveBeenCalled();
  });

  it('drafts for review with no generated text when generation was skipped', async () => {
    const h = makeHarness();
    h.evaluate.mockReturnValue(safety({ jailbreakDetected: true }));
    h.routeFn.mockReturnValue(
      route({ action: 'DRAFT_REVIEW', holdingMessage: 'Ek minute, check kar raha hoon' }),
    );

    const result = await h.service.processMessage('b1', dto);

    expect(result.outcome).toBe('SENT_FOR_REVIEW');
    expect(result.responseText).toBeNull();
    expect(result.suggestedActions).toEqual([]);
    expect(h.createReviewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        draftResponse: null,
        suggestedActions: [],
        // Falls back to the classifier's reasoning when there is no draft.
        reasoning: 'Rules-only classification (LLM skipped due to safety flag)',
      }),
    );
    expect(h.emit).toHaveBeenCalledWith(
      'ai.response.generated',
      expect.objectContaining({ modelId: 'none', latencyMs: 0, suggestedActions: [] }),
    );
  });

  it('routes the GUIDED band through the review queue', async () => {
    const h = makeHarness();
    h.routeFn.mockReturnValue(
      route({ action: 'GUIDED', holdingMessage: 'Thoda time dijiye' }),
    );

    const result = await h.service.processMessage('b1', dto);

    expect(result.outcome).toBe('SENT_FOR_REVIEW');
    expect(h.createReviewTask).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'GUIDED' }),
    );
  });

  it('defaults a missing decision latency to zero', async () => {
    const h = makeHarness();

    const result = await h.service.processMessage('b1', dto);

    expect(result.outcome).toBe('AUTO_EXECUTED');
    expect(result.latencyMs).toBe(0);
  });

  it('publishes the secondary intent as an alternative', async () => {
    const h = makeHarness();
    h.classify.mockResolvedValue({
      intent: IntentType.BOOKING,
      secondaryIntent: IntentType.PRICING,
      confidence: 0.72,
      tier: 2,
      entities: {},
      reasoning: 'two plausible intents',
    });

    await h.service.processMessage('b1', dto);

    expect(h.emit).toHaveBeenCalledWith(
      'ai.intent.classified',
      expect.objectContaining({
        alternativeIntents: [{ intent: IntentType.PRICING, confidence: 0.72 }],
      }),
    );
  });
});

describe('AiEngineService — refund override inputs', () => {
  it('feeds the refund amount and the tenant cap into the confidence calculator', async () => {
    const h = makeHarness();
    h.classify.mockResolvedValue({
      intent: IntentType.REFUND,
      secondaryIntent: null,
      confidence: 0.8,
      tier: 2,
      entities: { amountPaise: 250_000 },
      reasoning: 'refund request',
    });
    h.load.mockResolvedValue(
      makeContext({
        business: { name: 'Priya Salon', ai_settings: { maxAutoRefundPaise: 100_000 } } as never,
      }),
    );

    await h.service.processMessage('b1', dto);

    expect(h.calculate).toHaveBeenCalledWith(
      expect.objectContaining({
        refundAmountPaise: 250_000,
        maxRefundAmountPaise: 100_000,
      }),
    );
  });

  it('leaves both bounds undefined when the entity and the policy are absent', async () => {
    const h = makeHarness();
    h.classify.mockResolvedValue({
      intent: IntentType.REFUND,
      secondaryIntent: null,
      confidence: 0.8,
      tier: 2,
      entities: { amountPaise: 'two thousand rupees' },
      reasoning: 'refund request',
    });
    h.load.mockResolvedValue(makeContext({ business: null as never }));

    await h.service.processMessage('b1', dto);

    expect(h.calculate).toHaveBeenCalledWith(
      expect.objectContaining({
        refundAmountPaise: undefined,
        maxRefundAmountPaise: undefined,
      }),
    );
  });

  it('passes no refund inputs at all for a non-refund intent', async () => {
    const h = makeHarness();

    await h.service.processMessage('b1', dto);

    const [input] = h.calculate.mock.calls[0]!;
    expect(input).not.toHaveProperty('refundAmountPaise');
  });
});

describe('AiEngineService — emergency escalation', () => {
  it('records a hand-off when the pipeline crashes before a decision', async () => {
    const h = makeHarness();
    h.load.mockRejectedValue(new Error('context loader exploded'));

    const result = await h.service.processMessage('b1', dto);

    expect(result.outcome).toBe('ESCALATED');
    expect(result.intent).toBe(IntentType.GENERAL_INQUIRY);
    expect(h.createReviewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        urgency: 'HIGH',
        escalationReason: 'AI pipeline error: context loader exploded',
      }),
    );
  });

  it('stringifies a non-Error crash', async () => {
    const h = makeHarness();
    h.load.mockRejectedValue('context loader vanished');

    const result = await h.service.processMessage('b1', dto);

    expect(h.createReviewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        escalationReason: 'AI pipeline error: context loader vanished',
      }),
    );
    expect(result.confidence.finalScore).toBe(0);
  });

  it('re-throws the original error when the emergency hand-off itself fails', async () => {
    const h = makeHarness();
    const original = new Error('database is gone');
    h.load.mockRejectedValue(original);
    h.createReviewTask.mockRejectedValue(new Error('task queue is gone too'));

    await expect(h.service.processMessage('b1', dto)).rejects.toThrow(original);
  });

  it('re-throws when a non-Error breaks the emergency hand-off', async () => {
    const h = makeHarness();
    h.load.mockRejectedValue(new Error('database is gone'));
    h.createReviewTask.mockRejectedValue('task queue is gone too');

    await expect(h.service.processMessage('b1', dto)).rejects.toThrow('database is gone');
  });

  it('tolerates the recent-intent lookup failing', async () => {
    const h = makeHarness();
    h.getRecentIntents.mockRejectedValue(new Error('redis timeout'));

    await expect(h.service.processMessage('b1', dto)).resolves.toMatchObject({
      outcome: 'AUTO_EXECUTED',
    });
  });
});

describe('AiEngineService — message.received guard', () => {
  const baseEvent = {
    type: 'message.received',
    id: 'evt-1',
    timestamp: '2026-06-27T00:00:00.000Z',
    businessId: 'b1',
    correlationId: 'corr-1',
    conversationId: 'c1',
    messageId: 'm1',
  } as unknown as MessageReceivedEvent;

  it('skips realty tenants — the realty bridge owns those messages', async () => {
    const h = makeHarness();
    h.isRealtyTenant.mockResolvedValue(true);

    await h.service.handleMessageReceived(baseEvent);

    expect(h.load).not.toHaveBeenCalled();
  });

  it('skips a message whose conversation is not resolved yet', async () => {
    const h = makeHarness();

    await h.service.handleMessageReceived({
      ...baseEvent,
      conversationId: undefined,
    } as unknown as MessageReceivedEvent);

    expect(h.load).not.toHaveBeenCalled();
  });

  it('skips a message with no id at all', async () => {
    const h = makeHarness();

    await h.service.handleMessageReceived({
      ...baseEvent,
      messageId: undefined,
    } as unknown as MessageReceivedEvent);

    expect(h.load).not.toHaveBeenCalled();
  });

  it('swallows a rethrown pipeline error so the event bus keeps running', async () => {
    const h = makeHarness();
    h.load.mockRejectedValue(new Error('total outage'));
    h.createReviewTask.mockRejectedValue(new Error('and the queue too'));

    await expect(h.service.handleMessageReceived(baseEvent)).resolves.toBeUndefined();
  });

  it('swallows a rethrown non-Error', async () => {
    const h = makeHarness();
    h.load.mockRejectedValue('total outage');
    h.createReviewTask.mockRejectedValue(new Error('and the queue too'));

    await expect(h.service.handleMessageReceived(baseEvent)).resolves.toBeUndefined();
  });

  it('processes an ordinary message end-to-end', async () => {
    const h = makeHarness();

    await h.service.handleMessageReceived(baseEvent);

    expect(h.load).toHaveBeenCalledWith('b1', 'c1', 'm1');
  });
});

describe('AiEngineService — delivery guards', () => {
  it('defers delivery when the channel context is incomplete', async () => {
    const h = makeHarness();
    h.load.mockResolvedValue(makeContext({ channelAccountId: null as never }));

    await h.service.processMessage('b1', dto);

    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('defers delivery when there is no recipient', async () => {
    const h = makeHarness();
    h.load.mockResolvedValue(makeContext({ recipientExternalId: null as never }));

    await h.service.processMessage('b1', dto);

    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('never lets an outbound failure break the decision', async () => {
    const h = makeHarness();
    h.sendMessage.mockRejectedValue(new Error('channel offline'));

    await expect(h.service.processMessage('b1', dto)).resolves.toMatchObject({
      outcome: 'AUTO_EXECUTED',
    });
  });

  it('never lets a non-Error outbound failure break the decision', async () => {
    const h = makeHarness();
    h.sendMessage.mockRejectedValue('channel offline');

    await expect(h.service.processMessage('b1', dto)).resolves.toMatchObject({
      outcome: 'AUTO_EXECUTED',
    });
  });

  it('marks a conversation with a prior AI decision as having executed an action', async () => {
    const h = makeHarness();
    h.load.mockResolvedValue(
      makeContext({ history: [{ ai_decision_id: 'dec-0' }] as never }),
    );

    await h.service.processMessage('b1', dto);

    expect(h.evaluate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ actionsExecuted: true }),
    );
  });

  it('tolerates a RAG retrieval failure', async () => {
    const h = makeHarness();
    h.retrieve.mockRejectedValue(new Error('qdrant unreachable'));

    await expect(h.service.processMessage('b1', dto)).resolves.toMatchObject({
      outcome: 'AUTO_EXECUTED',
    });
  });
});
