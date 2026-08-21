/**
 * OperatorAlertRepository unit tests.
 *
 * The repository-wide contract already asserts every method carries
 * `business_id`. What it cannot assert is the *shape* of the predicates that
 * make this table behave: the claim on `status: DEFERRED` is what stops two
 * sweep ticks paging the same operator twice, and the `read_at: null` in
 * `markRead` is what preserves the first reader's timestamp. Both are one word
 * to delete and neither breaks anything visible when it goes.
 */
import { Test } from '@nestjs/testing';
import { OperatorAlertStatus } from '@gosumo/database';

import { OperatorAlertRepository } from './operator-alert.repository';
import { PrismaService } from '../../../common/services/prisma.service';

const BIZ = '00000000-0000-4000-a000-000000000001';
const ID = '00000000-0000-4000-b000-000000000001';

describe('OperatorAlertRepository', () => {
  let repository: OperatorAlertRepository;
  let prisma: {
    operator_alerts: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      operator_alerts: {
        create: jest.fn().mockResolvedValue({ id: ID }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OperatorAlertRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = moduleRef.get(OperatorAlertRepository);
  });

  describe('create', () => {
    it('stamps the tenant and defaults the optional columns', async () => {
      await repository.create(BIZ, {
        kind: 'SLA_BREACH',
        severity: 'WARNING',
        title: 'A title',
        status: OperatorAlertStatus.PENDING,
      });

      expect(prisma.operator_alerts.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: BIZ,
          kind: 'SLA_BREACH',
          severity: 'WARNING',
          title: 'A title',
          body: null,
          context: {},
          status: OperatorAlertStatus.PENDING,
          dedupe_key: null,
        }),
      });
    });

    it('carries the dedupe key and deferral through', async () => {
      const until = new Date('2026-08-21T02:00:00.000Z');
      await repository.create(BIZ, {
        kind: 'ESCALATION',
        severity: 'CRITICAL',
        title: 'Escalated',
        status: OperatorAlertStatus.DEFERRED,
        deferredUntil: until,
        dedupeKey: 'sla.escalated:c1:RESOLUTION:NOTIFY',
        context: { policyId: 'p1' },
      });

      expect(prisma.operator_alerts.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          deferred_until: until,
          dedupe_key: 'sla.escalated:c1:RESOLUTION:NOTIFY',
          context: { policyId: 'p1' },
        }),
      });
    });
  });

  describe('recordOutcome', () => {
    it('scopes the write by tenant and id together', async () => {
      await repository.recordOutcome(BIZ, ID, {
        status: OperatorAlertStatus.DELIVERED,
        deliveredTo: ['ops@example.com'],
      });

      expect(prisma.operator_alerts.updateMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, id: ID },
        data: expect.objectContaining({
          status: OperatorAlertStatus.DELIVERED,
          delivered_to: ['ops@example.com'],
        }),
      });
    });

    it('omits columns the caller did not name, rather than nulling them', async () => {
      await repository.recordOutcome(BIZ, ID, { status: OperatorAlertStatus.FAILED });

      const data = prisma.operator_alerts.updateMany.mock.calls[0][0].data;
      expect(data).toEqual({ status: OperatorAlertStatus.FAILED });
      expect('delivered_to' in data).toBe(false);
    });
  });

  describe('claimDeferred', () => {
    it('only claims a row still in DEFERRED', async () => {
      await repository.claimDeferred(BIZ, ID);

      expect(prisma.operator_alerts.updateMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, id: ID, status: OperatorAlertStatus.DEFERRED },
        data: { status: OperatorAlertStatus.PENDING },
      });
    });

    it('reports a lost claim as false', async () => {
      prisma.operator_alerts.updateMany.mockResolvedValue({ count: 0 });
      await expect(repository.claimDeferred(BIZ, ID)).resolves.toBe(false);
    });

    it('reports a won claim as true', async () => {
      await expect(repository.claimDeferred(BIZ, ID)).resolves.toBe(true);
    });
  });

  describe('findDueDeferredGlobal', () => {
    it('returns only the discriminator, never alert content', async () => {
      const now = new Date('2026-08-21T07:00:00.000Z');
      await repository.findDueDeferredGlobal(now, 50);

      expect(prisma.operator_alerts.findMany).toHaveBeenCalledWith({
        where: {
          status: OperatorAlertStatus.DEFERRED,
          deferred_until: { not: null, lte: now },
        },
        select: { id: true, business_id: true },
        orderBy: { deferred_until: 'asc' },
        take: 50,
      });
    });
  });

  describe('list', () => {
    it('filters unread and read as opposites, and neither when unset', async () => {
      await repository.list(BIZ, { unreadOnly: true });
      expect(prisma.operator_alerts.findMany.mock.calls[0][0].where.read_at).toBeNull();

      await repository.list(BIZ, { unreadOnly: false });
      expect(prisma.operator_alerts.findMany.mock.calls[1][0].where.read_at).toEqual({
        not: null,
      });

      await repository.list(BIZ, {});
      expect(
        'read_at' in prisma.operator_alerts.findMany.mock.calls[2][0].where,
      ).toBe(false);
    });

    it('pages from 1 and reports the page count', async () => {
      prisma.operator_alerts.count.mockResolvedValue(45);
      const result = await repository.list(BIZ, { page: 3, limit: 20 });

      expect(prisma.operator_alerts.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 40, take: 20 }),
      );
      expect(result).toEqual(
        expect.objectContaining({ total: 45, page: 3, limit: 20, totalPages: 3 }),
      );
    });
  });

  describe('markRead', () => {
    it('leaves an already-read alert alone so the first reader survives', async () => {
      const at = new Date('2026-08-21T09:00:00.000Z');
      await repository.markRead(BIZ, ID, 'member-1', at);

      expect(prisma.operator_alerts.updateMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, id: ID, read_at: null },
        data: { read_at: at, read_by: 'member-1' },
      });
    });

    it('marks every unread alert at once, still scoped to the tenant', async () => {
      const at = new Date('2026-08-21T09:00:00.000Z');
      prisma.operator_alerts.updateMany.mockResolvedValue({ count: 7 });

      await expect(repository.markAllRead(BIZ, 'member-1', at)).resolves.toBe(7);
      expect(prisma.operator_alerts.updateMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, read_at: null },
        data: { read_at: at, read_by: 'member-1' },
      });
    });
  });

  describe('counts', () => {
    it('counts only unread rows for the badge', async () => {
      prisma.operator_alerts.count.mockResolvedValue(3);
      await expect(repository.countUnread(BIZ)).resolves.toBe(3);
      expect(prisma.operator_alerts.count).toHaveBeenCalledWith({
        where: { business_id: BIZ, read_at: null },
      });
    });

    it('flattens the grouped severity counts', async () => {
      prisma.operator_alerts.groupBy.mockResolvedValue([
        { severity: 'CRITICAL', _count: { _all: 2 } },
        { severity: 'WARNING', _count: { _all: 5 } },
      ]);

      await expect(repository.countUnreadBySeverity(BIZ)).resolves.toEqual([
        { severity: 'CRITICAL', count: 2 },
        { severity: 'WARNING', count: 5 },
      ]);
    });
  });
});
