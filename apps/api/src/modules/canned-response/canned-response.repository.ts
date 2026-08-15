import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { canned_responses } from '@prisma/client';
import { ChannelType } from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';
import { escapeLikeTerm } from '../../common/utils/search-pattern.util';

export interface CannedResponseListFilters {
  search?: string;
  category?: string;
  channel?: ChannelType;
  tag?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
}

export interface PaginatedCannedResponses {
  data: canned_responses[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CreateCannedResponseData {
  title: string;
  shortcut: string;
  content: string;
  category?: string;
  channel?: ChannelType;
  tags?: string[];
  isActive?: boolean;
  createdBy?: string;
}

export interface UpdateCannedResponseData {
  title?: string;
  content?: string;
  category?: string | null;
  channel?: ChannelType | null;
  tags?: string[];
  isActive?: boolean;
}

/**
 * CannedResponseRepository — all Prisma access for the canned-response module.
 */
@Injectable()
export class CannedResponseRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(businessId: string, data: CreateCannedResponseData): Promise<canned_responses> {
    return this.prisma.canned_responses.create({
      data: {
        business_id: businessId,
        title: data.title,
        shortcut: data.shortcut,
        content: data.content,
        category: data.category,
        channel: data.channel,
        tags: data.tags ?? [],
        is_active: data.isActive ?? true,
        created_by: data.createdBy,
      },
    });
  }

  async findMany(
    businessId: string,
    filters: CannedResponseListFilters,
  ): Promise<PaginatedCannedResponses> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const where = this.buildWhere(businessId, filters);

    const [data, total] = await Promise.all([
      this.prisma.canned_responses.findMany({
        where,
        orderBy: [{ usage_count: 'desc' }, { title: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.canned_responses.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async findById(businessId: string, id: string): Promise<canned_responses | null> {
    return this.prisma.canned_responses.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async findByShortcut(businessId: string, shortcut: string): Promise<canned_responses | null> {
    return this.prisma.canned_responses.findFirst({
      where: { business_id: businessId, shortcut, deleted_at: null },
    });
  }

  /**
   * A soft-deleted row still holding `shortcut`. The `(business_id, shortcut)`
   * unique index does not exclude deleted rows, so such a row keeps the shortcut
   * reserved even though nothing in the UI shows it.
   */
  async findDeletedByShortcut(
    businessId: string,
    shortcut: string,
  ): Promise<canned_responses | null> {
    return this.prisma.canned_responses.findFirst({
      where: { business_id: businessId, shortcut, deleted_at: { not: null } },
    });
  }

  /**
   * Revive a soft-deleted row as a brand-new canned response: every field is
   * overwritten from `data` and `usage_count` restarts at zero, so the caller
   * gets the row it asked to create rather than the deleted one's history.
   */
  async restore(
    businessId: string,
    id: string,
    data: CreateCannedResponseData,
  ): Promise<canned_responses> {
    return this.prisma.canned_responses.update({
      where: { id, business_id: businessId },
      data: {
        title: data.title,
        content: data.content,
        category: data.category ?? null,
        channel: data.channel ?? null,
        tags: data.tags ?? [],
        is_active: data.isActive ?? true,
        created_by: data.createdBy ?? null,
        usage_count: 0,
        deleted_at: null,
      },
    });
  }

  async update(businessId: string, id: string, data: UpdateCannedResponseData): Promise<canned_responses> {
    return this.prisma.canned_responses.update({
      where: { id, business_id: businessId },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.content !== undefined ? { content: data.content } : {}),
        ...(data.category !== undefined ? { category: data.category } : {}),
        ...(data.channel !== undefined ? { channel: data.channel } : {}),
        ...(data.tags !== undefined ? { tags: data.tags } : {}),
        ...(data.isActive !== undefined ? { is_active: data.isActive } : {}),
      },
    });
  }

  async softDelete(businessId: string, id: string): Promise<void> {
    await this.prisma.canned_responses.update({
      where: { id, business_id: businessId },
      data: { deleted_at: new Date() },
    });
  }

  async incrementUsage(businessId: string, id: string): Promise<canned_responses> {
    return this.prisma.canned_responses.update({
      where: { id, business_id: businessId },
      data: { usage_count: { increment: 1 } },
    });
  }

  private buildWhere(
    businessId: string,
    filters: CannedResponseListFilters,
  ): Prisma.canned_responsesWhereInput {
    const where: Prisma.canned_responsesWhereInput = { business_id: businessId, deleted_at: null };
    const and: Prisma.canned_responsesWhereInput[] = [];

    if (filters.search) {
      // Escaped so `%`/`_` are searched for, not executed as LIKE wildcards.
      const search = escapeLikeTerm(filters.search);
      and.push({
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { content: { contains: search, mode: 'insensitive' } },
          { shortcut: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
    if (filters.category) {
      where.category = filters.category;
    }
    if (filters.channel) {
      // A canned response with no channel is usable on every channel.
      and.push({ OR: [{ channel: filters.channel }, { channel: null }] });
    }
    if (filters.tag) {
      where.tags = { has: filters.tag };
    }
    if (filters.isActive !== undefined) {
      where.is_active = filters.isActive;
    }
    if (and.length) {
      where.AND = and;
    }

    return where;
  }
}
