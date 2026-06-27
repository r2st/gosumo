import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { conversations } from '@prisma/client';
import {
  ConversationStatus,
  ChannelType,
  generateId,
  generateCorrelationId,
  MessageReceivedEvent,
  ConversationCreatedEvent,
  ConversationStatusChangedEvent,
  ConversationAssignedEvent,
} from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';
import { ConversationRepository, PaginatedConversations } from './conversation.repository';
import { ListConversationsQueryDto } from './dto';

// ─────────────────────────────────────────────
// State machine: valid status transitions
// ─────────────────────────────────────────────

const VALID_TRANSITIONS: Record<ConversationStatus, ConversationStatus[]> = {
  [ConversationStatus.OPEN]: [
    ConversationStatus.PENDING_HUMAN,
    ConversationStatus.ESCALATED,
    ConversationStatus.RESOLVED,
    ConversationStatus.SNOOZED,
  ],
  [ConversationStatus.PENDING_HUMAN]: [
    ConversationStatus.OPEN,
    ConversationStatus.ESCALATED,
    ConversationStatus.RESOLVED,
  ],
  [ConversationStatus.ESCALATED]: [
    ConversationStatus.OPEN,
    ConversationStatus.RESOLVED,
  ],
  [ConversationStatus.RESOLVED]: [
    ConversationStatus.OPEN,
  ],
  [ConversationStatus.SNOOZED]: [
    ConversationStatus.OPEN,
  ],
};

// ─────────────────────────────────────────────
// Context response type
// ─────────────────────────────────────────────

interface ConversationContext {
  conversation: conversations;
  messages: unknown[];
  client: unknown;
}

/**
 * ConversationService — core business logic for the Conversation module.
 *
 * Handles conversation lifecycle: creation, status transitions, assignment,
 * and context loading for the AI engine.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly repository: ConversationRepository,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Find an active conversation for the given client + channel account,
   * or create a new one if none exists.
   *
   * Emits `conversation.created` when a new conversation is created.
   */
  async findOrCreate(
    businessId: string,
    dto: { clientId: string; channelAccountId: string; channel: ChannelType },
  ): Promise<conversations> {
    // Look for an existing non-RESOLVED conversation
    const existing = await this.repository.findActiveByClientAndChannel(
      businessId,
      dto.clientId,
      dto.channelAccountId,
    );

    if (existing) {
      this.logger.debug(
        `Found active conversation ${existing.id} for client ${dto.clientId} on ${dto.channel}`,
      );
      return existing;
    }

    // Create a new OPEN conversation
    const conversation = await this.repository.create({
      businessId,
      clientId: dto.clientId,
      channelAccountId: dto.channelAccountId,
      channel: dto.channel,
    });

    const event: ConversationCreatedEvent = {
      type: 'conversation.created',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId: conversation.id,
      clientId: dto.clientId,
      channelAccountId: dto.channelAccountId,
      channel: dto.channel,
    };

    this.eventEmitter.emit('conversation.created', event);

    this.logger.log(
      `Created conversation ${conversation.id} for client ${dto.clientId} on ${dto.channel}`,
    );

    return conversation;
  }

  /**
   * Get a single conversation by ID with relations.
   * Throws NotFoundException if not found.
   */
  async getConversation(businessId: string, id: string): Promise<conversations> {
    const conversation = await this.repository.findById(businessId, id);

    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${id}`);
    }

    return conversation;
  }

  /**
   * List conversations with optional filters, paginated.
   */
  async listConversations(
    businessId: string,
    query: ListConversationsQueryDto,
  ): Promise<PaginatedConversations> {
    return this.repository.list(businessId, {
      status: query.status,
      channel: query.channel,
      assigneeId: query.assigneeId,
      page: query.page,
      limit: query.limit,
    });
  }

  /**
   * Update the status of a conversation.
   * Validates the state transition using the VALID_TRANSITIONS map.
   *
   * Emits `conversation.status.changed` on success.
   */
  async updateStatus(
    businessId: string,
    id: string,
    newStatus: ConversationStatus,
    actorId?: string,
  ): Promise<conversations> {
    const conversation = await this.repository.findById(businessId, id);

    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${id}`);
    }

    const currentStatus = conversation.status as ConversationStatus;
    const allowed = VALID_TRANSITIONS[currentStatus];

    if (!allowed || !allowed.includes(newStatus)) {
      throw new BadRequestException(
        `Invalid status transition: ${currentStatus} → ${newStatus}`,
      );
    }

    const updated = await this.repository.updateStatus(businessId, id, newStatus);

    const event: ConversationStatusChangedEvent = {
      type: 'conversation.status.changed',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId: id,
      clientId: conversation.client_id,
      previousStatus: currentStatus,
      newStatus,
      actorId,
    };

    this.eventEmitter.emit('conversation.status.changed', event);

    this.logger.log(
      `Conversation ${id} status changed: ${currentStatus} → ${newStatus}`,
    );

    return updated;
  }

  /**
   * Assign a conversation to a team member.
   *
   * Emits `conversation.assigned` on success.
   */
  async assignConversation(
    businessId: string,
    id: string,
    assigneeId: string,
  ): Promise<conversations> {
    const conversation = await this.repository.findById(businessId, id);

    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${id}`);
    }

    const previousAssigneeId = conversation.assigned_to ?? undefined;

    const updated = await this.repository.assign(businessId, id, assigneeId);

    const event: ConversationAssignedEvent = {
      type: 'conversation.assigned',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId: id,
      clientId: conversation.client_id,
      assigneeId,
      previousAssigneeId,
    };

    this.eventEmitter.emit('conversation.assigned', event);

    this.logger.log(
      `Conversation ${id} assigned to ${assigneeId}`,
    );

    return updated;
  }

  /**
   * Load conversation context for the AI engine.
   *
   * Returns the conversation (with client relation), the last 20 messages,
   * and the client profile.
   */
  async getConversationContext(
    businessId: string,
    id: string,
  ): Promise<ConversationContext> {
    const conversation = await this.repository.findById(businessId, id);

    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${id}`);
    }

    const messages = await this.prisma.messages.findMany({
      where: {
        conversation_id: id,
        business_id: businessId,
      },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: {
        id: true,
        direction: true,
        type: true,
        sender_type: true,
        sender_id: true,
        content: true,
        text_content: true,
        created_at: true,
      },
    });

    // Reverse so messages are in chronological order
    const chronologicalMessages = messages.reverse();

    // Client is already included via the findById include
    const client = (conversation as Record<string, unknown>)['client'] ?? null;

    return {
      conversation,
      messages: chronologicalMessages,
      client,
    };
  }

  // ─────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────

  /**
   * Handle message.received events.
   *
   * When a new message arrives with a resolved clientId:
   * 1. Find or create a conversation for the client + channel.
   * 2. Update the conversation's last_message_at timestamp.
   */
  @OnEvent('message.received')
  async handleMessageReceived(event: MessageReceivedEvent): Promise<void> {
    // Only process if clientId has been resolved by client-intelligence module
    if (!event.clientId) {
      this.logger.debug(
        `Skipping message.received ${event.messageId}: clientId not yet resolved`,
      );
      return;
    }

    try {
      const conversation = await this.findOrCreate(event.businessId, {
        clientId: event.clientId,
        channelAccountId: event.channelAccountId,
        channel: event.channel,
      });

      await this.repository.updateLastMessageAt(
        conversation.id,
        new Date(),
      );

      this.logger.debug(
        `Processed message.received for conversation ${conversation.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle message.received for message ${event.messageId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
