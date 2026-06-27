import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { ConversationStatus, ChannelType } from '@gosumo/shared';
import type { conversations } from '@prisma/client';

// ─────────────────────────────────────────────
// Filter & pagination types
// ─────────────────────────────────────────────

export interface ConversationListFilters {
  status?: ConversationStatus;
  channel?: ChannelType;
  assigneeId?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedConversations {
  data: conversations[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CreateConversationData {
  businessId: string;
  clientId: string;
  channelAccountId: string;
  channel: ChannelType;
}

/**
 * ConversationRepository — all Prisma queries for the Conversation module.
 *
 * Every query includes businessId scoping. Soft-deleted records
 * are excluded by default (deleted_at: null).
 */
@Injectable()
export class ConversationRepository {
  private readonly logger = new Logger(ConversationRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find a conversation by ID within a business scope.
   * Includes client and channel_account relations.
   */
  async findById(
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
        channel_account: true,
      },
    });
  }

  /**
   * Find an active (non-RESOLVED, non-deleted) conversation for a given
   * client and channel account within a business.
   */
  async findActiveByClientAndChannel(
    businessId: string,
    clientId: string,
    channelAccountId: string,
  ): Promise<conversations | null> {
    return this.prisma.conversations.findFirst({
      where: {
        business_id: businessId,
        client_id: clientId,
        channel_account_id: channelAccountId,
        status: { not: ConversationStatus.RESOLVED },
        deleted_at: null,
      },
      include: {
        client: true,
        channel_account: true,
      },
    });
  }

  /**
   * Create a new conversation with OPEN status.
   */
  async create(data: CreateConversationData): Promise<conversations> {
    return this.prisma.conversations.create({
      data: {
        business_id: data.businessId,
        client_id: data.clientId,
        channel_account_id: data.channelAccountId,
        channel: data.channel,
        status: ConversationStatus.OPEN,
        first_message_at: new Date(),
        last_message_at: new Date(),
        message_count: 0,
        unread_count: 0,
        human_message_count: 0,
        tags: [],
        metadata: {},
      },
      include: {
        client: true,
        channel_account: true,
      },
    });
  }

  /**
   * Update conversation status. Sets resolved_at when transitioning to RESOLVED.
   */
  async updateStatus(
    businessId: string,
    conversationId: string,
    status: ConversationStatus,
  ): Promise<conversations> {
    const updateData: Record<string, unknown> = { status };

    if (status === ConversationStatus.RESOLVED) {
      updateData['resolved_at'] = new Date();
    }

    return this.prisma.conversations.update({
      where: { id: conversationId },
      data: updateData,
    });
  }

  /**
   * List conversations for a business with optional filters, paginated.
   * Ordered by last_message_at DESC.
   */
  async list(
    businessId: string,
    filters: ConversationListFilters,
  ): Promise<PaginatedConversations> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      business_id: businessId,
      deleted_at: null,
    };

    if (filters.status) {
      where['status'] = filters.status;
    }
    if (filters.channel) {
      where['channel'] = filters.channel;
    }
    if (filters.assigneeId) {
      where['assigned_to'] = filters.assigneeId;
    }

    const [data, total] = await Promise.all([
      this.prisma.conversations.findMany({
        where,
        include: {
          client: true,
          channel_account: true,
        },
        orderBy: { last_message_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.conversations.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Update last_message_at timestamp and increment message_count.
   */
  async updateLastMessageAt(
    conversationId: string,
    timestamp: Date,
  ): Promise<conversations> {
    return this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        last_message_at: timestamp,
        message_count: { increment: 1 },
      },
    });
  }

  /**
   * Assign a conversation to a team member.
   */
  async assign(
    businessId: string,
    conversationId: string,
    assigneeId: string,
  ): Promise<conversations> {
    return this.prisma.conversations.update({
      where: { id: conversationId },
      data: { assigned_to: assigneeId },
    });
  }
}
