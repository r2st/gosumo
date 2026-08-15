import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Queue } from 'bull';
import { Prisma, DeadLetterStatus } from '@prisma/client';
import type { webhook_dead_letters } from '@prisma/client';
import {
  WebhookDlqRepository,
  ListWebhookDeadLettersFilter,
} from './webhook-dlq.repository';
import type {
  WebhookDeadLetterDetailDto,
  WebhookDeadLetterStatsDto,
  WebhookDeadLetterSummaryDto,
  WebhookReplayResultDto,
} from './dto';
import {
  WEBHOOK_DLQ_DEPTH_FAIL,
  WEBHOOK_DLQ_DEPTH_WARN,
  WEBHOOK_DLQ_EVENTS,
  WEBHOOK_DLQ_JOBS,
  WEBHOOK_DLQ_QUEUE,
  webhookRetryBackoffMs,
} from './webhook-dlq.constants';

/** `unknown` means the probe itself could not run — never "healthy". */
export type WebhookDlqHealthStatus = 'pass' | 'warn' | 'fail' | 'unknown';

/** The backlog gauge an operator (or an alert rule) reads. */
export interface WebhookDlqHealth {
  status: WebhookDlqHealthStatus;
  /** Platform-wide PENDING entries, or null when the count could not be read. */
  pending: number | null;
  warnAt: number;
  failAt: number;
  detail: string;
  /** Sources with a registered replayer — a backlog of anything else is stuck. */
  sources: string[];
  checkedAt: string;
}

/** Everything needed to park a failed delivery and later replay it. */
export interface FailedWebhookDelivery {
  /** null when the tenant could not be resolved from the payload. */
  businessId: string | null;
  /** The `webhook_events` row id, when the delivery got that far. */
  webhookEventId?: string | null;
  /** Provider key — also the replayer registry key, e.g. "RAZORPAY". */
  source: string;
  eventType: string;
  externalId: string;
  payload: Record<string, unknown>;
  headers?: Record<string, unknown>;
  correlationId?: string | null;
}

/**
 * Re-executes a captured webhook from its stored payload.
 *
 * Registered by the module that owns the provider. The signature is
 * deliberately post-verification: the payload only reached the DLQ because its
 * signature already passed, and the raw bytes needed to re-verify are gone.
 */
export type WebhookReplayHandler = (
  payload: Record<string, unknown>,
  entry: webhook_dead_letters,
) => Promise<void>;

/** What a retry attempt did, for the caller (processor, sweep, operator) to log. */
export interface WebhookRetryOutcome {
  entry: webhook_dead_letters;
  status: 'REPLAYED' | 'RESCHEDULED' | 'DISCARDED' | 'SKIPPED';
  error?: string;
}

/**
 * WebhookDlqService — the recovery path for inbound webhooks whose handler
 * threw.
 *
 * The gap this closes: `webhook_events` dedupes on `(source, external_id)`, so
 * once a delivery is recorded, the provider's own redelivery is discarded as a
 * duplicate. A handler that threw therefore lost that event permanently — the
 * one retry mechanism we had was the one we were suppressing.
 *
 * So a failed delivery is captured here instead, and retried on our own
 * schedule: exponential backoff (30s, 1m, 2m, 4m, 8m … capped at an hour)
 * carried by the `webhook-dlq` Bull queue, with `next_retry_at` persisted so a
 * job Redis never delivers is still recovered by {@link sweepDue}. Once the
 * entry's `max_attempts` is spent it is DISCARDED, not dropped: the payload
 * stays readable and an operator can still replay it by hand.
 */
@Injectable()
export class WebhookDlqService {
  private readonly logger = new Logger(WebhookDlqService.name);
  private readonly replayers = new Map<string, WebhookReplayHandler>();

  constructor(
    private readonly repository: WebhookDlqRepository,
    private readonly eventEmitter: EventEmitter2,
    @InjectQueue(WEBHOOK_DLQ_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Register the function that re-runs deliveries from `source`. The owning
   * module calls this in `onModuleInit`. Idempotent — last registration wins.
   */
  registerReplayer(source: string, handler: WebhookReplayHandler): void {
    this.replayers.set(source.toUpperCase(), handler);
  }

  /** Sources that can currently be replayed — surfaced on the ops endpoint. */
  registeredSources(): string[] {
    return [...this.replayers.keys()].sort();
  }

  // ─────────────────────────────────────────────
  // Capture
  // ─────────────────────────────────────────────

  /**
   * Park a failed delivery and schedule its first retry.
   *
   * Never throws: this runs inside a webhook handler's catch block, and a DLQ
   * that takes down the response would turn one lost event into a 500 the
   * provider retries into the dedupe wall. A capture failure is logged loudly
   * and swallowed.
   */
  async capture(
    delivery: FailedWebhookDelivery,
    error: unknown,
    now: Date = new Date(),
  ): Promise<webhook_dead_letters | null> {
    // The live delivery that just failed is attempt 1.
    const attempts = 1;
    const nextRetryAt = new Date(now.getTime() + webhookRetryBackoffMs(attempts));

    let entry: webhook_dead_letters;
    try {
      entry = await this.repository.capture({
        businessId: delivery.businessId ?? null,
        webhookEventId: delivery.webhookEventId ?? null,
        source: delivery.source,
        eventType: delivery.eventType,
        externalId: delivery.externalId,
        payload: (delivery.payload ?? {}) as Prisma.InputJsonValue,
        headers: (delivery.headers ?? {}) as Prisma.InputJsonValue,
        errorMessage: this.describe(error),
        errorStack: error instanceof Error ? (error.stack ?? null) : null,
        attempts,
        nextRetryAt,
        lastAttemptAt: now,
        correlationId: delivery.correlationId ?? null,
      });
    } catch (persistErr) {
      // Last resort: we could not even record that we lost the event.
      this.logger.error(
        `CRITICAL: failed to dead-letter ${delivery.source}/${delivery.externalId}: ` +
          `${this.describe(persistErr)}`,
      );
      return null;
    }

    this.logger.warn(
      `Dead-lettered ${entry.source}/${entry.event_type} (${entry.external_id}) → ${entry.id}; ` +
        `retry 1 due ${nextRetryAt.toISOString()}`,
    );
    this.eventEmitter.emit(WEBHOOK_DLQ_EVENTS.CAPTURED, {
      businessId: entry.business_id,
      deadLetterId: entry.id,
      source: entry.source,
      eventType: entry.event_type,
    });

    await this.enqueueRetry(entry, webhookRetryBackoffMs(attempts));
    return entry;
  }

  // ─────────────────────────────────────────────
  // Retry
  // ─────────────────────────────────────────────

  /**
   * Run one retry attempt. Called by the queue processor, the recovery sweep,
   * and the operator replay route, so all three share one state machine.
   */
  async runRetry(
    businessId: string | null,
    id: string,
    now: Date = new Date(),
  ): Promise<WebhookRetryOutcome> {
    const entry = await this.repository.findById(businessId, id);
    if (!entry) throw new NotFoundException(`Webhook dead letter ${id} not found`);

    // Already recovered, or already closed out by a human — nothing to do.
    // Retries are enqueued per attempt, so a duplicate delivery lands here.
    if (entry.status !== DeadLetterStatus.PENDING) {
      return { entry, status: 'SKIPPED' };
    }

    const handler = this.replayers.get(entry.source.toUpperCase());
    if (!handler) {
      // No owner registered: rescheduling would spin forever against a gap
      // only a deploy can close, so fail the attempt with a legible reason.
      return this.recordFailure(
        entry,
        new Error(`No replayer registered for webhook source "${entry.source}"`),
        now,
      );
    }

    try {
      await handler(this.readPayload(entry), entry);
    } catch (err) {
      return this.recordFailure(entry, err, now);
    }

    const replayed = await this.repository.update(entry.business_id, entry.id, {
      status: DeadLetterStatus.REPLAYED,
      attempts: entry.attempts + 1,
      last_attempt_at: now,
      replayed_at: now,
      next_retry_at: null,
    });
    this.logger.log(
      `Replayed webhook ${entry.source}/${entry.external_id} on attempt ${entry.attempts + 1}`,
    );
    this.eventEmitter.emit(WEBHOOK_DLQ_EVENTS.REPLAYED, {
      businessId: entry.business_id,
      deadLetterId: entry.id,
      source: entry.source,
      attempts: entry.attempts + 1,
    });
    return { entry: replayed, status: 'REPLAYED' };
  }

  /**
   * Operator-triggered replay: run the next attempt immediately, ignoring the
   * remaining backoff. Attempt accounting is unchanged, so a manual replay of
   * an entry on its last attempt still discards it if it fails.
   */
  async replayNow(businessId: string, id: string): Promise<WebhookReplayResultDto> {
    const outcome = await this.runRetry(businessId, id);
    return {
      status: outcome.status,
      error: outcome.error ?? null,
      entry: this.toSummaryDto(outcome.entry),
    };
  }

  /**
   * Re-enqueue entries whose backoff elapsed but whose job never arrived —
   * a flushed Redis, or a crash between the DB write and the enqueue.
   *
   * Cheap and idempotent: the job id is derived from the entry and its attempt
   * count, so re-running the sweep collapses onto the same job.
   */
  async sweepDue(now: Date = new Date(), limit = 100): Promise<number> {
    const due = await this.repository.listDueGlobal(now, limit);
    let enqueued = 0;

    for (const row of due) {
      const ok = await this.enqueueRetryJob(row.id, row.business_id, 0, `sweep:${row.id}`);
      if (ok) enqueued += 1;
    }

    if (enqueued > 0) {
      this.logger.log(`Recovery sweep re-enqueued ${enqueued} overdue webhook retr(ies)`);
    }
    return enqueued;
  }

  // ─────────────────────────────────────────────
  // Inspection / operator actions
  // ─────────────────────────────────────────────

  /** Summaries only: a list view has no business showing captured payloads. */
  async list(
    businessId: string,
    filter: ListWebhookDeadLettersFilter = {},
  ): Promise<WebhookDeadLetterSummaryDto[]> {
    const rows = await this.repository.list(businessId, filter);
    return rows.map((r) => this.toSummaryDto(r));
  }

  /** Single entry, payload included — that is the point of opening one. */
  async get(businessId: string, id: string): Promise<WebhookDeadLetterDetailDto> {
    const entry = await this.requireEntry(businessId, id);
    return {
      ...this.toSummaryDto(entry),
      payload: entry.payload,
      headers: entry.headers,
      errorStack: entry.error_stack,
      webhookEventId: entry.webhook_event_id,
    };
  }

  async stats(businessId: string): Promise<WebhookDeadLetterStatsDto> {
    const [pending, replayed, resolved, discarded] = await Promise.all([
      this.repository.countByStatus(businessId, DeadLetterStatus.PENDING),
      this.repository.countByStatus(businessId, DeadLetterStatus.REPLAYED),
      this.repository.countByStatus(businessId, DeadLetterStatus.RESOLVED),
      this.repository.countByStatus(businessId, DeadLetterStatus.DISCARDED),
    ]);
    return { pending, replayed, resolved, discarded, sources: this.registeredSources() };
  }

  /** Platform-wide PENDING depth, for the readiness gauge. */
  async pendingDepth(): Promise<number> {
    return this.repository.countPendingGlobal();
  }

  /**
   * Backlog health, graded against {@link WEBHOOK_DLQ_DEPTH_WARN} and
   * {@link WEBHOOK_DLQ_DEPTH_FAIL}.
   *
   * A rising PENDING count is the one webhook symptom nothing else surfaces.
   * Every other signal here reads healthy while it happens: the provider got
   * its 200, `webhook_events` recorded the delivery, the retry schedule is
   * being kept — deliveries are simply failing on every attempt and marching
   * toward DISCARDED. By the time anyone notices, the payloads are past their
   * attempt budget and only a manual replay brings them back.
   *
   * Deliberately *not* folded into `/health/ready`. The depth is platform-wide,
   * so a backlog would take every instance out of the load balancer at once —
   * turning "some webhooks are failing" into "the API is down", which is both
   * false and the opposite of helpful. This is an operator gauge, and it is
   * read on an operator route.
   *
   * Fails soft: an unreadable count is reported as `unknown`, never thrown. A
   * monitoring endpoint that 500s tells an operator less than one that says
   * which probe it could not run.
   */
  async queueHealth(nowIso: string = new Date().toISOString()): Promise<WebhookDlqHealth> {
    let pending: number;
    try {
      pending = await this.pendingDepth();
    } catch (err) {
      this.logger.error(`Webhook DLQ depth probe failed: ${this.describe(err)}`);
      return {
        status: 'unknown',
        pending: null,
        warnAt: WEBHOOK_DLQ_DEPTH_WARN,
        failAt: WEBHOOK_DLQ_DEPTH_FAIL,
        detail: `backlog depth unreadable: ${this.describe(err)}`,
        sources: this.registeredSources(),
        checkedAt: nowIso,
      };
    }

    // At the threshold, not past it: `WEBHOOK_DLQ_DEPTH_FAIL` entries parked is
    // already the condition the number names.
    const status: WebhookDlqHealthStatus =
      pending >= WEBHOOK_DLQ_DEPTH_FAIL
        ? 'fail'
        : pending >= WEBHOOK_DLQ_DEPTH_WARN
          ? 'warn'
          : 'pass';

    if (status !== 'pass') {
      this.logger.warn(
        `Webhook DLQ backlog ${status}: ${pending} pending ` +
          `(warn ${WEBHOOK_DLQ_DEPTH_WARN}, fail ${WEBHOOK_DLQ_DEPTH_FAIL})`,
      );
    }

    return {
      status,
      pending,
      warnAt: WEBHOOK_DLQ_DEPTH_WARN,
      failAt: WEBHOOK_DLQ_DEPTH_FAIL,
      detail: `${pending} delivery(ies) pending retry`,
      sources: this.registeredSources(),
      checkedAt: nowIso,
    };
  }

  /** Close an entry out by hand, with a note. Stops all further retries. */
  async resolve(
    businessId: string,
    id: string,
    status: DeadLetterStatus,
    note?: string,
  ): Promise<WebhookDeadLetterSummaryDto> {
    if (status !== DeadLetterStatus.RESOLVED && status !== DeadLetterStatus.DISCARDED) {
      throw new BadRequestException('resolve status must be RESOLVED or DISCARDED');
    }
    const entry = await this.requireEntry(businessId, id);
    const updated = await this.repository.update(entry.business_id, entry.id, {
      status,
      resolution: note ?? null,
      resolved_at: new Date(),
      next_retry_at: null,
    });
    this.eventEmitter.emit(WEBHOOK_DLQ_EVENTS.RESOLVED, {
      businessId: entry.business_id,
      deadLetterId: entry.id,
      status,
    });
    return this.toSummaryDto(updated);
  }

  private async requireEntry(
    businessId: string | null,
    id: string,
  ): Promise<webhook_dead_letters> {
    const entry = await this.repository.findById(businessId, id);
    if (!entry) throw new NotFoundException(`Webhook dead letter ${id} not found`);
    return entry;
  }

  private toSummaryDto(e: webhook_dead_letters): WebhookDeadLetterSummaryDto {
    return {
      id: e.id,
      source: e.source,
      eventType: e.event_type,
      externalId: e.external_id,
      status: e.status,
      attempts: e.attempts,
      maxAttempts: e.max_attempts,
      errorMessage: e.error_message,
      nextRetryAt: e.next_retry_at?.toISOString() ?? null,
      lastAttemptAt: e.last_attempt_at?.toISOString() ?? null,
      replayedAt: e.replayed_at?.toISOString() ?? null,
      resolvedAt: e.resolved_at?.toISOString() ?? null,
      resolution: e.resolution,
      createdAt: e.created_at.toISOString(),
    };
  }

  // ─────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────

  /** Bump the attempt count and either schedule the next try or give up. */
  private async recordFailure(
    entry: webhook_dead_letters,
    error: unknown,
    now: Date,
  ): Promise<WebhookRetryOutcome> {
    const attempts = entry.attempts + 1;
    const message = this.describe(error);
    const exhausted = attempts >= entry.max_attempts;

    if (exhausted) {
      const discarded = await this.repository.update(entry.business_id, entry.id, {
        status: DeadLetterStatus.DISCARDED,
        attempts,
        error_message: message,
        last_attempt_at: now,
        next_retry_at: null,
        resolved_at: now,
        resolution: `auto-discarded after ${attempts} attempts`,
      });
      this.logger.error(
        `Webhook ${entry.source}/${entry.external_id} discarded after ${attempts} attempts: ${message}`,
      );
      this.eventEmitter.emit(WEBHOOK_DLQ_EVENTS.DISCARDED, {
        businessId: entry.business_id,
        deadLetterId: entry.id,
        source: entry.source,
        attempts,
      });
      return { entry: discarded, status: 'DISCARDED', error: message };
    }

    const backoff = webhookRetryBackoffMs(attempts);
    const nextRetryAt = new Date(now.getTime() + backoff);
    const rescheduled = await this.repository.update(entry.business_id, entry.id, {
      attempts,
      error_message: message,
      last_attempt_at: now,
      next_retry_at: nextRetryAt,
    });
    this.logger.warn(
      `Webhook ${entry.source}/${entry.external_id} attempt ${attempts}/${entry.max_attempts} ` +
        `failed (${message}); next try in ${backoff}ms`,
    );
    await this.enqueueRetry(rescheduled, backoff);
    return { entry: rescheduled, status: 'RESCHEDULED', error: message };
  }

  private async enqueueRetry(entry: webhook_dead_letters, delay: number): Promise<void> {
    await this.enqueueRetryJob(
      entry.id,
      entry.business_id,
      delay,
      `${entry.id}:${entry.attempts}`,
    );
  }

  /**
   * Add the delayed retry job. `attempts: 1` because this module owns the
   * retry bookkeeping — letting Bull retry as well would advance the schedule
   * twice per failure and burn the budget in seconds.
   *
   * A queue that refuses the job is logged rather than thrown: the row already
   * carries `next_retry_at`, so {@link sweepDue} picks it up regardless.
   */
  private async enqueueRetryJob(
    deadLetterId: string,
    businessId: string | null,
    delay: number,
    jobId: string,
  ): Promise<boolean> {
    try {
      await this.queue.add(
        WEBHOOK_DLQ_JOBS.RETRY,
        { deadLetterId, businessId },
        { delay, attempts: 1, jobId, removeOnComplete: true, removeOnFail: 100 },
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to enqueue webhook retry for ${deadLetterId}: ${this.describe(err)} ` +
          `— the recovery sweep will pick it up`,
      );
      return false;
    }
  }

  private readPayload(entry: webhook_dead_letters): Record<string, unknown> {
    const p = entry.payload;
    return p && typeof p === 'object' && !Array.isArray(p)
      ? (p as Record<string, unknown>)
      : {};
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
