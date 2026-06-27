import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ConfidenceMode,
  ConfidenceScore,
  SuggestedAction,
  IntentType,
  generateId,
  generateCorrelationId,
  AIResponseGeneratedEvent,
} from '@gosumo/shared';
import { AiDecisionType, AiDecisionOutcome } from '@gosumo/database';
import { AiEngineRepository } from '../ai-engine.repository';
import {
  HOLDING_MESSAGES,
  DEFAULT_HOLDING_MESSAGE,
  ESCALATION_HOLDING_MESSAGE,
  OVERRIDE,
} from '../ai-engine.constants';
import type { AISettings } from './context-loader';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface RouteResult {
  outcome: 'AUTO_EXECUTED' | 'SENT_FOR_REVIEW' | 'ESCALATED';
  holdingMessage: string | null;
  decisionId: string;
}

export interface RouteParams {
  businessId: string;
  conversationId: string;
  messageId: string | null;
  intent: IntentType;
  confidenceScore: ConfidenceScore;
  responseText: string | null;
  reasoning: string;
  suggestedActions: SuggestedAction[];
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  aiSettings: AISettings;
}

// ─────────────────────────────────────────────
// Intent → AiDecisionType mapping
// ─────────────────────────────────────────────

const INTENT_TO_DECISION_TYPE: Record<IntentType, AiDecisionType> = {
  [IntentType.ORDER]: AiDecisionType.CREATE_ORDER,
  [IntentType.REFUND]: AiDecisionType.PROCESS_REFUND,
  [IntentType.BOOKING]: AiDecisionType.CREATE_BOOKING,
  [IntentType.CANCELLATION]: AiDecisionType.CANCEL_BOOKING,
  [IntentType.PAYMENT]: AiDecisionType.COLLECT_PAYMENT,
  [IntentType.PRICING]: AiDecisionType.SHARE_CATALOG,
  [IntentType.COMPLAINT]: AiDecisionType.SEND_MESSAGE,
  [IntentType.GENERAL_INQUIRY]: AiDecisionType.SEND_MESSAGE,
  [IntentType.CHIT_CHAT]: AiDecisionType.SEND_MESSAGE,
  [IntentType.FOLLOW_UP]: AiDecisionType.SEND_MESSAGE,
  [IntentType.PROMOTION_RESPONSE]: AiDecisionType.SEND_MESSAGE,
  [IntentType.ORDER_TRACKING]: AiDecisionType.SEND_MESSAGE,
  [IntentType.RETURNS]: AiDecisionType.SEND_MESSAGE,
};

// ─────────────────────────────────────────────
// Escalation override codes — any override whose constant has `escalate: true`
// forces the ESCALATED path regardless of the numeric score.
// ─────────────────────────────────────────────

const ESCALATION_OVERRIDE_CODES = new Set<string>(
  (Object.values(OVERRIDE) as ReadonlyArray<{ code: string; escalate: boolean }>)
    .filter((o) => o.escalate)
    .map((o) => o.code),
);

// ─────────────────────────────────────────────
// Proposed action payload shape (stored as JSONB)
// ─────────────────────────────────────────────

interface ProposedAction {
  actionType: AiDecisionType;
  responseText: string | null;
  reasoning: string;
  suggestedActions: SuggestedAction[];
  alternativesConsidered: SuggestedAction[];
}

// ─────────────────────────────────────────────
// Confidence breakdown payload shape (stored as JSONB)
// ─────────────────────────────────────────────

interface ConfidenceBreakdown {
  dataAvailability: number;
  policyClarity: number;
  finalScore: number;
  mode: ConfidenceMode;
  overrides: ConfidenceScore['overrides'];
}

// ─────────────────────────────────────────────
// Auto-executed event payload (not a typed domain event)
// ─────────────────────────────────────────────

interface AutoExecutedPayload {
  businessId: string;
  conversationId: string;
  decisionId: string;
  action: ProposedAction;
}

// ─────────────────────────────────────────────
// Escalated event payload
// ─────────────────────────────────────────────

interface EscalatedPayload {
  businessId: string;
  conversationId: string;
  reason: string;
}

/**
 * ActionRouterService — persists an AI decision to the immutable audit trail
 * and emits the appropriate domain event based on the confidence score band.
 *
 * Routing bands (configurable per business via `AISettings`):
 *
 *   ≥ autoExecuteThreshold (default 0.90)  → AUTO_EXECUTED
 *   ≥ reviewThreshold      (default 0.70)  → SENT_FOR_REVIEW
 *   < reviewThreshold                      → ESCALATED
 *
 * Any active override with `escalate: true` forces the ESCALATED path
 * regardless of the numeric score.
 */
@Injectable()
export class ActionRouterService {
  private readonly logger = new Logger(ActionRouterService.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly repository: AiEngineRepository,
  ) {}

  async route(params: RouteParams): Promise<RouteResult> {
    const {
      businessId,
      conversationId,
      messageId,
      intent,
      confidenceScore,
      responseText,
      reasoning,
      suggestedActions,
      modelId,
      promptTokens,
      completionTokens,
      latencyMs,
      aiSettings,
    } = params;

    // ── 1. Determine the routing outcome ──────────
    const outcome = this.determineOutcome(confidenceScore, aiSettings);

    // ── 2. Resolve the decision type ──────────────
    const decisionType =
      outcome === 'ESCALATED'
        ? AiDecisionType.ESCALATE
        : (INTENT_TO_DECISION_TYPE[intent] ?? AiDecisionType.SEND_MESSAGE);

    // ── 3. Build JSONB payloads ───────────────────
    const proposedAction: ProposedAction = {
      actionType: decisionType,
      responseText,
      reasoning,
      suggestedActions,
      alternativesConsidered: [],
    };

    const confidenceBreakdown: ConfidenceBreakdown = {
      dataAvailability: confidenceScore.dataAvailability,
      policyClarity: confidenceScore.policyClarity,
      finalScore: confidenceScore.finalScore,
      mode: confidenceScore.mode,
      overrides: confidenceScore.overrides,
    };

    // ── 4. Persist the ai_decisions record ────────
    const decisionOutcome: AiDecisionOutcome =
      AiDecisionOutcome[outcome as keyof typeof AiDecisionOutcome];

    const decision = await this.repository.createDecision({
      business_id: businessId,
      conversation_id: conversationId,
      message_id: messageId,
      type: decisionType,
      outcome: decisionOutcome,
      proposed_action: proposedAction as unknown as Record<string, unknown>,
      confidence_score: confidenceScore.finalScore,
      confidence_breakdown: confidenceBreakdown as unknown as Record<string, unknown>,
      model_id: modelId,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      latency_ms: latencyMs,
      decided_at: new Date(),
      executed_at: outcome === 'AUTO_EXECUTED' ? new Date() : null,
    });

    const decisionId = decision.id;

    // ── 5. Emit the appropriate event ─────────────
    switch (outcome) {
      case 'AUTO_EXECUTED':
        this.emitAutoExecuted({
          businessId,
          conversationId,
          decisionId,
          action: proposedAction,
        });
        break;

      case 'SENT_FOR_REVIEW':
        this.emitResponseGenerated({
          businessId,
          conversationId,
          messageId,
          decisionId,
          intent,
          confidenceScore,
          suggestedActions,
          modelId,
          latencyMs,
        });
        break;

      case 'ESCALATED':
        this.emitEscalated({
          businessId,
          conversationId,
          reason: this.buildEscalationReason(confidenceScore, reasoning),
        });
        break;
    }

    // ── 6. Determine holding message ──────────────
    const holdingMessage = this.resolveHoldingMessage(outcome, intent);

    this.logger.log(
      `Routed decision ${decisionId} for conversation ${conversationId}: ` +
        `outcome=${outcome}, type=${decisionType}, score=${confidenceScore.finalScore}`,
    );

    return { outcome, holdingMessage, decisionId };
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  /**
   * Determine the routing outcome from the confidence score and business
   * thresholds. An override with `escalate: true` forces ESCALATED.
   */
  private determineOutcome(
    confidenceScore: ConfidenceScore,
    aiSettings: AISettings,
  ): RouteResult['outcome'] {
    // Check for escalation-forcing overrides first
    const hasEscalationOverride = confidenceScore.overrides.some(
      (o) => ESCALATION_OVERRIDE_CODES.has(o.code),
    );

    if (hasEscalationOverride) {
      return 'ESCALATED';
    }

    // Band-based routing
    if (confidenceScore.finalScore >= aiSettings.autoExecuteThreshold) {
      return 'AUTO_EXECUTED';
    }

    if (confidenceScore.finalScore >= aiSettings.reviewThreshold) {
      return 'SENT_FOR_REVIEW';
    }

    return 'ESCALATED';
  }

  /**
   * Resolve the holding message based on the routing outcome and intent.
   *
   * - AUTO_EXECUTED: no holding message (response sent directly).
   * - SENT_FOR_REVIEW: intent-specific holding message.
   * - ESCALATED: empathetic escalation holding message.
   */
  private resolveHoldingMessage(
    outcome: RouteResult['outcome'],
    intent: IntentType,
  ): string | null {
    switch (outcome) {
      case 'AUTO_EXECUTED':
        return null;
      case 'SENT_FOR_REVIEW':
        return HOLDING_MESSAGES[intent] ?? DEFAULT_HOLDING_MESSAGE;
      case 'ESCALATED':
        return ESCALATION_HOLDING_MESSAGE;
    }
  }

  /**
   * Build a human-readable escalation reason from the confidence overrides
   * and the LLM reasoning.
   */
  private buildEscalationReason(
    confidenceScore: ConfidenceScore,
    reasoning: string,
  ): string {
    const overrideReasons = confidenceScore.overrides
      .map((o) => o.reason)
      .filter(Boolean);

    if (overrideReasons.length > 0) {
      return `Escalated due to: ${overrideReasons.join('; ')}. AI reasoning: ${reasoning}`;
    }

    return `Low confidence (${confidenceScore.finalScore.toFixed(4)}). AI reasoning: ${reasoning}`;
  }

  // ─────────────────────────────────────────────
  // Event emitters
  // ─────────────────────────────────────────────

  private emitAutoExecuted(payload: AutoExecutedPayload): void {
    this.eventEmitter.emit('ai.auto.executed', payload);
    this.logger.debug(
      `Emitted ai.auto.executed for decision ${payload.decisionId}`,
    );
  }

  private emitResponseGenerated(params: {
    businessId: string;
    conversationId: string;
    messageId: string | null;
    decisionId: string;
    intent: IntentType;
    confidenceScore: ConfidenceScore;
    suggestedActions: SuggestedAction[];
    modelId: string;
    latencyMs: number;
  }): void {
    const event: AIResponseGeneratedEvent = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId: params.businessId,
      correlationId: generateCorrelationId(),
      type: 'ai.response.generated',
      conversationId: params.conversationId,
      messageId: params.messageId ?? '',
      aiDecisionId: params.decisionId,
      intent: params.intent,
      confidenceScore: params.confidenceScore,
      suggestedActions: params.suggestedActions,
      modelId: params.modelId,
      latencyMs: params.latencyMs,
    };

    this.eventEmitter.emit('ai.response.generated', event);
    this.logger.debug(
      `Emitted ai.response.generated for decision ${params.decisionId}`,
    );
  }

  private emitEscalated(payload: EscalatedPayload): void {
    this.eventEmitter.emit('ai.escalated', payload);
    this.logger.debug(
      `Emitted ai.escalated for conversation ${payload.conversationId}`,
    );
  }
}
