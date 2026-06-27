import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { messages, file_uploads } from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  MessageStoredEvent,
  MessageSentEvent,
  MessageFailedEvent,
  MessageDirection,
  MessageStatus,
  ChannelType,
} from '@gosumo/shared';
import {
  MessageRepository,
  PaginationCursor,
  MessageReaction,
  MessageStats,
} from './message.repository';
import {
  StoreInboundMessageDto,
  StoreOutboundMessageDto,
  MessagePaginationQueryDto,
  UpdateDeliveryStatusDto,
  AttachAIMetadataDto,
  AttachMediaDto,
  ReactionDto,
} from './dto';
import {
  resolveMessageType,
  resolveFileUploadType,
  MEDIA_CONTENT_TYPES,
} from './message.constants';

// ─────────────────────────────────────────────
// Response interface for paginated messages
// ─────────────────────────────────────────────

export interface PaginatedMessages {
  data: messages[];
  cursor: string | null;
  hasMore: boolean;
}

/**
 * MessageService — business logic for storing, retrieving, and managing messages.
 *
 * Messages are append-only: content is never updated after storage.
 * All queries are scoped to businessId for multi-tenant safety.
 */
@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);

  constructor(
    private readonly repository: MessageRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Store an inbound message from a channel.
   *
   * 1. Deduplicates by external_id — if a message with the same external_id
   *    already exists, returns the existing record.
   * 2. Creates the message with direction=INBOUND, status=PENDING.
   * 3. Emits a `message.stored` event for downstream processing.
   */
  async storeInboundMessage(
    businessId: string,
    dto: StoreInboundMessageDto,
  ): Promise<messages> {
    // Deduplication by external_id
    const existing = await this.repository.findByExternalId(dto.externalId);
    if (existing) {
      this.logger.debug(
        `Duplicate inbound message detected (external_id=${dto.externalId}), returning existing`,
      );
      return existing;
    }

    const message = await this.repository.create({
      business_id: businessId,
      conversation_id: dto.conversationId,
      channel_account_id: dto.channelAccountId,
      direction: MessageDirection.INBOUND,
      type: resolveMessageType(dto.content),
      status: MessageStatus.PENDING,
      sender_type: dto.senderType,
      sender_id: dto.senderId,
      content: dto.content as Prisma.InputJsonValue,
      text_content: dto.textContent,
      external_id: dto.externalId,
      metadata: this.buildMetadata(dto.metadata, dto.replyToMessageId),
    });

    await this.persistMediaFromContent(businessId, message.id, dto.content);

    this.emitMessageStoredEvent(message, dto.channel);

    this.logger.log(
      `Inbound message stored: id=${message.id}, conversation=${message.conversation_id}`,
    );

    return message;
  }

  /**
   * Store an outbound message (sent by AI, human agent, or system).
   *
   * 1. Creates the message with direction=OUTBOUND, status=PENDING.
   * 2. Emits a `message.stored` event.
   */
  async storeOutboundMessage(
    businessId: string,
    dto: StoreOutboundMessageDto,
  ): Promise<messages> {
    const message = await this.repository.create({
      business_id: businessId,
      conversation_id: dto.conversationId,
      channel_account_id: dto.channelAccountId,
      direction: MessageDirection.OUTBOUND,
      type: resolveMessageType(dto.content),
      status: MessageStatus.PENDING,
      sender_type: dto.senderType,
      sender_id: dto.senderId,
      content: dto.content as Prisma.InputJsonValue,
      text_content: dto.textContent,
      external_id: dto.externalId,
      is_ai_generated: dto.isAiGenerated,
      confidence_score: dto.confidenceScore,
      ai_decision_id: dto.aiDecisionId,
      metadata: this.buildMetadata(dto.metadata, dto.replyToMessageId),
    });

    await this.persistMediaFromContent(businessId, message.id, dto.content);

    this.emitMessageStoredEvent(message, dto.channel);

    this.logger.log(
      `Outbound message stored: id=${message.id}, conversation=${message.conversation_id}`,
    );

    return message;
  }

  /**
   * Get paginated messages for a conversation using keyset pagination.
   *
   * The cursor is a base64-encoded JSON object with {createdAt, id}.
   * Returns data, next cursor, and whether more records exist.
   */
  async getConversationMessages(
    businessId: string,
    conversationId: string,
    query: MessagePaginationQueryDto,
  ): Promise<PaginatedMessages> {
    const limit = query.limit ?? 20;

    let parsedCursor: PaginationCursor | undefined;
    if (query.cursor) {
      parsedCursor = this.decodeCursor(query.cursor);
    }

    const results = await this.repository.findByConversation(
      businessId,
      conversationId,
      { limit, cursor: parsedCursor },
    );

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;

    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1];
      if (lastItem) {
        nextCursor = this.encodeCursor({
          createdAt: lastItem.created_at.toISOString(),
          id: lastItem.id,
        });
      }
    }

    return { data, cursor: nextCursor, hasMore };
  }

  /**
   * Get a single message by ID, scoped to business.
   */
  async getMessageById(businessId: string, messageId: string): Promise<messages> {
    const message = await this.repository.findById(businessId, messageId);
    if (!message) {
      throw new NotFoundException(`Message ${messageId} not found`);
    }
    return message;
  }

  /**
   * Get the last N messages for a conversation.
   */
  async getLastNMessages(
    businessId: string,
    conversationId: string,
    n: number,
  ): Promise<messages[]> {
    // Verify at least one message exists for this conversation + business
    // (serves as a lightweight ownership check)
    const probe = await this.repository.findByConversation(
      businessId,
      conversationId,
      { limit: 1 },
    );

    if (probe.length === 0) {
      // Conversation has no messages for this business — could be non-existent
      // or belong to another tenant. Return empty array.
      return [];
    }

    return this.repository.getLastN(conversationId, n);
  }

  /**
   * Update delivery status and associated timestamps on a message.
   */
  async updateDeliveryStatus(
    businessId: string,
    messageId: string,
    dto: UpdateDeliveryStatusDto,
  ): Promise<messages> {
    // Verify the message exists and belongs to this business
    const existing = await this.repository.findById(businessId, messageId);
    if (!existing) {
      throw new NotFoundException(`Message ${messageId} not found`);
    }

    return this.repository.updateStatus(businessId, messageId, dto.status, {
      deliveredAt: dto.deliveredAt,
      readAt: dto.readAt,
      failedAt: dto.failedAt,
      failureReason: dto.failureReason,
    });
  }

  /**
   * Search messages by text content with optional filters.
   */
  async searchMessages(
    businessId: string,
    query: string,
    filters: { conversationId?: string; dateFrom?: string; dateTo?: string },
  ): Promise<messages[]> {
    return this.repository.search(businessId, query, filters);
  }

  /**
   * Attach AI metadata to an existing message.
   * Updates is_ai_generated, confidence_score, and ai_decision_id.
   */
  async attachAIMetadata(
    businessId: string,
    messageId: string,
    metadata: AttachAIMetadataDto,
  ): Promise<messages> {
    const existing = await this.repository.findById(businessId, messageId);
    if (!existing) {
      throw new NotFoundException(`Message ${messageId} not found`);
    }

    return this.repository.attachAIMetadata(businessId, messageId, {
      is_ai_generated: metadata.isAiGenerated,
      confidence_score: metadata.confidenceScore,
      ai_decision_id: metadata.aiDecisionId,
    });
  }

  // ─────────────────────────────────────────────
  // Media attachments
  // ─────────────────────────────────────────────

  /**
   * Attach an S3-backed media file to an existing message. The `storageKey`
   * must point at GoSumo storage — never an external channel CDN URL.
   */
  async attachMedia(
    businessId: string,
    messageId: string,
    dto: AttachMediaDto,
  ): Promise<file_uploads> {
    await this.getMessageById(businessId, messageId);
    return this.repository.createFileUpload({
      business_id: businessId,
      message_id: messageId,
      type: resolveFileUploadType(dto.type),
      filename: dto.filename,
      mime_type: dto.mimeType,
      size_bytes: dto.sizeBytes,
      storage_key: dto.storageKey,
      cdn_url: dto.cdnUrl,
      width: dto.width,
      height: dto.height,
      is_public: dto.isPublic,
    });
  }

  /** List media files attached to a message. */
  async getMessageMedia(
    businessId: string,
    messageId: string,
  ): Promise<file_uploads[]> {
    await this.getMessageById(businessId, messageId);
    return this.repository.findFileUploadsByMessage(businessId, messageId);
  }

  // ─────────────────────────────────────────────
  // Reactions
  // ─────────────────────────────────────────────

  /** Add (or replace, per sender) a reaction emoji on a message. */
  async addReaction(
    businessId: string,
    messageId: string,
    dto: ReactionDto,
  ): Promise<messages> {
    const message = await this.getMessageById(businessId, messageId);
    const current = this.readReactions(message);
    // One reaction per sender — replace any existing entry.
    const next = current.filter((r) => r.senderId !== dto.senderId);
    next.push({
      emoji: dto.emoji,
      senderId: dto.senderId,
      at: new Date().toISOString(),
    });
    return this.repository.setReactions(messageId, next);
  }

  /** Remove a sender's reaction from a message. */
  async removeReaction(
    businessId: string,
    messageId: string,
    senderId: string,
  ): Promise<messages> {
    const message = await this.getMessageById(businessId, messageId);
    const next = this.readReactions(message).filter(
      (r) => r.senderId !== senderId,
    );
    return this.repository.setReactions(messageId, next);
  }

  // ─────────────────────────────────────────────
  // Threading
  // ─────────────────────────────────────────────

  /**
   * Return a message together with its direct replies (messages whose
   * metadata `reply_to_message_id` points at it).
   */
  async getMessageThread(
    businessId: string,
    messageId: string,
  ): Promise<{ root: messages; replies: messages[] }> {
    const root = await this.getMessageById(businessId, messageId);
    const replies = await this.repository.findReplies(businessId, messageId);
    return { root, replies };
  }

  // ─────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────

  /** Aggregate message counts for a conversation. */
  async getMessageStats(
    businessId: string,
    conversationId: string,
  ): Promise<MessageStats> {
    return this.repository.getStats(businessId, conversationId);
  }

  // ─────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────

  /**
   * message.sent → mark the outbound message SENT (matched by external id).
   */
  @OnEvent('message.sent')
  async handleMessageSent(event: MessageSentEvent): Promise<void> {
    if (!event.externalMessageId) return;
    try {
      const message = await this.repository.findByExternalId(
        event.externalMessageId,
      );
      if (!message || message.business_id !== event.businessId) return;
      await this.repository.updateStatus(
        event.businessId,
        message.id,
        MessageStatus.SENT,
        {},
      );
    } catch (error) {
      this.logger.debug(
        `Could not apply message.sent for ${event.externalMessageId}: ${this.errMsg(error)}`,
      );
    }
  }

  /**
   * message.failed → mark the outbound message FAILED with the failure reason.
   */
  @OnEvent('message.failed')
  async handleMessageFailed(event: MessageFailedEvent): Promise<void> {
    try {
      const message = await this.repository.findById(
        event.businessId,
        event.messageId,
      );
      if (!message) return;
      await this.repository.updateStatus(
        event.businessId,
        message.id,
        MessageStatus.FAILED,
        { failedAt: new Date().toISOString(), failureReason: event.reason },
      );
    } catch (error) {
      this.logger.debug(
        `Could not apply message.failed for ${event.messageId}: ${this.errMsg(error)}`,
      );
    }
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  /** Merge caller metadata with the optional reply-threading pointer. */
  private buildMetadata(
    metadata: Record<string, unknown> | undefined,
    replyToMessageId: string | undefined,
  ): Prisma.InputJsonValue | undefined {
    if (!metadata && !replyToMessageId) return undefined;
    return {
      ...(metadata ?? {}),
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    } as Prisma.InputJsonValue;
  }

  /**
   * If the content payload carries a media attachment with an S3 storage key,
   * persist a file_uploads row referencing it.
   */
  private async persistMediaFromContent(
    businessId: string,
    messageId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    const type = String(content?.type ?? '').toUpperCase();
    if (!MEDIA_CONTENT_TYPES.includes(type)) return;

    const storageKey =
      (content.storageKey as string) ?? (content.storage_key as string);
    if (!storageKey) return; // media not yet re-uploaded to GoSumo storage

    try {
      await this.repository.createFileUpload({
        business_id: businessId,
        message_id: messageId,
        type: resolveFileUploadType(type),
        filename: (content.filename as string) ?? `${type.toLowerCase()}-${messageId}`,
        mime_type: (content.mimeType as string) ?? 'application/octet-stream',
        size_bytes: Number(content.sizeBytes ?? 0),
        storage_key: storageKey,
        cdn_url: (content.url as string) ?? undefined,
        width: content.width ? Number(content.width) : undefined,
        height: content.height ? Number(content.height) : undefined,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to persist media for message ${messageId}: ${this.errMsg(error)}`,
      );
    }
  }

  /** Safely read the reactions JSON array off a message row. */
  private readReactions(message: messages): MessageReaction[] {
    const raw = message.reactions;
    return Array.isArray(raw) ? (raw as unknown as MessageReaction[]) : [];
  }

  private errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Emit a MessageStoredEvent for downstream consumers.
   */
  private emitMessageStoredEvent(message: messages, channel: ChannelType): void {
    const event: MessageStoredEvent = {
      type: 'message.stored',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId: message.business_id,
      correlationId: generateCorrelationId(),
      messageId: message.id,
      conversationId: message.conversation_id,
      channelAccountId: message.channel_account_id,
      channel,
      direction: message.direction,
      senderType: message.sender_type,
    };

    this.eventEmitter.emit('message.stored', event);
  }

  /**
   * Encode a pagination cursor to a base64 string.
   */
  private encodeCursor(cursor: PaginationCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64');
  }

  /**
   * Decode a base64 pagination cursor string.
   * Throws BadRequestException if the cursor is invalid.
   */
  private decodeCursor(encoded: string): PaginationCursor {
    try {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const parsed = JSON.parse(decoded) as PaginationCursor;

      if (!parsed.createdAt || !parsed.id) {
        throw new Error('Missing cursor fields');
      }

      return parsed;
    } catch {
      throw new BadRequestException('Invalid pagination cursor');
    }
  }
}
