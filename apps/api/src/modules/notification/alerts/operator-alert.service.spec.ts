/**
 * OperatorAlertService unit tests.
 *
 * The properties worth pinning are the ones that decide whether a human hears
 * about a breach:
 *
 *  - a withheld alert is *stored* as SUPPRESSED, because "why was I never
 *    told" has to be answerable after the fact;
 *  - FAILED and SUPPRESSED are different things — one is a rule working, the
 *    other is a misconfiguration nobody would otherwise see;
 *  - one bad address does not withhold a CRITICAL alert from everyone listed
 *    after it;
 *  - a deferred alert is claimed out of DEFERRED before it is sent, so two
 *    sweep ticks cannot page the same operator twice;
 *  - `raise` never throws, because every caller is an event listener on a path
 *    that must not die because alerting did.
 */
import { Logger, NotFoundException } from '@nestjs/common';
import { Prisma, NotificationCategory, NotificationTemplateChannel } from '@prisma/client';
import { OperatorAlertStatus } from '@gosumo/database';

import { OperatorAlertService } from './operator-alert.service';
import { OperatorAlertRepository } from './operator-alert.repository';
import { NotificationService } from '../notification.service';
import { NotificationSettingsService } from '../settings/notification-settings.service';
import { TenantService } from '../../tenant/tenant.service';
import { ALERT_FAILURE_REASONS, MAX_ALERT_RECIPIENTS } from './operator-alert.constants';

const BIZ = '00000000-0000-4000-a000-000000000001';
const ID = '00000000-0000-4000-b000-000000000001';

const alertRow = (over: Record<string, unknown> = {}) => ({
  id: ID,
  business_id: BIZ,
  kind: 'SLA_BREACH',
  severity: 'WARNING',
  title: 'SLA breached',
  body: null,
  source_channel: null,
  conversation_id: null,
  entity_type: null,
  entity_id: null,
  context: {},
  status: OperatorAlertStatus.PENDING,
  reason: null,
  deferred_until: null,
  delivered_at: null,
  delivered_to: [],
  read_at: null,
  read_by: null,
  dedupe_key: null,
  created_at: new Date('2026-08-21T10:00:00.000Z'),
  updated_at: new Date('2026-08-21T10:00:00.000Z'),
  ...over,
});

const member = (over: Record<string, unknown> = {}) => ({
  id: 'member-1',
  business_id: BIZ,
  email: 'lead@example.com',
  name: 'Lead',
  role: 'MANAGER',
  status: 'ACTIVE',
  notification_prefs: {},
  ...over,
});

describe('OperatorAlertService', () => {
  let repository: {
    create: jest.Mock;
    findByDedupeKey: jest.Mock;
    findById: jest.Mock;
    recordOutcome: jest.Mock;
    claimDeferred: jest.Mock;
    findDueDeferredGlobal: jest.Mock;
    list: jest.Mock;
    markRead: jest.Mock;
    markAllRead: jest.Mock;
    countUnread: jest.Mock;
    countUnreadBySeverity: jest.Mock;
  };
  let settings: {
    resolveAlert: jest.Mock;
    resolveFallbackRecipients: jest.Mock;
  };
  let notifications: { dispatch: jest.Mock };
  let tenant: { getMembers: jest.Mock };
  let service: OperatorAlertService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    repository = {
      create: jest.fn(async (_biz: string, data: Record<string, unknown>) =>
        alertRow({
          status: data.status,
          reason: data.reason ?? null,
          deferred_until: data.deferredUntil ?? null,
          context: data.context ?? {},
        }),
      ),
      findByDedupeKey: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue(null),
      recordOutcome: jest.fn().mockResolvedValue(1),
      claimDeferred: jest.fn().mockResolvedValue(true),
      findDueDeferredGlobal: jest.fn().mockResolvedValue([]),
      list: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
      markRead: jest.fn().mockResolvedValue(1),
      markAllRead: jest.fn().mockResolvedValue(0),
      countUnread: jest.fn().mockResolvedValue(0),
      countUnreadBySeverity: jest.fn().mockResolvedValue([]),
    };
    settings = {
      resolveAlert: jest.fn().mockResolvedValue({ deliver: true, deferUntil: null, reason: null }),
      resolveFallbackRecipients: jest.fn().mockResolvedValue(['ops@example.com']),
    };
    notifications = { dispatch: jest.fn().mockResolvedValue({ id: 'n1' }) };
    tenant = { getMembers: jest.fn().mockResolvedValue([]) };

    service = new OperatorAlertService(
      repository as unknown as OperatorAlertRepository,
      settings as unknown as NotificationSettingsService,
      notifications as unknown as NotificationService,
      tenant as unknown as TenantService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const raise = (over: Record<string, unknown> = {}) =>
    service.raise(BIZ, {
      kind: 'SLA_BREACH',
      severity: 'WARNING',
      title: 'SLA breached',
      ...over,
    });

  // ───────────────────────────────────────────────────────────────────
  // Routing
  // ───────────────────────────────────────────────────────────────────

  describe('routing', () => {
    it('delivers an alert the rules clear', async () => {
      const alert = await raise();

      expect(notifications.dispatch).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({
          channel: NotificationTemplateChannel.EMAIL,
          // SYSTEM, so client-facing marketing opt-outs cannot filter an
          // operational alert to the business's own staff.
          category: NotificationCategory.SYSTEM,
          recipient: 'ops@example.com',
        }),
      );
      expect(repository.recordOutcome).toHaveBeenCalledWith(
        BIZ,
        ID,
        expect.objectContaining({
          status: OperatorAlertStatus.DELIVERED,
          deliveredTo: ['ops@example.com'],
        }),
      );
      expect(alert?.status).toBe(OperatorAlertStatus.DELIVERED);
    });

    it('stores a withheld alert as SUPPRESSED, with the rule that dropped it', async () => {
      settings.resolveAlert.mockResolvedValue({
        deliver: false,
        deferUntil: null,
        reason: 'Alert kind is not in the subscribed list',
      });

      const alert = await raise();

      expect(alert?.status).toBe(OperatorAlertStatus.SUPPRESSED);
      expect(repository.create).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({
          status: OperatorAlertStatus.SUPPRESSED,
          reason: 'Alert kind is not in the subscribed list',
        }),
      );
      // Withheld means not sent — the row exists purely as evidence.
      expect(notifications.dispatch).not.toHaveBeenCalled();
    });

    it('parks a quiet-hours alert as DEFERRED without sending it', async () => {
      const until = new Date('2026-08-21T02:00:00.000Z');
      settings.resolveAlert.mockResolvedValue({
        deliver: true,
        deferUntil: until,
        reason: 'Deferred to the end of quiet hours',
      });

      const alert = await raise();

      expect(alert?.status).toBe(OperatorAlertStatus.DEFERRED);
      expect(repository.create).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({ deferredUntil: until }),
      );
      expect(notifications.dispatch).not.toHaveBeenCalled();
    });

    it('passes the source channel to the rules so muting can apply', async () => {
      await raise({ sourceChannel: 'INSTAGRAM' });

      expect(settings.resolveAlert).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({ sourceChannel: 'INSTAGRAM' }),
        expect.any(Date),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Failure vs suppression
  // ───────────────────────────────────────────────────────────────────

  describe('unreachable businesses', () => {
    it('records FAILED, not SUPPRESSED, when no address resolves', async () => {
      settings.resolveFallbackRecipients.mockResolvedValue([]);

      const alert = await raise();

      expect(alert?.status).toBe(OperatorAlertStatus.FAILED);
      expect(repository.recordOutcome).toHaveBeenCalledWith(BIZ, ID, {
        status: OperatorAlertStatus.FAILED,
        reason: ALERT_FAILURE_REASONS.NO_RECIPIENT,
      });
    });

    it('records FAILED when every dispatch throws', async () => {
      notifications.dispatch.mockRejectedValue(new Error('smtp down'));

      const alert = await raise();

      expect(alert?.status).toBe(OperatorAlertStatus.FAILED);
      expect(repository.recordOutcome).toHaveBeenCalledWith(BIZ, ID, {
        status: OperatorAlertStatus.FAILED,
        reason: ALERT_FAILURE_REASONS.DISPATCH_FAILED,
      });
    });

    it('still delivers to the rest when one address fails', async () => {
      settings.resolveFallbackRecipients.mockResolvedValue([]);
      tenant.getMembers.mockResolvedValue([
        member({ id: 'a', email: 'a@example.com', role: 'MANAGER' }),
        member({ id: 'b', email: 'b@example.com', role: 'MANAGER' }),
      ]);
      notifications.dispatch.mockImplementation(async (_biz, dto) => {
        if (dto.recipient === 'a@example.com') throw new Error('bounced');
        return { id: 'n1' };
      });

      const alert = await raise({ target: 'MANAGER' });

      expect(alert?.status).toBe(OperatorAlertStatus.DELIVERED);
      expect(repository.recordOutcome).toHaveBeenCalledWith(
        BIZ,
        ID,
        expect.objectContaining({ deliveredTo: ['b@example.com'] }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Recipients
  // ───────────────────────────────────────────────────────────────────

  describe('resolveRecipients', () => {
    it('takes an address target literally, without a member lookup', async () => {
      await expect(service.resolveRecipients(BIZ, 'oncall@example.com')).resolves.toEqual([
        'oncall@example.com',
      ]);
      expect(tenant.getMembers).not.toHaveBeenCalled();
    });

    it('resolves a member UUID to that member only', async () => {
      tenant.getMembers.mockResolvedValue([
        member({ id: 'member-1', email: 'lead@example.com' }),
        member({ id: 'member-2', email: 'other@example.com' }),
      ]);

      await expect(service.resolveRecipients(BIZ, 'member-2')).resolves.toEqual([
        'other@example.com',
      ]);
    });

    it('resolves a role name to everyone holding it, case-insensitively', async () => {
      tenant.getMembers.mockResolvedValue([
        member({ id: 'a', email: 'a@example.com', role: 'OWNER' }),
        member({ id: 'b', email: 'b@example.com', role: 'OWNER' }),
        member({ id: 'c', email: 'c@example.com', role: 'STAFF' }),
      ]);

      await expect(service.resolveRecipients(BIZ, 'owner')).resolves.toEqual([
        'a@example.com',
        'b@example.com',
      ]);
    });

    it('skips a member who turned email alerts off, but not one who never set it', async () => {
      tenant.getMembers.mockResolvedValue([
        member({ id: 'a', email: 'a@example.com', role: 'OWNER', notification_prefs: { email: false } }),
        member({ id: 'b', email: 'b@example.com', role: 'OWNER', notification_prefs: {} }),
        member({ id: 'c', email: 'c@example.com', role: 'OWNER', notification_prefs: { email: true } }),
      ]);

      await expect(service.resolveRecipients(BIZ, 'OWNER')).resolves.toEqual([
        'b@example.com',
        'c@example.com',
      ]);
    });

    it('falls back when the target resolves to nobody', async () => {
      // An escalation aimed at a manager who has since left must still reach
      // the business rather than silently reaching no one.
      tenant.getMembers.mockResolvedValue([]);

      await expect(service.resolveRecipients(BIZ, 'member-gone')).resolves.toEqual([
        'ops@example.com',
      ]);
    });

    it('falls back when the member lookup itself fails', async () => {
      tenant.getMembers.mockRejectedValue(new Error('db down'));

      await expect(service.resolveRecipients(BIZ, 'member-1')).resolves.toEqual([
        'ops@example.com',
      ]);
    });

    it('collapses the same address in different casing', async () => {
      tenant.getMembers.mockResolvedValue([
        member({ id: 'a', email: 'Ops@Example.com', role: 'OWNER' }),
        member({ id: 'b', email: 'ops@example.com', role: 'OWNER' }),
      ]);

      await expect(service.resolveRecipients(BIZ, 'OWNER')).resolves.toEqual([
        'Ops@Example.com',
      ]);
    });

    it('caps the fan-out', async () => {
      tenant.getMembers.mockResolvedValue(
        Array.from({ length: MAX_ALERT_RECIPIENTS + 5 }, (_, i) =>
          member({ id: `m${i}`, email: `m${i}@example.com`, role: 'STAFF' }),
        ),
      );

      const resolved = await service.resolveRecipients(BIZ, 'STAFF');
      expect(resolved).toHaveLength(MAX_ALERT_RECIPIENTS);
    });

    it('returns nothing when even the fallback is unreadable', async () => {
      settings.resolveFallbackRecipients.mockRejectedValue(new Error('db down'));
      await expect(service.resolveRecipients(BIZ, null)).resolves.toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Dedupe and resilience
  // ───────────────────────────────────────────────────────────────────

  describe('dedupe', () => {
    it('returns the existing alert without re-delivering on a duplicate key', async () => {
      const existing = alertRow({ status: OperatorAlertStatus.DELIVERED });
      repository.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );
      repository.findByDedupeKey.mockResolvedValue(existing);

      const alert = await raise({ dedupeKey: 'sla.breached:c1:RESOLUTION' });

      expect(alert).toBe(existing);
      expect(notifications.dispatch).not.toHaveBeenCalled();
    });

    it('gives each dispatch its own dedupe key so a repeat cannot double-page', async () => {
      await raise();

      expect(notifications.dispatch).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({ dedupeKey: `alert:${ID}:ops@example.com` }),
      );
    });
  });

  describe('resilience', () => {
    it('never throws when the alert cannot be stored', async () => {
      repository.create.mockRejectedValue(new Error('db down'));
      await expect(raise()).resolves.toBeNull();
    });

    it('never throws when the routing rules cannot be read', async () => {
      settings.resolveAlert.mockRejectedValue(new Error('db down'));
      await expect(raise()).resolves.toBeNull();
    });

    it('does not fail the delivery when the outcome write fails', async () => {
      repository.recordOutcome.mockRejectedValue(new Error('db down'));
      await expect(raise()).resolves.toEqual(
        expect.objectContaining({ status: OperatorAlertStatus.DELIVERED }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Deferred release
  // ───────────────────────────────────────────────────────────────────

  describe('sweepDeferred', () => {
    const now = new Date('2026-08-21T07:00:00.000Z');
    const due = new Date('2026-08-21T06:55:00.000Z');

    it('claims a released alert before sending it', async () => {
      repository.findDueDeferredGlobal.mockResolvedValue([{ id: ID, business_id: BIZ }]);
      repository.findById.mockResolvedValue(
        alertRow({ status: OperatorAlertStatus.DEFERRED, deferred_until: due }),
      );

      const result = await service.sweepDeferred(now);

      expect(repository.claimDeferred).toHaveBeenCalledWith(BIZ, ID);
      expect(notifications.dispatch).toHaveBeenCalled();
      expect(result).toEqual({ found: 1, released: 1, skipped: 0 });
    });

    it('sends nothing when the claim is lost to a concurrent tick', async () => {
      repository.findDueDeferredGlobal.mockResolvedValue([{ id: ID, business_id: BIZ }]);
      repository.findById.mockResolvedValue(
        alertRow({ status: OperatorAlertStatus.DEFERRED, deferred_until: due }),
      );
      repository.claimDeferred.mockResolvedValue(false);

      const result = await service.sweepDeferred(now);

      expect(notifications.dispatch).not.toHaveBeenCalled();
      expect(result).toEqual({ found: 1, released: 0, skipped: 1 });
    });

    it('re-reads the row and skips one already released', async () => {
      repository.findDueDeferredGlobal.mockResolvedValue([{ id: ID, business_id: BIZ }]);
      repository.findById.mockResolvedValue(
        alertRow({ status: OperatorAlertStatus.DELIVERED, deferred_until: due }),
      );

      const result = await service.sweepDeferred(now);

      expect(repository.claimDeferred).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });

    it('closes an alert held past the point of being useful', async () => {
      repository.findDueDeferredGlobal.mockResolvedValue([{ id: ID, business_id: BIZ }]);
      repository.findById.mockResolvedValue(
        alertRow({
          status: OperatorAlertStatus.DEFERRED,
          deferred_until: new Date('2026-08-19T06:00:00.000Z'),
        }),
      );

      const result = await service.sweepDeferred(now);

      expect(repository.recordOutcome).toHaveBeenCalledWith(BIZ, ID, {
        status: OperatorAlertStatus.FAILED,
        reason: ALERT_FAILURE_REASONS.EXPIRED,
      });
      expect(notifications.dispatch).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });

    it('delivers a released alert to the target it was raised for', async () => {
      repository.findDueDeferredGlobal.mockResolvedValue([{ id: ID, business_id: BIZ }]);
      repository.findById.mockResolvedValue(
        alertRow({
          status: OperatorAlertStatus.DEFERRED,
          deferred_until: due,
          context: { target: 'oncall@example.com' },
        }),
      );

      await service.sweepDeferred(now);

      expect(notifications.dispatch).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({ recipient: 'oncall@example.com' }),
      );
    });

    it('keeps sweeping after one alert throws', async () => {
      repository.findDueDeferredGlobal.mockResolvedValue([
        { id: 'a', business_id: BIZ },
        { id: 'b', business_id: BIZ },
      ]);
      repository.findById.mockImplementation(async (_biz: string, id: string) => {
        if (id === 'a') throw new Error('db blip');
        return alertRow({ id: 'b', status: OperatorAlertStatus.DEFERRED, deferred_until: due });
      });

      const result = await service.sweepDeferred(now);
      expect(result).toEqual({ found: 2, released: 1, skipped: 1 });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Inbox
  // ───────────────────────────────────────────────────────────────────

  describe('inbox', () => {
    it('404s an alert belonging to another tenant', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.get(BIZ, ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('treats a second read as success rather than a 404', async () => {
      repository.findById.mockResolvedValue(alertRow({ read_at: new Date() }));
      repository.markRead.mockResolvedValue(0);

      await expect(service.markRead(BIZ, ID, 'member-1')).resolves.toEqual(
        expect.objectContaining({ id: ID }),
      );
    });

    it('reports unread totals and the severity split together', async () => {
      repository.countUnread.mockResolvedValue(4);
      repository.countUnreadBySeverity.mockResolvedValue([{ severity: 'CRITICAL', count: 1 }]);

      await expect(service.unreadCounts(BIZ)).resolves.toEqual({
        total: 4,
        bySeverity: [{ severity: 'CRITICAL', count: 1 }],
      });
    });
  });
});
