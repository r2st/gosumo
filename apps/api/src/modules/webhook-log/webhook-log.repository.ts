import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { webhook_events } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

export interface WebhookEventListFilters {
  source?: string;
  eventType?: string;
  processed?: boolean;
  signatureValid?: boolean;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

export interface PaginatedWebhookEvents {
  data: webhook_events[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface WebhookEventStats {
  total: number;
  processed: number;
  unprocessed: number;
  invalidSignature: number;
  bySource: { source: string; count: number }[];
}

/**
 * WebhookLogRepository — read-only Prisma access over `webhook_events`.
 *
 * `webhook_events` is written by channel-adapter and payment (each inbound
 * webhook handler records its own delivery there) — this module never
 * writes to it, only reads, the same read-only-across-modules pattern
 * `analytics` uses for its dashboard queries.
 */
@Injectable()
export class WebhookLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(businessId: string, filters: WebhookEventListFilters): Promise<PaginatedWebhookEvents> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const where = this.buildWhere(businessId, filters);

    const [data, total] = await Promise.all([
      this.prisma.webhook_events.findMany({
        where,
        orderBy: { received_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.webhook_events.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async findById(businessId: string, id: string): Promise<webhook_events | null> {
    return this.prisma.webhook_events.findFirst({
      where: { id, business_id: businessId },
    });
  }

  async getStats(businessId: string, from: Date, to: Date): Promise<WebhookEventStats> {
    const where: Prisma.webhook_eventsWhereInput = {
      business_id: businessId,
      received_at: { gte: from, lt: to },
    };

    const [total, processed, invalidSignature, bySource] = await Promise.all([
      this.prisma.webhook_events.count({ where }),
      this.prisma.webhook_events.count({ where: { ...where, processed: true } }),
      this.prisma.webhook_events.count({ where: { ...where, signature_valid: false } }),
      this.prisma.webhook_events.groupBy({
        by: ['source'],
        where,
        _count: { _all: true },
      }),
    ]);

    return {
      total,
      processed,
      unprocessed: total - processed,
      invalidSignature,
      bySource: bySource.map((r) => ({ source: r.source, count: r._count._all })),
    };
  }

  private buildWhere(businessId: string, filters: WebhookEventListFilters): Prisma.webhook_eventsWhereInput {
    const where: Prisma.webhook_eventsWhereInput = { business_id: businessId };

    if (filters.source) where.source = filters.source;
    if (filters.eventType) where.event_type = filters.eventType;
    if (filters.processed !== undefined) where.processed = filters.processed;
    if (filters.signatureValid !== undefined) where.signature_valid = filters.signatureValid;
    if (filters.from || filters.to) {
      where.received_at = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lt: filters.to } : {}),
      };
    }

    return where;
  }
}
