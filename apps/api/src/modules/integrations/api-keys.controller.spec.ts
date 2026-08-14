/**
 * ApiKeysController unit tests.
 *
 * The controller used to create the `api_keys` table at runtime via
 * `$executeRawUnsafe` and swallow every error, so a broken database read looked
 * identical to "no keys yet". It now talks to the typed Prisma delegate backed
 * by migration 0031, and these tests pin the properties that made the raw-SQL
 * version wrong: tenant scoping on every query, a `total` that reflects the
 * table rather than the page, the raw secret being returned exactly once, and
 * failures surfacing instead of being reported as an empty list.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';

import { ApiKeysController } from './api-keys.controller';
import { PrismaService } from '../../common/services/prisma.service';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { DEFAULT_API_KEY_PAGE_SIZE } from './dto/list-api-keys-query.dto';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS_ID = '00000000-0000-4000-a000-0000000000ff';
const USER_ID = '00000000-0000-4000-a000-000000000002';
const KEY_ID = '00000000-0000-4000-a000-000000000003';

const USER: AuthenticatedUser = {
  sub: USER_ID,
  businessId: BUSINESS_ID,
  role: 'OWNER',
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    business_id: BUSINESS_ID,
    name: 'CI pipeline',
    prefix: 'gs_abcdef1',
    last4: '9876',
    key_hash: 'a'.repeat(64),
    scopes: ['orders:read'],
    created_by: USER_ID,
    created_at: new Date('2026-01-01T00:00:00Z'),
    last_used_at: null,
    expires_at: null,
    ...overrides,
  };
}

describe('ApiKeysController', () => {
  let controller: ApiKeysController;
  let apiKeys: {
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    deleteMany: jest.Mock;
  };

  beforeEach(async () => {
    apiKeys = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(({ data }) => ({ id: KEY_ID, ...data })),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApiKeysController],
      providers: [{ provide: PrismaService, useValue: { api_keys: apiKeys } }],
    }).compile();

    controller = module.get(ApiKeysController);
  });

  // ── list ───────────────────────────────────────

  describe('list', () => {
    it('scopes the query to the tenant and orders newest first', async () => {
      apiKeys.findMany.mockResolvedValue([row()]);
      apiKeys.count.mockResolvedValue(1);

      const result = await controller.list(BUSINESS_ID, {});

      expect(apiKeys.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID },
        orderBy: { created_at: 'desc' },
        take: 100,
      });
      expect(apiKeys.count).toHaveBeenCalledWith({ where: { business_id: BUSINESS_ID } });
      expect(result.data).toEqual([
        {
          id: KEY_ID,
          name: 'CI pipeline',
          prefix: 'gs_abcdef1',
          last4: '9876',
          scopes: ['orders:read'],
          createdAt: new Date('2026-01-01T00:00:00Z'),
          lastUsedAt: null,
          expiresAt: null,
        },
      ]);
    });

    it('never leaks the stored hash to the client', async () => {
      apiKeys.findMany.mockResolvedValue([row()]);
      apiKeys.count.mockResolvedValue(1);

      const result = await controller.list(BUSINESS_ID, {});

      expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
      expect(result.data[0]).not.toHaveProperty('key_hash');
    });

    it('reports the table total, not the page size', async () => {
      apiKeys.findMany.mockResolvedValue([row(), row({ id: 'x' })]);
      apiKeys.count.mockResolvedValue(7);

      const result = await controller.list(BUSINESS_ID, { limit: 2 });

      expect(result.pagination).toEqual({ total: 7, limit: 2, page: 1, totalPages: 4 });
    });

    it('keeps totalPages at 1 when the table is empty', async () => {
      const result = await controller.list(BUSINESS_ID, {});

      expect(result.data).toEqual([]);
      expect(result.pagination).toEqual({ total: 0, limit: 100, page: 1, totalPages: 1 });
    });

    // This block used to enumerate the local `parseLimit` helper's clamping:
    // 'abc', '50abc', '0', '-5' and '5000' all silently became a working page
    // size. Clamping was safe but silent — a caller with a broken paging loop
    // got a 200 and no signal, where every other list endpoint answers 400.
    // The rejection is now the ValidationPipe's job through
    // ListApiKeysQueryDto, and is asserted in pagination-bound-contract.spec.ts.
    // What is left here is the controller's own half: the default, and that a
    // validated limit reaches Prisma as `take`.
    it.each([
      ['a supplied limit', { limit: 25 }, 25],
      ['an omitted limit', {}, DEFAULT_API_KEY_PAGE_SIZE],
    ])('passes %s to the query as take', async (_label, query, expected) => {
      await controller.list(BUSINESS_ID, query);

      expect(apiKeys.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: expected }),
      );
    });

    it('propagates a database failure instead of reporting an empty list', async () => {
      apiKeys.findMany.mockRejectedValue(new Error('connection reset'));

      await expect(controller.list(BUSINESS_ID, {})).rejects.toThrow('connection reset');
    });
  });

  // ── create ─────────────────────────────────────

  describe('create', () => {
    it('stores only the SHA-256 digest and returns the raw key once', async () => {
      const result = await controller.create(BUSINESS_ID, USER, { name: 'CI pipeline' });

      const { data } = apiKeys.create.mock.calls[0][0];
      expect(data.key_hash).toBe(createHash('sha256').update(result.secret).digest('hex'));
      expect(data).not.toHaveProperty('key');
      expect(Object.values(data)).not.toContain(result.secret);

      expect(result.secret).toMatch(/^gs_[0-9a-f]{64}$/);
      expect(result.key).toBe(result.secret); // deprecated alias
    });

    it('derives prefix and last4 from the raw key', async () => {
      const result = await controller.create(BUSINESS_ID, USER, { name: 'CI pipeline' });

      expect(result.prefix).toBe(result.secret.slice(0, 10));
      expect(result.last4).toBe(result.secret.slice(-4));
      expect(result.prefix).toHaveLength(10);
    });

    it('issues a distinct key per call', async () => {
      const a = await controller.create(BUSINESS_ID, USER, { name: 'a' });
      const b = await controller.create(BUSINESS_ID, USER, { name: 'b' });

      expect(a.secret).not.toBe(b.secret);
    });

    it('attributes the key to the calling tenant and user', async () => {
      await controller.create(BUSINESS_ID, USER, { name: 'CI pipeline' });

      expect(apiKeys.create.mock.calls[0][0].data).toMatchObject({
        business_id: BUSINESS_ID,
        created_by: USER_ID,
        name: 'CI pipeline',
      });
    });

    it('persists the requested scopes', async () => {
      await controller.create(BUSINESS_ID, USER, {
        name: 'CI pipeline',
        scopes: ['orders:read', 'clients:read'],
      });

      expect(apiKeys.create.mock.calls[0][0].data.scopes).toEqual([
        'orders:read',
        'clients:read',
      ]);
    });

    it('defaults to no scopes when none are requested', async () => {
      await controller.create(BUSINESS_ID, USER, { name: 'CI pipeline' });

      expect(apiKeys.create.mock.calls[0][0].data.scopes).toEqual([]);
    });

    it('stores no expiry when expiresInDays is omitted', async () => {
      const result = await controller.create(BUSINESS_ID, USER, { name: 'CI pipeline' });

      expect(apiKeys.create.mock.calls[0][0].data.expires_at).toBeNull();
      expect(result.expiresAt).toBeNull();
    });

    it('converts expiresInDays into an absolute timestamp', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
      try {
        const result = await controller.create(BUSINESS_ID, USER, {
          name: 'CI pipeline',
          expiresInDays: 30,
        });

        expect(result.expiresAt).toBe('2026-01-31T00:00:00.000Z');
        expect(apiKeys.create.mock.calls[0][0].data.expires_at).toEqual(
          new Date('2026-01-31T00:00:00.000Z'),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('propagates a write failure rather than retrying with raw DDL', async () => {
      apiKeys.create.mockRejectedValue(new Error('unique constraint violated'));

      await expect(
        controller.create(BUSINESS_ID, USER, { name: 'CI pipeline' }),
      ).rejects.toThrow('unique constraint violated');
    });
  });

  // ── revoke ─────────────────────────────────────

  describe('revoke', () => {
    it('deletes by id AND business_id so one tenant cannot revoke another\'s key', async () => {
      await controller.revoke(BUSINESS_ID, KEY_ID);

      expect(apiKeys.deleteMany).toHaveBeenCalledWith({
        where: { id: KEY_ID, business_id: BUSINESS_ID },
      });
    });

    it('404s when the key belongs to another tenant', async () => {
      apiKeys.deleteMany.mockResolvedValue({ count: 0 });

      await expect(controller.revoke(OTHER_BUSINESS_ID, KEY_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s when the key does not exist', async () => {
      apiKeys.deleteMany.mockResolvedValue({ count: 0 });

      await expect(controller.revoke(BUSINESS_ID, KEY_ID)).rejects.toThrow(NotFoundException);
    });

    it('propagates a delete failure instead of silently succeeding', async () => {
      apiKeys.deleteMany.mockRejectedValue(new Error('deadlock detected'));

      await expect(controller.revoke(BUSINESS_ID, KEY_ID)).rejects.toThrow('deadlock detected');
    });

    it('rejects a non-UUID id before it reaches Prisma', () => {
      const pipe = new UuidValidationPipe();

      expect(() => pipe.transform('not-a-uuid', { type: 'param', data: 'id' })).toThrow(
        BadRequestException,
      );
    });
  });
});
