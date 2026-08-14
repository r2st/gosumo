import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Prisma } from '@prisma/client';
import type {
  notifications,
  notification_templates,
  notification_preferences,
  notification_triggers,
  clients,
} from '@prisma/client';
import {
  NotificationTemplateChannel,
  NotificationCategory,
  NotificationStatus,
} from '@prisma/client';
import { generateId, generateCorrelationId } from '@gosumo/shared';
import type {
  NotificationQueuedEvent,
  NotificationSentEvent,
  NotificationDeliveredEvent,
  NotificationFailedEvent,
  NotificationSkippedEvent,
} from '@gosumo/shared';
import { NotificationRepository } from './notification.repository';
import { TemplateRenderer, TemplateContent } from './template-renderer';
import { NotificationRateLimiter } from './notification.rate-limiter';
import { SenderRegistry } from './senders/sender-registry';
import { OutboundNotification } from './senders/channel-sender.interface';
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_JOBS,
  DEFAULT_MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  BATCH_CHUNK_SIZE,
  DEFAULT_EVENT_TRIGGERS,
  DispatchJobData,
  BatchJobData,
} from './notification.constants';
import {
  evaluateConditions,
  categoryHonoursOptOut,
  deferUntilQuietHoursEnd,
  TriggerCondition,
} from './notification.util';
import {
  DispatchNotificationDto,
  DispatchBatchDto,
  CreateTemplateDto,
  UpdateTemplateDto,
  CreateTriggerDto,
  UpdateTriggerDto,
  SetPreferenceDto,
  ListNotificationsQueryDto,
  UpdateDeliveryStatusDto,
  TemplateContentDto,
  NotificationDto,
  TemplateDto,
  PreferenceDto,
  TriggerDto,
  NotificationStatsDto,
  DispatchResultDto,
  BatchResultDto,
} from './dto';

/** Statuses past which a notification will never be (re)sent. */
const TERMINAL_STATUSES: NotificationStatus[] = [
  NotificationStatus.SENT,
  NotificationStatus.DELIVERED,
  NotificationStatus.READ,
  NotificationStatus.CANCELLED,
  NotificationStatus.SKIPPED,
];

interface ResolvedPreference {
  allowed: boolean;
  reason?: string;
  quietStart: number | null;
  quietEnd: number | null;
}

/** Internal, fully-resolved dispatch parameters shared by the public entry points. */
interface DispatchParams {
  clientId?: string | null;
  channel: NotificationTemplateChannel;
  category: NotificationCategory;
  recipientOverride?: string | null;
  template?: notification_templates | null;
  body?: TemplateContentDto | null;
  data: Record<string, unknown>;
  scheduledAt?: Date | null;
  dedupeKey?: string | null;
  eventType?: string | null;
  maxAttempts?: number;
  campaignId?: string | null;
  batchId?: string | null;
  correlationId?: string;
}

/**
 * NotificationService — the cognitive core of the Notification module.
 *
 * Owns: multi-channel dispatch, template rendering, client preference / opt-out
 * enforcement, quiet-hours deferral, per-channel rate limiting, delivery
 * tracking, retry bookkeeping, and event-driven triggers. It is
 * provider-agnostic — every actual send goes through {@link SenderRegistry}.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly repository: NotificationRepository,
    private readonly renderer: TemplateRenderer,
    private readonly rateLimiter: NotificationRateLimiter,
    private readonly senders: SenderRegistry,
    private readonly eventEmitter: EventEmitter2,
    @InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue,
  ) {}

  // ════════════════════════════════════════════
  // Public dispatch API
  // ════════════════════════════════════════════

  /**
   * Create and enqueue a single notification. Honours client preferences and
   * opt-outs (the notification is recorded as SKIPPED rather than silently
   * dropped), defers around quiet hours, and is idempotent on `dedupeKey`.
   */
  async dispatch(
    businessId: string,
    dto: DispatchNotificationDto,
  ): Promise<DispatchResultDto> {
    const template = dto.templateName
      ? await this.loadTemplateByNameOrThrow(businessId, dto.channel, dto.templateName)
      : null;

    return this.createAndQueue(businessId, {
      clientId: dto.clientId ?? null,
      channel: dto.channel,
      category: dto.category ?? NotificationCategory.TRANSACTIONAL,
      recipientOverride: dto.recipient ?? null,
      template,
      body: dto.body ?? null,
      data: dto.data ?? {},
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      dedupeKey: dto.dedupeKey ?? null,
      eventType: dto.eventType ?? null,
      maxAttempts: dto.maxAttempts,
    });
  }

  /**
   * Fan a notification out to many recipients. The recipients are written as
   * individual notification rows sharing a `batchId`, then enqueued in chunks
   * so one slow recipient never blocks the rest.
   *
   * A batch is up to 5000 recipients assembled by the caller from their own
   * export, so bad entries are normal rather than exceptional — and the two
   * ways a batch can go wrong need opposite handling.
   *
   * An unresolvable `clientId` is the caller's list being wrong, and it is
   * checked for the whole batch before anything is written. A foreign
   * business's client id is not distinguishable here from a stale one: both
   * simply fail to resolve within the tenant, and either way the right answer
   * is to reject the submission rather than send to whoever *did* resolve.
   * Doing it per-recipient mid-loop would abort the batch after writing rows
   * for everyone ahead of the bad entry, with no batch id returned — rows that
   * would then sit PENDING forever, never sent and never failed.
   *
   * A failure while creating or enqueuing an individual recipient is different:
   * it is not the caller's mistake and it says nothing about the rest of the
   * list, so it is counted into `failed` and the batch carries on. The
   * invariant that holds either way is that no row is created without being
   * handed to the queue.
   */
  async dispatchBatch(
    businessId: string,
    dto: DispatchBatchDto,
  ): Promise<BatchResultDto> {
    if (dto.recipients.length === 0) {
      throw new BadRequestException('Batch must contain at least one recipient');
    }

    const template = dto.templateName
      ? await this.loadTemplateByNameOrThrow(businessId, dto.channel, dto.templateName)
      : null;
    if (!template && !dto.body) {
      throw new BadRequestException('Batch requires either templateName or body');
    }

    await this.assertRecipientClientsAreOurs(businessId, dto.recipients);

    const batchId = generateId();
    const category = dto.category ?? NotificationCategory.MARKETING;
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    const createdIds: string[] = [];
    let skipped = 0;
    let failed = 0;

    for (const r of dto.recipients) {
      try {
        const result = await this.createAndQueue(
          businessId,
          {
            clientId: r.clientId ?? null,
            channel: dto.channel,
            category,
            recipientOverride: r.recipient ?? null,
            template,
            body: dto.body ?? null,
            data: { ...(dto.data ?? {}), ...(r.data ?? {}) },
            scheduledAt,
            campaignId: dto.campaignId ?? null,
            batchId,
          },
          // Defer queueing — we push chunks ourselves below.
          { deferQueue: true },
        );
        if (result.skipped) {
          skipped += 1;
        } else {
          createdIds.push(result.notification.id);
        }
      } catch (err) {
        failed += 1;
        this.logger.error(
          `Batch ${batchId}: recipient failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Enqueue in BATCH_CHUNK_SIZE chunks. A chunk that cannot reach the queue
    // must not take the chunks after it down with it: those rows are already
    // written, and an unqueued row never sends and never fails.
    let queued = 0;
    for (let i = 0; i < createdIds.length; i += BATCH_CHUNK_SIZE) {
      const chunk = createdIds.slice(i, i + BATCH_CHUNK_SIZE);
      const data: BatchJobData = { businessId, batchId, notificationIds: chunk };
      try {
        await this.queue.add(NOTIFICATION_JOBS.BATCH, data, {
          attempts: 1,
          delay: scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : 0,
        });
        queued += chunk.length;
      } catch (err) {
        failed += chunk.length;
        // The rows stay PENDING and are individually retryable via
        // `POST /notifications/:id/retry`, so name the batch in the log.
        this.logger.error(
          `Batch ${batchId}: ${chunk.length} notifications written but not enqueued — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.logger.log(
      `Batch ${batchId}: ${queued} queued, ${skipped} skipped, ${failed} failed ` +
        `(channel ${dto.channel})`,
    );
    return {
      batchId,
      total: dto.recipients.length,
      queued,
      skipped,
      failed,
    };
  }

  /**
   * Reject the batch unless every referenced client resolves inside this
   * business. One query for the whole list, before any row is written.
   */
  private async assertRecipientClientsAreOurs(
    businessId: string,
    recipients: DispatchBatchDto['recipients'],
  ): Promise<void> {
    const ids = [
      ...new Set(
        recipients
          .map((r) => r.clientId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    if (ids.length === 0) return;

    const found = await this.repository.findExistingClientIds(businessId, ids);
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length === 0) return;

    // Enough to fix the list, without echoing 5000 ids into an error body.
    const sample = missing.slice(0, 5).join(', ');
    throw new BadRequestException(
      `${missing.length} of ${ids.length} recipient client ids do not exist in this business` +
        `${missing.length > 5 ? ` (first 5: ${sample})` : `: ${sample}`}`,
    );
  }

  // ════════════════════════════════════════════
  // Core create-and-queue pipeline
  // ════════════════════════════════════════════

  private async createAndQueue(
    businessId: string,
    params: DispatchParams,
    opts: { deferQueue?: boolean } = {},
  ): Promise<DispatchResultDto> {
    const correlationId = params.correlationId ?? generateCorrelationId();

    // 1. Load the client once (recipient + preferences both need it).
    const client = params.clientId
      ? await this.repository.findClient(businessId, params.clientId)
      : null;
    if (params.clientId && !client) {
      throw new NotFoundException(`Client not found: ${params.clientId}`);
    }

    // 2. Render the body from a template or ad-hoc content.
    const rendered = this.renderBody(params, client);

    // 3. Resolve the destination address.
    const recipient = this.resolveRecipient(
      params.channel,
      params.recipientOverride ?? null,
      client,
    );
    if (!recipient) {
      return this.recordSkipped(
        businessId,
        params,
        rendered,
        '',
        `No ${params.channel} address available for recipient`,
        correlationId,
      );
    }

    // 4. Preference / opt-out enforcement.
    const pref = this.resolvePreference(
      params.category,
      params.channel,
      client,
      params.clientId
        ? await this.repository.listPreferences(businessId, params.clientId)
        : [],
    );
    if (!pref.allowed) {
      return this.recordSkipped(
        businessId,
        params,
        rendered,
        recipient,
        pref.reason ?? 'Recipient opted out',
        correlationId,
      );
    }

    // 5. Quiet-hours deferral (reminders/marketing only).
    let scheduledAt = params.scheduledAt ?? null;
    if (categoryHonoursOptOut(params.category)) {
      const deferUntil = deferUntilQuietHoursEnd(
        new Date(),
        pref.quietStart,
        pref.quietEnd,
      );
      if (deferUntil && (!scheduledAt || deferUntil > scheduledAt)) {
        scheduledAt = deferUntil;
      }
    }

    // 6. Persist the notification row (idempotent on dedupeKey).
    let row: notifications;
    try {
      row = await this.repository.createNotification({
        businessId,
        clientId: params.clientId ?? null,
        channel: params.channel,
        category: params.category,
        status: NotificationStatus.PENDING,
        templateId: params.template?.id ?? null,
        eventType: params.eventType ?? null,
        recipient,
        subject: rendered.subject,
        content: rendered.contentJson as Prisma.InputJsonValue,
        data: params.data as Prisma.InputJsonValue,
        dedupeKey: params.dedupeKey ?? null,
        batchId: params.batchId ?? null,
        campaignId: params.campaignId ?? null,
        maxAttempts: params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        scheduledAt,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        params.dedupeKey
      ) {
        const existing = await this.repository.findByDedupeKey(
          businessId,
          params.dedupeKey,
        );
        if (existing) {
          this.logger.debug(
            `Duplicate notification suppressed (dedupeKey=${params.dedupeKey})`,
          );
          return { notification: this.toDto(existing), skipped: false };
        }
      }
      throw err;
    }

    // 7. Enqueue for delivery (unless a batch caller defers it).
    if (!opts.deferQueue) {
      await this.enqueueDispatch(businessId, row.id, scheduledAt, correlationId);
      const queued = await this.repository.updateNotification(businessId, row.id, {
        status: NotificationStatus.QUEUED,
        queued_at: new Date(),
      });
      return { notification: this.toDto(queued), skipped: false };
    }

    return { notification: this.toDto(row), skipped: false };
  }

  /** Push a dispatch job, emitting `notification.queued`. */
  private async enqueueDispatch(
    businessId: string,
    notificationId: string,
    scheduledAt: Date | null,
    correlationId: string,
  ): Promise<void> {
    const delay = scheduledAt
      ? Math.max(0, scheduledAt.getTime() - Date.now())
      : 0;
    const data: DispatchJobData = { businessId, notificationId };
    // attempts:1 — the module owns retry bookkeeping, not Bull.
    await this.queue.add(NOTIFICATION_JOBS.DISPATCH, data, { attempts: 1, delay });

    const row = await this.repository.findById(businessId, notificationId);
    if (row) {
      this.emitQueued(row, correlationId);
    }
  }

  // ════════════════════════════════════════════
  // Delivery (called by the Bull processor)
  // ════════════════════════════════════════════

  /**
   * Deliver one notification through its channel sender. Applies the per-channel
   * rate limit (re-queueing without consuming an attempt when throttled),
   * records the outcome, emits the matching domain event, and schedules a
   * backoff retry on transient failure.
   */
  async processDispatch(businessId: string, notificationId: string): Promise<void> {
    const row = await this.repository.findById(businessId, notificationId);
    if (!row) {
      this.logger.warn(`processDispatch: notification ${notificationId} not found`);
      return;
    }
    if (TERMINAL_STATUSES.includes(row.status)) {
      this.logger.debug(
        `processDispatch: ${notificationId} already ${row.status}, skipping`,
      );
      return;
    }

    // Rate-limit: re-queue (no attempt charged) if the window is exhausted.
    const decision = this.rateLimiter.tryConsume(businessId, row.channel);
    if (!decision.allowed) {
      this.logger.debug(
        `Rate limited ${row.channel} for ${businessId}; re-queue in ${decision.retryAfterMs}ms`,
      );
      const data: DispatchJobData = { businessId, notificationId };
      await this.queue.add(NOTIFICATION_JOBS.DISPATCH, data, {
        attempts: 1,
        delay: decision.retryAfterMs || 1000,
      });
      return;
    }

    const sender = this.senders.get(row.channel);
    const outbound = this.toOutbound(row);
    const correlationId = generateCorrelationId();
    const startMs = Date.now();

    const outcome = await sender.send(outbound);

    if (outcome.success) {
      const updated = await this.repository.updateNotification(businessId, row.id, {
        status: NotificationStatus.SENT,
        sent_at: new Date(),
        provider_message_id: outcome.providerMessageId ?? null,
        attempts: { increment: 1 },
        failure_reason: null,
      });
      this.emitSent(updated, Date.now() - startMs, correlationId);
      return;
    }

    // Failure: decide retry vs. permanent fail.
    const attempts = row.attempts + 1;
    const retryable = outcome.retryable !== false && attempts < row.max_attempts;

    if (retryable) {
      const backoff =
        RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)];
      await this.repository.updateNotification(businessId, row.id, {
        status: NotificationStatus.QUEUED,
        attempts: { increment: 1 },
        failure_reason: outcome.error ?? 'Unknown error',
      });
      const data: DispatchJobData = { businessId, notificationId };
      await this.queue.add(NOTIFICATION_JOBS.DISPATCH, data, {
        attempts: 1,
        delay: backoff,
      });
      this.logger.warn(
        `Notification ${row.id} attempt ${attempts}/${row.max_attempts} failed ` +
          `(${outcome.error}); retrying in ${backoff}ms`,
      );
      return;
    }

    const failed = await this.repository.updateNotification(businessId, row.id, {
      status: NotificationStatus.FAILED,
      failed_at: new Date(),
      attempts: { increment: 1 },
      failure_reason: outcome.error ?? 'Unknown error',
    });
    this.emitFailed(failed, attempts, correlationId);
    this.logger.error(
      `Notification ${row.id} permanently failed after ${attempts} attempts: ${outcome.error}`,
    );
  }

  /** Process one chunk of a batch: dispatch each notification independently. */
  async processBatch(
    businessId: string,
    notificationIds: string[],
  ): Promise<void> {
    for (const id of notificationIds) {
      try {
        await this.processDispatch(businessId, id);
      } catch (err) {
        this.logger.error(
          `Batch item ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ════════════════════════════════════════════
  // Event-driven triggers
  // ════════════════════════════════════════════

  /**
   * React to a domain event by dispatching every matching trigger. A business's
   * configured {@link notification_triggers} take precedence; if none exist for
   * the event, the built-in {@link DEFAULT_EVENT_TRIGGERS} default applies.
   */
  async handleEventTrigger(
    eventType: string,
    payload: Record<string, unknown> & {
      businessId?: string;
      clientId?: string;
      correlationId?: string;
    },
  ): Promise<void> {
    const businessId = payload.businessId;
    if (!businessId) {
      this.logger.warn(`Event ${eventType} missing businessId; ignoring`);
      return;
    }

    const configured = await this.repository.listTriggers(businessId, eventType, true);
    const triggers: Array<{
      channel: NotificationTemplateChannel;
      category: NotificationCategory;
      templateId: string | null;
      delayMinutes: number;
      conditions: TriggerCondition[];
      templateName?: string;
    }> = configured.map((t: notification_triggers) => ({
      channel: t.channel,
      category: t.category,
      templateId: t.template_id,
      delayMinutes: t.delay_minutes,
      conditions: (t.conditions as unknown as TriggerCondition[]) ?? [],
    }));

    if (triggers.length === 0) {
      const def = DEFAULT_EVENT_TRIGGERS[eventType];
      if (!def) return;
      triggers.push({
        channel: def.channel,
        category: def.category,
        templateId: null,
        delayMinutes: 0,
        conditions: [],
        templateName: def.templateName,
      });
    }

    // Resolve every trigger's template up front. One event can fan out to
    // several triggers, and resolving inside the loop meant a query per
    // trigger for a set already known here.
    const applicable = triggers.filter((t) => evaluateConditions(t.conditions, payload));
    const templates = await this.repository.findTemplatesForTriggers(
      businessId,
      applicable.flatMap((t) => (t.templateId ? [t.templateId] : [])),
      applicable.flatMap((t) =>
        !t.templateId && t.templateName
          ? [{ channel: t.channel, name: t.templateName }]
          : [],
      ),
    );
    const templatesById = new Map(templates.map((t) => [t.id, t]));
    const templatesByChannelName = new Map(
      templates.map((t) => [`${t.channel}:${t.name}`, t]),
    );

    for (const trigger of applicable) {
      try {
        const template = trigger.templateId
          ? (templatesById.get(trigger.templateId) ?? null)
          : trigger.templateName
            ? (templatesByChannelName.get(`${trigger.channel}:${trigger.templateName}`) ?? null)
            : null;
        if (template) {
          this.assertWhatsAppTemplateApproved(trigger.channel, template);
        }

        const scheduledAt =
          trigger.delayMinutes > 0
            ? new Date(Date.now() + trigger.delayMinutes * 60_000)
            : null;

        await this.createAndQueue(businessId, {
          clientId: payload.clientId ?? null,
          channel: trigger.channel,
          category: trigger.category,
          template,
          body: template ? null : this.defaultEventBody(eventType),
          data: payload,
          scheduledAt,
          eventType,
          // Idempotency: one notification per (event entity, channel).
          dedupeKey: this.eventDedupeKey(eventType, payload, trigger.channel),
          correlationId: payload.correlationId,
        });
      } catch (err) {
        this.logger.error(
          `Trigger for ${eventType} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ════════════════════════════════════════════
  // Delivery receipts & manual retry
  // ════════════════════════════════════════════

  /**
   * Apply a provider delivery receipt (DELIVERED / READ / FAILED). Lookup is by
   * notification id, or by `providerMessageId` when the receipt only carries the
   * provider's id.
   */
  async updateDeliveryStatus(
    businessId: string,
    idOrProviderId: string,
    dto: UpdateDeliveryStatusDto,
  ): Promise<NotificationDto> {
    const row =
      (await this.repository.findById(businessId, idOrProviderId)) ??
      (await this.repository.findByProviderMessageId(businessId, idOrProviderId)) ??
      (dto.providerMessageId
        ? await this.repository.findByProviderMessageId(
            businessId,
            dto.providerMessageId,
          )
        : null);

    if (!row) {
      throw new NotFoundException(`Notification not found: ${idOrProviderId}`);
    }

    const data: Prisma.notificationsUpdateInput = { status: dto.status };
    if (dto.providerMessageId) data.provider_message_id = dto.providerMessageId;
    if (dto.status === NotificationStatus.DELIVERED) data.delivered_at = new Date();
    if (dto.status === NotificationStatus.READ) data.read_at = new Date();
    if (dto.status === NotificationStatus.FAILED) {
      data.failed_at = new Date();
      data.failure_reason = dto.failureReason ?? 'Reported failed by provider';
    }

    const updated = await this.repository.updateNotification(businessId, row.id, data);

    const correlationId = generateCorrelationId();
    if (dto.status === NotificationStatus.DELIVERED) {
      this.emitDelivered(updated, correlationId);
    } else if (dto.status === NotificationStatus.FAILED) {
      this.emitFailed(updated, updated.attempts, correlationId);
    }
    return this.toDto(updated);
  }

  /** Manually re-queue a FAILED notification (resets nothing but its status). */
  async retryNotification(
    businessId: string,
    id: string,
  ): Promise<NotificationDto> {
    const row = await this.repository.findById(businessId, id);
    if (!row) throw new NotFoundException(`Notification not found: ${id}`);
    if (TERMINAL_STATUSES.includes(row.status) && row.status !== NotificationStatus.FAILED) {
      throw new ConflictException(
        `Cannot retry a notification in status ${row.status}`,
      );
    }
    const updated = await this.repository.updateNotification(businessId, id, {
      status: NotificationStatus.QUEUED,
      queued_at: new Date(),
      failure_reason: null,
    });
    await this.enqueueDispatch(businessId, id, null, generateCorrelationId());
    return this.toDto(updated);
  }

  // ════════════════════════════════════════════
  // History & stats
  // ════════════════════════════════════════════

  async listNotifications(
    businessId: string,
    query: ListNotificationsQueryDto,
  ): Promise<{
    data: NotificationDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const result = await this.repository.list(businessId, {
      status: query.status,
      channel: query.channel,
      category: query.category,
      clientId: query.clientId,
      eventType: query.eventType,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      page: query.page,
      limit: query.limit,
    });
    return { ...result, data: result.data.map((r) => this.toDto(r)) };
  }

  async getNotification(businessId: string, id: string): Promise<NotificationDto> {
    const row = await this.repository.findById(businessId, id);
    if (!row) throw new NotFoundException(`Notification not found: ${id}`);
    return this.toDto(row);
  }

  async getStats(
    businessId: string,
    from?: string,
    to?: string,
  ): Promise<NotificationStatsDto> {
    const { byStatus, byChannel } = await this.repository.aggregateStats(
      businessId,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
    const byStatusMap: Record<string, number> = {};
    let total = 0;
    let delivered = 0;
    let failed = 0;
    for (const r of byStatus) {
      byStatusMap[r.status] = r.count;
      total += r.count;
      if (
        r.status === NotificationStatus.DELIVERED ||
        r.status === NotificationStatus.READ
      ) {
        delivered += r.count;
      }
      if (r.status === NotificationStatus.FAILED) failed += r.count;
    }
    const byChannelMap: Record<string, number> = {};
    for (const r of byChannel) byChannelMap[r.channel] = r.count;

    return {
      total,
      byStatus: byStatusMap,
      byChannel: byChannelMap,
      deliveryRate: total > 0 ? delivered / total : 0,
      failureRate: total > 0 ? failed / total : 0,
    };
  }

  // ════════════════════════════════════════════
  // Templates
  // ════════════════════════════════════════════

  async createTemplate(
    businessId: string,
    dto: CreateTemplateDto,
  ): Promise<TemplateDto> {
    const existing = await this.repository.findTemplateByName(
      businessId,
      dto.channel,
      dto.name,
    );
    if (existing) {
      throw new ConflictException(
        `Template "${dto.name}" already exists for channel ${dto.channel}`,
      );
    }
    // Derive declared variables from the content when not explicitly supplied.
    const variables =
      dto.variables ?? this.renderer.extractVariables(dto.content as TemplateContent);

    const row = await this.repository.createTemplate({
      business_id: businessId,
      channel_account_id: dto.channelAccountId ?? null,
      channel: dto.channel,
      name: dto.name,
      external_name: dto.externalName ?? null,
      content: dto.content as unknown as Prisma.InputJsonValue,
      variables: variables as unknown as Prisma.InputJsonValue,
      category: dto.category ?? null,
      language: dto.language ?? 'en',
    });
    return this.toTemplateDto(row);
  }

  async updateTemplate(
    businessId: string,
    id: string,
    dto: UpdateTemplateDto,
  ): Promise<TemplateDto> {
    await this.getTemplateRow(businessId, id);
    const data: Prisma.notification_templatesUpdateInput = {};
    if (dto.content) {
      data.content = dto.content as unknown as Prisma.InputJsonValue;
      data.variables =
        dto.variables ??
        (this.renderer.extractVariables(
          dto.content as TemplateContent,
        ) as unknown as Prisma.InputJsonValue);
    } else if (dto.variables) {
      data.variables = dto.variables as unknown as Prisma.InputJsonValue;
    }
    if (dto.externalName !== undefined) data.external_name = dto.externalName;
    if (dto.isActive !== undefined) data.is_active = dto.isActive;
    if (dto.language !== undefined) data.language = dto.language;

    const row = await this.repository.updateTemplate(businessId, id, data);
    return this.toTemplateDto(row);
  }

  /**
   * Mark a template approved (e.g. once Meta approves a WhatsApp template
   * name). Only APPROVED WhatsApp templates may be used to dispatch — see
   * the gate in `loadTemplateByNameOrThrow`.
   */
  async approveTemplate(businessId: string, id: string): Promise<TemplateDto> {
    await this.getTemplateRow(businessId, id);
    const row = await this.repository.updateTemplate(businessId, id, {
      is_approved: true,
      approval_status: 'APPROVED',
      approved_at: new Date(),
      rejection_reason: null,
    });
    return this.toTemplateDto(row);
  }

  /** Mark a template rejected (e.g. Meta declined the WhatsApp submission). */
  async rejectTemplate(
    businessId: string,
    id: string,
    reason: string,
  ): Promise<TemplateDto> {
    await this.getTemplateRow(businessId, id);
    const row = await this.repository.updateTemplate(businessId, id, {
      is_approved: false,
      approval_status: 'REJECTED',
      rejection_reason: reason,
    });
    return this.toTemplateDto(row);
  }

  async listTemplates(
    businessId: string,
    channel?: NotificationTemplateChannel,
  ): Promise<TemplateDto[]> {
    const rows = await this.repository.listTemplates(businessId, channel);
    return rows.map((r) => this.toTemplateDto(r));
  }

  async getTemplate(businessId: string, id: string): Promise<TemplateDto> {
    const row = await this.getTemplateRow(businessId, id);
    return this.toTemplateDto(row);
  }

  async deleteTemplate(businessId: string, id: string): Promise<void> {
    await this.getTemplateRow(businessId, id);
    await this.repository.softDeleteTemplate(businessId, id);
  }

  /** Render a template against sample data without sending anything. */
  async previewTemplate(
    businessId: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<{
    subject: string | null;
    title: string | null;
    text: string;
    html: string | null;
    missingVariables: string[];
  }> {
    const row = await this.getTemplateRow(businessId, id);
    return this.renderer.render(row.content as unknown as TemplateContent, data);
  }

  // ════════════════════════════════════════════
  // Preferences
  // ════════════════════════════════════════════

  async setPreference(
    businessId: string,
    dto: SetPreferenceDto,
  ): Promise<PreferenceDto> {
    if (
      (dto.quietHoursStart == null) !== (dto.quietHoursEnd == null)
    ) {
      throw new BadRequestException(
        'quietHoursStart and quietHoursEnd must be set together',
      );
    }
    const client = await this.repository.findClient(businessId, dto.clientId);
    if (!client) throw new NotFoundException(`Client not found: ${dto.clientId}`);

    const row = await this.repository.upsertPreference({
      businessId,
      clientId: dto.clientId,
      channel: dto.channel,
      category: dto.category ?? null,
      isEnabled: dto.isEnabled,
      quietHoursStart: dto.quietHoursStart ?? null,
      quietHoursEnd: dto.quietHoursEnd ?? null,
    });
    return this.toPreferenceDto(row);
  }

  async getPreferences(
    businessId: string,
    clientId: string,
  ): Promise<PreferenceDto[]> {
    const rows = await this.repository.listPreferences(businessId, clientId);
    return rows.map((r) => this.toPreferenceDto(r));
  }

  // ════════════════════════════════════════════
  // Triggers
  // ════════════════════════════════════════════

  async createTrigger(
    businessId: string,
    dto: CreateTriggerDto,
  ): Promise<TriggerDto> {
    if (dto.templateId) {
      await this.getTemplateRow(businessId, dto.templateId);
    }
    const row = await this.repository.createTrigger({
      business_id: businessId,
      event_type: dto.eventType,
      channel: dto.channel,
      category: dto.category ?? NotificationCategory.TRANSACTIONAL,
      template_id: dto.templateId ?? null,
      is_active: dto.isActive ?? true,
      delay_minutes: dto.delayMinutes ?? 0,
      conditions: (dto.conditions ?? []) as unknown as Prisma.InputJsonValue,
    });
    return this.toTriggerDto(row);
  }

  async updateTrigger(
    businessId: string,
    id: string,
    dto: UpdateTriggerDto,
  ): Promise<TriggerDto> {
    const existing = await this.repository.findTriggerById(businessId, id);
    if (!existing) throw new NotFoundException(`Trigger not found: ${id}`);
    if (dto.templateId) await this.getTemplateRow(businessId, dto.templateId);

    const data: Prisma.notification_triggersUpdateInput = {};
    if (dto.templateId !== undefined) data.template_id = dto.templateId;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.isActive !== undefined) data.is_active = dto.isActive;
    if (dto.delayMinutes !== undefined) data.delay_minutes = dto.delayMinutes;
    if (dto.conditions !== undefined) {
      data.conditions = dto.conditions as unknown as Prisma.InputJsonValue;
    }
    const row = await this.repository.updateTrigger(businessId, id, data);
    return this.toTriggerDto(row);
  }

  async listTriggers(
    businessId: string,
    eventType?: string,
  ): Promise<TriggerDto[]> {
    const rows = await this.repository.listTriggers(businessId, eventType);
    return rows.map((r) => this.toTriggerDto(r));
  }

  async deleteTrigger(businessId: string, id: string): Promise<void> {
    const existing = await this.repository.findTriggerById(businessId, id);
    if (!existing) throw new NotFoundException(`Trigger not found: ${id}`);
    await this.repository.softDeleteTrigger(businessId, id);
  }

  // ════════════════════════════════════════════
  // Private helpers
  // ════════════════════════════════════════════

  private async loadTemplateByNameOrThrow(
    businessId: string,
    channel: NotificationTemplateChannel,
    name: string,
  ): Promise<notification_templates> {
    const template = await this.repository.findTemplateByName(
      businessId,
      channel,
      name,
    );
    if (!template) {
      throw new NotFoundException(
        `Template "${name}" not found for channel ${channel}`,
      );
    }
    if (!template.is_active) {
      throw new BadRequestException(`Template "${name}" is inactive`);
    }
    this.assertWhatsAppTemplateApproved(channel, template);
    return template;
  }

  /**
   * WhatsApp Business messaging requires the template to be approved by Meta
   * before it can be used outside a customer-initiated 24h session —
   * dispatching an unapproved template is a guaranteed provider-side
   * rejection, so fail fast here instead. Other channels have no equivalent
   * approval step, so this only gates WHATSAPP. Shared by both the by-name
   * dispatch path and the event-trigger path so neither can bypass it.
   */
  private assertWhatsAppTemplateApproved(
    channel: NotificationTemplateChannel,
    template: notification_templates,
  ): void {
    if (channel === NotificationTemplateChannel.WHATSAPP && !template.is_approved) {
      throw new BadRequestException(
        `WhatsApp template "${template.name}" is not approved (status: ${template.approval_status ?? 'PENDING'})`,
      );
    }
  }

  private async getTemplateRow(
    businessId: string,
    id: string,
  ): Promise<notification_templates> {
    const row = await this.repository.findTemplateById(businessId, id);
    if (!row) throw new NotFoundException(`Template not found: ${id}`);
    return row;
  }

  /** Render the body from a template (preferred) or ad-hoc content. */
  private renderBody(
    params: DispatchParams,
    _client: clients | null,
  ): {
    subject: string | null;
    text: string;
    html: string | null;
    externalName: string | null;
    contentJson: Record<string, unknown>;
  } {
    const content: TemplateContent = params.template
      ? (params.template.content as unknown as TemplateContent)
      : (params.body as TemplateContent) ?? {};

    const rendered = this.renderer.render(content, params.data);
    if (!rendered.text && !rendered.subject && !rendered.html) {
      throw new BadRequestException(
        'Notification has no renderable content (template/body empty)',
      );
    }
    return {
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      externalName: params.template?.external_name ?? null,
      contentJson: {
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        externalName: params.template?.external_name ?? null,
      },
    };
  }

  /** Resolve the destination address for a channel. */
  private resolveRecipient(
    channel: NotificationTemplateChannel,
    override: string | null,
    client: clients | null,
  ): string | null {
    if (override) return override;
    if (!client) return null;
    switch (channel) {
      case NotificationTemplateChannel.EMAIL:
        return client.email ?? null;
      case NotificationTemplateChannel.SMS:
      case NotificationTemplateChannel.WHATSAPP:
        return client.phone ?? null;
      case NotificationTemplateChannel.PUSH: {
        const profile = (client.profile ?? {}) as Record<string, unknown>;
        const token = profile['pushToken'] ?? profile['deviceToken'];
        return typeof token === 'string' ? token : null;
      }
      default:
        return null;
    }
  }

  /**
   * Decide whether a notification may be sent given the client's stored
   * preferences and opt-outs. See {@link categoryHonoursOptOut} for the
   * transactional bypass rule.
   */
  private resolvePreference(
    category: NotificationCategory,
    channel: NotificationTemplateChannel,
    client: clients | null,
    prefs: notification_preferences[],
  ): ResolvedPreference {
    const exact = prefs.find(
      (p) => p.channel === channel && p.category === category,
    );
    const channelWide = prefs.find(
      (p) => p.channel === channel && p.category === null,
    );

    // An explicit per-category opt-out is always honoured, even transactional.
    if (exact && !exact.is_enabled) {
      return {
        allowed: false,
        reason: `Opted out of ${category} on ${channel}`,
        quietStart: exact.quiet_hours_start,
        quietEnd: exact.quiet_hours_end,
      };
    }

    if (categoryHonoursOptOut(category)) {
      const optOuts = (client?.opt_outs ?? {}) as Record<string, unknown>;
      if (optOuts[channel] === true) {
        return {
          allowed: false,
          reason: `Client opted out of ${channel}`,
          quietStart: null,
          quietEnd: null,
        };
      }
      if (!exact && channelWide && !channelWide.is_enabled) {
        return {
          allowed: false,
          reason: `Opted out of ${channel}`,
          quietStart: channelWide.quiet_hours_start,
          quietEnd: channelWide.quiet_hours_end,
        };
      }
    }

    const source = exact ?? channelWide ?? null;
    return {
      allowed: true,
      quietStart: source?.quiet_hours_start ?? null,
      quietEnd: source?.quiet_hours_end ?? null,
    };
  }

  /** Persist a SKIPPED notification and emit `notification.skipped`. */
  private async recordSkipped(
    businessId: string,
    params: DispatchParams,
    rendered: {
      subject: string | null;
      contentJson: Record<string, unknown>;
    },
    recipient: string,
    reason: string,
    correlationId: string,
  ): Promise<DispatchResultDto> {
    const row = await this.repository.createNotification({
      businessId,
      clientId: params.clientId ?? null,
      channel: params.channel,
      category: params.category,
      status: NotificationStatus.SKIPPED,
      templateId: params.template?.id ?? null,
      eventType: params.eventType ?? null,
      recipient: recipient || 'unresolved',
      subject: rendered.subject,
      content: rendered.contentJson as Prisma.InputJsonValue,
      data: params.data as Prisma.InputJsonValue,
      dedupeKey: params.dedupeKey ?? null,
      batchId: params.batchId ?? null,
      campaignId: params.campaignId ?? null,
      maxAttempts: params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    });
    await this.repository.updateNotification(businessId, row.id, {
      failure_reason: reason,
    });
    this.emitSkipped(row, reason, correlationId);
    this.logger.debug(`Notification skipped (${reason}) for business ${businessId}`);
    return { notification: this.toDto(row), skipped: true, skipReason: reason };
  }

  private defaultEventBody(eventType: string): TemplateContentDto {
    // Minimal built-in body used when a trigger has no template configured.
    return { text: `You have a new update regarding ${eventType.replace('.', ' ')}.` };
  }

  private eventDedupeKey(
    eventType: string,
    payload: Record<string, unknown>,
    channel: NotificationTemplateChannel,
  ): string {
    const entityId =
      (payload['bookingId'] as string) ??
      (payload['orderId'] as string) ??
      (payload['paymentId'] as string) ??
      (payload['id'] as string) ??
      generateId();
    return `${eventType}:${entityId}:${channel}`;
  }

  private toOutbound(row: notifications): OutboundNotification {
    const content = (row.content ?? {}) as Record<string, unknown>;
    return {
      notificationId: row.id,
      businessId: row.business_id,
      recipient: row.recipient,
      subject: row.subject,
      text: (content['text'] as string) ?? '',
      html: (content['html'] as string) ?? null,
      externalTemplateName: (content['externalName'] as string) ?? null,
      data: (row.data ?? {}) as Record<string, unknown>,
    };
  }

  // ─── Event emitters ───

  private emitQueued(row: notifications, correlationId: string): void {
    const event: NotificationQueuedEvent = {
      id: generateId(),
      type: 'notification.queued',
      timestamp: new Date().toISOString(),
      businessId: row.business_id,
      correlationId,
      notificationId: row.id,
      clientId: row.client_id ?? undefined,
      channel: row.channel,
      category: row.category,
      triggerEvent: row.event_type ?? undefined,
      scheduledAt: row.scheduled_at?.toISOString(),
    };
    this.eventEmitter.emit('notification.queued', event);
  }

  private emitSent(
    row: notifications,
    latencyMs: number,
    correlationId: string,
  ): void {
    const event: NotificationSentEvent = {
      id: generateId(),
      type: 'notification.sent',
      timestamp: new Date().toISOString(),
      businessId: row.business_id,
      correlationId,
      notificationId: row.id,
      clientId: row.client_id ?? undefined,
      channel: row.channel,
      category: row.category,
      recipient: row.recipient,
      providerMessageId: row.provider_message_id ?? undefined,
      latencyMs,
    };
    this.eventEmitter.emit('notification.sent', event);
  }

  private emitDelivered(row: notifications, correlationId: string): void {
    const event: NotificationDeliveredEvent = {
      id: generateId(),
      type: 'notification.delivered',
      timestamp: new Date().toISOString(),
      businessId: row.business_id,
      correlationId,
      notificationId: row.id,
      clientId: row.client_id ?? undefined,
      channel: row.channel,
      providerMessageId: row.provider_message_id ?? undefined,
    };
    this.eventEmitter.emit('notification.delivered', event);
  }

  private emitFailed(
    row: notifications,
    attempts: number,
    correlationId: string,
  ): void {
    const event: NotificationFailedEvent = {
      id: generateId(),
      type: 'notification.failed',
      timestamp: new Date().toISOString(),
      businessId: row.business_id,
      correlationId,
      notificationId: row.id,
      clientId: row.client_id ?? undefined,
      channel: row.channel,
      category: row.category,
      recipient: row.recipient,
      reason: row.failure_reason ?? 'Unknown error',
      attempts,
    };
    this.eventEmitter.emit('notification.failed', event);
  }

  private emitSkipped(
    row: notifications,
    reason: string,
    correlationId: string,
  ): void {
    const event: NotificationSkippedEvent = {
      id: generateId(),
      type: 'notification.skipped',
      timestamp: new Date().toISOString(),
      businessId: row.business_id,
      correlationId,
      notificationId: row.id,
      clientId: row.client_id ?? undefined,
      channel: row.channel,
      category: row.category,
      reason,
    };
    this.eventEmitter.emit('notification.skipped', event);
  }

  // ─── DTO mappers ───

  private toDto(n: notifications): NotificationDto {
    return {
      id: n.id,
      businessId: n.business_id,
      clientId: n.client_id,
      channel: n.channel,
      category: n.category,
      status: n.status,
      templateId: n.template_id,
      eventType: n.event_type,
      recipient: n.recipient,
      subject: n.subject,
      content: (n.content ?? {}) as Record<string, unknown>,
      data: (n.data ?? {}) as Record<string, unknown>,
      dedupeKey: n.dedupe_key,
      batchId: n.batch_id,
      campaignId: n.campaign_id,
      attempts: n.attempts,
      maxAttempts: n.max_attempts,
      providerMessageId: n.provider_message_id,
      failureReason: n.failure_reason,
      scheduledAt: n.scheduled_at?.toISOString() ?? null,
      queuedAt: n.queued_at?.toISOString() ?? null,
      sentAt: n.sent_at?.toISOString() ?? null,
      deliveredAt: n.delivered_at?.toISOString() ?? null,
      readAt: n.read_at?.toISOString() ?? null,
      failedAt: n.failed_at?.toISOString() ?? null,
      createdAt: n.created_at.toISOString(),
      updatedAt: n.updated_at.toISOString(),
    };
  }

  private toTemplateDto(t: notification_templates): TemplateDto {
    return {
      id: t.id,
      businessId: t.business_id,
      channelAccountId: t.channel_account_id,
      channel: t.channel,
      name: t.name,
      externalName: t.external_name,
      content: (t.content ?? {}) as Record<string, unknown>,
      variables: (t.variables ?? []) as string[],
      isApproved: t.is_approved,
      approvalStatus: t.approval_status,
      category: t.category,
      language: t.language,
      isActive: t.is_active,
      createdAt: t.created_at.toISOString(),
      updatedAt: t.updated_at.toISOString(),
    };
  }

  private toPreferenceDto(p: notification_preferences): PreferenceDto {
    return {
      id: p.id,
      businessId: p.business_id,
      clientId: p.client_id,
      channel: p.channel,
      category: p.category,
      isEnabled: p.is_enabled,
      quietHoursStart: p.quiet_hours_start,
      quietHoursEnd: p.quiet_hours_end,
    };
  }

  private toTriggerDto(t: notification_triggers): TriggerDto {
    return {
      id: t.id,
      businessId: t.business_id,
      eventType: t.event_type,
      channel: t.channel,
      category: t.category,
      templateId: t.template_id,
      isActive: t.is_active,
      delayMinutes: t.delay_minutes,
      conditions: (t.conditions ?? []) as unknown[],
    };
  }
}
