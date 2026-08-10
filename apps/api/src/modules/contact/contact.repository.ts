import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { clients, segments } from '@prisma/client';
import { ChannelType } from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';

// ─────────────────────────────────────────────
// Filter & pagination types
// ─────────────────────────────────────────────

export interface ContactListFilters {
  /** Free-text match across name, email, phone. */
  search?: string;
  /** Match any of these tags (OR semantics). */
  tags?: string[];
  channel?: ChannelType;
  minLtv?: number;
  maxChurnRisk?: number;
  minEngagement?: number;
  hasOrders?: boolean;
  page?: number;
  limit?: number;
}

export interface PaginatedClients {
  data: clients[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface UpdateContactData {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * The dynamic filter shape stored on `segments.filter` and evaluated
 * on-demand against `clients` — see contact.service.ts for validation.
 */
export interface SegmentFilter {
  tags?: string[];
  channels?: ChannelType[];
  minLtv?: number;
  maxChurnRisk?: number;
  minEngagement?: number;
  hasOrders?: boolean;
}

export interface CreateSegmentData {
  name: string;
  description?: string;
  filter: SegmentFilter;
  isActive?: boolean;
}

export interface UpdateSegmentData {
  name?: string;
  description?: string | null;
  filter?: SegmentFilter;
  isActive?: boolean;
}

/**
 * ContactRepository — all read/write Prisma access for the contact module.
 *
 * Contacts are the existing `clients` table; this module owns `segments`
 * and the `tags` column on `clients` (both introduced for contact
 * management/segmentation), but never owns client identity itself — that
 * remains channel-adapter/client-intelligence territory.
 */
@Injectable()
export class ContactRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────────────────────────────────────────────
  // Contacts (clients)
  // ───────────────────────────────────────────────────────────────────

  async findMany(businessId: string, filters: ContactListFilters): Promise<PaginatedClients> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;

    const where = this.buildWhere(businessId, filters);

    const [data, total] = await Promise.all([
      this.prisma.clients.findMany({
        where,
        orderBy: { last_interaction_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.clients.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  private buildWhere(businessId: string, filters: ContactListFilters): Prisma.clientsWhereInput {
    const where: Prisma.clientsWhereInput = { business_id: businessId, deleted_at: null };

    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
        { phone: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    if (filters.tags?.length) {
      where.tags = { hasSome: filters.tags };
    }
    if (filters.minLtv !== undefined) {
      where.ltv_score = { gte: filters.minLtv };
    }
    if (filters.maxChurnRisk !== undefined) {
      where.churn_risk = { lte: filters.maxChurnRisk };
    }
    if (filters.minEngagement !== undefined) {
      where.engagement_score = { gte: filters.minEngagement };
    }
    if (filters.hasOrders !== undefined) {
      where.total_orders = filters.hasOrders ? { gt: 0 } : { equals: 0 };
    }
    if (filters.channel) {
      where.channel_contacts = { some: { channel: filters.channel } };
    }

    return where;
  }

  async findById(businessId: string, id: string): Promise<clients | null> {
    return this.prisma.clients.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async update(businessId: string, id: string, data: UpdateContactData): Promise<clients> {
    return this.prisma.clients.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
      },
    });
  }

  /** Replace a contact's tag list wholesale (the service computes the merged/diffed set). */
  async setTags(businessId: string, id: string, tags: string[]): Promise<clients> {
    return this.prisma.clients.update({
      where: { id, business_id: businessId },
      data: { tags },
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Segment evaluation (dynamic filter against `clients`)
  // ───────────────────────────────────────────────────────────────────

  segmentFilterToWhere(businessId: string, filter: SegmentFilter): Prisma.clientsWhereInput {
    const where: Prisma.clientsWhereInput = { business_id: businessId, deleted_at: null };

    if (filter.tags?.length) {
      where.tags = { hasSome: filter.tags };
    }
    if (filter.minLtv !== undefined) {
      where.ltv_score = { gte: filter.minLtv };
    }
    if (filter.maxChurnRisk !== undefined) {
      where.churn_risk = { lte: filter.maxChurnRisk };
    }
    if (filter.minEngagement !== undefined) {
      where.engagement_score = { gte: filter.minEngagement };
    }
    if (filter.hasOrders !== undefined) {
      where.total_orders = filter.hasOrders ? { gt: 0 } : { equals: 0 };
    }
    if (filter.channels?.length) {
      where.channel_contacts = { some: { channel: { in: filter.channels } } };
    }

    return where;
  }

  async findBySegmentFilter(
    businessId: string,
    filter: SegmentFilter,
    page: number,
    limit: number,
  ): Promise<PaginatedClients> {
    const where = this.segmentFilterToWhere(businessId, filter);

    const [data, total] = await Promise.all([
      this.prisma.clients.findMany({
        where,
        orderBy: { last_interaction_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.clients.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async countBySegmentFilter(businessId: string, filter: SegmentFilter): Promise<number> {
    return this.prisma.clients.count({ where: this.segmentFilterToWhere(businessId, filter) });
  }

  // ───────────────────────────────────────────────────────────────────
  // Segments
  // ───────────────────────────────────────────────────────────────────

  async createSegment(businessId: string, data: CreateSegmentData): Promise<segments> {
    return this.prisma.segments.create({
      data: {
        business_id: businessId,
        name: data.name,
        description: data.description,
        filter: data.filter as unknown as Prisma.InputJsonValue,
        is_active: data.isActive ?? true,
      },
    });
  }

  async findSegments(businessId: string): Promise<segments[]> {
    return this.prisma.segments.findMany({
      where: { business_id: businessId, deleted_at: null },
      orderBy: { created_at: 'desc' },
    });
  }

  async findSegmentById(businessId: string, id: string): Promise<segments | null> {
    return this.prisma.segments.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async findSegmentByName(businessId: string, name: string): Promise<segments | null> {
    return this.prisma.segments.findFirst({
      where: { business_id: businessId, name, deleted_at: null },
    });
  }

  async updateSegment(businessId: string, id: string, data: UpdateSegmentData): Promise<segments> {
    return this.prisma.segments.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.filter !== undefined ? { filter: data.filter as unknown as Prisma.InputJsonValue } : {}),
        ...(data.isActive !== undefined ? { is_active: data.isActive } : {}),
      },
    });
  }

  async softDeleteSegment(businessId: string, id: string): Promise<void> {
    await this.prisma.segments.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
  }
}
