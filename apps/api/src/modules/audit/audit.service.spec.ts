import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditAction, audit_logs } from '@prisma/client';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import {
  DEFAULT_AUDIT_PAGE_SIZE,
  DEFAULT_AUDIT_WINDOW_DAYS,
  MAX_AUDIT_WINDOW_DAYS,
} from './audit.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const ROW_ID = '00000000-0000-4000-b000-000000000001';
const MS_PER_DAY = 86_400_000;

function makeRow(overrides: Partial<audit_logs> = {}): audit_logs {
  return {
    id: ROW_ID,
    business_id: BUSINESS_ID,
    actor_type: 'TEAM_MEMBER',
    actor_id: '00000000-0000-4000-c000-000000000001',
    actor_email: 'manager@example.invalid',
    action: AuditAction.UPDATE,
    resource_type: 'team_member',
    resource_id: '00000000-0000-4000-d000-000000000001',
    resource_before: { role: 'STAFF' },
    resource_after: { role: 'OWNER' },
    ip_address: '203.0.113.7',
    user_agent: 'Mozilla/5.0',
    request_id: 'req-1',
    description: 'Changed role',
    created_at: new Date('2026-03-01T10:00:00Z'),
    ...overrides,
  } as audit_logs;
}

describe('AuditService', () => {
  let repository: {
    list: jest.Mock;
    findById: jest.Mock;
    listAll: jest.Mock;
    countByAction: jest.Mock;
    countByActor: jest.Mock;
  };
  let service: AuditService;

  beforeEach(() => {
    repository = {
      list: jest.fn().mockResolvedValue({ rows: [makeRow()], total: 1 }),
      findById: jest.fn().mockResolvedValue(makeRow()),
      listAll: jest.fn().mockResolvedValue([makeRow()]),
      countByAction: jest.fn().mockResolvedValue([]),
      countByActor: jest.fn().mockResolvedValue([]),
    };
    service = new AuditService(repository as unknown as AuditRepository);
  });

  describe('window resolution', () => {
    it('defaults to the trailing 30 days ending now', async () => {
      // The table is append-only and never pruned here, so an unbounded default
      // would scan a long-lived tenant's whole history on page one.
      const before = Date.now();
      const result = await service.list(BUSINESS_ID, {});
      const after = Date.now();

      const { from, to } = repository.list.mock.calls[0]![1];
      expect(to.getTime()).toBeGreaterThanOrEqual(before);
      expect(to.getTime()).toBeLessThanOrEqual(after);
      expect(to.getTime() - from.getTime()).toBe(DEFAULT_AUDIT_WINDOW_DAYS * MS_PER_DAY);
      expect(result.window.from).toBe(from.toISOString());
    });

    it('anchors the default start to `to`, not to now', async () => {
      await service.list(BUSINESS_ID, { to: '2026-03-01T00:00:00Z' });
      const { from, to } = repository.list.mock.calls[0]![1];
      expect(to.toISOString()).toBe('2026-03-01T00:00:00.000Z');
      expect(to.getTime() - from.getTime()).toBe(DEFAULT_AUDIT_WINDOW_DAYS * MS_PER_DAY);
    });

    it('honours an explicit window', async () => {
      await service.list(BUSINESS_ID, {
        from: '2026-02-01T00:00:00Z',
        to: '2026-02-10T00:00:00Z',
      });
      const { from, to } = repository.list.mock.calls[0]![1];
      expect(from.toISOString()).toBe('2026-02-01T00:00:00.000Z');
      expect(to.toISOString()).toBe('2026-02-10T00:00:00.000Z');
    });

    it('rejects an inverted window', async () => {
      await expect(
        service.list(BUSINESS_ID, {
          from: '2026-03-01T00:00:00Z',
          to: '2026-02-01T00:00:00Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a zero-width window', async () => {
      // Equal ends is a legitimate "at this instant" query, not an error.
      await expect(
        service.list(BUSINESS_ID, {
          from: '2026-03-01T00:00:00Z',
          to: '2026-03-01T00:00:00Z',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects a window longer than the cap', async () => {
      await expect(
        service.list(BUSINESS_ID, {
          from: '2020-01-01T00:00:00Z',
          to: '2026-01-01T00:00:00Z',
        }),
      ).rejects.toThrow(new RegExp(String(MAX_AUDIT_WINDOW_DAYS)));
    });

    it('accepts a window exactly at the cap', async () => {
      const to = new Date('2026-03-01T00:00:00Z');
      const from = new Date(to.getTime() - MAX_AUDIT_WINDOW_DAYS * MS_PER_DAY);
      await expect(
        service.list(BUSINESS_ID, { from: from.toISOString(), to: to.toISOString() }),
      ).resolves.toBeDefined();
    });

    it.each([['from'], ['to']])('rejects an unparseable `%s`', async (field) => {
      await expect(
        service.list(BUSINESS_ID, { [field]: 'last tuesday' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('list', () => {
    it('passes every filter through to the repository', async () => {
      await service.list(BUSINESS_ID, {
        actions: [AuditAction.UPDATE],
        actorType: 'TEAM_MEMBER',
        actorId: '00000000-0000-4000-c000-000000000001',
        resourceType: 'team_member',
        resourceId: '00000000-0000-4000-d000-000000000001',
      });

      expect(repository.list.mock.calls[0]![1]).toMatchObject({
        actions: [AuditAction.UPDATE],
        actorType: 'TEAM_MEMBER',
        actorId: '00000000-0000-4000-c000-000000000001',
        resourceType: 'team_member',
        resourceId: '00000000-0000-4000-d000-000000000001',
      });
    });

    it('scopes the query to the caller’s business', async () => {
      await service.list(BUSINESS_ID, {});
      expect(repository.list.mock.calls[0]![0]).toBe(BUSINESS_ID);
    });

    it('defaults to page 1 at the default size', async () => {
      await service.list(BUSINESS_ID, {});
      const [, , skip, take] = repository.list.mock.calls[0]!;
      expect(skip).toBe(0);
      expect(take).toBe(DEFAULT_AUDIT_PAGE_SIZE);
    });

    it('translates page/limit into skip/take', async () => {
      await service.list(BUSINESS_ID, { page: 3, limit: 20 });
      const [, , skip, take] = repository.list.mock.calls[0]!;
      expect(skip).toBe(40);
      expect(take).toBe(20);
    });

    it('reports totalPages from the total and limit', async () => {
      repository.list.mockResolvedValue({ rows: [], total: 101 });
      const result = await service.list(BUSINESS_ID, { limit: 50 });
      expect(result.totalPages).toBe(3);
    });

    it('reports zero pages for an empty result', async () => {
      repository.list.mockResolvedValue({ rows: [], total: 0 });
      const result = await service.list(BUSINESS_ID, {});
      expect(result).toMatchObject({ total: 0, totalPages: 0, data: [] });
    });

    it('serialises the row, including the before/after diff', async () => {
      const result = await service.list(BUSINESS_ID, {});
      expect(result.data[0]).toMatchObject({
        id: ROW_ID,
        actorType: 'TEAM_MEMBER',
        actorEmail: 'manager@example.invalid',
        action: AuditAction.UPDATE,
        resourceType: 'team_member',
        before: { role: 'STAFF' },
        after: { role: 'OWNER' },
        createdAt: '2026-03-01T10:00:00.000Z',
      });
    });

    it('renders an absent diff as null rather than undefined', async () => {
      repository.list.mockResolvedValue({
        rows: [makeRow({ resource_before: null, resource_after: null })],
        total: 1,
      });
      const result = await service.list(BUSINESS_ID, {});
      expect(result.data[0]!.before).toBeNull();
      expect(result.data[0]!.after).toBeNull();
    });
  });

  describe('get', () => {
    it('returns the row', async () => {
      await expect(service.get(BUSINESS_ID, ROW_ID)).resolves.toMatchObject({ id: ROW_ID });
      expect(repository.findById).toHaveBeenCalledWith(BUSINESS_ID, ROW_ID);
    });

    it('404s a row that is missing or another tenant’s, indistinguishably', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.get(BUSINESS_ID, ROW_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('summary', () => {
    it('totals the per-action counts', async () => {
      repository.countByAction.mockResolvedValue([
        { action: AuditAction.CREATE, count: 3 },
        { action: AuditAction.UPDATE, count: 7 },
      ]);
      const result = await service.summary(BUSINESS_ID, {});
      expect(result.total).toBe(10);
    });

    it('sorts actions by descending count', async () => {
      repository.countByAction.mockResolvedValue([
        { action: AuditAction.CREATE, count: 3 },
        { action: AuditAction.UPDATE, count: 7 },
      ]);
      const result = await service.summary(BUSINESS_ID, {});
      expect(result.byAction.map((r) => r.count)).toEqual([7, 3]);
    });

    it('sorts actors by descending count', async () => {
      repository.countByActor.mockResolvedValue([
        { actorId: 'a', actorEmail: 'a@example.invalid', count: 1 },
        { actorId: 'b', actorEmail: 'b@example.invalid', count: 9 },
      ]);
      const result = await service.summary(BUSINESS_ID, {});
      expect(result.byActor[0]).toMatchObject({ actorId: 'b', count: 9 });
    });

    it('applies the same window rules as the list', async () => {
      await expect(
        service.summary(BUSINESS_ID, {
          from: '2026-03-01T00:00:00Z',
          to: '2026-02-01T00:00:00Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reports the window it actually queried', async () => {
      const result = await service.summary(BUSINESS_ID, {
        from: '2026-02-01T00:00:00Z',
        to: '2026-02-10T00:00:00Z',
      });
      expect(result.window).toEqual({
        from: '2026-02-01T00:00:00.000Z',
        to: '2026-02-10T00:00:00.000Z',
      });
    });
  });

  describe('export', () => {
    it('returns serialised rows for the window', async () => {
      const result = await service.export(BUSINESS_ID, {});
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: ROW_ID });
      expect(repository.listAll.mock.calls[0]![0]).toBe(BUSINESS_ID);
    });

    it('applies the same window rules', async () => {
      await expect(
        service.export(BUSINESS_ID, { from: 'nonsense' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
