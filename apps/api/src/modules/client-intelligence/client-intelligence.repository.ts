import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { escapeLikeTerm } from '../../common/utils/search-pattern.util';
import { findOrCreateClientByIdentity } from '../../common/utils/client-identity.util';
import { isUniqueViolation } from '../../common/utils/sequential-number.util';
import { ChannelType, ResourceNotFoundError } from '@gosumo/shared';
import { Prisma, $Enums } from '@prisma/client';
import type { clients, channel_contacts } from '@prisma/client';
import { ChurnRiskLevel } from './dto';

// ─────────────────────────────────────────────
// Data interfaces
// ─────────────────────────────────────────────

export interface CreateClientData {
  businessId: string;
  name?: string;
  email?: string;
  phone?: string;
  avatarUrl?: string;
  profile?: Record<string, unknown>;
}

export interface UpdateClientData {
  name?: string;
  email?: string;
  phone?: string;
  avatarUrl?: string;
  profile?: Record<string, unknown>;
  ltvScore?: number;
  churnRisk?: number;
  engagementScore?: number;
  totalOrders?: number;
  totalSpent?: number;
  lastInteractionAt?: Date;
  scoresUpdatedAt?: Date;
}

export interface CreateChannelContactData {
  businessId: string;
  clientId: string;
  channelAccountId: string;
  channel: ChannelType;
  externalId: string;
  displayName?: string;
  profilePicUrl?: string;
}

export interface ClientListFilters {
  search?: string;
  channelType?: ChannelType;
  churnRisk?: ChurnRiskLevel;
  page?: number;
  limit?: number;
}

export interface PaginatedClientRecords {
  data: ClientWithContacts[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export type ClientWithContacts = clients & {
  channel_contacts: channel_contacts[];
};

// ─────────────────────────────────────────────
// Timeline row shapes (subset selects)
// ─────────────────────────────────────────────

export interface TimelineConversationRow {
  id: string;
  channel: $Enums.ChannelType;
  status: $Enums.ConversationStatus;
  subject: string | null;
  created_at: Date;
  last_message_at: Date | null;
}

export interface TimelineOrderRow {
  id: string;
  order_number: string;
  status: $Enums.OrderStatus;
  total: Prisma.Decimal;
  placed_at: Date;
}

export interface TimelineBookingRow {
  id: string;
  status: $Enums.BookingStatus;
  start_at: Date;
  created_at: Date;
}

export interface TimelinePaymentRow {
  id: string;
  status: $Enums.PaymentStatus;
  amount: Prisma.Decimal;
  method: $Enums.PaymentMethod | null;
  created_at: Date;
}

// ─────────────────────────────────────────────
// Churn risk range mapping
// ─────────────────────────────────────────────

const CHURN_RISK_RANGES: Record<ChurnRiskLevel, { min: number; max: number }> = {
  [ChurnRiskLevel.LOW]: { min: 0, max: 0.3 },
  [ChurnRiskLevel.MEDIUM]: { min: 0.31, max: 0.6 },
  [ChurnRiskLevel.HIGH]: { min: 0.61, max: 0.8 },
  [ChurnRiskLevel.CRITICAL]: { min: 0.81, max: 1.0 },
};

/**
 * ClientIntelligenceRepository — all Prisma queries for the client-intelligence module.
 *
 * Every query includes businessId scoping.
 */
@Injectable()
export class ClientIntelligenceRepository {
  private readonly logger = new Logger(ClientIntelligenceRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Default includes for client queries. */
  private readonly clientIncludes = {
    channel_contacts: true,
  } as const;

  // ─────────────────────────────────────────────
  // Client CRUD
  // ─────────────────────────────────────────────

  /**
   * Find or create a client by externalId + channelType.
   * Uses a channel_contact lookup first, then creates client + contact if none found.
   */
  async findOrCreateClient(
    businessId: string,
    externalId: string,
    channelType: ChannelType,
    channelAccountId: string,
    data: { name?: string; phone?: string; email?: string },
  ): Promise<ClientWithContacts> {
    // Check if a channel_contact already exists for this external ID + channel account
    const existingContact = await this.prisma.channel_contacts.findFirst({
      where: {
        business_id: businessId,
        channel_account_id: channelAccountId,
        external_id: externalId,
      },
      include: {
        client: {
          include: this.clientIncludes,
        },
      },
    });

    if (existingContact) {
      // Update last_seen_at
      await this.prisma.channel_contacts.update({
        where: { id: existingContact.id, business_id: businessId },
        data: { last_seen_at: new Date() },
      });

      return existingContact.client as ClientWithContacts;
    }

    // No contact on this channel account — but the person may still be someone
    // this business already knows from another channel. `clients` is unique on
    // (business, phone) and (business, email), so creating unconditionally did
    // not produce a duplicate for a returning buyer: it raised P2002 and failed
    // the call. Resolve the identity first, and only insert when it is free.
    //
    // The two inserts no longer share a transaction, because the identity
    // resolution has to be able to re-read after a unique violation and a
    // failed statement leaves a Postgres transaction unusable. What that costs
    // is a stranded client row if the contact insert fails; what it buys is
    // that a returning buyer resolves at all. The stranded row also heals
    // itself — it holds the identity, so the sender's next message claims it.
    const resolved = await findOrCreateClientByIdentity(
      this.prisma.clients,
      businessId,
      { phone: data.phone, email: data.email },
      data.name,
    );

    try {
      await this.prisma.channel_contacts.create({
        data: {
          business_id: businessId,
          client_id: resolved.id,
          channel_account_id: channelAccountId,
          channel: channelType,
          external_id: externalId,
          display_name: data.name ?? null,
          channel_metadata: {} as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // `[channel_account_id, external_id]` is unique: another first message
      // from this same sender got there between our lookup and this insert.
      // The row it wrote is the one we were about to write.
      if (!isUniqueViolation(err)) throw err;
    }

    const result = await this.prisma.clients.findFirstOrThrow({
      where: { id: resolved.id, business_id: businessId },
      include: this.clientIncludes,
    });

    return result as ClientWithContacts;
  }

  /**
   * Get a client by ID within a business scope.
   */
  async getClientById(
    businessId: string,
    clientId: string,
  ): Promise<ClientWithContacts | null> {
    const result = await this.prisma.clients.findFirst({
      where: {
        id: clientId,
        business_id: businessId,
        deleted_at: null,
      },
      include: this.clientIncludes,
    });

    return result as ClientWithContacts | null;
  }

  /**
   * Get a client by external ID and channel type within a business scope.
   */
  async getClientByExternalId(
    businessId: string,
    externalId: string,
    channelType: ChannelType,
  ): Promise<ClientWithContacts | null> {
    const contact = await this.prisma.channel_contacts.findFirst({
      where: {
        business_id: businessId,
        external_id: externalId,
        channel: channelType,
      },
      include: {
        client: {
          include: this.clientIncludes,
        },
      },
    });

    if (!contact || contact.client.deleted_at) {
      return null;
    }

    return contact.client as ClientWithContacts;
  }

  /**
   * Update a client profile.
   */
  async updateClientProfile(
    businessId: string,
    clientId: string,
    data: UpdateClientData,
  ): Promise<ClientWithContacts> {
    // Verify business scope
    const existing = await this.prisma.clients.findFirst({
      where: {
        id: clientId,
        business_id: businessId,
        deleted_at: null,
      },
    });

    if (!existing) {
      throw new ResourceNotFoundError('Client', clientId, {
        context: { businessId },
      });
    }

    const updateData: Record<string, unknown> = {};

    if (data.name !== undefined) updateData['name'] = data.name;
    if (data.email !== undefined) updateData['email'] = data.email;
    if (data.phone !== undefined) updateData['phone'] = data.phone;
    if (data.avatarUrl !== undefined) updateData['avatar_url'] = data.avatarUrl;
    if (data.ltvScore !== undefined) updateData['ltv_score'] = data.ltvScore;
    if (data.churnRisk !== undefined) updateData['churn_risk'] = data.churnRisk;
    if (data.engagementScore !== undefined) updateData['engagement_score'] = data.engagementScore;
    if (data.totalOrders !== undefined) updateData['total_orders'] = data.totalOrders;
    if (data.totalSpent !== undefined) updateData['total_spent'] = data.totalSpent;
    if (data.lastInteractionAt !== undefined) updateData['last_interaction_at'] = data.lastInteractionAt;
    if (data.scoresUpdatedAt !== undefined) updateData['scores_updated_at'] = data.scoresUpdatedAt;
    if (data.profile !== undefined) {
      // Merge profile data with existing profile
      const existingProfile = (existing.profile as Record<string, unknown>) ?? {};
      updateData['profile'] = { ...existingProfile, ...data.profile } as Prisma.InputJsonValue;
    }

    const result = await this.prisma.clients.update({
      where: { id: clientId, business_id: businessId },
      data: updateData,
      include: this.clientIncludes,
    });

    return result as ClientWithContacts;
  }

  /**
   * List clients for a business with optional filters, paginated.
   */
  async listClients(
    businessId: string,
    filters: ClientListFilters,
  ): Promise<PaginatedClientRecords> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.clientsWhereInput = {
      business_id: businessId,
      deleted_at: null,
    };

    // Text search across name, email, phone
    if (filters.search) {
      // Escaped so `%`/`_` are searched for, not executed as LIKE wildcards.
      const searchTerm = escapeLikeTerm(filters.search);
      where.OR = [
        { name: { contains: searchTerm, mode: 'insensitive' } },
        { email: { contains: searchTerm, mode: 'insensitive' } },
        { phone: { contains: searchTerm } },
      ];
    }

    // Filter by channel type: find clients who have a contact on this channel
    if (filters.channelType) {
      where.channel_contacts = {
        some: {
          channel: filters.channelType,
        },
      };
    }

    // Filter by churn risk level
    if (filters.churnRisk) {
      const range = CHURN_RISK_RANGES[filters.churnRisk];
      where.churn_risk = {
        gte: range.min,
        lte: range.max,
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.clients.findMany({
        where,
        include: this.clientIncludes,
        orderBy: [{ last_interaction_at: { sort: 'desc', nulls: 'last' } }],
        skip,
        take: limit,
      }),
      this.prisma.clients.count({ where }),
    ]);

    return {
      data: data as ClientWithContacts[],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Merge two clients: move all relations from secondary to primary, then soft-delete secondary.
   * Runs in a transaction.
   */
  async mergeClients(
    businessId: string,
    primaryId: string,
    secondaryId: string,
  ): Promise<ClientWithContacts> {
    return this.prisma.$transaction(async (tx) => {
      // Verify both clients belong to this business
      const [primary, secondary] = await Promise.all([
        tx.clients.findFirst({
          where: { id: primaryId, business_id: businessId, deleted_at: null },
        }),
        tx.clients.findFirst({
          where: { id: secondaryId, business_id: businessId, deleted_at: null },
        }),
      ]);

      // Both sides report the same message; `resourceId` in the context is
      // what says which of the two was missing.
      if (!primary) {
        throw new ResourceNotFoundError('Client', primaryId, {
          context: { businessId, role: 'primary' },
        });
      }
      if (!secondary) {
        throw new ResourceNotFoundError('Client', secondaryId, {
          context: { businessId, role: 'secondary' },
        });
      }

      // Move channel_contacts from secondary to primary
      await tx.channel_contacts.updateMany({
        where: { client_id: secondaryId, business_id: businessId },
        data: { client_id: primaryId },
      });

      // Move conversations from secondary to primary
      await tx.conversations.updateMany({
        where: { client_id: secondaryId, business_id: businessId },
        data: { client_id: primaryId },
      });

      // Move orders from secondary to primary
      await tx.orders.updateMany({
        where: { client_id: secondaryId, business_id: businessId },
        data: { client_id: primaryId },
      });

      // Move bookings from secondary to primary
      await tx.bookings.updateMany({
        where: { client_id: secondaryId, business_id: businessId },
        data: { client_id: primaryId },
      });

      // Move payments from secondary to primary
      await tx.payments.updateMany({
        where: { client_id: secondaryId, business_id: businessId },
        data: { client_id: primaryId },
      });

      // Move shipping addresses from secondary to primary
      await tx.shipping_addresses.updateMany({
        where: { client_id: secondaryId, business_id: businessId },
        data: { client_id: primaryId },
      });

      // Merge aggregate stats
      const mergedTotalOrders = primary.total_orders + secondary.total_orders;
      const mergedTotalSpent = primary.total_spent.toNumber() + secondary.total_spent.toNumber();

      // Determine latest interaction
      const latestInteraction = [primary.last_interaction_at, secondary.last_interaction_at]
        .filter((d): d is Date => d !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

      // Merge profile metadata
      const primaryProfile = (primary.profile as Record<string, unknown>) ?? {};
      const secondaryProfile = (secondary.profile as Record<string, unknown>) ?? {};
      const mergedProfile = { ...secondaryProfile, ...primaryProfile };

      // Soft-delete secondary, releasing the identifiers primary is about to
      // inherit.
      //
      // This has to happen *before* the primary update, and it has to null the
      // columns rather than only stamping `deleted_at`. `uq_clients_business_
      // phone` and `uq_clients_business_email` do not exclude soft-deleted
      // rows, so a tombstone keeps owning its phone number: merging a
      // phone-only client into an email-only one asked Postgres for two rows
      // with the same phone and lost, failing the whole merge — the exact
      // operation whose entire purpose is to collapse a duplicate identity.
      //
      // Clearing them also keeps the tombstone from matching in
      // `findOrCreateClientByIdentity`, so a later message from that number
      // reaches the surviving client instead of resurrecting the loser.
      await tx.clients.update({
        where: { id: secondaryId, business_id: businessId },
        data: { deleted_at: new Date(), phone: null, email: null },
      });

      // Update primary with merged data
      await tx.clients.update({
        where: { id: primaryId, business_id: businessId },
        data: {
          total_orders: mergedTotalOrders,
          total_spent: mergedTotalSpent,
          last_interaction_at: latestInteraction,
          profile: mergedProfile as Prisma.InputJsonValue,
          // Fill in any missing fields from secondary
          name: primary.name ?? secondary.name,
          email: primary.email ?? secondary.email,
          phone: primary.phone ?? secondary.phone,
          avatar_url: primary.avatar_url ?? secondary.avatar_url,
        },
      });

      // Return the updated primary
      const result = await tx.clients.findFirstOrThrow({
        where: { id: primaryId, business_id: businessId },
        include: this.clientIncludes,
      });

      return result as ClientWithContacts;
    });
  }

  // ─────────────────────────────────────────────
  // Intelligence scores
  // ─────────────────────────────────────────────

  /**
   * Update intelligence scores for a client.
   */
  async updateIntelligenceScores(
    businessId: string,
    clientId: string,
    scores: {
      churnRisk?: number;
      ltvScore?: number;
      engagementScore?: number;
    },
  ): Promise<ClientWithContacts> {
    const existing = await this.prisma.clients.findFirst({
      where: { id: clientId, business_id: businessId, deleted_at: null },
    });

    if (!existing) {
      throw new ResourceNotFoundError('Client', clientId, {
        context: { businessId },
      });
    }

    return this.writeIntelligenceScores(businessId, clientId, scores);
  }

  /**
   * Write intelligence scores without an existence check.
   * Use when the caller has already verified the client exists.
   */
  async writeIntelligenceScores(
    businessId: string,
    clientId: string,
    scores: {
      churnRisk?: number;
      ltvScore?: number;
      engagementScore?: number;
    },
  ): Promise<ClientWithContacts> {
    const updateData: Record<string, unknown> = {
      scores_updated_at: new Date(),
    };

    if (scores.churnRisk !== undefined) updateData['churn_risk'] = scores.churnRisk;
    if (scores.ltvScore !== undefined) updateData['ltv_score'] = scores.ltvScore;
    if (scores.engagementScore !== undefined) updateData['engagement_score'] = scores.engagementScore;

    const result = await this.prisma.clients.update({
      where: { id: clientId, business_id: businessId },
      data: updateData,
      include: this.clientIncludes,
    });

    return result as ClientWithContacts;
  }

  // ─────────────────────────────────────────────
  // Channel contacts
  // ─────────────────────────────────────────────

  /**
   * Create a channel contact mapping.
   */
  async createChannelContact(data: CreateChannelContactData): Promise<channel_contacts> {
    return this.prisma.channel_contacts.create({
      data: {
        business_id: data.businessId,
        client_id: data.clientId,
        channel_account_id: data.channelAccountId,
        channel: data.channel,
        external_id: data.externalId,
        display_name: data.displayName ?? null,
        profile_pic_url: data.profilePicUrl ?? null,
        channel_metadata: {} as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Find a channel contact by channel account + external ID.
   */
  async findChannelContact(
    businessId: string,
    channelAccountId: string,
    externalId: string,
  ): Promise<channel_contacts | null> {
    return this.prisma.channel_contacts.findFirst({
      where: {
        business_id: businessId,
        channel_account_id: channelAccountId,
        external_id: externalId,
      },
    });
  }

  // ─────────────────────────────────────────────
  // Order aggregation (for LTV)
  // ─────────────────────────────────────────────

  /**
   * Get aggregate order data for a client (delivered/completed orders only).
   */
  async getClientOrderAggregates(
    businessId: string,
    clientId: string,
  ): Promise<{ totalRevenue: number; orderCount: number }> {
    const result = await this.prisma.orders.aggregate({
      where: {
        business_id: businessId,
        client_id: clientId,
        status: { in: ['DELIVERED', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED'] },
        deleted_at: null,
      },
      _sum: { total: true },
      _count: { id: true },
    });

    return {
      totalRevenue: result._sum.total?.toNumber() ?? 0,
      orderCount: result._count.id,
    };
  }

  /**
   * Get the latest interaction timestamps for RFM calculation.
   */
  async getClientRFMData(
    businessId: string,
    clientId: string,
  ): Promise<{
    lastInteractionAt: Date | null;
    lastOrderAt: Date | null;
    orderCount: number;
    totalSpent: number;
    firstSeenAt: Date;
  }> {
    const client = await this.prisma.clients.findFirst({
      where: { id: clientId, business_id: businessId, deleted_at: null },
      select: {
        last_interaction_at: true,
        total_orders: true,
        total_spent: true,
        first_seen_at: true,
      },
    });

    if (!client) {
      throw new ResourceNotFoundError('Client', clientId, {
        context: { businessId },
      });
    }

    return this.buildRFMData(businessId, clientId, client);
  }

  /**
   * Build RFM data from an already-loaded client, querying only the latest order date.
   * Saves a redundant client read when the caller already has the row.
   */
  async getRFMDataFromClient(
    businessId: string,
    clientId: string,
    client: Pick<clients, 'last_interaction_at' | 'total_orders' | 'total_spent' | 'first_seen_at'>,
  ): Promise<{
    lastInteractionAt: Date | null;
    lastOrderAt: Date | null;
    orderCount: number;
    totalSpent: number;
    firstSeenAt: Date;
  }> {
    return this.buildRFMData(businessId, clientId, client);
  }

  private async buildRFMData(
    businessId: string,
    clientId: string,
    client: Pick<clients, 'last_interaction_at' | 'total_orders' | 'total_spent' | 'first_seen_at'>,
  ): Promise<{
    lastInteractionAt: Date | null;
    lastOrderAt: Date | null;
    orderCount: number;
    totalSpent: number;
    firstSeenAt: Date;
  }> {
    const latestOrder = await this.prisma.orders.findFirst({
      where: {
        business_id: businessId,
        client_id: clientId,
        deleted_at: null,
      },
      orderBy: { placed_at: 'desc' },
      select: { placed_at: true },
    });

    return {
      lastInteractionAt: client.last_interaction_at,
      lastOrderAt: latestOrder?.placed_at ?? null,
      orderCount: client.total_orders,
      totalSpent: client.total_spent.toNumber(),
      firstSeenAt: client.first_seen_at,
    };
  }

  // ─────────────────────────────────────────────
  // Timeline aggregation
  // ─────────────────────────────────────────────

  /**
   * Fetch the raw building blocks of a client's interaction timeline:
   * conversations, orders, bookings, and payments. Each list is capped at
   * `limit` (most recent first); the service merges + sorts them into one
   * chronological stream. All queries are businessId + clientId scoped and
   * exclude soft-deleted records.
   */
  async getClientTimelineData(
    businessId: string,
    clientId: string,
    limit: number,
  ): Promise<{
    conversations: TimelineConversationRow[];
    orders: TimelineOrderRow[];
    bookings: TimelineBookingRow[];
    payments: TimelinePaymentRow[];
  }> {
    const [conversations, orders, bookings, payments] = await Promise.all([
      this.prisma.conversations.findMany({
        where: { business_id: businessId, client_id: clientId, deleted_at: null },
        select: {
          id: true,
          channel: true,
          status: true,
          subject: true,
          created_at: true,
          last_message_at: true,
        },
        orderBy: { created_at: 'desc' },
        take: limit,
      }),
      this.prisma.orders.findMany({
        where: { business_id: businessId, client_id: clientId, deleted_at: null },
        select: {
          id: true,
          order_number: true,
          status: true,
          total: true,
          placed_at: true,
        },
        orderBy: { placed_at: 'desc' },
        take: limit,
      }),
      this.prisma.bookings.findMany({
        where: { business_id: businessId, client_id: clientId, deleted_at: null },
        select: {
          id: true,
          status: true,
          start_at: true,
          created_at: true,
        },
        orderBy: { created_at: 'desc' },
        take: limit,
      }),
      this.prisma.payments.findMany({
        where: { business_id: businessId, client_id: clientId },
        select: {
          id: true,
          status: true,
          amount: true,
          method: true,
          created_at: true,
        },
        orderBy: { created_at: 'desc' },
        take: limit,
      }),
    ]);

    return { conversations, orders, bookings, payments };
  }
}
