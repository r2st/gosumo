import { Injectable } from '@nestjs/common';
import { Prisma, DeadLetterStatus } from '@prisma/client';
import type { webhook_dead_letters } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { WEBHOOK_MAX_ATTEMPTS } from './webhook-dlq.constants';

export interface CaptureWebhookDeadLetterData {
  /** null when the failure happened before the tenant could be resolved. */
  businessId: string | null;
  /** The `webhook_events` row this delivery failed on, when it was recorded. */
  webhookEventId?: string | null;
  source: string;
  eventType: string;
  externalId: string;
  payload: Prisma.InputJsonValue;
  headers?: Prisma.InputJsonValue;
  errorMessage: string;
  errorStack?: string | null;
  attempts: number;
  maxAttempts?: number;
  nextRetryAt: Date | null;
  lastAttemptAt: Date;
  correlationId?: string | null;
}

export interface ListWebhookDeadLettersFilter {
  status?: DeadLetterStatus;
  source?: string;
  eventType?: string;
  limit?: number;
}

/** A due retry, reduced to the two fields the scheduler needs to re-enqueue it. */
export interface DueWebhookRetry {
  id: string;
  business_id: string | null;
}

/**
 * WebhookDlqRepository — all Prisma access for `webhook_dead_letters`.
 *
 * Tenant scoping here is unusual in one respect and worth stating: a gateway
 * webhook can fail *before* its tenant is knowable, so `business_id` is
 * nullable and the scoped methods take `string | null`. Passing null still
 * emits a `business_id` predicate (`IS NULL`), so a tenant session can never
 * reach another tenant's rows — and a platform-level row is reachable only by
 * the two deliberately global methods below.
 */
@Injectable()
export class WebhookDlqRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a failed delivery, or fold another failure into the existing row.
   *
   * Keyed on the provider's own `(source, external_id)` so a webhook that fails
   * repeatedly advances one entry instead of stacking a queue of near-copies.
   */
  async capture(data: CaptureWebhookDeadLetterData): Promise<webhook_dead_letters> {
    const shared = {
      business_id: data.businessId ?? null,
      webhook_event_id: data.webhookEventId ?? null,
      error_message: data.errorMessage,
      error_stack: data.errorStack ?? null,
      attempts: data.attempts,
      max_attempts: data.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS,
      next_retry_at: data.nextRetryAt,
      last_attempt_at: data.lastAttemptAt,
      correlation_id: data.correlationId ?? null,
      status: DeadLetterStatus.PENDING,
    };

    return this.prisma.webhook_dead_letters.upsert({
      where: { source_external_id: { source: data.source, external_id: data.externalId } },
      create: {
        ...shared,
        source: data.source,
        event_type: data.eventType,
        external_id: data.externalId,
        payload: data.payload,
        headers: data.headers ?? {},
      },
      // The captured payload is never rewritten: the first delivery is the
      // provider's own body, and a later attempt has nothing truer to say.
      update: shared,
    });
  }

  async findById(businessId: string | null, id: string): Promise<webhook_dead_letters | null> {
    return this.prisma.webhook_dead_letters.findFirst({
      where: { id, business_id: businessId },
    });
  }

  async list(
    businessId: string,
    filter: ListWebhookDeadLettersFilter = {},
  ): Promise<webhook_dead_letters[]> {
    const where: Prisma.webhook_dead_lettersWhereInput = { business_id: businessId };
    if (filter.status) where.status = filter.status;
    if (filter.source) where.source = filter.source;
    if (filter.eventType) where.event_type = filter.eventType;

    return this.prisma.webhook_dead_letters.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: Math.min(filter.limit ?? 100, 500),
    });
  }

  async countByStatus(businessId: string, status: DeadLetterStatus): Promise<number> {
    return this.prisma.webhook_dead_letters.count({
      where: { business_id: businessId, status },
    });
  }

  /** Platform-wide PENDING depth — the readiness gauge. Returns a count, no rows. */
  async countPendingGlobal(): Promise<number> {
    return this.prisma.webhook_dead_letters.count({
      where: { status: DeadLetterStatus.PENDING },
    });
  }

  /**
   * Entries whose backoff has elapsed, across every tenant.
   *
   * The recovery sweep for retries Redis never delivered — a flushed queue, or
   * a crash between the DB write and the enqueue. Returns only `id` and the
   * tenant discriminator; the sweep re-enters the scoped path per entry.
   */
  async listDueGlobal(now: Date, limit: number): Promise<DueWebhookRetry[]> {
    return this.prisma.webhook_dead_letters.findMany({
      where: {
        status: DeadLetterStatus.PENDING,
        next_retry_at: { not: null, lte: now },
      },
      select: { id: true, business_id: true },
      orderBy: { next_retry_at: 'asc' },
      take: Math.min(limit, 500),
    });
  }

  async update(
    businessId: string | null,
    id: string,
    data: Prisma.webhook_dead_lettersUpdateInput,
  ): Promise<webhook_dead_letters> {
    return this.prisma.webhook_dead_letters.update({
      where: { id, business_id: businessId },
      data,
    });
  }
}
