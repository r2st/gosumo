import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AiEngineRepository } from '../ai-engine.repository';
import { CONTEXT_MESSAGE_WINDOW } from '../ai-engine.constants';
import type { ConversationContextData } from './prompt-assembler';

/**
 * Business-level AI configuration parsed from the `businesses.ai_settings`
 * JSON column, with safe defaults for every field.
 */
export interface AISettings {
  /** Confidence threshold for autonomous execution (0–1). */
  autoExecuteThreshold: number;
  /** Confidence threshold for draft/review routing (0–1). */
  reviewThreshold: number;
  /** Maximum refund amount in paise that the AI may auto-approve. */
  maxRefundAmountPaise: number;
  /** Display name of the business (used in prompts). */
  businessName: string;
  /** Arbitrary profile data (hours, city, brand voice, etc.). */
  businessProfile: Record<string, unknown>;
}

/**
 * Everything the pipeline needs to begin reasoning about a single inbound
 * message. Assembled from parallel reads against the repository layer.
 */
export interface LoadedContext {
  conversation: ConversationContextData;
  aiSettings: AISettings;
  businessRules: Array<{
    id: string;
    type: string;
    name: string;
    conditions: unknown;
    actions: unknown;
  }>;
  /** Plain text of the message that triggered this pipeline run. */
  triggeringMessageText: string;
}

// ─────────────────────────────────────────────
// Default AI settings (applied when the business has not configured a field)
// ─────────────────────────────────────────────

const DEFAULT_AI_SETTINGS: AISettings = {
  autoExecuteThreshold: 0.9,
  reviewThreshold: 0.7,
  maxRefundAmountPaise: 100_000, // Rs 1,000
  businessName: 'this business',
  businessProfile: {},
};

/**
 * ContextLoaderService — loads all conversation context required by the AI
 * pipeline in a single parallel fetch, then normalises it into a
 * {@link LoadedContext} ready for classification and prompt assembly.
 *
 * Uses {@link AiEngineRepository} for all database access so the pipeline
 * never touches Prisma directly.
 */
@Injectable()
export class ContextLoaderService {
  private readonly logger = new Logger(ContextLoaderService.name);

  constructor(private readonly repository: AiEngineRepository) {}

  /**
   * Load context for one inbound message.
   *
   * @throws NotFoundException if the conversation does not exist or is
   *   soft-deleted within the given business.
   */
  async loadContext(
    businessId: string,
    conversationId: string,
    messageId: string,
  ): Promise<LoadedContext> {
    // ── 1. Parallel reads ──────────────────────
    const [conversation, messages, rawAiSettings, rawRules] = await Promise.all([
      this.repository.getConversationWithClient(businessId, conversationId),
      this.repository.getLastMessages(conversationId, CONTEXT_MESSAGE_WINDOW),
      this.repository.getBusinessAISettings(businessId),
      this.repository.findActiveBusinessRules(businessId),
    ]);

    // ── 2. Conversation must exist ─────────────
    if (!conversation) {
      throw new NotFoundException(
        `Conversation ${conversationId} not found for business ${businessId}`,
      );
    }

    // ── 3. Extract the triggering message text ─
    const triggerMessage = messages.find((m) => m.id === messageId);
    const triggeringMessageText = triggerMessage
      ? triggerMessage.text_content ?? JSON.stringify(triggerMessage.content)
      : '';

    if (!triggerMessage) {
      this.logger.warn(
        `Triggering message ${messageId} not found in the last ${CONTEXT_MESSAGE_WINDOW} messages — text will be empty`,
      );
    }

    // ── 4. Build ConversationContextData ───────
    // Messages arrive from the repository in DESC order — reverse to chronological.
    const recentMessages = messages
      .map((m) => ({
        role: this.mapSenderRole(m.sender_type) as 'client' | 'assistant' | 'system',
        content: m.text_content ?? JSON.stringify(m.content),
        timestamp: m.created_at.toISOString(),
      }))
      .reverse();

    // ── 5. Parse AI settings with defaults ─────
    const aiSettings = this.parseAiSettings(rawAiSettings);

    // Extract client from the conversation's included relation (set by
    // getConversationWithClient).
    const client = (conversation as Record<string, unknown>).client as
      | Record<string, unknown>
      | null
      | undefined;

    const conversationContext: ConversationContextData = {
      conversationId: conversation.id,
      businessName: aiSettings.businessName,
      businessProfile: aiSettings.businessProfile,
      clientName: client && typeof client['name'] === 'string' ? client['name'] : null,
      clientProfile: client && typeof client === 'object' ? this.extractClientProfile(client) : {},
      recentMessages,
      currentIntent: null,
      channel: (conversation as Record<string, unknown>).channel as string ?? 'UNKNOWN',
    };

    // ── 6. Map business rules ──────────────────
    const businessRules = rawRules.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      conditions: (r as Record<string, unknown>).conditions ?? null,
      actions: (r as Record<string, unknown>).actions ?? null,
    }));

    this.logger.debug(
      `Loaded context for conversation ${conversationId}: ` +
        `${recentMessages.length} messages, ${businessRules.length} rules`,
    );

    return {
      conversation: conversationContext,
      aiSettings,
      businessRules,
      triggeringMessageText,
    };
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  /**
   * Map the Prisma `sender_type` string to the simplified role used in
   * conversation context.
   */
  private mapSenderRole(senderType: string | null): 'client' | 'assistant' | 'system' {
    if (!senderType) return 'system';
    const upper = senderType.toUpperCase();
    if (upper === 'CLIENT') return 'client';
    if (upper === 'AI') return 'assistant';
    return 'system';
  }

  /**
   * Build a flat client profile object from the Prisma client record,
   * pulling out fields useful for prompt context.
   */
  private extractClientProfile(client: Record<string, unknown>): Record<string, unknown> {
    const profile: Record<string, unknown> = {};
    if (typeof client['total_orders'] === 'number') profile['totalOrders'] = client['total_orders'];
    if (client['total_spent'] != null) profile['totalSpent'] = Number(client['total_spent']);
    if (client['last_interaction_at']) profile['lastInteraction'] = client['last_interaction_at'];
    if (client['churn_risk'] != null) profile['churnRisk'] = Number(client['churn_risk']);
    if (typeof client['tags'] === 'object' && client['tags'] !== null) profile['tags'] = client['tags'];
    return profile;
  }

  /**
   * Merge the raw JSON from the database with safe defaults so every field
   * is guaranteed to be present and typed.
   */
  private parseAiSettings(raw: Record<string, unknown> | null): AISettings {
    if (!raw) return { ...DEFAULT_AI_SETTINGS };

    return {
      autoExecuteThreshold:
        typeof raw['autoExecuteThreshold'] === 'number'
          ? raw['autoExecuteThreshold']
          : DEFAULT_AI_SETTINGS.autoExecuteThreshold,
      reviewThreshold:
        typeof raw['reviewThreshold'] === 'number'
          ? raw['reviewThreshold']
          : DEFAULT_AI_SETTINGS.reviewThreshold,
      maxRefundAmountPaise:
        typeof raw['maxRefundAmountPaise'] === 'number'
          ? raw['maxRefundAmountPaise']
          : DEFAULT_AI_SETTINGS.maxRefundAmountPaise,
      businessName:
        typeof raw['businessName'] === 'string' && raw['businessName'].length > 0
          ? raw['businessName']
          : DEFAULT_AI_SETTINGS.businessName,
      businessProfile:
        typeof raw['businessProfile'] === 'object' &&
        raw['businessProfile'] !== null &&
        !Array.isArray(raw['businessProfile'])
          ? (raw['businessProfile'] as Record<string, unknown>)
          : DEFAULT_AI_SETTINGS.businessProfile,
    };
  }
}
