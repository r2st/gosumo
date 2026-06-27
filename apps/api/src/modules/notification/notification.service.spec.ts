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

const BUSINESS = '00000000-0000-4000-8000-000000000001';
const CLIENT = '00000000-0000-4000-8000-000000000002';

let idSeq = 0;
const nextId = () => `id-${++idSeq}`;

// ─────────────────────────────────────────────
// In-memory fake repository
// ─────────────────────────────────────────────

class FakeRepo {
  notifications = new Map<string, any>();
  templates = new Map<string, any>();
  triggers = new Map<string, any>();
  preferences: any[] = [];
  clients = new Map<string, any>();

  // Notifications
  createNotification = jest.fn(async (data: any) => {
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

  updateNotification = jest.fn(async (b: string, id: string, data: any) => {
    const row = this.notifications.get(id);
    if (!row || row.business_id !== b) {
      throw new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: '5',
      });
    }
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in (v as object)) {
        row[k] = (row[k] ?? 0) + (v as any).increment;
      } else {
        row[k] = v;
      }
    }
    row.updated_at = new Date();
    return { ...row };
  });

  list = jest.fn(async () => ({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 }));

  aggregateStats = jest.fn(async () => ({
    byStatus: [
      { status: NotificationStatus.SENT, count: 3 },
      { status: NotificationStatus.DELIVERED, count: 5 },
      { status: NotificationStatus.FAILED, count: 2 },
    ],
    byChannel: [{ channel: NotificationTemplateChannel.WHATSAPP, count: 10 }],
  }));

  // Templates
  createTemplate = jest.fn(async (data: any) => {
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
    this.templates.set(row.id, row);
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
  listTemplates = jest.fn(async () => [...this.templates.values()]);
  updateTemplate = jest.fn(async (b: string, id: string, data: any) => {
    const t = this.templates.get(id);
    Object.assign(t, data, { updated_at: new Date() });
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
  upsertPreference = jest.fn(async (data: any) => {
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
  createTrigger = jest.fn(async (data: any) => {
    const row = {
      id: nextId(),
      ...data,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    };
    this.triggers.set(row.id, row);
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
  updateTrigger = jest.fn(async (b: string, id: string, data: any) => {
    const t = this.triggers.get(id);
    Object.assign(t, data, { updated_at: new Date() });
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
  return { service, repo, queue, emitter, send, sender, limiter };
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
    expect(result.notification.content.text).toBe('Hi Asha');
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
    expect(updated.status).toBe(NotificationStatus.SENT);
    expect(updated.provider_message_id).toBe('p1');
    expect(updated.attempts).toBe(1);
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
    expect(updated.status).toBe(NotificationStatus.QUEUED);
    expect(updated.attempts).toBe(1);
    expect(updated.failure_reason).toBe('timeout');
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
    expect(updated.status).toBe(NotificationStatus.FAILED);
    expect(updated.failed_at).not.toBeNull();
    expect(emitted(emitter, 'notification.failed')).toHaveLength(1);
  });

  it('fails permanently once attempts reach max_attempts', async () => {
    const { service, repo } = makeService({
      outcome: { success: false, retryable: true, error: 'timeout' },
    });
    const row = repo.seedNotification({ attempts: 2, max_attempts: 3 });
    await service.processDispatch(BUSINESS, row.id);
    expect(repo.notifications.get(row.id).status).toBe(NotificationStatus.FAILED);
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
    expect(repo.notifications.get(row.id).attempts).toBe(0);
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
    expect(created.event_type).toBe('order.confirmed');
    expect(created.dedupe_key).toBe('order.confirmed:ORD-1:WHATSAPP');
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
