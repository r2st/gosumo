import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { MessageDirection, MessageStatus } from '@gosumo/shared';
import type { messages, file_uploads } from '@prisma/client';
import { Prisma, MessageType, FileUploadType } from '@prisma/client';
import { escapeLikeTerm } from '../../common/utils/search-pattern.util';
import {
  MESSAGE_ORDER_NEWEST_FIRST,
  MESSAGE_ORDER_OLDEST_FIRST,
  MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST,
} from '../../common/utils/message-order';
import { createSequencedMessage } from '../../common/utils/message-sequence';
import { MAX_SEARCH_RESULTS, MAX_REPLIES_PER_MESSAGE, SEARCHABLE_MESSAGE_TYPES } from './message.constants';

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

export interface CreateFileUploadData {
  business_id: string;
  message_id: string;
  type: FileUploadType;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  cdn_url?: string;
  width?: number;
  height?: number;
  is_public?: boolean;
}

export interface MessageStats {
  total: number;
  inbound: number;
  outbound: number;
  aiGenerated: number;
  byStatus: Record<string, number>;
}

export interface MessageReaction {
  emoji: string;
  senderId: string;
  at: string;
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
    const { message } = await createSequencedMessage(this.prisma, {
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
    });
    return message;
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
      orderBy: MESSAGE_ORDER_NEWEST_FIRST,
      take: limit + 1,
    });
  }

  /**
   * Find a message by its external_id for deduplication.
   * Returns the first match or null.
   */
  async findByExternalId(
    businessId: string,
    externalId: string,
  ): Promise<messages | null> {
    return this.prisma.messages.findFirst({
      where: {
        business_id: businessId,
        external_id: externalId,
      },
    });
  }

  /**
   * Get the last N messages in a conversation, newest first.
   *
   * This feeds the AI context window, so the `LIMIT` is the part that matters:
   * an untied `created_at` sort lets a tie straddling the Nth row decide
   * arbitrarily which of the tied messages the AI gets to see — and "book me
   * for 2pm" / "no wait, 3pm" read in the wrong order is a different
   * instruction. Scoped to one conversation, so it sorts on `sequence`: see
   * {@link MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST}.
   */
  async getLastN(
    businessId: string,
    conversationId: string,
    n: number,
  ): Promise<messages[]> {
    return this.prisma.messages.findMany({
      where: {
        business_id: businessId,
        conversation_id: conversationId,
      },
      orderBy: MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST,
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
      where: { id: messageId, business_id: businessId },
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
      // Full-text search is restricted to text-bearing messages; media and
      // structured payloads have no denormalized text_content to match.
      type: { in: SEARCHABLE_MESSAGE_TYPES },
      text_content: {
        // Escaped, not raw: `%` and `_` in a term would otherwise act as LIKE
        // wildcards, and `q=%` would sequentially scan and return the tenant's
        // entire message history. See search-pattern.util.ts.
        contains: escapeLikeTerm(query),
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
      // Also `LIMIT`-ed, so the same tie-break argument applies: which of two
      // simultaneous matches makes the cut should not vary between runs of the
      // same search.
      orderBy: MESSAGE_ORDER_NEWEST_FIRST,
      take: MAX_SEARCH_RESULTS,
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
      where: { id: messageId, business_id: businessId },
      data: {
        is_ai_generated: metadata.is_ai_generated,
        confidence_score: metadata.confidence_score ?? undefined,
        ai_decision_id: metadata.ai_decision_id ?? undefined,
      },
    });
  }

  // ─────────────────────────────────────────────
  // Media attachments (file_uploads)
  // ─────────────────────────────────────────────

  /**
   * Create a file_uploads row linked to a message. Media URLs must already be
   * GoSumo S3-backed (channel-adapter re-uploads channel CDN media first).
   */
  async createFileUpload(data: CreateFileUploadData): Promise<file_uploads> {
    return this.prisma.file_uploads.create({
      data: {
        business_id: data.business_id,
        message_id: data.message_id,
        type: data.type,
        filename: data.filename,
        mime_type: data.mime_type,
        size_bytes: data.size_bytes,
        storage_key: data.storage_key,
        cdn_url: data.cdn_url ?? null,
        width: data.width ?? null,
        height: data.height ?? null,
        is_public: data.is_public ?? false,
      },
    });
  }

  /** List non-deleted file uploads attached to a message. */
  async findFileUploadsByMessage(
    businessId: string,
    messageId: string,
  ): Promise<file_uploads[]> {
    return this.prisma.file_uploads.findMany({
      where: {
        business_id: businessId,
        message_id: messageId,
        deleted_at: null,
      },
      orderBy: { created_at: 'asc' },
    });
  }

  // ─────────────────────────────────────────────
  // Reactions
  // ─────────────────────────────────────────────

  /** Overwrite the reactions array on a message. */
  async setReactions(
    businessId: string,
    messageId: string,
    reactions: MessageReaction[],
  ): Promise<messages> {
    return this.prisma.messages.update({
      where: { id: messageId, business_id: businessId },
      data: { reactions: reactions as unknown as Prisma.InputJsonValue },
    });
  }

  // ─────────────────────────────────────────────
  // Threading
  // ─────────────────────────────────────────────

  /**
   * Find direct replies to a message — rows whose metadata carries
   * `reply_to_message_id` equal to the given id.
   */
  async findReplies(
    businessId: string,
    messageId: string,
  ): Promise<messages[]> {
    return this.prisma.messages.findMany({
      where: {
        business_id: businessId,
        metadata: {
          path: ['reply_to_message_id'],
          equals: messageId,
        },
      },
      orderBy: MESSAGE_ORDER_OLDEST_FIRST,
      take: MAX_REPLIES_PER_MESSAGE,
    });
  }

  // ─────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────

  /** Aggregate message counts for a conversation. */
  async getStats(
    businessId: string,
    conversationId: string,
  ): Promise<MessageStats> {
    const where: Prisma.messagesWhereInput = {
      business_id: businessId,
      conversation_id: conversationId,
    };

    const [total, inbound, aiGenerated, statusGroups] = await Promise.all([
      this.prisma.messages.count({ where }),
      this.prisma.messages.count({
        where: { ...where, direction: MessageDirection.INBOUND },
      }),
      this.prisma.messages.count({ where: { ...where, is_ai_generated: true } }),
      this.prisma.messages.groupBy({
        by: ['status'],
        where,
        _count: { status: true },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const group of statusGroups) {
      byStatus[group.status] = group._count.status;
    }

    return {
      total,
      inbound,
      outbound: total - inbound,
      aiGenerated,
      byStatus,
    };
  }
}
