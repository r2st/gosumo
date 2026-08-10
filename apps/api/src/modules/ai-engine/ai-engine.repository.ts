import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ai_decisions,
  vector_embeddings_metadata,
  AiDecisionType,
  AiDecisionOutcome,
  EmbeddingEntityType,
} from '@gosumo/database';
import type { business_rules, conversations, messages } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

// ─────────────────────────────────────────────
// Data types
// ─────────────────────────────────────────────

export interface CreateDecisionData {
  business_id: string;
  conversation_id: string;
  message_id?: string | null;
  task_id?: string | null;
  type: AiDecisionType;
  outcome: AiDecisionOutcome;
  proposed_action: Prisma.InputJsonValue;
  confidence_score: number;
  confidence_breakdown: Prisma.InputJsonValue;
  model_id?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  latency_ms?: number | null;
  decided_at?: Date;
  executed_at?: Date | null;
}

export interface CreateEmbeddingMetadataData {
  business_id: string;
  entity_type: EmbeddingEntityType;
  entity_id: string;
  collection: string;
  qdrant_point_id: string;
  content_hash: string;
  model_id: string;
}

export interface PaginatedDecisions {
  data: ai_decisions[];
  total: number;
  page: number;
  limit: number;
}

/**
 * AiEngineRepository — all Prisma access for the AI engine.
 *
 * Owns three tables: `ai_decisions` (immutable audit trail — created once,
 * never updated), `vector_embeddings_metadata` (tracks what is embedded in
 * Qdrant), and reads of `ai_precedents`. Also reads from `business_rules`,
 * `businesses`, `conversations`, and `messages` for context gathering.
 *
 * Every query is scoped by `business_id`.
 */
@Injectable()
export class AiEngineRepository {
  private readonly logger = new Logger(AiEngineRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────
  // ai_decisions (append-only)
  // ─────────────────────────────────────────────

  /**
   * Persist a single AI decision. Records are immutable: all fields (including
   * `task_id` and `executed_at`) must be supplied at creation time — never
   * issue an UPDATE against this table.
   */
  async createDecision(data: CreateDecisionData): Promise<ai_decisions> {
    return this.prisma.ai_decisions.create({
      data: {
        business_id: data.business_id,
        conversation_id: data.conversation_id,
        message_id: data.message_id ?? null,
        task_id: data.task_id ?? null,
        type: data.type,
        outcome: data.outcome,
        proposed_action: data.proposed_action,
        confidence_score: data.confidence_score,
        confidence_breakdown: data.confidence_breakdown,
        model_id: data.model_id ?? null,
        prompt_tokens: data.prompt_tokens ?? null,
        completion_tokens: data.completion_tokens ?? null,
        latency_ms: data.latency_ms ?? null,
        decided_at: data.decided_at ?? new Date(),
        executed_at: data.executed_at ?? null,
      },
    });
  }

  /**
   * Find a single decision by business_id and id.
   */
  async findDecisionById(
    businessId: string,
    decisionId: string,
  ): Promise<ai_decisions | null> {
    return this.prisma.ai_decisions.findFirst({
      where: {
        id: decisionId,
        business_id: businessId,
      },
    });
  }

  /**
   * List decisions for a conversation, ordered by decided_at DESC.
   * Paginated.
   */
  async findDecisionsByConversation(
    businessId: string,
    conversationId: string,
    options: { page?: number; limit?: number } = {},
  ): Promise<PaginatedDecisions> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = {
      business_id: businessId,
      conversation_id: conversationId,
    };

    const [data, total] = await Promise.all([
      this.prisma.ai_decisions.findMany({
        where,
        orderBy: { decided_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.ai_decisions.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Count the number of consecutive ai_decisions with the same type
   * at the END of the decision stream for a conversation.
   *
   * Used for loop detection — e.g. "has the AI made the same kind
   * of decision N times in a row?"
   */
  async getLoopCount(
    businessId: string,
    conversationId: string,
    intent: string,
  ): Promise<number> {
    const recentDecisions = await this.prisma.ai_decisions.findMany({
      where: {
        business_id: businessId,
        conversation_id: conversationId,
      },
      orderBy: { decided_at: 'desc' },
      select: { type: true },
      take: 50,
    });

    let count = 0;
    for (const decision of recentDecisions) {
      if (decision.type === intent) {
        count++;
      } else {
        break;
      }
    }

    return count;
  }

  /**
   * Recent classified intents (oldest->newest) for a conversation, used by the
   * loop detector. Reads the immutable decision log.
   */
  async getRecentIntents(
    businessId: string,
    conversationId: string,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.ai_decisions.findMany({
      where: { business_id: businessId, conversation_id: conversationId },
      orderBy: { decided_at: 'desc' },
      take: limit,
      select: { proposed_action: true },
    });

    return rows
      .reverse()
      .map((r) => {
        const action = r.proposed_action as Record<string, unknown> | null;
        const intent =
          action && typeof action['intent'] === 'string'
            ? (action['intent'] as string)
            : null;
        return intent;
      })
      .filter((i): i is string => i !== null);
  }

  // ─────────────────────────────────────────────
  // business_rules
  // ─────────────────────────────────────────────

  /**
   * Find all active business_rules for a business.
   * Excludes soft-deleted rules. Ordered by priority DESC.
   */
  async findActiveBusinessRules(
    businessId: string,
  ): Promise<business_rules[]> {
    return this.prisma.business_rules.findMany({
      where: {
        business_id: businessId,
        is_active: true,
        deleted_at: null,
      },
      orderBy: { priority: 'desc' },
    });
  }

  // ─────────────────────────────────────────────
  // businesses
  // ─────────────────────────────────────────────

  /**
   * Get the ai_settings JSON field from the businesses table.
   */
  async getBusinessAISettings(
    businessId: string,
  ): Promise<Record<string, unknown> | null> {
    const business = await this.prisma.businesses.findFirst({
      where: {
        id: businessId,
      },
      select: {
        ai_settings: true,
      },
    });

    if (!business) {
      return null;
    }

    return business.ai_settings as Record<string, unknown>;
  }

  // ─────────────────────────────────────────────
  // conversations
  // ─────────────────────────────────────────────

  /**
   * Get a conversation with its client relation included.
   */
  async getConversationWithClient(
    businessId: string,
    conversationId: string,
  ): Promise<conversations | null> {
    return this.prisma.conversations.findFirst({
      where: {
        id: conversationId,
        business_id: businessId,
        deleted_at: null,
      },
      include: {
        client: true,
      },
    });
  }

  // ─────────────────────────────────────────────
  // messages
  // ─────────────────────────────────────────────

  /**
   * Get the last N messages for a conversation, ordered by created_at DESC.
   * Scoped by conversation_id (which is already tenant-scoped).
   */
  async getLastMessages(
    businessId: string,
    conversationId: string,
    limit: number,
  ): Promise<messages[]> {
    return this.prisma.messages.findMany({
      where: {
        business_id: businessId,
        conversation_id: conversationId,
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  // ─────────────────────────────────────────────
  // vector_embeddings_metadata (knowledge tracking)
  // ─────────────────────────────────────────────

  async createEmbeddingMetadata(
    data: CreateEmbeddingMetadataData,
  ): Promise<vector_embeddings_metadata> {
    return this.prisma.vector_embeddings_metadata.create({
      data: {
        business_id: data.business_id,
        entity_type: data.entity_type,
        entity_id: data.entity_id,
        collection: data.collection,
        qdrant_point_id: data.qdrant_point_id,
        content_hash: data.content_hash,
        model_id: data.model_id,
        embedded_at: new Date(),
      },
    });
  }

  async findEmbeddingMetadata(
    businessId: string,
    entryId: string,
  ): Promise<vector_embeddings_metadata | null> {
    return this.prisma.vector_embeddings_metadata.findFirst({
      where: { business_id: businessId, entity_id: entryId },
    });
  }

  async deleteEmbeddingMetadata(
    businessId: string,
    entryId: string,
  ): Promise<void> {
    await this.prisma.vector_embeddings_metadata.deleteMany({
      where: { business_id: businessId, entity_id: entryId },
    });
  }
}
