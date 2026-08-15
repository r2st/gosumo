import { Injectable, Logger } from '@nestjs/common';
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
import { PrismaService } from '../../common/services/prisma.service';

// ─────────────────────────────────────────────
// Data interfaces
// ─────────────────────────────────────────────

export interface CreateNotificationData {
  businessId: string;
  clientId?: string | null;
  channel: NotificationTemplateChannel;
  category: NotificationCategory;
  status: NotificationStatus;
  templateId?: string | null;
  eventType?: string | null;
  recipient: string;
  subject?: string | null;
  content: Prisma.InputJsonValue;
  data?: Prisma.InputJsonValue;
  dedupeKey?: string | null;
  batchId?: string | null;
  campaignId?: string | null;
  maxAttempts?: number;
  scheduledAt?: Date | null;
}

export interface NotificationListFilters {
  status?: NotificationStatus;
  channel?: NotificationTemplateChannel;
  category?: NotificationCategory;
  clientId?: string;
  eventType?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

export interface PaginatedNotifications {
  data: notifications[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * NotificationRepository — all Prisma access for the Notification module.
 *
 * Every query is scoped by `business_id`; mutable rows exclude soft-deleted
 * records. The module never reaches into another module's tables — recipient
 * contact details come from the `clients` row (read-only) only.
 */
@Injectable()
export class NotificationRepository {
  private readonly logger = new Logger(NotificationRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────
  // Notifications
  // ─────────────────────────────────────────────

  /**
   * Insert a notification. Relies on the `(business_id, dedupe_key)` unique
   * constraint for idempotency — a duplicate throws P2002, which the service
   * catches and treats as a no-op.
   */
  async createNotification(data: CreateNotificationData): Promise<notifications> {
    return this.prisma.notifications.create({
      data: {
        business_id: data.businessId,
        client_id: data.clientId ?? null,
        channel: data.channel,
        category: data.category,
        status: data.status,
        template_id: data.templateId ?? null,
        event_type: data.eventType ?? null,
        recipient: data.recipient,
        subject: data.subject ?? null,
        content: data.content,
        data: data.data ?? {},
        dedupe_key: data.dedupeKey ?? null,
        batch_id: data.batchId ?? null,
        campaign_id: data.campaignId ?? null,
        max_attempts: data.maxAttempts ?? 3,
        scheduled_at: data.scheduledAt ?? null,
      },
    });
  }

  async findById(businessId: string, id: string): Promise<notifications | null> {
    return this.prisma.notifications.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async findByDedupeKey(
    businessId: string,
    dedupeKey: string,
  ): Promise<notifications | null> {
    return this.prisma.notifications.findFirst({
      where: { business_id: businessId, dedupe_key: dedupeKey },
    });
  }

  async findByProviderMessageId(
    businessId: string,
    providerMessageId: string,
  ): Promise<notifications | null> {
    return this.prisma.notifications.findFirst({
      where: {
        business_id: businessId,
        provider_message_id: providerMessageId,
        deleted_at: null,
      },
    });
  }

  /**
   * Identify notifications stranded in a non-terminal status with no job behind
   * them, across every tenant.
   *
   * Cross-tenant on purpose, and the one query in this file without a
   * `business_id` — it is the scheduler's global tick, and the whole question
   * it asks is *which* tenants are holding stranded rows. It follows the shape
   * `WebhookDlqRepository.listDueGlobal` established for the same situation:
   * it selects the id and the tenant discriminator and nothing else, so no
   * tenant content crosses the boundary, and the sweep re-enters the scoped
   * `findById` per row to do any actual work. The re-read is not waste — it is
   * what makes the sweep re-check that the row is still non-terminal before
   * acting on it.
   *
   * Served by `notifications(status, created_at)`, added in migration 0038;
   * every other index on the table leads with `business_id` and so cannot seek
   * here.
   *
   * `scheduled_at` is honoured: a notification scheduled for next Tuesday is a
   * delayed Bull job doing exactly what it was told, not a stranded row.
   */
  async findStuckGlobal(
    cutoff: Date,
    limit: number,
  ): Promise<Array<{ id: string; business_id: string }>> {
    return this.prisma.notifications.findMany({
      where: {
        status: { in: [NotificationStatus.PENDING, NotificationStatus.QUEUED] },
        created_at: { lt: cutoff },
        deleted_at: null,
        OR: [{ scheduled_at: null }, { scheduled_at: { lt: cutoff } }],
      },
      select: { id: true, business_id: true },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
  }

  async updateNotification(
    businessId: string,
    id: string,
    data: Prisma.notificationsUpdateInput,
  ): Promise<notifications> {
    // Scope the update to the tenant via updateMany guard, then return the row.
    const result = await this.prisma.notifications.updateMany({
      where: { id, business_id: businessId },
      data,
    });
    if (result.count === 0) {
      throw new Prisma.PrismaClientKnownRequestError('Notification not found', {
        code: 'P2025',
        clientVersion: Prisma.prismaVersion.client,
      });
    }
    return this.prisma.notifications.findFirstOrThrow({
      where: { id, business_id: businessId },
    });
  }

  /** Increment attempt count and stamp the failure reason in one statement. */
  async recordAttempt(
    businessId: string,
    id: string,
    data: Prisma.notificationsUpdateInput,
  ): Promise<void> {
    await this.prisma.notifications.updateMany({
      where: { id, business_id: businessId },
      data: { ...data, attempts: { increment: 1 } },
    });
  }

  async list(
    businessId: string,
    filters: NotificationListFilters,
  ): Promise<PaginatedNotifications> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20));

    const where: Prisma.notificationsWhereInput = {
      business_id: businessId,
      deleted_at: null,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.channel ? { channel: filters.channel } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.clientId ? { client_id: filters.clientId } : {}),
      ...(filters.eventType ? { event_type: filters.eventType } : {}),
      ...(filters.from || filters.to
        ? {
            created_at: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.notifications.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notifications.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** Aggregate counts for the stats endpoint, grouped by status and channel. */
  async aggregateStats(
    businessId: string,
    from?: Date,
    to?: Date,
  ): Promise<{
    byStatus: Array<{ status: NotificationStatus; count: number }>;
    byChannel: Array<{ channel: NotificationTemplateChannel; count: number }>;
  }> {
    const where: Prisma.notificationsWhereInput = {
      business_id: businessId,
      deleted_at: null,
      ...(from || to
        ? { created_at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    };

    const [byStatus, byChannel] = await Promise.all([
      this.prisma.notifications.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.notifications.groupBy({
        by: ['channel'],
        where,
        _count: { _all: true },
      }),
    ]);

    return {
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      byChannel: byChannel.map((r) => ({ channel: r.channel, count: r._count._all })),
    };
  }

  // ─────────────────────────────────────────────
  // Templates
  // ─────────────────────────────────────────────

  async createTemplate(
    data: Prisma.notification_templatesUncheckedCreateInput,
  ): Promise<notification_templates> {
    return this.prisma.notification_templates.create({ data });
  }

  async findTemplateById(
    businessId: string,
    id: string,
  ): Promise<notification_templates | null> {
    return this.prisma.notification_templates.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async findTemplateByName(
    businessId: string,
    channel: NotificationTemplateChannel,
    name: string,
  ): Promise<notification_templates | null> {
    return this.prisma.notification_templates.findFirst({
      where: { business_id: businessId, channel, name, deleted_at: null },
    });
  }

  /**
   * Resolve the templates a batch of triggers refers to, by id and by
   * (channel, name), in one query each.
   *
   * A single domain event fans out to every trigger a tenant has configured
   * for it, and each one used to resolve its template with its own query while
   * the whole set was already known.
   */
  async findTemplatesForTriggers(
    businessId: string,
    ids: string[],
    named: { channel: NotificationTemplateChannel; name: string }[],
  ): Promise<notification_templates[]> {
    const or: Prisma.notification_templatesWhereInput[] = [];
    if (ids.length > 0) or.push({ id: { in: [...new Set(ids)] } });
    for (const n of named) or.push({ channel: n.channel, name: n.name });
    if (or.length === 0) return [];

    return this.prisma.notification_templates.findMany({
      where: { business_id: businessId, deleted_at: null, OR: or },
    });
  }

  async listTemplates(
    businessId: string,
    channel?: NotificationTemplateChannel,
  ): Promise<notification_templates[]> {
    return this.prisma.notification_templates.findMany({
      where: {
        business_id: businessId,
        deleted_at: null,
        ...(channel ? { channel } : {}),
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async updateTemplate(
    businessId: string,
    id: string,
    data: Prisma.notification_templatesUpdateInput,
  ): Promise<notification_templates> {
    const result = await this.prisma.notification_templates.updateMany({
      where: { id, business_id: businessId, deleted_at: null },
      data,
    });
    if (result.count === 0) {
      throw new Prisma.PrismaClientKnownRequestError('Template not found', {
        code: 'P2025',
        clientVersion: Prisma.prismaVersion.client,
      });
    }
    return this.prisma.notification_templates.findFirstOrThrow({
      where: { id, business_id: businessId },
    });
  }

  async softDeleteTemplate(businessId: string, id: string): Promise<void> {
    await this.prisma.notification_templates.updateMany({
      where: { id, business_id: businessId, deleted_at: null },
      data: { deleted_at: new Date(), is_active: false },
    });
  }

  // ─────────────────────────────────────────────
  // Preferences
  // ─────────────────────────────────────────────

  /**
   * Upsert a preference for the exact (client, channel, category) tuple, keyed
   * by the `uq_notif_pref_client_channel_category` unique constraint.
   */
  async upsertPreference(data: {
    businessId: string;
    clientId: string;
    channel: NotificationTemplateChannel;
    category: NotificationCategory | null;
    isEnabled: boolean;
    quietHoursStart?: number | null;
    quietHoursEnd?: number | null;
  }): Promise<notification_preferences> {
    const existing = await this.prisma.notification_preferences.findFirst({
      where: {
        business_id: data.businessId,
        client_id: data.clientId,
        channel: data.channel,
        category: data.category,
      },
    });

    if (existing) {
      return this.prisma.notification_preferences.update({
        where: { id: existing.id, business_id: data.businessId },
        data: {
          is_enabled: data.isEnabled,
          quiet_hours_start: data.quietHoursStart ?? null,
          quiet_hours_end: data.quietHoursEnd ?? null,
        },
      });
    }

    return this.prisma.notification_preferences.create({
      data: {
        business_id: data.businessId,
        client_id: data.clientId,
        channel: data.channel,
        category: data.category,
        is_enabled: data.isEnabled,
        quiet_hours_start: data.quietHoursStart ?? null,
        quiet_hours_end: data.quietHoursEnd ?? null,
      },
    });
  }

  async listPreferences(
    businessId: string,
    clientId: string,
  ): Promise<notification_preferences[]> {
    return this.prisma.notification_preferences.findMany({
      where: { business_id: businessId, client_id: clientId },
    });
  }

  // ─────────────────────────────────────────────
  // Triggers
  // ─────────────────────────────────────────────

  async createTrigger(
    data: Prisma.notification_triggersUncheckedCreateInput,
  ): Promise<notification_triggers> {
    return this.prisma.notification_triggers.create({ data });
  }

  async findTriggerById(
    businessId: string,
    id: string,
  ): Promise<notification_triggers | null> {
    return this.prisma.notification_triggers.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async listTriggers(
    businessId: string,
    eventType?: string,
    activeOnly = false,
  ): Promise<notification_triggers[]> {
    return this.prisma.notification_triggers.findMany({
      where: {
        business_id: businessId,
        deleted_at: null,
        ...(eventType ? { event_type: eventType } : {}),
        ...(activeOnly ? { is_active: true } : {}),
      },
      orderBy: { created_at: 'asc' },
    });
  }

  /** All active triggers for a given event across every business — used by the listener. */
  async listActiveTriggersForEvent(
    businessId: string,
    eventType: string,
  ): Promise<notification_triggers[]> {
    return this.prisma.notification_triggers.findMany({
      where: {
        business_id: businessId,
        event_type: eventType,
        is_active: true,
        deleted_at: null,
      },
    });
  }

  async updateTrigger(
    businessId: string,
    id: string,
    data: Prisma.notification_triggersUpdateInput,
  ): Promise<notification_triggers> {
    const result = await this.prisma.notification_triggers.updateMany({
      where: { id, business_id: businessId, deleted_at: null },
      data,
    });
    if (result.count === 0) {
      throw new Prisma.PrismaClientKnownRequestError('Trigger not found', {
        code: 'P2025',
        clientVersion: Prisma.prismaVersion.client,
      });
    }
    return this.prisma.notification_triggers.findFirstOrThrow({
      where: { id, business_id: businessId },
    });
  }

  async softDeleteTrigger(businessId: string, id: string): Promise<void> {
    await this.prisma.notification_triggers.updateMany({
      where: { id, business_id: businessId, deleted_at: null },
      data: { deleted_at: new Date(), is_active: false },
    });
  }

  // ─────────────────────────────────────────────
  // Clients (read-only contact lookup)
  // ─────────────────────────────────────────────

  async findClient(businessId: string, clientId: string): Promise<clients | null> {
    return this.prisma.clients.findFirst({
      where: { id: clientId, business_id: businessId, deleted_at: null },
    });
  }

  /**
   * Which of `clientIds` exist in this business — one round trip for a whole
   * batch, so a 5000-recipient dispatch can be validated before it writes a
   * single row. Ids belonging to another tenant simply do not come back.
   */
  async findExistingClientIds(
    businessId: string,
    clientIds: string[],
  ): Promise<Set<string>> {
    if (clientIds.length === 0) return new Set();
    const rows = await this.prisma.clients.findMany({
      where: { id: { in: clientIds }, business_id: businessId, deleted_at: null },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }
}
