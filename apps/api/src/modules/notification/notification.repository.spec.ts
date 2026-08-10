/**
 * NotificationRepository unit tests.
 *
 * This repository is almost entirely query construction, and its branches are
 * of two kinds that fail in opposite directions:
 *
 *   - **Optional filters** (`...(filters.status ? { status } : {})`). A filter
 *     that fails to apply returns *more* rows than asked for; on a stats or
 *     list endpoint that reads as a wrong number, not as an error.
 *   - **The tenant guard on writes.** Every update goes through `updateMany`
 *     scoped by `business_id` and then re-reads the row, specifically so a
 *     mismatched tenant updates zero rows and raises P2025 rather than
 *     succeeding against someone else's notification. That pattern only works
 *     if the `where` really carries the tenant, and only if `count === 0` is
 *     actually treated as a miss — both asserted here.
 *
 * PrismaService is mocked; the assertions are on the emitted query, which is
 * the thing that has to be right.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  NotificationStatus,
  NotificationCategory,
  NotificationTemplateChannel,
} from '@prisma/client';

import { NotificationRepository } from './notification.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS_ID = '00000000-0000-4000-a000-0000000000ff';
const NOTIFICATION_ID = '00000000-0000-4000-b000-000000000001';
const CLIENT_ID = '00000000-0000-4000-c000-000000000001';
const TEMPLATE_ID = '00000000-0000-4000-d000-000000000001';
const TRIGGER_ID = '00000000-0000-4000-e000-000000000001';
const PREFERENCE_ID = '00000000-0000-4000-f000-000000000001';

interface Table {
  create: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  findFirst: jest.Mock;
  findFirstOrThrow: jest.Mock;
  findMany: jest.Mock;
  count: jest.Mock;
  groupBy: jest.Mock;
}

function makeTable(row: Record<string, unknown>): Table {
  return {
    create: jest.fn().mockResolvedValue(row),
    update: jest.fn().mockResolvedValue(row),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn().mockResolvedValue(null),
    findFirstOrThrow: jest.fn().mockResolvedValue(row),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    groupBy: jest.fn().mockResolvedValue([]),
  };
}

describe('NotificationRepository', () => {
  let repository: NotificationRepository;
  let prisma: {
    notifications: Table;
    notification_templates: Table;
    notification_preferences: Table;
    notification_triggers: Table;
    clients: Table;
  };

  beforeEach(async () => {
    prisma = {
      notifications: makeTable({ id: NOTIFICATION_ID }),
      notification_templates: makeTable({ id: TEMPLATE_ID }),
      notification_preferences: makeTable({ id: PREFERENCE_ID }),
      notification_triggers: makeTable({ id: TRIGGER_ID }),
      clients: makeTable({ id: CLIENT_ID }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [NotificationRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(NotificationRepository);
  });

  /** The `where` clause of the nth call to a mocked Prisma method. */
  const whereOf = (fn: jest.Mock, call = 0): Record<string, unknown> =>
    (fn.mock.calls[call]?.[0] as { where: Record<string, unknown> }).where;

  // ─────────────────────────────────────────────
  // createNotification — defaults for every optional column
  // ─────────────────────────────────────────────

  describe('createNotification', () => {
    const REQUIRED = {
      businessId: BUSINESS_ID,
      channel: NotificationTemplateChannel.EMAIL,
      category: NotificationCategory.TRANSACTIONAL,
      status: NotificationStatus.PENDING,
      recipient: 'buyer@example.com',
      content: 'Your site visit is confirmed',
    };

    it('nulls every optional column rather than leaving it undefined', async () => {
      await repository.createNotification(REQUIRED as never);

      expect(prisma.notifications.create.mock.calls[0]![0].data).toEqual({
        business_id: BUSINESS_ID,
        client_id: null,
        channel: NotificationTemplateChannel.EMAIL,
        category: NotificationCategory.TRANSACTIONAL,
        status: NotificationStatus.PENDING,
        template_id: null,
        event_type: null,
        recipient: 'buyer@example.com',
        subject: null,
        content: 'Your site visit is confirmed',
        data: {},
        dedupe_key: null,
        batch_id: null,
        campaign_id: null,
        max_attempts: 3,
        scheduled_at: null,
      });
    });

    it('carries every optional column through when supplied', async () => {
      const scheduledAt = new Date('2026-08-11T09:00:00Z');

      await repository.createNotification({
        ...REQUIRED,
        clientId: CLIENT_ID,
        templateId: TEMPLATE_ID,
        eventType: 'booking.confirmed',
        subject: 'Site visit confirmed',
        data: { leadId: 'l1' },
        dedupeKey: 'booking.confirmed:l1',
        batchId: 'batch-1',
        campaignId: 'camp-1',
        maxAttempts: 5,
        scheduledAt,
      } as never);

      expect(prisma.notifications.create.mock.calls[0]![0].data).toMatchObject({
        client_id: CLIENT_ID,
        template_id: TEMPLATE_ID,
        event_type: 'booking.confirmed',
        subject: 'Site visit confirmed',
        data: { leadId: 'l1' },
        dedupe_key: 'booking.confirmed:l1',
        batch_id: 'batch-1',
        campaign_id: 'camp-1',
        max_attempts: 5,
        scheduled_at: scheduledAt,
      });
    });

    it('keeps an explicit maxAttempts of 0 instead of defaulting it to 3', async () => {
      // `?? 3` rather than `|| 3` is what makes "never retry this" expressible.
      await repository.createNotification({ ...REQUIRED, maxAttempts: 0 } as never);

      expect(prisma.notifications.create.mock.calls[0]![0].data.max_attempts).toBe(0);
    });
  });

  // ─────────────────────────────────────────────
  // Reads are tenant-scoped and skip soft-deleted rows
  // ─────────────────────────────────────────────

  describe('lookups', () => {
    it('scopes findById to the tenant and excludes soft-deleted rows', async () => {
      await repository.findById(BUSINESS_ID, NOTIFICATION_ID);

      expect(whereOf(prisma.notifications.findFirst)).toEqual({
        id: NOTIFICATION_ID,
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
    });

    it('scopes the dedupe lookup to the tenant', async () => {
      // A dedupe key is only unique within a business; an unscoped lookup would
      // let one tenant's key suppress another tenant's notification.
      await repository.findByDedupeKey(BUSINESS_ID, 'booking.confirmed:l1');

      expect(whereOf(prisma.notifications.findFirst)).toEqual({
        business_id: BUSINESS_ID,
        dedupe_key: 'booking.confirmed:l1',
      });
    });

    it('scopes the provider-message lookup to the tenant', async () => {
      await repository.findByProviderMessageId(BUSINESS_ID, 'prov-1');

      expect(whereOf(prisma.notifications.findFirst)).toEqual({
        business_id: BUSINESS_ID,
        provider_message_id: 'prov-1',
        deleted_at: null,
      });
    });
  });

  // ─────────────────────────────────────────────
  // list — the optional filter matrix
  // ─────────────────────────────────────────────

  describe('list', () => {
    it('filters on tenant and soft-delete alone when nothing else is asked', async () => {
      await repository.list(BUSINESS_ID, {});

      expect(whereOf(prisma.notifications.findMany)).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
    });

    it('applies every filter it is given', async () => {
      const from = new Date('2026-08-01T00:00:00Z');
      const to = new Date('2026-08-31T23:59:59Z');

      await repository.list(BUSINESS_ID, {
        status: NotificationStatus.FAILED,
        channel: NotificationTemplateChannel.SMS,
        category: NotificationCategory.MARKETING,
        clientId: CLIENT_ID,
        eventType: 'order.confirmed',
        from,
        to,
      } as never);

      expect(whereOf(prisma.notifications.findMany)).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
        status: NotificationStatus.FAILED,
        channel: NotificationTemplateChannel.SMS,
        category: NotificationCategory.MARKETING,
        client_id: CLIENT_ID,
        event_type: 'order.confirmed',
        created_at: { gte: from, lte: to },
      });
    });

    it('builds an open-ended range from a lower bound alone', async () => {
      const from = new Date('2026-08-01T00:00:00Z');
      await repository.list(BUSINESS_ID, { from } as never);

      expect(whereOf(prisma.notifications.findMany)['created_at']).toEqual({ gte: from });
    });

    it('builds an open-ended range from an upper bound alone', async () => {
      const to = new Date('2026-08-31T00:00:00Z');
      await repository.list(BUSINESS_ID, { to } as never);

      expect(whereOf(prisma.notifications.findMany)['created_at']).toEqual({ lte: to });
    });

    it('omits the date predicate entirely when neither bound is given', async () => {
      await repository.list(BUSINESS_ID, { status: NotificationStatus.SENT } as never);

      expect(whereOf(prisma.notifications.findMany)).not.toHaveProperty('created_at');
    });

    it('counts against exactly the same predicate as the page query', async () => {
      // A total computed from a different `where` than the rows is how a list
      // reports "127 results" and renders 20 of a different set.
      await repository.list(BUSINESS_ID, { status: NotificationStatus.FAILED } as never);

      expect(whereOf(prisma.notifications.count)).toEqual(
        whereOf(prisma.notifications.findMany),
      );
    });

    it('defaults to the first page of 20', async () => {
      await repository.list(BUSINESS_ID, {});

      const args = prisma.notifications.findMany.mock.calls[0]![0];
      expect(args).toMatchObject({ skip: 0, take: 20 });
    });

    it('translates page and limit into skip/take', async () => {
      await repository.list(BUSINESS_ID, { page: 3, limit: 25 } as never);

      expect(prisma.notifications.findMany.mock.calls[0]![0]).toMatchObject({
        skip: 50,
        take: 25,
      });
    });

    it('clamps a page below 1 rather than computing a negative skip', async () => {
      // `skip: -20` is a Prisma error, so an out-of-range page would 500
      // instead of returning the first page.
      await repository.list(BUSINESS_ID, { page: 0 } as never);

      expect(prisma.notifications.findMany.mock.calls[0]![0].skip).toBe(0);
    });

    it('caps the page size so one request cannot ask for everything', async () => {
      await repository.list(BUSINESS_ID, { limit: 5000 } as never);

      expect(prisma.notifications.findMany.mock.calls[0]![0].take).toBe(100);
    });

    it('clamps a non-positive limit up to 1', async () => {
      await repository.list(BUSINESS_ID, { limit: 0 } as never);

      expect(prisma.notifications.findMany.mock.calls[0]![0].take).toBe(1);
    });

    it('reports the page count from the total, not from the rows returned', async () => {
      prisma.notifications.count.mockResolvedValue(45);

      const result = await repository.list(BUSINESS_ID, { limit: 20 } as never);

      expect(result).toMatchObject({ total: 45, page: 1, limit: 20, totalPages: 3 });
    });
  });

  // ─────────────────────────────────────────────
  // aggregateStats
  // ─────────────────────────────────────────────

  describe('aggregateStats', () => {
    it('scopes both groupings to the tenant with no date predicate by default', async () => {
      await repository.aggregateStats(BUSINESS_ID);

      const expected = { business_id: BUSINESS_ID, deleted_at: null };
      expect(whereOf(prisma.notifications.groupBy, 0)).toEqual(expected);
      expect(whereOf(prisma.notifications.groupBy, 1)).toEqual(expected);
    });

    it('applies a bounded window when both dates are given', async () => {
      const from = new Date('2026-08-01T00:00:00Z');
      const to = new Date('2026-08-31T00:00:00Z');

      await repository.aggregateStats(BUSINESS_ID, from, to);

      expect(whereOf(prisma.notifications.groupBy)['created_at']).toEqual({
        gte: from,
        lte: to,
      });
    });

    it('applies a lower bound alone', async () => {
      const from = new Date('2026-08-01T00:00:00Z');
      await repository.aggregateStats(BUSINESS_ID, from);

      expect(whereOf(prisma.notifications.groupBy)['created_at']).toEqual({ gte: from });
    });

    it('applies an upper bound alone', async () => {
      const to = new Date('2026-08-31T00:00:00Z');
      await repository.aggregateStats(BUSINESS_ID, undefined, to);

      expect(whereOf(prisma.notifications.groupBy)['created_at']).toEqual({ lte: to });
    });
  });

  // ─────────────────────────────────────────────
  // Writes fail loudly when the tenant does not match
  // ─────────────────────────────────────────────

  describe('tenant-guarded updates', () => {
    /**
     * Each of these goes `updateMany({ where: { id, business_id } })` then
     * re-reads. The guard is the whole point: with a plain `update({ where: {
     * id } })` a caller could edit any row in the database by id alone.
     */
    const CASES: Array<{
      name: string;
      table: () => Table;
      run: (businessId: string) => Promise<unknown>;
    }> = [
      {
        name: 'updateNotification',
        table: () => prisma.notifications,
        run: (b) => repository.updateNotification(b, NOTIFICATION_ID, { status: 'SENT' } as never),
      },
      {
        name: 'updateTemplate',
        table: () => prisma.notification_templates,
        run: (b) => repository.updateTemplate(b, TEMPLATE_ID, { name: 'x' } as never),
      },
      {
        name: 'updateTrigger',
        table: () => prisma.notification_triggers,
        run: (b) => repository.updateTrigger(b, TRIGGER_ID, { is_active: false } as never),
      },
    ];

    it.each(CASES)('$name scopes the write to the tenant', async ({ table, run }) => {
      await run(BUSINESS_ID);

      expect(whereOf(table().updateMany)).toMatchObject({ business_id: BUSINESS_ID });
    });

    it.each(CASES)('$name raises P2025 when nothing matched', async ({ table, run }) => {
      // Zero rows updated means the id belongs to another tenant (or is gone).
      // Returning silently would let a cross-tenant write look like a success.
      table().updateMany.mockResolvedValue({ count: 0 });

      await expect(run(OTHER_BUSINESS_ID)).rejects.toMatchObject({ code: 'P2025' });
      expect(table().findFirstOrThrow).not.toHaveBeenCalled();
    });

    it.each(CASES)('$name re-reads the row within the tenant', async ({ table, run }) => {
      await run(BUSINESS_ID);

      expect(whereOf(table().findFirstOrThrow)).toMatchObject({
        business_id: BUSINESS_ID,
      });
    });
  });

  describe('recordAttempt', () => {
    it('increments the attempt counter in the same statement as the reason', async () => {
      // Read-modify-write would lose an increment whenever two workers retry
      // the same notification concurrently.
      await repository.recordAttempt(BUSINESS_ID, NOTIFICATION_ID, {
        error: 'SMTP 421',
      } as never);

      const call = prisma.notifications.updateMany.mock.calls[0]![0];
      expect(call.where).toEqual({ id: NOTIFICATION_ID, business_id: BUSINESS_ID });
      expect(call.data).toEqual({ error: 'SMTP 421', attempts: { increment: 1 } });
    });
  });

  // ─────────────────────────────────────────────
  // Templates, triggers, preferences
  // ─────────────────────────────────────────────

  describe('listTemplates', () => {
    it('lists every channel when none is named', async () => {
      await repository.listTemplates(BUSINESS_ID);

      expect(whereOf(prisma.notification_templates.findMany)).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
    });

    it('narrows to one channel when named', async () => {
      await repository.listTemplates(BUSINESS_ID, NotificationTemplateChannel.SMS);

      expect(whereOf(prisma.notification_templates.findMany)).toMatchObject({
        channel: NotificationTemplateChannel.SMS,
      });
    });
  });

  describe('listTriggers', () => {
    it('lists all triggers when neither filter is applied', async () => {
      await repository.listTriggers(BUSINESS_ID);

      expect(whereOf(prisma.notification_triggers.findMany)).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
    });

    it('narrows by event type', async () => {
      await repository.listTriggers(BUSINESS_ID, 'order.confirmed');

      expect(whereOf(prisma.notification_triggers.findMany)).toMatchObject({
        event_type: 'order.confirmed',
      });
    });

    it('narrows to active triggers only', async () => {
      await repository.listTriggers(BUSINESS_ID, undefined, true);

      expect(whereOf(prisma.notification_triggers.findMany)).toMatchObject({
        is_active: true,
      });
    });

    it('omits the active predicate when not asked, so disabled triggers are visible', async () => {
      // The settings screen has to show disabled triggers; a hardcoded
      // `is_active: true` would make them unmanageable.
      await repository.listTriggers(BUSINESS_ID, 'order.confirmed', false);

      expect(whereOf(prisma.notification_triggers.findMany)).not.toHaveProperty('is_active');
    });
  });

  describe('listActiveTriggersForEvent', () => {
    it('scopes to the tenant, the event, and active-and-live rows', async () => {
      await repository.listActiveTriggersForEvent(BUSINESS_ID, 'order.confirmed');

      expect(whereOf(prisma.notification_triggers.findMany)).toEqual({
        business_id: BUSINESS_ID,
        event_type: 'order.confirmed',
        is_active: true,
        deleted_at: null,
      });
    });
  });

  describe('upsertPreference', () => {
    const INPUT = {
      businessId: BUSINESS_ID,
      clientId: CLIENT_ID,
      channel: NotificationTemplateChannel.WHATSAPP,
      category: NotificationCategory.MARKETING,
      isEnabled: false,
    };

    it('creates a preference when none exists', async () => {
      await repository.upsertPreference(INPUT as never);

      expect(prisma.notification_preferences.create).toHaveBeenCalled();
      expect(prisma.notification_preferences.update).not.toHaveBeenCalled();
      expect(prisma.notification_preferences.create.mock.calls[0]![0].data).toMatchObject({
        business_id: BUSINESS_ID,
        client_id: CLIENT_ID,
        is_enabled: false,
        quiet_hours_start: null,
        quiet_hours_end: null,
      });
    });

    it('updates in place when one already exists', async () => {
      prisma.notification_preferences.findFirst.mockResolvedValue({ id: PREFERENCE_ID });

      await repository.upsertPreference({
        ...INPUT,
        isEnabled: true,
        quietHoursStart: 22,
        quietHoursEnd: 8,
      } as never);

      expect(prisma.notification_preferences.create).not.toHaveBeenCalled();
      expect(prisma.notification_preferences.update.mock.calls[0]![0]).toMatchObject({
        where: { id: PREFERENCE_ID, business_id: BUSINESS_ID },
        data: { is_enabled: true, quiet_hours_start: 22, quiet_hours_end: 8 },
      });
    });

    it('keeps a quiet-hours start of 0 rather than nulling it', async () => {
      // Midnight is hour 0, which `||` would discard.
      await repository.upsertPreference({
        ...INPUT,
        quietHoursStart: 0,
        quietHoursEnd: 6,
      } as never);

      expect(prisma.notification_preferences.create.mock.calls[0]![0].data).toMatchObject({
        quiet_hours_start: 0,
        quiet_hours_end: 6,
      });
    });

    it('matches an existing row on the null category, not just a named one', async () => {
      // A null category means "all categories" and is a real stored value; the
      // lookup has to distinguish it from "no filter".
      await repository.upsertPreference({ ...INPUT, category: null } as never);

      expect(whereOf(prisma.notification_preferences.findFirst)).toEqual({
        business_id: BUSINESS_ID,
        client_id: CLIENT_ID,
        channel: NotificationTemplateChannel.WHATSAPP,
        category: null,
      });
    });
  });

  describe('listPreferences', () => {
    it('scopes to the tenant and the client', async () => {
      await repository.listPreferences(BUSINESS_ID, CLIENT_ID);

      expect(whereOf(prisma.notification_preferences.findMany)).toEqual({
        business_id: BUSINESS_ID,
        client_id: CLIENT_ID,
      });
    });
  });

  describe('findClient', () => {
    it('scopes the client lookup to the tenant', async () => {
      await repository.findClient(BUSINESS_ID, CLIENT_ID);

      expect(whereOf(prisma.clients.findFirst)).toMatchObject({
        id: CLIENT_ID,
        business_id: BUSINESS_ID,
      });
    });
  });
  describe('findTemplatesForTriggers', () => {
    it('queries nothing when there are no ids and no names', async () => {
      const result = await repository.findTemplatesForTriggers(BUSINESS_ID, [], []);

      expect(result).toEqual([]);
      expect(prisma.notification_templates.findMany).not.toHaveBeenCalled();
    });

    it('collapses duplicate ids into one IN list', async () => {
      await repository.findTemplatesForTriggers(
        BUSINESS_ID,
        [TEMPLATE_ID, TEMPLATE_ID],
        [],
      );

      expect(whereOf(prisma.notification_templates.findMany)).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
        OR: [{ id: { in: [TEMPLATE_ID] } }],
      });
    });

    it('matches named templates on channel AND name, never name alone', async () => {
      await repository.findTemplatesForTriggers(BUSINESS_ID, [], [
        { channel: NotificationTemplateChannel.SMS, name: 'receipt' },
        { channel: NotificationTemplateChannel.EMAIL, name: 'receipt' },
      ]);

      expect(whereOf(prisma.notification_templates.findMany)).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
        OR: [
          { channel: NotificationTemplateChannel.SMS, name: 'receipt' },
          { channel: NotificationTemplateChannel.EMAIL, name: 'receipt' },
        ],
      });
    });

    it('scopes to the tenant and excludes soft-deleted templates', async () => {
      await repository.findTemplatesForTriggers(BUSINESS_ID, [TEMPLATE_ID], [
        { channel: NotificationTemplateChannel.SMS, name: 'receipt' },
      ]);

      const where = whereOf(prisma.notification_templates.findMany) as Record<string, unknown>;
      expect(where['business_id']).toBe(BUSINESS_ID);
      expect(where['deleted_at']).toBeNull();
      expect(where['OR']).toHaveLength(2);
    });
  });
});
