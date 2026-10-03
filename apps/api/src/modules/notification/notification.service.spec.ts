import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  NotificationTemplateChannel,
  NotificationCategory,
  NotificationStatus,
} from '@prisma/client';
import { NotificationService } from './notification.service';
import { TemplateRenderer } from './template-renderer';
import { NotificationRateLimiter } from './notification.rate-limiter';
import { SendOutcome } from './senders/channel-sender.interface';
import { BATCH_CHUNK_SIZE, NOTIFICATION_JOBS } from './notification.constants';

const BUSINESS = '00000000-0000-4000-8000-000000000001';
const CLIENT = '00000000-0000-4000-8000-000000000002';

let idSeq = 0;
const nextId = () => `id-${++idSeq}`;

// ─────────────────────────────────────────────
// In-memory fake repository
// ─────────────────────────────────────────────

/**
 * Rows in these fakes mirror Prisma model rows, which mix typed scalar columns
 * with untyped JSON columns. `FakeRow` pins the two identifiers the fakes
 * actually branch on and leaves the rest loose, so fixtures stay terse.
 */
type FakeRow = { id: string; business_id: string } & Record<string, unknown>;

/** A repository input DTO, as the service under test passes it. */
type FakeInput = Record<string, unknown>;

/** Fields `createNotification` reads off its input. */
type CreateNotificationInput = {
  businessId: string;
  clientId?: string | null;
  channel: unknown;
  category: unknown;
  status: unknown;
  templateId?: string | null;
  eventType?: string | null;
  recipient: string;
  subject?: string | null;
  content?: unknown;
  data?: unknown;
  dedupeKey?: string | null;
  batchId?: string | null;
  campaignId?: string | null;
  maxAttempts?: number;
  scheduledAt?: Date | null;
};

class FakeRepo {
  notifications = new Map<string, FakeRow>();
  templates = new Map<string, FakeRow>();
  triggers = new Map<string, FakeRow>();
  preferences: FakeRow[] = [];
  clients = new Map<string, FakeRow>();

  // Notifications
  createNotification = jest.fn(async (input: FakeInput) => {
    const data = input as CreateNotificationInput;
    if (data.dedupeKey) {
      const dup = [...this.notifications.values()].find(
        (n) => n.dedupe_key === data.dedupeKey && n.business_id === data.businessId,
      );
      if (dup) {
        throw new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '5',
        });
      }
    }
    const now = new Date();
    const row = {
      id: nextId(),
      business_id: data.businessId,
      client_id: data.clientId ?? null,
      channel: data.channel,
      category: data.category,
      status: data.status,
      template_id: data.templateId ?? null,
      event_type: data.eventType ?? null,
      recipient: data.recipient,
      subject: data.subject ?? null,
      content: data.content ?? {},
      data: data.data ?? {},
      dedupe_key: data.dedupeKey ?? null,
      batch_id: data.batchId ?? null,
      campaign_id: data.campaignId ?? null,
      attempts: 0,
      max_attempts: data.maxAttempts ?? 3,
      provider_message_id: null,
      failure_reason: null,
      scheduled_at: data.scheduledAt ?? null,
      queued_at: null,
      sent_at: null,
      delivered_at: null,
      read_at: null,
      failed_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.notifications.set(row.id, row);
    return row;
  });

  findById = jest.fn(async (b: string, id: string) => {
    const r = this.notifications.get(id);
    return r && r.business_id === b ? { ...r } : null;
  });

  findByDedupeKey = jest.fn(async (b: string, key: string) => {
    return (
      [...this.notifications.values()].find(
        (n) => n.business_id === b && n.dedupe_key === key,
      ) ?? null
    );
  });

  findByProviderMessageId = jest.fn(async (b: string, pid: string) => {
    return (
      [...this.notifications.values()].find(
        (n) => n.business_id === b && n.provider_message_id === pid,
      ) ?? null
    );
  });

  /**
   * Cross-tenant, like the real query: no business_id, PENDING/QUEUED only,
   * created before the cutoff, a `scheduled_at` in the future excluded — and
   * returning the id and the tenant discriminator only, never row content.
   */
  findStuckGlobal = jest.fn(async (cutoff: Date, limit: number) => {
    return [...this.notifications.values()]
      .filter(
        (n) =>
          (n.status === NotificationStatus.PENDING ||
            n.status === NotificationStatus.QUEUED) &&
          (n.created_at as Date) < cutoff &&
          n.deleted_at == null &&
          (n.scheduled_at == null || (n.scheduled_at as Date) < cutoff),
      )
      .sort((a, b) => (a.created_at as Date).getTime() - (b.created_at as Date).getTime())
      .slice(0, limit)
      .map((n) => ({ id: n.id, business_id: n.business_id }));
  });

  updateNotification = jest.fn(async (b: string, id: string, data: FakeInput) => {
    const row = this.notifications.get(id);
    if (!row || row.business_id !== b) {
      throw new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: '5',
      });
    }
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in (v as object)) {
        row[k] = ((row[k] as number) ?? 0) + (v as { increment: number }).increment;
      } else {
        row[k] = v;
      }
    }
    row.updated_at = new Date();
    return { ...row };
  });

  list = jest.fn(
    async (_businessId: string, _filters: Record<string, unknown>) => ({
      data: [] as FakeRow[],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    }),
  );

  aggregateStats = jest.fn(async () => ({
    byStatus: [
      { status: NotificationStatus.SENT, count: 3 },
      { status: NotificationStatus.DELIVERED, count: 5 },
      { status: NotificationStatus.FAILED, count: 2 },
    ],
    byChannel: [{ channel: NotificationTemplateChannel.WHATSAPP, count: 10 }],
  }));

  // Templates
  createTemplate = jest.fn(async (data: FakeInput) => {
    const row = {
      id: nextId(),
      ...data,
      is_approved: false,
      approval_status: null,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    };
    this.templates.set(row.id, row as unknown as FakeRow);
    return row;
  });
  findTemplateById = jest.fn(async (b: string, id: string) => {
    const t = this.templates.get(id);
    return t && t.business_id === b && !t.deleted_at ? { ...t } : null;
  });
  findTemplateByName = jest.fn(async (b: string, ch: string, name: string) => {
    return (
      [...this.templates.values()].find(
        (t) => t.business_id === b && t.channel === ch && t.name === name && !t.deleted_at,
      ) ?? null
    );
  });
  findTemplatesForTriggers = jest.fn(
    async (b: string, ids: string[], named: { channel: string; name: string }[]) => {
      if (ids.length === 0 && named.length === 0) return [];
      const idSet = new Set(ids);
      return [...this.templates.values()].filter(
        (t) =>
          t.business_id === b &&
          !t.deleted_at &&
          (idSet.has(t.id) ||
            named.some((n) => n.channel === t.channel && n.name === t.name)),
      );
    },
  );
  listTemplates = jest.fn(async () => [...this.templates.values()]);
  updateTemplate = jest.fn(async (b: string, id: string, data: FakeInput) => {
    const t = this.templates.get(id);
    Object.assign(t!, data, { updated_at: new Date() });
    return { ...t };
  });
  softDeleteTemplate = jest.fn(async (b: string, id: string) => {
    const t = this.templates.get(id);
    if (t) t.deleted_at = new Date();
  });

  // Preferences
  listPreferences = jest.fn(async (b: string, c: string) =>
    this.preferences.filter((p) => p.business_id === b && p.client_id === c),
  );
  upsertPreference = jest.fn(async (input: FakeInput) => {
    const data = input as {
      businessId: string;
      clientId: string;
      channel: unknown;
      category: unknown;
      isEnabled: boolean;
      quietHoursStart?: number | null;
      quietHoursEnd?: number | null;
    };
    const row = {
      id: nextId(),
      business_id: data.businessId,
      client_id: data.clientId,
      channel: data.channel,
      category: data.category,
      is_enabled: data.isEnabled,
      quiet_hours_start: data.quietHoursStart ?? null,
      quiet_hours_end: data.quietHoursEnd ?? null,
    };
    this.preferences.push(row);
    return row;
  });

  // Triggers
  createTrigger = jest.fn(async (data: FakeInput) => {
    const row = {
      id: nextId(),
      ...data,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    };
    this.triggers.set(row.id, row as unknown as FakeRow);
    return row;
  });
  findTriggerById = jest.fn(async (b: string, id: string) => {
    const t = this.triggers.get(id);
    return t && t.business_id === b && !t.deleted_at ? { ...t } : null;
  });
  listTriggers = jest.fn(async (b: string, eventType?: string, activeOnly?: boolean) =>
    [...this.triggers.values()].filter(
      (t) =>
        t.business_id === b &&
        !t.deleted_at &&
        (!eventType || t.event_type === eventType) &&
        (!activeOnly || t.is_active),
    ),
  );
  updateTrigger = jest.fn(async (b: string, id: string, data: FakeInput) => {
    const t = this.triggers.get(id);
    Object.assign(t!, data, { updated_at: new Date() });
    return { ...t };
  });
  softDeleteTrigger = jest.fn(async (b: string, id: string) => {
    const t = this.triggers.get(id);
    if (t) t.deleted_at = new Date();
  });

  // Clients
  findClient = jest.fn(async (b: string, id: string) => {
    const c = this.clients.get(id);
    return c && c.business_id === b ? { ...c } : null;
  });

  findExistingClientIds = jest.fn(async (b: string, ids: string[]) => {
    return new Set(ids.filter((id) => this.clients.get(id)?.business_id === b));
  });

  findClientsByIds = jest.fn(async (b: string, ids: string[]) => {
    const map = new Map<string, unknown>();
    for (const id of ids) {
      const c = this.clients.get(id);
      if (c && c.business_id === b) map.set(id, { ...c });
    }
    return map;
  });

  listPreferencesForClients = jest.fn(async (b: string, ids: string[]) => {
    const map = new Map<string, unknown[]>();
    for (const id of ids) {
      const prefs = this.preferences.filter((p) => p.business_id === b && p.client_id === id);
      if (prefs.length > 0) map.set(id, prefs);
    }
    return map;
  });

  // Test helpers
  seedClient(overrides: Record<string, unknown> = {}) {
    const c = {
      id: CLIENT,
      business_id: BUSINESS,
      email: 'asha@example.com',
      phone: '+919876543210',
      profile: {},
      opt_outs: {},
      ...overrides,
    };
    this.clients.set(c.id, c);
    return c;
  }

  seedNotification(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    const row = {
      id: nextId(),
      business_id: BUSINESS,
      client_id: CLIENT,
      channel: NotificationTemplateChannel.WHATSAPP,
      category: NotificationCategory.TRANSACTIONAL,
      status: NotificationStatus.QUEUED,
      template_id: null,
      event_type: null,
      recipient: '+919876543210',
      subject: null,
      content: { text: 'hi' },
      data: {},
      dedupe_key: null,
      batch_id: null,
      campaign_id: null,
      attempts: 0,
      max_attempts: 3,
      provider_message_id: null,
      failure_reason: null,
      scheduled_at: null,
      queued_at: now,
      sent_at: null,
      delivered_at: null,
      read_at: null,
      failed_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      ...overrides,
    };
    this.notifications.set(row.id, row);
    return row;
  }
}

// ─────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────

function makeService(opts: { outcome?: SendOutcome; limiter?: NotificationRateLimiter } = {}) {
  const repo = new FakeRepo();
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const emitter = { emit: jest.fn() };
  const send = jest
    .fn<Promise<SendOutcome>, []>()
    .mockResolvedValue(opts.outcome ?? { success: true, providerMessageId: 'p1' });
  const sender = {
    channel: NotificationTemplateChannel.WHATSAPP,
    validateRecipient: () => null,
    send,
  };
  const senders = { get: jest.fn(() => sender), has: () => true };
  const limiter = opts.limiter ?? new NotificationRateLimiter();

  const service = new NotificationService(
    repo as never,
    new TemplateRenderer(),
    limiter as never,
    senders as never,
    emitter as never,
    queue as never,
  );
  return { service, repo, queue, emitter, send, sender, senders, limiter };
}

const emitted = (emitter: { emit: jest.Mock }, type: string) =>
  emitter.emit.mock.calls.filter((c) => c[0] === type);

beforeEach(() => {
  idSeq = 0;
});

// ─────────────────────────────────────────────
// dispatch()
// ─────────────────────────────────────────────

describe('NotificationService.dispatch', () => {
  it('queues an ad-hoc notification and emits notification.queued', async () => {
    const { service, queue, emitter } = makeService();
    const result = await service.dispatch(BUSINESS, {
      channel: NotificationTemplateChannel.WHATSAPP,
      recipient: '+919876543210',
      body: { text: 'Hi {{ name }}' },
      data: { name: 'Asha' },
    });

    expect(result.skipped).toBe(false);
    expect(result.notification.status).toBe(NotificationStatus.QUEUED);
    expect((result.notification.content as { text: string }).text).toBe('Hi Asha');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(emitted(emitter, 'notification.queued')).toHaveLength(1);
  });

  it('resolves the recipient from the client when not given', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    const result = await service.dispatch(BUSINESS, {
      clientId: CLIENT,
      channel: NotificationTemplateChannel.EMAIL,
      body: { subject: 'Hello', text: 'body' },
    });
    expect(result.notification.recipient).toBe('asha@example.com');
  });

  it('throws NotFound when templateName does not exist', async () => {
    const { service } = makeService();
    await expect(
      service.dispatch(BUSINESS, {
        channel: NotificationTemplateChannel.WHATSAPP,
        templateName: 'missing',
        recipient: '+919876543210',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('skips a MARKETING notification when the client opted out of the channel', async () => {
    const { service, repo, emitter, queue } = makeService();
    repo.seedClient({ opt_outs: { WHATSAPP: true } });
    const result = await service.dispatch(BUSINESS, {
      clientId: CLIENT,
      channel: NotificationTemplateChannel.WHATSAPP,
      category: NotificationCategory.MARKETING,
      body: { text: 'Sale!' },
    });
    expect(result.skipped).toBe(true);
    expect(result.notification.status).toBe(NotificationStatus.SKIPPED);
    expect(emitted(emitter, 'notification.skipped')).toHaveLength(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('still sends a TRANSACTIONAL notification despite a channel opt-out', async () => {
    const { service, repo } = makeService();
    repo.seedClient({ opt_outs: { WHATSAPP: true } });
    const result = await service.dispatch(BUSINESS, {
      clientId: CLIENT,
      channel: NotificationTemplateChannel.WHATSAPP,
      category: NotificationCategory.TRANSACTIONAL,
      body: { text: 'Your receipt' },
    });
    expect(result.skipped).toBe(false);
    expect(result.notification.status).toBe(NotificationStatus.QUEUED);
  });

  it('honours an explicit per-category opt-out even for TRANSACTIONAL', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    repo.preferences.push({
      id: nextId(),
      business_id: BUSINESS,
      client_id: CLIENT,
      channel: NotificationTemplateChannel.WHATSAPP,
      category: NotificationCategory.TRANSACTIONAL,
      is_enabled: false,
      quiet_hours_start: null,
      quiet_hours_end: null,
    });
    const result = await service.dispatch(BUSINESS, {
      clientId: CLIENT,
      channel: NotificationTemplateChannel.WHATSAPP,
      category: NotificationCategory.TRANSACTIONAL,
      body: { text: 'Your receipt' },
    });
    expect(result.skipped).toBe(true);
  });

  it('records SKIPPED when no recipient address is available', async () => {
    const { service, repo } = makeService();
    repo.seedClient({ email: null, phone: null });
    const result = await service.dispatch(BUSINESS, {
      clientId: CLIENT,
      channel: NotificationTemplateChannel.SMS,
      body: { text: 'hi' },
    });
    expect(result.skipped).toBe(true);
    expect(result.notification.failureReason).toMatch(/No SMS address/);
  });

  it('is idempotent on dedupeKey (returns the existing notification)', async () => {
    const { service, queue } = makeService();
    const dto = {
      channel: NotificationTemplateChannel.WHATSAPP,
      recipient: '+919876543210',
      body: { text: 'hi' },
      dedupeKey: 'evt-1',
    };
    const first = await service.dispatch(BUSINESS, dto);
    const second = await service.dispatch(BUSINESS, dto);
    expect(second.notification.id).toBe(first.notification.id);
    // Only the first send is queued.
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('throws BadRequest when there is no renderable content', async () => {
    const { service } = makeService();
    await expect(
      service.dispatch(BUSINESS, {
        channel: NotificationTemplateChannel.WHATSAPP,
        recipient: '+919876543210',
        body: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─────────────────────────────────────────────
// processDispatch()
// ─────────────────────────────────────────────

describe('NotificationService.processDispatch', () => {
  it('sends a queued notification and marks it SENT', async () => {
    const { service, repo, emitter, send } = makeService();
    const row = repo.seedNotification();
    await service.processDispatch(BUSINESS, row.id);

    expect(send).toHaveBeenCalledTimes(1);
    const updated = repo.notifications.get(row.id);
    expect(updated!.status).toBe(NotificationStatus.SENT);
    expect(updated!.provider_message_id).toBe('p1');
    expect(updated!.attempts).toBe(1);
    expect(emitted(emitter, 'notification.sent')).toHaveLength(1);
  });

  it('skips notifications already in a terminal state', async () => {
    const { service, repo, send } = makeService();
    const row = repo.seedNotification({ status: NotificationStatus.SENT });
    await service.processDispatch(BUSINESS, row.id);
    expect(send).not.toHaveBeenCalled();
  });

  it('retries a transient failure with backoff (status QUEUED)', async () => {
    const { service, repo, queue } = makeService({
      outcome: { success: false, retryable: true, error: 'timeout' },
    });
    const row = repo.seedNotification();
    await service.processDispatch(BUSINESS, row.id);

    const updated = repo.notifications.get(row.id);
    expect(updated!.status).toBe(NotificationStatus.QUEUED);
    expect(updated!.attempts).toBe(1);
    expect(updated!.failure_reason).toBe('timeout');
    // Re-queued for a retry.
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][2].delay).toBeGreaterThan(0);
  });

  it('fails permanently for a non-retryable error', async () => {
    const { service, repo, emitter } = makeService({
      outcome: { success: false, retryable: false, error: 'invalid recipient' },
    });
    const row = repo.seedNotification();
    await service.processDispatch(BUSINESS, row.id);

    const updated = repo.notifications.get(row.id);
    expect(updated!.status).toBe(NotificationStatus.FAILED);
    expect(updated!.failed_at).not.toBeNull();
    expect(emitted(emitter, 'notification.failed')).toHaveLength(1);
  });

  it('fails permanently once attempts reach max_attempts', async () => {
    const { service, repo } = makeService({
      outcome: { success: false, retryable: true, error: 'timeout' },
    });
    const row = repo.seedNotification({ attempts: 2, max_attempts: 3 });
    await service.processDispatch(BUSINESS, row.id);
    expect(repo.notifications.get(row.id)!.status).toBe(NotificationStatus.FAILED);
  });

  // Dispatch jobs are queued with `attempts: 1` because this method owns the
  // retry bookkeeping, and nothing sweeps the table for rows left behind. So a
  // throw that escapes `processDispatch` is not "one failed attempt" — it is a
  // notification that will never be sent, never be failed, and never be seen
  // again. These pin the two throwing paths onto the recorded-failure path.
  it('records a failure when the sender registry has no sender for the channel', async () => {
    const { service, repo, senders, queue } = makeService();
    senders.get.mockImplementation(() => {
      throw new NotFoundException('No sender registered for channel: WHATSAPP');
    });
    const row = repo.seedNotification();

    await expect(service.processDispatch(BUSINESS, row.id)).resolves.toBeUndefined();

    const updated = repo.notifications.get(row.id);
    // Not left in QUEUED with nothing scheduled: the attempt is recorded and a
    // retry is on the queue, so the row is still moving toward a terminal state.
    expect(updated!.attempts).toBe(1);
    expect(updated!.failure_reason).toContain('No sender registered');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('reaches FAILED rather than stranding when the send path keeps throwing', async () => {
    const { service, repo, senders, emitter } = makeService();
    senders.get.mockImplementation(() => {
      throw new Error('registry exploded');
    });
    // One attempt short of the budget, so this dispatch is the last one.
    const row = repo.seedNotification({ attempts: 2, max_attempts: 3 });

    await service.processDispatch(BUSINESS, row.id);

    const updated = repo.notifications.get(row.id);
    expect(updated!.status).toBe(NotificationStatus.FAILED);
    expect(updated!.failed_at).not.toBeNull();
    expect(updated!.failure_reason).toBe('registry exploded');
    // The terminal event is what an operator (and any downstream consumer)
    // actually sees; a stranded row emits nothing at all.
    expect(emitted(emitter, 'notification.failed')).toHaveLength(1);
  });

  it('records a failure when a sender throws instead of returning an outcome', async () => {
    const { service, repo, send, queue } = makeService();
    // `ChannelSender.send` is documented never to throw; hold that line anyway.
    send.mockRejectedValue(new Error('provider client blew up'));
    const row = repo.seedNotification();

    await expect(service.processDispatch(BUSINESS, row.id)).resolves.toBeUndefined();

    const updated = repo.notifications.get(row.id);
    expect(updated!.attempts).toBe(1);
    expect(updated!.failure_reason).toBe('provider client blew up');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('re-queues without consuming an attempt when rate limited', async () => {
    const limiter = new NotificationRateLimiter({
      WHATSAPP: { limit: 1, windowMs: 1000 },
      SMS: { limit: 1, windowMs: 1000 },
      EMAIL: { limit: 1, windowMs: 1000 },
      PUSH: { limit: 1, windowMs: 1000 },
    });
    // Exhaust the window before processing.
    limiter.tryConsume(BUSINESS, NotificationTemplateChannel.WHATSAPP);
    const { service, repo, queue, send } = makeService({ limiter });
    const row = repo.seedNotification();
    await service.processDispatch(BUSINESS, row.id);

    expect(send).not.toHaveBeenCalled();
    expect(repo.notifications.get(row.id)!.attempts).toBe(0);
    expect(queue.add).toHaveBeenCalledTimes(1); // re-queued
  });
});

// ─────────────────────────────────────────────
// updateDeliveryStatus()
// ─────────────────────────────────────────────

describe('NotificationService.updateDeliveryStatus', () => {
  it('applies a DELIVERED receipt and emits notification.delivered', async () => {
    const { service, repo, emitter } = makeService();
    const row = repo.seedNotification({ status: NotificationStatus.SENT });
    const dto = await service.updateDeliveryStatus(BUSINESS, row.id, {
      status: NotificationStatus.DELIVERED,
    });
    expect(dto.status).toBe(NotificationStatus.DELIVERED);
    expect(dto.deliveredAt).not.toBeNull();
    expect(emitted(emitter, 'notification.delivered')).toHaveLength(1);
  });

  it('looks the notification up by providerMessageId', async () => {
    const { service, repo } = makeService();
    const row = repo.seedNotification({
      status: NotificationStatus.SENT,
      provider_message_id: 'wamid.xyz',
    });
    const dto = await service.updateDeliveryStatus(BUSINESS, 'wamid.xyz', {
      status: NotificationStatus.READ,
    });
    expect(dto.id).toBe(row.id);
    expect(dto.readAt).not.toBeNull();
  });

  it('throws NotFound for an unknown id', async () => {
    const { service } = makeService();
    await expect(
      service.updateDeliveryStatus(BUSINESS, 'nope', {
        status: NotificationStatus.DELIVERED,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ─────────────────────────────────────────────
// handleEventTrigger()
// ─────────────────────────────────────────────

describe('NotificationService.handleEventTrigger', () => {
  it('dispatches a default trigger when none is configured', async () => {
    const { service, repo, queue } = makeService();
    repo.seedClient();
    await service.handleEventTrigger('order.confirmed', {
      businessId: BUSINESS,
      clientId: CLIENT,
      orderId: 'ORD-1',
    });
    expect(repo.createNotification).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const created = [...repo.notifications.values()][0];
    expect(created!.event_type).toBe('order.confirmed');
    expect(created!.dedupe_key).toBe('order.confirmed:ORD-1:WHATSAPP');
  });

  it('does not dispatch when a configured trigger condition fails', async () => {
    const { service, repo, queue } = makeService();
    repo.seedClient();
    await service.createTrigger(BUSINESS, {
      eventType: 'order.confirmed',
      channel: NotificationTemplateChannel.WHATSAPP,
      conditions: [{ path: 'totalPaise', op: 'gte', value: 100000 }],
    });
    await service.handleEventTrigger('order.confirmed', {
      businessId: BUSINESS,
      clientId: CLIENT,
      orderId: 'ORD-2',
      totalPaise: 5000,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('ignores events without a businessId', async () => {
    const { service, repo } = makeService();
    await service.handleEventTrigger('order.confirmed', { orderId: 'x' });
    expect(repo.createNotification).not.toHaveBeenCalled();
  });

  it('does not dispatch a configured trigger pointing at an unapproved WhatsApp template', async () => {
    const { service, repo, queue } = makeService();
    repo.seedClient();
    const tpl = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.WHATSAPP,
      name: 'order_confirmed_wa',
      content: { text: 'Your order is confirmed' },
    });
    await service.createTrigger(BUSINESS, {
      eventType: 'order.confirmed',
      channel: NotificationTemplateChannel.WHATSAPP,
      templateId: tpl.id,
    });

    await service.handleEventTrigger('order.confirmed', {
      businessId: BUSINESS,
      clientId: CLIENT,
      orderId: 'ORD-3',
    });

    expect(queue.add).not.toHaveBeenCalled();
    expect(repo.createNotification).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Templates / preferences / triggers / stats
// ─────────────────────────────────────────────

describe('NotificationService templates', () => {
  it('creates a template and derives variables from the body', async () => {
    const { service } = makeService();
    const tpl = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.EMAIL,
      name: 'welcome',
      content: { subject: 'Hi {{ name }}', text: 'Order {{ order.id }}' },
    });
    expect(tpl.variables.sort()).toEqual(['name', 'order.id'].sort());
  });

  it('rejects a duplicate template name', async () => {
    const { service } = makeService();
    const dto = {
      channel: NotificationTemplateChannel.EMAIL,
      name: 'welcome',
      content: { text: 'hi' },
    };
    await service.createTemplate(BUSINESS, dto);
    await expect(service.createTemplate(BUSINESS, dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('previews a template against sample data', async () => {
    const { service } = makeService();
    const tpl = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      name: 'otp',
      content: { text: 'Code: {{ otp }}' },
    });
    const preview = await service.previewTemplate(BUSINESS, tpl.id, { otp: '123' });
    expect(preview.text).toBe('Code: 123');
  });

  it('rejects dispatch by name for an unapproved WhatsApp template', async () => {
    const { service } = makeService();
    await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.WHATSAPP,
      name: 'order_shipped',
      content: { text: 'Your order shipped' },
    });

    await expect(
      service.dispatch(BUSINESS, {
        channel: NotificationTemplateChannel.WHATSAPP,
        templateName: 'order_shipped',
        recipient: '+919876543210',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('dispatches by name once a WhatsApp template is approved', async () => {
    const { service } = makeService();
    const tpl = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.WHATSAPP,
      name: 'order_shipped',
      content: { text: 'Your order shipped' },
    });
    await service.approveTemplate(BUSINESS, tpl.id);

    const result = await service.dispatch(BUSINESS, {
      channel: NotificationTemplateChannel.WHATSAPP,
      templateName: 'order_shipped',
      recipient: '+919876543210',
    });

    expect(result.skipped).toBe(false);
  });

  it('does not gate non-WhatsApp channels on approval', async () => {
    const { service } = makeService();
    const tpl = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      name: 'shipped_sms',
      content: { text: 'Your order shipped' },
    });
    expect(tpl.isApproved).toBe(false);

    const result = await service.dispatch(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      templateName: 'shipped_sms',
      recipient: '+919876543210',
    });

    expect(result.skipped).toBe(false);
  });

  it('approveTemplate sets is_approved and clears any rejection reason', async () => {
    const { service } = makeService();
    const tpl = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.WHATSAPP,
      name: 'promo',
      content: { text: 'Sale!' },
    });
    await service.rejectTemplate(BUSINESS, tpl.id, 'Marketing copy too aggressive');

    const approved = await service.approveTemplate(BUSINESS, tpl.id);

    expect(approved.isApproved).toBe(true);
    expect(approved.approvalStatus).toBe('APPROVED');
  });

  it('rejectTemplate records the rejection reason', async () => {
    const { service } = makeService();
    const tpl = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.WHATSAPP,
      name: 'promo2',
      content: { text: 'Sale!' },
    });

    const rejected = await service.rejectTemplate(BUSINESS, tpl.id, 'Formatting violation');

    expect(rejected.isApproved).toBe(false);
    expect(rejected.approvalStatus).toBe('REJECTED');
  });
});

describe('NotificationService preferences', () => {
  it('upserts a preference', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    const pref = await service.setPreference(BUSINESS, {
      clientId: CLIENT,
      channel: NotificationTemplateChannel.SMS,
      isEnabled: false,
    });
    expect(pref.isEnabled).toBe(false);
  });

  it('rejects a half-specified quiet-hours window', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    await expect(
      service.setPreference(BUSINESS, {
        clientId: CLIENT,
        channel: NotificationTemplateChannel.SMS,
        isEnabled: true,
        quietHoursStart: 1320,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('NotificationService stats', () => {
  it('computes delivery and failure rates', async () => {
    const { service } = makeService();
    const stats = await service.getStats(BUSINESS);
    expect(stats.total).toBe(10);
    expect(stats.byChannel.WHATSAPP).toBe(10);
    // delivered+read = 5 of 10
    expect(stats.deliveryRate).toBeCloseTo(0.5);
    expect(stats.failureRate).toBeCloseTo(0.2);
  });
});

// ─────────────────────────────────────────────
// dispatchBatch()
// ─────────────────────────────────────────────

describe('NotificationService.dispatchBatch', () => {
  it('rejects an empty recipient list', async () => {
    const { service } = makeService();
    await expect(
      service.dispatchBatch(BUSINESS, {
        channel: NotificationTemplateChannel.SMS,
        recipients: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a batch with neither templateName nor body', async () => {
    const { service } = makeService();
    await expect(
      service.dispatchBatch(BUSINESS, {
        channel: NotificationTemplateChannel.SMS,
        recipients: [{ recipient: '+919876543210' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('defaults to MARKETING, merges shared data under per-recipient data', async () => {
    const { service, repo } = makeService();

    const result = await service.dispatchBatch(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      body: { text: 'Hi {{ name }}, {{ offer }}' },
      data: { offer: '20% off', name: 'there' },
      recipients: [
        { recipient: '+919000000001', data: { name: 'Asha' } },
        { recipient: '+919000000002' },
      ],
    });

    expect(result).toMatchObject({ total: 2, queued: 2, skipped: 0 });
    const rows = [...repo.notifications.values()];
    expect(rows).toHaveLength(2);
    // Every row shares the batch id and inherits the MARKETING default.
    expect(new Set(rows.map((r) => r.batch_id)).size).toBe(1);
    expect(rows[0]!.batch_id).toBe(result.batchId);
    expect(rows.every((r) => r.category === NotificationCategory.MARKETING)).toBe(true);
    // Per-recipient data wins over the shared data.
    expect((rows[0]!.content as { text: string }).text).toBe('Hi Asha, 20% off');
    expect((rows[1]!.content as { text: string }).text).toBe('Hi there, 20% off');
    expect(rows[0]!.campaign_id).toBeNull();
  });

  it('resolves a template by name and threads category, campaignId and clientId', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      name: 'promo',
      content: { text: 'Deal for {{ name }}' },
    });

    const result = await service.dispatchBatch(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      category: NotificationCategory.TRANSACTIONAL,
      templateName: 'promo',
      campaignId: 'campaign-1',
      recipients: [{ clientId: CLIENT, data: { name: 'Asha' } }],
    });

    expect(result.queued).toBe(1);
    const row = [...repo.notifications.values()][0];
    expect(row!.category).toBe(NotificationCategory.TRANSACTIONAL);
    expect(row!.campaign_id).toBe('campaign-1');
    expect(row!.client_id).toBe(CLIENT);
    expect(row!.recipient).toBe('+919876543210');
    expect((row!.content as { text: string }).text).toBe('Deal for Asha');
  });

  it('counts recipients with no resolvable address as skipped, not queued', async () => {
    const { service, queue } = makeService();

    const result = await service.dispatchBatch(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      body: { text: 'hi' },
      recipients: [{ recipient: '+919000000001' }, {}, {}],
    });

    expect(result).toMatchObject({ total: 3, queued: 1, skipped: 2 });
    // One BATCH job for the single queued recipient; skipped rows are never enqueued.
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('enqueues in BATCH_CHUNK_SIZE chunks with a scheduled delay', async () => {
    const { service, queue } = makeService();
    const scheduledAt = new Date(Date.now() + 3_600_000);
    const recipients = Array.from({ length: BATCH_CHUNK_SIZE + 1 }, (_, i) => ({
      recipient: `+9190000${String(i).padStart(5, '0')}`,
    }));

    const result = await service.dispatchBatch(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      body: { text: 'hi' },
      scheduledAt: scheduledAt.toISOString(),
      recipients,
    });

    expect(result.queued).toBe(BATCH_CHUNK_SIZE + 1);
    const batchJobs = queue.add.mock.calls.filter((c) => c[0] === NOTIFICATION_JOBS.BATCH);
    expect(batchJobs).toHaveLength(2);
    expect(batchJobs[0][1].notificationIds).toHaveLength(BATCH_CHUNK_SIZE);
    expect(batchJobs[1][1].notificationIds).toHaveLength(1);
    expect(batchJobs[0][2].delay).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────
  // Partial failure
  //
  // A batch is up to 5000 recipients built by a caller from their own CRM
  // export. Some of those ids will be stale, and — the case that matters — an
  // id belonging to a different business is indistinguishable from a typo at
  // the point it arrives. What must never happen is a batch that half-commits:
  // rows written for the recipients before the bad one, no batch id returned
  // to the caller, and nothing enqueued to send or fail them.
  // ─────────────────────────────────────────────

  it('rejects the whole batch before writing anything when a recipient belongs to another business', async () => {
    const { service, repo, queue } = makeService();
    repo.seedClient();
    // A real client id — just not this tenant's.
    repo.clients.set('00000000-0000-4000-8000-0000000000ff', {
      id: '00000000-0000-4000-8000-0000000000ff',
      business_id: '00000000-0000-4000-8000-000000000999',
      email: 'other@example.com',
      phone: '+919111111111',
      profile: {},
      opt_outs: {},
    });

    await expect(
      service.dispatchBatch(BUSINESS, {
        channel: NotificationTemplateChannel.SMS,
        body: { text: 'hi' },
        recipients: [
          { recipient: '+919000000001' },
          { clientId: CLIENT },
          { clientId: '00000000-0000-4000-8000-0000000000ff' },
          { recipient: '+919000000002' },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Nothing half-written: the two recipients ahead of the foreign id in the
    // list must not have left rows behind, and nothing may be enqueued.
    expect([...repo.notifications.values()]).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('names how many recipients are unresolvable without dumping the whole list', async () => {
    const { service } = makeService();
    const unknown = Array.from(
      { length: 12 },
      (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
    );

    const thrown = await service
      .dispatchBatch(BUSINESS, {
        channel: NotificationTemplateChannel.SMS,
        body: { text: 'hi' },
        recipients: unknown.map((clientId) => ({ clientId })),
      })
      .then(() => null)
      .catch((e: unknown) => e as Error);

    const message = thrown?.message ?? '';
    expect(message).toContain('12');
    // Actionable, but a 5000-id error body helps nobody.
    expect(message.match(/00000000-0000-4000-8000/g)?.length ?? 0).toBeLessThanOrEqual(5);
  });

  it('still resolves a client that does belong to the tenant', async () => {
    const { service, repo } = makeService();
    repo.seedClient();

    const result = await service.dispatchBatch(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      body: { text: 'hi' },
      recipients: [{ clientId: CLIENT }, { recipient: '+919000000001' }],
    });

    expect(result).toMatchObject({ total: 2, queued: 2, skipped: 0, failed: 0 });
  });

  it('isolates an unexpected per-recipient failure instead of abandoning the batch', async () => {
    const { service, repo, queue } = makeService();
    const realCreate = repo.createNotification.getMockImplementation()!;
    let n = 0;
    repo.createNotification.mockImplementation(async (input: Record<string, unknown>) => {
      n += 1;
      if (n === 2) throw new Error('connection reset');
      return realCreate(input);
    });

    const result = await service.dispatchBatch(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      body: { text: 'hi' },
      recipients: [
        { recipient: '+919000000001' },
        { recipient: '+919000000002' },
        { recipient: '+919000000003' },
      ],
    });

    // The failure is reported rather than swallowed or thrown.
    expect(result).toMatchObject({ total: 3, queued: 2, skipped: 0, failed: 1 });

    // The invariant that matters: every row that got created got enqueued.
    // A row left PENDING and unqueued never sends and never fails.
    const created = [...repo.notifications.values()].map((r) => r.id);
    const enqueued = queue.add.mock.calls
      .filter((c) => c[0] === NOTIFICATION_JOBS.BATCH)
      .flatMap((c) => c[1].notificationIds as string[]);
    expect(new Set(enqueued)).toEqual(new Set(created));
  });

  it('keeps enqueuing later chunks when one chunk fails to reach the queue', async () => {
    const { service, repo, queue } = makeService();
    queue.add.mockImplementationOnce(() => Promise.reject(new Error('redis down')));

    const recipients = Array.from({ length: BATCH_CHUNK_SIZE + 2 }, (_, i) => ({
      recipient: `+9190000${String(i).padStart(5, '0')}`,
    }));

    const result = await service.dispatchBatch(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      body: { text: 'hi' },
      recipients,
    });

    // The second chunk still went out, and the count reported as queued is the
    // number actually handed to the queue — not the number of rows written.
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(result.queued).toBe(2);
    expect(result.failed).toBe(BATCH_CHUNK_SIZE);
    expect([...repo.notifications.values()]).toHaveLength(BATCH_CHUNK_SIZE + 2);
  });
});

// ─────────────────────────────────────────────
// processBatch()
// ─────────────────────────────────────────────

describe('NotificationService.processBatch', () => {
  it('keeps going when one item throws an Error', async () => {
    const { service, repo, send } = makeService();
    const ok1 = repo.seedNotification();
    const bad = repo.seedNotification();
    const ok2 = repo.seedNotification();
    repo.findById.mockImplementationOnce(async () => {
      throw new Error('db down');
    });

    await service.processBatch(BUSINESS, [bad.id, ok1.id, ok2.id]);

    expect(send).toHaveBeenCalledTimes(2);
    expect(repo.notifications.get(ok1.id)!.status).toBe(NotificationStatus.SENT);
    expect(repo.notifications.get(ok2.id)!.status).toBe(NotificationStatus.SENT);
  });

  it('keeps going when one item throws a non-Error value', async () => {
    const { service, repo, send } = makeService();
    const ok = repo.seedNotification();
    repo.findById.mockImplementationOnce(async () => {
      throw 'boom';
    });

    await expect(service.processBatch(BUSINESS, ['missing', ok.id])).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// Scheduling & quiet hours
// ─────────────────────────────────────────────

describe('NotificationService scheduling', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('delays the dispatch job until scheduledAt', async () => {
    const { service, queue, repo } = makeService();
    const scheduledAt = new Date(Date.now() + 600_000);

    await service.dispatch(BUSINESS, {
      channel: NotificationTemplateChannel.WHATSAPP,
      recipient: '+919876543210',
      body: { text: 'hi' },
      scheduledAt: scheduledAt.toISOString(),
    });

    const job = queue.add.mock.calls.find((c) => c[0] === NOTIFICATION_JOBS.DISPATCH);
    expect(job[2].delay).toBeGreaterThan(0);
    expect(job[2].delay).toBeLessThanOrEqual(600_000);
    expect([...repo.notifications.values()][0]!.scheduled_at).toEqual(scheduledAt);
  });

  it('defers a MARKETING notification landing inside quiet hours', async () => {
    // 18:00 UTC = 23:30 IST, inside a 22:00–07:00 IST quiet window.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-10T18:00:00.000Z'));
    const { service, repo } = makeService();
    repo.seedClient();
    repo.preferences.push({
      id: 'pref-quiet',
      business_id: BUSINESS,
      client_id: CLIENT,
      channel: NotificationTemplateChannel.SMS,
      category: null,
      is_enabled: true,
      quiet_hours_start: 22 * 60,
      quiet_hours_end: 7 * 60,
    });

    await service.dispatch(BUSINESS, {
      clientId: CLIENT,
      channel: NotificationTemplateChannel.SMS,
      category: NotificationCategory.MARKETING,
      body: { text: 'sale' },
    });

    const row = [...repo.notifications.values()][0];
    // 23:30 IST → deferred to 07:00 IST, i.e. 7.5 hours out.
    expect((row!.scheduled_at as Date).getTime() - Date.now()).toBe(450 * 60_000);
  });

  it('keeps a later explicit scheduledAt in preference to the quiet-hours end', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-10T18:00:00.000Z'));
    const { service, repo } = makeService();
    repo.seedClient();
    repo.preferences.push({
      id: 'pref-quiet-2',
      business_id: BUSINESS,
      client_id: CLIENT,
      channel: NotificationTemplateChannel.SMS,
      category: null,
      is_enabled: true,
      quiet_hours_start: 22 * 60,
      quiet_hours_end: 7 * 60,
    });
    const later = new Date(Date.now() + 24 * 60 * 60_000);

    await service.dispatch(BUSINESS, {
      clientId: CLIENT,
      channel: NotificationTemplateChannel.SMS,
      category: NotificationCategory.MARKETING,
      body: { text: 'sale' },
      scheduledAt: later.toISOString(),
    });

    expect([...repo.notifications.values()][0]!.scheduled_at).toEqual(later);
  });

  it('throws NotFound when the dispatch names a client that does not exist', async () => {
    const { service } = makeService();
    await expect(
      service.dispatch(BUSINESS, {
        clientId: CLIENT,
        channel: NotificationTemplateChannel.SMS,
        body: { text: 'hi' },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws BadRequest when neither a template nor a body is supplied', async () => {
    const { service } = makeService();
    await expect(
      service.dispatch(BUSINESS, {
        channel: NotificationTemplateChannel.WHATSAPP,
        recipient: '+919876543210',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─────────────────────────────────────────────
// processDispatch() — remaining branches
// ─────────────────────────────────────────────

describe('NotificationService.processDispatch edge cases', () => {
  it('returns quietly when the notification no longer exists', async () => {
    const { service, send } = makeService();
    await expect(service.processDispatch(BUSINESS, 'gone')).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('falls back to a 1s re-queue delay when the limiter reports no retryAfterMs', async () => {
    const limiter = {
      tryConsume: jest.fn(() => ({ allowed: false, retryAfterMs: 0 })),
    } as unknown as NotificationRateLimiter;
    const { service, repo, queue, send } = makeService({ limiter });
    const row = repo.seedNotification();

    await service.processDispatch(BUSINESS, row.id);

    expect(send).not.toHaveBeenCalled();
    const job = queue.add.mock.calls.find((c) => c[0] === NOTIFICATION_JOBS.DISPATCH);
    expect(job[2].delay).toBe(1000);
  });

  it('stores a null provider id when the sender does not return one', async () => {
    const { service, repo } = makeService({ outcome: { success: true } });
    const row = repo.seedNotification();

    await service.processDispatch(BUSINESS, row.id);

    const stored = repo.notifications.get(row.id);
    expect(stored!.status).toBe(NotificationStatus.SENT);
    expect(stored!.provider_message_id).toBeNull();
  });

  it('records "Unknown error" when a retryable failure carries no message', async () => {
    const { service, repo } = makeService({ outcome: { success: false } });
    const row = repo.seedNotification();

    await service.processDispatch(BUSINESS, row.id);

    const stored = repo.notifications.get(row.id);
    expect(stored!.status).toBe(NotificationStatus.QUEUED);
    expect(stored!.failure_reason).toBe('Unknown error');
  });

  it('records "Unknown error" when a permanent failure carries no message', async () => {
    const { service, repo, emitter } = makeService({
      outcome: { success: false, retryable: false },
    });
    const row = repo.seedNotification();

    await service.processDispatch(BUSINESS, row.id);

    const stored = repo.notifications.get(row.id);
    expect(stored!.status).toBe(NotificationStatus.FAILED);
    expect(stored!.failure_reason).toBe('Unknown error');
    expect(emitted(emitter, 'notification.failed')[0][1].reason).toBe('Unknown error');
  });

  it('emits sent/failed events with an undefined clientId for client-less rows', async () => {
    const { service, repo, emitter } = makeService();
    const row = repo.seedNotification({ client_id: null });

    await service.processDispatch(BUSINESS, row.id);

    const event = emitted(emitter, 'notification.sent')[0][1];
    expect(event.clientId).toBeUndefined();
    expect(event.providerMessageId).toBe('p1');
  });
});

// ─────────────────────────────────────────────
// updateDeliveryStatus() — remaining branches
// ─────────────────────────────────────────────

describe('NotificationService.updateDeliveryStatus branches', () => {
  it('falls back to the providerMessageId carried in the body', async () => {
    const { service, repo } = makeService();
    repo.seedNotification({ provider_message_id: 'wamid-9' });

    const dto = await service.updateDeliveryStatus(BUSINESS, 'not-an-id', {
      status: NotificationStatus.DELIVERED,
      providerMessageId: 'wamid-9',
    });

    expect(dto.status).toBe(NotificationStatus.DELIVERED);
    expect(dto.deliveredAt).not.toBeNull();
  });

  it('records a READ receipt without emitting delivered or failed', async () => {
    const { service, repo, emitter } = makeService();
    const row = repo.seedNotification();

    const dto = await service.updateDeliveryStatus(BUSINESS, row.id, {
      status: NotificationStatus.READ,
      providerMessageId: 'wamid-10',
    });

    expect(dto.readAt).not.toBeNull();
    expect(dto.providerMessageId).toBe('wamid-10');
    expect(emitted(emitter, 'notification.delivered')).toHaveLength(0);
    expect(emitted(emitter, 'notification.failed')).toHaveLength(0);
  });

  it('applies a FAILED receipt with the provider-supplied reason', async () => {
    const { service, repo, emitter } = makeService();
    const row = repo.seedNotification();

    const dto = await service.updateDeliveryStatus(BUSINESS, row.id, {
      status: NotificationStatus.FAILED,
      failureReason: 'Number not on WhatsApp',
    });

    expect(dto.failureReason).toBe('Number not on WhatsApp');
    expect(dto.failedAt).not.toBeNull();
    expect(emitted(emitter, 'notification.failed')).toHaveLength(1);
  });

  it('defaults the failure reason when the provider does not give one', async () => {
    const { service, repo } = makeService();
    const row = repo.seedNotification();

    const dto = await service.updateDeliveryStatus(BUSINESS, row.id, {
      status: NotificationStatus.FAILED,
    });

    expect(dto.failureReason).toBe('Reported failed by provider');
  });
});

// ─────────────────────────────────────────────
// retryNotification()
// ─────────────────────────────────────────────

describe('NotificationService.retryNotification', () => {
  it('throws NotFound for an unknown notification', async () => {
    const { service } = makeService();
    await expect(service.retryNotification(BUSINESS, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to retry a notification in a non-FAILED terminal state', async () => {
    const { service, repo } = makeService();
    const row = repo.seedNotification({ status: NotificationStatus.SENT });

    await expect(service.retryNotification(BUSINESS, row.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('re-queues a FAILED notification and clears its failure reason', async () => {
    const { service, repo, queue } = makeService();
    const row = repo.seedNotification({
      status: NotificationStatus.FAILED,
      failure_reason: 'timeout',
    });

    const dto = await service.retryNotification(BUSINESS, row.id);

    expect(dto.status).toBe(NotificationStatus.QUEUED);
    expect(dto.failureReason).toBeNull();
    expect(queue.add).toHaveBeenCalledWith(
      NOTIFICATION_JOBS.DISPATCH,
      { businessId: BUSINESS, notificationId: row.id },
      { attempts: 1, delay: 0 },
    );
  });
});

// ─────────────────────────────────────────────
// History & stats — remaining branches
// ─────────────────────────────────────────────

describe('NotificationService history', () => {
  it('converts the from/to query window into Dates', async () => {
    const { service, repo } = makeService();

    await service.listNotifications(BUSINESS, {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      page: 2,
      limit: 5,
    });

    expect(repo.list).toHaveBeenCalledWith(BUSINESS, {
      status: undefined,
      channel: undefined,
      category: undefined,
      clientId: undefined,
      eventType: undefined,
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-02-01T00:00:00.000Z'),
      page: 2,
      limit: 5,
    });
  });

  it('leaves the window undefined when no dates are given', async () => {
    const { service, repo } = makeService();
    await service.listNotifications(BUSINESS, {});
    expect(repo.list.mock.calls[0]?.[1]).toMatchObject({ from: undefined, to: undefined });
  });

  it('throws NotFound for an unknown notification id', async () => {
    const { service } = makeService();
    await expect(service.getNotification(BUSINESS, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps a notification with null content and data to empty objects', async () => {
    const { service, repo } = makeService();
    const row = repo.seedNotification({ content: null, data: null });

    const dto = await service.getNotification(BUSINESS, row.id);

    expect(dto.content).toEqual({});
    expect(dto.data).toEqual({});
  });

  it('passes the stats window through and reports zero rates for no data', async () => {
    const { service, repo } = makeService();
    repo.aggregateStats.mockResolvedValue({ byStatus: [], byChannel: [] });

    const stats = await service.getStats(BUSINESS, '2026-01-01', '2026-02-01');

    expect(repo.aggregateStats).toHaveBeenCalledWith(
      BUSINESS,
      new Date('2026-01-01'),
      new Date('2026-02-01'),
    );
    expect(stats.total).toBe(0);
    expect(stats.deliveryRate).toBe(0);
    expect(stats.failureRate).toBe(0);
  });
});

// ─────────────────────────────────────────────
// Templates — remaining branches
// ─────────────────────────────────────────────

describe('NotificationService templates (optional fields)', () => {
  it('honours explicitly supplied variables and every optional column', async () => {
    const { service, repo } = makeService();

    const dto = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.EMAIL,
      name: 'welcome',
      channelAccountId: 'acct-1',
      externalName: 'welcome_v2',
      content: { subject: 'Hi {{ name }}', text: 'Welcome {{ name }}' },
      variables: ['name', 'extra'],
      category: 'UTILITY',
      language: 'hi',
    });

    expect(dto.variables).toEqual(['name', 'extra']);
    expect(dto.channelAccountId).toBe('acct-1');
    expect(dto.externalName).toBe('welcome_v2');
    expect(dto.language).toBe('hi');
    expect(repo.createTemplate.mock.calls[0]?.[0].category).toBe('UTILITY');
  });

  it('re-derives variables when the content changes without explicit variables', async () => {
    const { service } = makeService();
    const created = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      name: 'tpl',
      content: { text: 'Hi {{ name }}' },
    });

    const updated = await service.updateTemplate(BUSINESS, created.id, {
      content: { text: 'Hi {{ firstName }} on {{ date }}' },
    });

    expect(updated!.variables.sort()).toEqual(['date', 'firstName']);
  });

  it('prefers explicit variables over derivation when content also changes', async () => {
    const { service } = makeService();
    const created = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      name: 'tpl',
      content: { text: 'Hi {{ name }}' },
    });

    const updated = await service.updateTemplate(BUSINESS, created.id, {
      content: { text: 'Hi {{ firstName }}' },
      variables: ['pinned'],
    });

    expect(updated!.variables).toEqual(['pinned']);
  });

  it('updates variables alone without touching the content', async () => {
    const { service, repo } = makeService();
    const created = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      name: 'tpl',
      content: { text: 'Hi {{ name }}' },
    });

    const updated = await service.updateTemplate(BUSINESS, created.id, {
      variables: ['name', 'city'],
    });

    expect(updated!.variables).toEqual(['name', 'city']);
    expect(repo.updateTemplate.mock.calls[0]?.[2].content).toBeUndefined();
  });

  it('updates externalName, isActive and language independently of content', async () => {
    const { service } = makeService();
    const created = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      name: 'tpl',
      content: { text: 'Hi' },
    });

    const updated = await service.updateTemplate(BUSINESS, created.id, {
      externalName: 'tpl_v3',
      isActive: false,
      language: 'ta',
    });

    expect(updated!.externalName).toBe('tpl_v3');
    expect(updated!.isActive).toBe(false);
    expect(updated!.language).toBe('ta');
  });

  it('throws NotFound for an unknown template id', async () => {
    const { service } = makeService();
    await expect(service.getTemplate(BUSINESS, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to dispatch by name using an inactive template', async () => {
    const { service } = makeService();
    const created = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      name: 'retired',
      content: { text: 'hi' },
    });
    await service.updateTemplate(BUSINESS, created.id, { isActive: false });

    await expect(
      service.dispatch(BUSINESS, {
        channel: NotificationTemplateChannel.SMS,
        recipient: '+919876543210',
        templateName: 'retired',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps a template row with null content and variables to empty defaults', async () => {
    const { service, repo } = makeService();
    repo.templates.set('tpl-null', {
      id: 'tpl-null',
      business_id: BUSINESS,
      channel_account_id: null,
      channel: NotificationTemplateChannel.SMS,
      name: 'bare',
      external_name: null,
      content: null,
      variables: null,
      is_approved: false,
      approval_status: null,
      category: null,
      language: 'en',
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    });

    const [dto] = await service.listTemplates(BUSINESS);

    expect(dto?.content).toEqual({});
    expect(dto?.variables).toEqual([]);
  });

  it('soft-deletes a template', async () => {
    const { service, repo } = makeService();
    const created = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      name: 'tpl',
      content: { text: 'hi' },
    });

    await service.deleteTemplate(BUSINESS, created.id);

    expect(repo.templates.get(created.id)!.deleted_at).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────
// Preferences & triggers — remaining branches
// ─────────────────────────────────────────────

describe('NotificationService preferences (branches)', () => {
  it('throws NotFound when the preference names an unknown client', async () => {
    const { service } = makeService();
    await expect(
      service.setPreference(BUSINESS, {
        clientId: CLIENT,
        channel: NotificationTemplateChannel.SMS,
        isEnabled: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stores a per-category preference with a quiet-hours window', async () => {
    const { service, repo } = makeService();
    repo.seedClient();

    const dto = await service.setPreference(BUSINESS, {
      clientId: CLIENT,
      channel: NotificationTemplateChannel.SMS,
      category: NotificationCategory.MARKETING,
      isEnabled: true,
      quietHoursStart: 1320,
      quietHoursEnd: 420,
    });

    expect(dto.category).toBe(NotificationCategory.MARKETING);
    expect(dto.quietHoursStart).toBe(1320);
    expect(dto.quietHoursEnd).toBe(420);

    const listed = await service.getPreferences(BUSINESS, CLIENT);
    expect(listed).toHaveLength(1);
  });
});

describe('NotificationService triggers (branches)', () => {
  const seedTrigger = async (service: NotificationService, _repo: FakeRepo) => {
    const template = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      name: 'trig-tpl',
      content: { text: 'hi' },
    });
    const trigger = await service.createTrigger(BUSINESS, {
      eventType: 'order.created',
      channel: NotificationTemplateChannel.SMS,
      templateId: template.id,
    });
    return { template, trigger };
  };

  it('throws NotFound when updating an unknown trigger', async () => {
    const { service } = makeService();
    await expect(
      service.updateTrigger(BUSINESS, 'nope', { isActive: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('validates a replacement templateId and writes every supplied field', async () => {
    const { service, repo } = makeService();
    const { trigger } = await seedTrigger(service, repo);
    const replacement = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      name: 'trig-tpl-2',
      content: { text: 'hi again' },
    });

    const updated = await service.updateTrigger(BUSINESS, trigger.id, {
      templateId: replacement.id,
      category: NotificationCategory.REMINDER,
      isActive: false,
      delayMinutes: 15,
      conditions: [{ path: 'total', op: 'gt', value: 100 }],
    });

    expect(updated!.templateId).toBe(replacement.id);
    expect(updated!.category).toBe(NotificationCategory.REMINDER);
    expect(updated!.isActive).toBe(false);
    expect(updated!.delayMinutes).toBe(15);
    expect(updated!.conditions).toHaveLength(1);
  });

  it('throws NotFound when deleting an unknown trigger', async () => {
    const { service } = makeService();
    await expect(service.deleteTrigger(BUSINESS, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('soft-deletes a trigger and maps null conditions to an empty list', async () => {
    const { service, repo } = makeService();
    const { trigger } = await seedTrigger(service, repo);
    repo.triggers.get(trigger.id)!.conditions = null;

    const [dto] = await service.listTriggers(BUSINESS);
    expect(dto?.conditions).toEqual([]);

    await service.deleteTrigger(BUSINESS, trigger.id);
    expect(repo.triggers.get(trigger.id)!.deleted_at).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────
// handleEventTrigger() — remaining branches
// ─────────────────────────────────────────────

describe('NotificationService.handleEventTrigger branches', () => {
  it('ignores an event with no configured trigger and no built-in default', async () => {
    const { service, repo } = makeService();
    await service.handleEventTrigger('unknown.event', { businessId: BUSINESS });
    expect(repo.createNotification).not.toHaveBeenCalled();
  });

  it('dispatches a configured trigger with an approved template and a delay', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    const template = await service.createTemplate(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      name: 'order_tpl',
      content: { text: 'Order {{ orderId }} received' },
    });
    await service.createTrigger(BUSINESS, {
      eventType: 'order.created',
      channel: NotificationTemplateChannel.SMS,
      templateId: template.id,
      delayMinutes: 30,
    });

    await service.handleEventTrigger('order.created', {
      businessId: BUSINESS,
      clientId: CLIENT,
      orderId: 'order-1',
    });

    const row = [...repo.notifications.values()][0];
    expect(row!.template_id).toBe(template.id);
    expect((row!.content as { text: string }).text).toBe('Order order-1 received');
    expect(row!.dedupe_key).toBe('order.created:order-1:SMS');
    expect((row!.scheduled_at as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('falls back to the built-in body when a trigger has no template at all', async () => {
    const { service, repo } = makeService();
    await service.createTrigger(BUSINESS, {
      eventType: 'order.created',
      channel: NotificationTemplateChannel.SMS,
    });

    await service.handleEventTrigger('order.created', {
      businessId: BUSINESS,
      orderId: 'order-2',
      recipient: 'ignored',
    });

    // No client and no recipient override → recorded as SKIPPED, still rendered.
    const row = [...repo.notifications.values()][0];
    expect((row!.content as { text: string }).text).toMatch(/order created/);
    expect(row!.template_id).toBeNull();
  });

  it('treats null trigger conditions as "always match"', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    const trigger = await service.createTrigger(BUSINESS, {
      eventType: 'order.created',
      channel: NotificationTemplateChannel.SMS,
    });
    repo.triggers.get(trigger.id)!.conditions = null;

    await service.handleEventTrigger('order.created', {
      businessId: BUSINESS,
      clientId: CLIENT,
      orderId: 'order-3',
    });

    expect(repo.createNotification).toHaveBeenCalled();
  });

  it('swallows a non-Error thrown while dispatching a trigger', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    await service.createTrigger(BUSINESS, {
      eventType: 'order.created',
      channel: NotificationTemplateChannel.SMS,
    });
    repo.createNotification.mockImplementationOnce(async () => {
      throw 'kaboom';
    });

    await expect(
      service.handleEventTrigger('order.created', {
        businessId: BUSINESS,
        clientId: CLIENT,
        orderId: 'order-4',
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    [{ orderId: 'o-1' }, 'o-1'],
    [{ paymentId: 'pay-1' }, 'pay-1'],
    [{ id: 'ent-1' }, 'ent-1'],
  ])('derives the dedupe key from %o', async (payload, expectedEntity) => {
    const { service, repo } = makeService();
    repo.seedClient();
    await service.createTrigger(BUSINESS, {
      eventType: 'order.created',
      channel: NotificationTemplateChannel.SMS,
    });

    await service.handleEventTrigger('order.created', {
      businessId: BUSINESS,
      clientId: CLIENT,
      ...payload,
    });

    const row = [...repo.notifications.values()][0];
    expect(row!.dedupe_key).toBe(`order.created:${expectedEntity}:SMS`);
  });

  it('falls back to a generated id when the payload carries no entity id', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    await service.createTrigger(BUSINESS, {
      eventType: 'order.created',
      channel: NotificationTemplateChannel.SMS,
    });

    await service.handleEventTrigger('order.created', {
      businessId: BUSINESS,
      clientId: CLIENT,
    });

    const row = [...repo.notifications.values()][0];
    expect(row!.dedupe_key).toMatch(/^order\.created:.+:SMS$/);
  });
});

// ─────────────────────────────────────────────
// Recipient resolution & preference resolution
// ─────────────────────────────────────────────

describe('NotificationService recipient resolution', () => {
  const dispatchTo = async (
    channel: NotificationTemplateChannel,
    clientOverrides: Record<string, unknown> | null,
  ) => {
    const { service, repo } = makeService();
    if (clientOverrides) repo.seedClient(clientOverrides);
    const result = await service.dispatch(BUSINESS, {
      ...(clientOverrides ? { clientId: CLIENT } : {}),
      channel,
      body: { text: 'hi' },
    });
    return { result, repo };
  };

  it('skips when there is neither an override nor a client', async () => {
    const { result } = await dispatchTo(NotificationTemplateChannel.SMS, null);
    expect(result.skipped).toBe(true);
  });

  it('reads the email address for the EMAIL channel', async () => {
    const { result } = await dispatchTo(NotificationTemplateChannel.EMAIL, {
      email: 'asha@example.com',
    });
    expect(result.skipped).toBe(false);
    expect(result.notification.recipient).toBe('asha@example.com');
  });

  it('skips when the client has no email for the EMAIL channel', async () => {
    const { result } = await dispatchTo(NotificationTemplateChannel.EMAIL, {
      email: null,
    });
    expect(result.skipped).toBe(true);
  });

  it.each([['pushToken'], ['deviceToken']])(
    'reads the PUSH token from profile.%s',
    async (key) => {
      const { result } = await dispatchTo(NotificationTemplateChannel.PUSH, {
        profile: { [key]: 'tok-123' },
      });
      expect(result.skipped).toBe(false);
      expect(result.notification.recipient).toBe('tok-123');
    },
  );

  it('skips PUSH when the stored token is not a string', async () => {
    const { result } = await dispatchTo(NotificationTemplateChannel.PUSH, {
      profile: { pushToken: 42 },
    });
    expect(result.skipped).toBe(true);
  });

  it('skips PUSH when the client has no profile at all', async () => {
    const { result } = await dispatchTo(NotificationTemplateChannel.PUSH, {
      profile: null,
    });
    expect(result.skipped).toBe(true);
  });

  it('skips an unrecognised channel', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    const result = await service.dispatch(BUSINESS, {
      clientId: CLIENT,
      channel: 'TELEGRAM' as NotificationTemplateChannel,
      body: { text: 'hi' },
    });
    expect(result.skipped).toBe(true);
  });

  it('records a skipped notification with no client id', async () => {
    const { service, repo, emitter } = makeService();

    const result = await service.dispatch(BUSINESS, {
      channel: NotificationTemplateChannel.SMS,
      body: { text: 'hi' },
    });

    expect(result.skipped).toBe(true);
    expect(result.notification.clientId).toBeNull();
    expect(repo.notifications.size).toBe(1);
    expect(emitted(emitter, 'notification.skipped')[0][1].clientId).toBeUndefined();
  });
});

describe('NotificationService preference resolution', () => {
  it('treats a client with null opt_outs as opted in', async () => {
    const { service, repo } = makeService();
    repo.seedClient({ opt_outs: null });

    const result = await service.dispatch(BUSINESS, {
      clientId: CLIENT,
      channel: NotificationTemplateChannel.SMS,
      category: NotificationCategory.MARKETING,
      body: { text: 'sale' },
    });

    expect(result.skipped).toBe(false);
  });

  it('honours a channel-wide opt-out for MARKETING when no per-category row exists', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    repo.preferences.push({
      id: 'p-wide',
      business_id: BUSINESS,
      client_id: CLIENT,
      channel: NotificationTemplateChannel.SMS,
      category: null,
      is_enabled: false,
      quiet_hours_start: null,
      quiet_hours_end: null,
    });

    const result = await service.dispatch(BUSINESS, {
      clientId: CLIENT,
      channel: NotificationTemplateChannel.SMS,
      category: NotificationCategory.MARKETING,
      body: { text: 'sale' },
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/Opted out of SMS/);
  });

  it('inherits quiet hours from the channel-wide row when it is enabled', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    repo.preferences.push({
      id: 'p-wide-on',
      business_id: BUSINESS,
      client_id: CLIENT,
      channel: NotificationTemplateChannel.SMS,
      category: null,
      is_enabled: true,
      quiet_hours_start: null,
      quiet_hours_end: null,
    });

    const result = await service.dispatch(BUSINESS, {
      clientId: CLIENT,
      channel: NotificationTemplateChannel.SMS,
      category: NotificationCategory.TRANSACTIONAL,
      body: { text: 'receipt' },
    });

    expect(result.skipped).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Outbound mapping
// ─────────────────────────────────────────────

describe('NotificationService outbound mapping', () => {
  it('defaults every missing content field when handing off to the sender', async () => {
    const { service, repo, send } = makeService();
    const row = repo.seedNotification({ content: null, data: null });

    await service.processDispatch(BUSINESS, row.id);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: row.id,
        text: '',
        html: null,
        externalTemplateName: null,
        data: {},
      }),
    );
  });

  it('passes through subject, html and the external template name', async () => {
    const { service, repo, send } = makeService();
    const row = repo.seedNotification({
      subject: 'Receipt',
      content: { text: 'body', html: '<p>body</p>', externalName: 'receipt_v1' },
      data: { orderId: 'o-1' },
    });

    await service.processDispatch(BUSINESS, row.id);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Receipt',
        html: '<p>body</p>',
        externalTemplateName: 'receipt_v1',
        data: { orderId: 'o-1' },
      }),
    );
  });
});

describe('NotificationService.handleEventTrigger — template batching', () => {
  it('resolves every trigger\'s template in one query, not one per trigger', async () => {
    const { service, repo } = makeService();
    repo.seedClient();

    const a = await service.createTemplate(BUSINESS, {
      name: 'tpl_sms',
      channel: NotificationTemplateChannel.SMS,
      content: { text: 'sms {{orderId}}' },
    } as Parameters<typeof service.createTemplate>[1]);
    const b = await service.createTemplate(BUSINESS, {
      name: 'tpl_email',
      channel: NotificationTemplateChannel.EMAIL,
      content: { text: 'email {{orderId}}' },
    } as Parameters<typeof service.createTemplate>[1]);

    await service.createTrigger(BUSINESS, {
      eventType: 'order.created',
      channel: NotificationTemplateChannel.SMS,
      templateId: a.id,
    });
    await service.createTrigger(BUSINESS, {
      eventType: 'order.created',
      channel: NotificationTemplateChannel.EMAIL,
      templateId: b.id,
    });

    repo.findTemplatesForTriggers.mockClear();
    repo.findTemplateById.mockClear();

    await service.handleEventTrigger('order.created', {
      businessId: BUSINESS,
      clientId: CLIENT,
      orderId: 'o-9',
    });

    expect(repo.findTemplatesForTriggers).toHaveBeenCalledTimes(1);
    expect(repo.findTemplateById).not.toHaveBeenCalled();
    expect([...repo.notifications.values()]).toHaveLength(2);
  });

  it('asks for nothing when no trigger passes its conditions', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    await service.createTrigger(BUSINESS, {
      eventType: 'order.created',
      channel: NotificationTemplateChannel.SMS,
      conditions: [{ path: 'total', op: 'gt', value: 1000 }],
    });

    repo.findTemplatesForTriggers.mockClear();

    await service.handleEventTrigger('order.created', {
      businessId: BUSINESS,
      clientId: CLIENT,
      orderId: 'o-9',
      total: 10,
    });

    expect(repo.findTemplatesForTriggers).toHaveBeenCalledWith(BUSINESS, [], []);
    expect([...repo.notifications.values()]).toHaveLength(0);
  });

  it('still dispatches when a trigger references a template that no longer exists', async () => {
    const { service, repo } = makeService();
    repo.seedClient();
    const tpl = await service.createTemplate(BUSINESS, {
      name: 'gone',
      channel: NotificationTemplateChannel.SMS,
      content: { text: 'x' },
    } as Parameters<typeof service.createTemplate>[1]);
    await service.createTrigger(BUSINESS, {
      eventType: 'order.created',
      channel: NotificationTemplateChannel.SMS,
      templateId: tpl.id,
    });
    repo.templates.delete(tpl.id);

    await service.handleEventTrigger('order.created', {
      businessId: BUSINESS,
      clientId: CLIENT,
      orderId: 'o-9',
    });

    expect([...repo.notifications.values()]).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────
// Stuck-notification recovery
// ─────────────────────────────────────────────

/**
 * `recoverStuck` is the backstop for the one gap the module's retry design
 * leaves open: the row lives in Postgres and the job lives in Redis, and every
 * path that writes one then enqueues the other has a window between them. A row
 * that loses its job is otherwise indistinguishable from one that is waiting —
 * never sent, never failed, and silent to `notification.failed` consumers.
 */
describe('recoverStuck', () => {
  const NOW = new Date('2026-08-15T12:00:00Z');
  /** Comfortably past STUCK_NOTIFICATION_AFTER_MS (30m) before NOW. */
  const LONG_AGO = new Date(NOW.getTime() - 90 * 60_000);

  /** A row as `dispatchBatch` leaves one it wrote but could not enqueue. */
  function seedStuck(
    repo: FakeRepo,
    overrides: Record<string, unknown> = {},
  ): FakeRow {
    const row: FakeRow = {
      id: nextId(),
      business_id: BUSINESS,
      client_id: CLIENT,
      channel: NotificationTemplateChannel.WHATSAPP,
      category: NotificationCategory.TRANSACTIONAL,
      status: NotificationStatus.PENDING,
      recipient: '+919876543210',
      content: { text: 'hi' },
      data: {},
      attempts: 0,
      max_attempts: 3,
      scheduled_at: null,
      queued_at: null,
      failure_reason: null,
      deleted_at: null,
      created_at: LONG_AGO,
      updated_at: LONG_AGO,
      ...overrides,
    };
    repo.notifications.set(row.id, row);
    return row;
  }

  it('re-enqueues a row stranded past the threshold and marks it QUEUED', async () => {
    const { service, repo, queue } = makeService();
    const row = seedStuck(repo);

    const result = await service.recoverStuck(NOW);

    expect(result).toEqual({ scanned: 1, requeued: 1, failed: 0 });
    expect(queue.add).toHaveBeenCalledWith(
      NOTIFICATION_JOBS.DISPATCH,
      { businessId: BUSINESS, notificationId: row.id },
      { attempts: 1 },
    );
    const after = repo.notifications.get(row.id)!;
    expect(after.status).toBe(NotificationStatus.QUEUED);
    expect(after.queued_at).toBeInstanceOf(Date);
  });

  it('enqueues before writing the status, so a crash mid-recovery re-strands rather than loses', async () => {
    const { service, repo, queue } = makeService();
    seedStuck(repo);
    const order: string[] = [];
    queue.add.mockImplementation(async () => {
      order.push('enqueue');
    });
    repo.updateNotification.mockImplementation(async () => {
      order.push('status-write');
      return {} as never;
    });

    await service.recoverStuck(NOW);

    expect(order).toEqual(['enqueue', 'status-write']);
  });

  it('fails out a stranded row whose attempts are already exhausted, and emits notification.failed', async () => {
    const { service, repo, queue, emitter } = makeService();
    const row = seedStuck(repo, {
      status: NotificationStatus.QUEUED,
      attempts: 3,
      max_attempts: 3,
      failure_reason: 'provider timeout',
    });

    const result = await service.recoverStuck(NOW);

    expect(result).toEqual({ scanned: 1, requeued: 0, failed: 1 });
    expect(queue.add).not.toHaveBeenCalled();
    const after = repo.notifications.get(row.id)!;
    expect(after.status).toBe(NotificationStatus.FAILED);
    expect(after.failed_at).toBeInstanceOf(Date);
    // The reason the row already carried survives — it says more than
    // "stranded" about why this notification never arrived.
    expect(after.failure_reason).toBe('provider timeout');
    expect(emitted(emitter, 'notification.failed')).toHaveLength(1);
  });

  it('leaves a row alone until it is older than the threshold', async () => {
    const { service, repo, queue } = makeService();
    // 10 minutes old: still inside the 15-minute retry backoff, so a job may
    // legitimately be pending. Re-enqueueing here would double-send.
    seedStuck(repo, { created_at: new Date(NOW.getTime() - 10 * 60_000) });

    const result = await service.recoverStuck(NOW);

    expect(result.scanned).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('leaves a notification scheduled for the future alone', async () => {
    const { service, repo, queue } = makeService();
    // Written long ago but scheduled for tomorrow — a delayed Bull job doing
    // exactly what it was told, not a stranded row.
    seedStuck(repo, { scheduled_at: new Date(NOW.getTime() + 24 * 3_600_000) });

    const result = await service.recoverStuck(NOW);

    expect(result.scanned).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('never touches a row that already reached a terminal status', async () => {
    const { service, repo, queue } = makeService();
    seedStuck(repo, { status: NotificationStatus.SENT });
    seedStuck(repo, { status: NotificationStatus.DELIVERED });

    const result = await service.recoverStuck(NOW);

    expect(result.scanned).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('keeps sweeping after one row fails, and recovers each under its own business', async () => {
    const { service, repo, queue } = makeService();
    const other = '00000000-0000-4000-8000-0000000000ff';
    const doomed = seedStuck(repo);
    const survivor = seedStuck(repo, { business_id: other });
    queue.add.mockImplementation(async (_name: string, data: { notificationId: string }) => {
      if (data.notificationId === doomed.id) throw new Error('redis down');
    });

    const result = await service.recoverStuck(NOW);

    expect(result).toEqual({ scanned: 2, requeued: 1, failed: 0 });
    // The second row's businessId comes off the row, not the first one's.
    expect(queue.add).toHaveBeenLastCalledWith(
      NOTIFICATION_JOBS.DISPATCH,
      { businessId: other, notificationId: survivor.id },
      { attempts: 1 },
    );
    expect(repo.notifications.get(survivor.id)!.status).toBe(NotificationStatus.QUEUED);
  });

  it('re-reads each row scoped to its tenant, and skips one that sent in the meantime', async () => {
    const { service, repo, queue } = makeService();
    const row = seedStuck(repo);
    // The scan sees a stranded row; by the time the sweep gets to it a
    // late-arriving job has delivered it. The global query returns ids only,
    // so this re-read is where the status comes from.
    repo.findById.mockImplementation(async () => ({
      ...row,
      status: NotificationStatus.SENT,
    }));

    const result = await service.recoverStuck(NOW);

    expect(repo.findById).toHaveBeenCalledWith(BUSINESS, row.id);
    expect(result).toEqual({ scanned: 1, requeued: 0, failed: 0 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('skips a row that vanished between the scan and the re-read', async () => {
    const { service, repo, queue } = makeService();
    seedStuck(repo);
    repo.findById.mockResolvedValue(null);

    await expect(service.recoverStuck(NOW)).resolves.toEqual({
      scanned: 1,
      requeued: 0,
      failed: 0,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('is a no-op with nothing stranded', async () => {
    const { service, queue } = makeService();

    await expect(service.recoverStuck(NOW)).resolves.toEqual({
      scanned: 0,
      requeued: 0,
      failed: 0,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
