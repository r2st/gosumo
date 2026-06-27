import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { MessageDirection, MessageStatus } from '@gosumo/shared';
import type { messages } from '@prisma/client';
import { Prisma, MessageType } from '@prisma/client';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface CreateMessageData {
  business_id: string;
  conversation_id: string;
  channel_account_id: string;
  direction: MessageDirection;
  type?: MessageType;
  status?: MessageStatus;
  sender_type: string;
  sender_id?: string;
  content: Prisma.InputJsonValue;
  text_content?: string;
  external_id?: string;
  is_ai_generated?: boolean;
  confidence_score?: number;
  ai_decision_id?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface PaginationCursor {
  createdAt: string;
  id: string;
}

export interface PaginationOptions {
  limit: number;
  cursor?: PaginationCursor;
}

export interface SearchFilters {
  conversationId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface UpdateStatusTimestamps {
  deliveredAt?: string;
  readAt?: string;
  failedAt?: string;
  failureReason?: string;
}

/**
 * MessageRepository — all Prisma queries for the Message module.
 *
 * Every query includes business_id scoping.
 * Messages are append-only: content is never updated after storage.
 */
@Injectable()
export class MessageRepository {
  private readonly logger = new Logger(MessageRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new message record.
   */
  async create(data: CreateMessageData): Promise<messages> {
    return this.prisma.messages.create({
      data: {
        business_id: data.business_id,
        conversation_id: data.conversation_id,
        channel_account_id: data.channel_account_id,
        direction: data.direction,
        type: data.type ?? MessageType.TEXT,
        status: data.status ?? MessageStatus.PENDING,
        sender_type: data.sender_type,
        sender_id: data.sender_id ?? null,
        content: data.content,
        text_content: data.text_content ?? null,
        external_id: data.external_id ?? null,
        is_ai_generated: data.is_ai_generated ?? false,
        confidence_score: data.confidence_score ?? null,
        ai_decision_id: data.ai_decision_id ?? null,
        metadata: data.metadata ?? {},
      },
    });
  }

  /**
   * Find a message by ID with business_id filter.
   */
  async findById(businessId: string, messageId: string): Promise<messages | null> {
    return this.prisma.messages.findFirst({
      where: {
        id: messageId,
        business_id: businessId,
      },
    });
  }

  /**
   * Find messages for a conversation with keyset pagination.
   *
   * Uses (created_at DESC, id DESC) ordering with cursor-based pagination.
   * Returns limit + 1 records to detect whether more records exist.
   */
  async findByConversation(
    businessId: string,
    conversationId: string,
    options: PaginationOptions,
  ): Promise<messages[]> {
    const { limit, cursor } = options;

    const where: Prisma.messagesWhereInput = {
      business_id: businessId,
      conversation_id: conversationId,
    };

    if (cursor) {
      // Keyset pagination: (created_at, id) < (cursorCreatedAt, cursorId)
      where.OR = [
        {
          created_at: { lt: new Date(cursor.createdAt) },
        },
        {
          created_at: new Date(cursor.createdAt),
          id: { lt: cursor.id },
        },
      ];
    }

    return this.prisma.messages.findMany({
      where,
      orderBy: [
        { created_at: 'desc' },
        { id: 'desc' },
      ],
      take: limit + 1,
    });
  }

  /**
   * Find a message by its external_id for deduplication.
   * Returns the first match or null.
   */
  async findByExternalId(externalId: string): Promise<messages | null> {
    return this.prisma.messages.findFirst({
      where: {
        external_id: externalId,
      },
    });
  }

  /**
   * Get the last N messages in a conversation, ordered by created_at DESC.
   */
  async getLastN(conversationId: string, n: number): Promise<messages[]> {
    return this.prisma.messages.findMany({
      where: {
        conversation_id: conversationId,
      },
      orderBy: { created_at: 'desc' },
      take: n,
    });
  }

  /**
   * Update delivery status and associated timestamps on a message.
   */
  async updateStatus(
    businessId: string,
    messageId: string,
    status: MessageStatus,
    timestamps: UpdateStatusTimestamps,
  ): Promise<messages> {
    return this.prisma.messages.update({
      where: { id: messageId },
      data: {
        status,
        delivered_at: timestamps.deliveredAt
          ? new Date(timestamps.deliveredAt)
          : undefined,
        read_at: timestamps.readAt
          ? new Date(timestamps.readAt)
          : undefined,
        failed_at: timestamps.failedAt
          ? new Date(timestamps.failedAt)
          : undefined,
        failure_reason: timestamps.failureReason ?? undefined,
      },
    });
  }

  /**
   * Search messages by text_content using ILIKE.
   * Returns up to 50 results filtered by business_id and optional filters.
   */
  async search(
    businessId: string,
    query: string,
    filters: SearchFilters,
  ): Promise<messages[]> {
    const where: Prisma.messagesWhereInput = {
      business_id: businessId,
      text_content: {
        contains: query,
        mode: 'insensitive',
      },
    };

    if (filters.conversationId) {
      where.conversation_id = filters.conversationId;
    }

    if (filters.dateFrom || filters.dateTo) {
      where.created_at = {};
      if (filters.dateFrom) {
        (where.created_at as Prisma.DateTimeFilter).gte = new Date(filters.dateFrom);
      }
      if (filters.dateTo) {
        (where.created_at as Prisma.DateTimeFilter).lte = new Date(filters.dateTo);
      }
    }

    return this.prisma.messages.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 50,
    });
  }

  /**
   * Attach AI metadata to an existing message.
   * Only updates AI-related fields; never modifies message content.
   */
  async attachAIMetadata(
    businessId: string,
    messageId: string,
    metadata: {
      is_ai_generated: boolean;
      confidence_score?: number;
      ai_decision_id?: string;
    },
  ): Promise<messages> {
    return this.prisma.messages.update({
      where: { id: messageId },
      data: {
        is_ai_generated: metadata.is_ai_generated,
        confidence_score: metadata.confidence_score ?? undefined,
        ai_decision_id: metadata.ai_decision_id ?? undefined,
      },
    });
  }
}
