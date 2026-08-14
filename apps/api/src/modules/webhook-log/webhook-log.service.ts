import { Injectable, NotFoundException } from '@nestjs/common';
import type { webhook_events } from '@prisma/client';
import { WebhookLogRepository } from './webhook-log.repository';
import {
  ListWebhookEventsQueryDto,
  PaginatedWebhookEventsDto,
  WebhookEventSummaryDto,
  WebhookEventDetailDto,
  WebhookStatsDto,
} from './dto';

const DEFAULT_STATS_RANGE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * WebhookLogService — read-only inspection over inbound webhook deliveries
 * recorded in `webhook_events` by channel-adapter and payment.
 *
 * Never writes to `webhook_events`: that table is the writing modules'
 * idempotency ledger (unique on `[source, external_id]`), and a second module
 * mutating it would put that guarantee at risk. Recovery of a failed delivery
 * lives in `WebhookDlqService`, which owns its own table for exactly that
 * reason.
 */
@Injectable()
export class WebhookLogService {
  constructor(private readonly repository: WebhookLogRepository) {}

  async list(businessId: string, query: ListWebhookEventsQueryDto): Promise<PaginatedWebhookEventsDto> {
    const result = await this.repository.findMany(businessId, {
      source: query.source,
      eventType: query.eventType,
      processed: query.processed,
      signatureValid: query.signatureValid,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      page: query.page,
      limit: query.limit,
    });

    return {
      data: result.data.map((e) => this.toSummaryDto(e)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  async get(businessId: string, id: string): Promise<WebhookEventDetailDto> {
    const event = await this.repository.findById(businessId, id);
    if (!event) {
      throw new NotFoundException(`Webhook event ${id} not found`);
    }
    return { ...this.toSummaryDto(event), payload: event.payload, headers: event.headers };
  }

  async getStats(businessId: string, fromIso?: string, toIso?: string): Promise<WebhookStatsDto> {
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - DEFAULT_STATS_RANGE_DAYS * MS_PER_DAY);

    const stats = await this.repository.getStats(businessId, from, to);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      ...stats,
    };
  }

  private toSummaryDto(e: webhook_events): WebhookEventSummaryDto {
    return {
      id: e.id,
      source: e.source,
      eventType: e.event_type,
      externalId: e.external_id,
      processed: e.processed,
      processedAt: e.processed_at?.toISOString() ?? null,
      attempts: e.attempts,
      error: e.error,
      signatureValid: e.signature_valid,
      receivedAt: e.received_at.toISOString(),
    };
  }
}
