/**
 * WebhookDlqRepository unit tests.
 *
 * Two things are genuinely load-bearing here and neither is obvious from
 * reading the methods:
 *
 *   - **The upsert key.** Capture is keyed on the provider's own
 *     `(source, external_id)`, so a webhook that fails six times advances one
 *     row instead of stacking six near-identical entries — and the captured
 *     payload is never rewritten on the way through, because the first
 *     delivery is the provider's own body and a later attempt has nothing
 *     truer to say.
 *   - **Nullable tenancy.** A gateway webhook can fail before its business is
 *     knowable, so `business_id` is nullable and the scoped methods take
 *     `string | null`. Passing null must still emit a `business_id` predicate
 *     (`IS NULL`) rather than dropping the clause — dropping it would let a
 *     platform-level id reach any tenant's row.
 *
 * PrismaService is mocked; the assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { DeadLetterStatus } from '@prisma/client';

import { WebhookDlqRepository } from './webhook-dlq.repository';
import { WEBHOOK_MAX_ATTEMPTS } from './webhook-dlq.constants';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const ENTRY_ID = '00000000-0000-4000-b000-000000000001';
const NOW = new Date('2026-08-14T10:00:00.000Z');

const BASE_CAPTURE = {
  businessId: BUSINESS_ID,
  source: 'RAZORPAY',
  eventType: 'payment.captured',
  externalId: 'payment.captured_pay_123',
  payload: { event: 'payment.captured' },
  errorMessage: 'gateway timeout',
  attempts: 1,
  nextRetryAt: new Date('2026-08-14T10:00:30.000Z'),
  lastAttemptAt: NOW,
};

describe('WebhookDlqRepository', () => {
  let repository: WebhookDlqRepository;
  let prisma: {
    webhook_dead_letters: {
      upsert: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      webhook_dead_letters: {
        upsert: jest.fn().mockResolvedValue({ id: ENTRY_ID }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: ENTRY_ID }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDlqRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(WebhookDlqRepository);
  });

  // ── capture ────────────────────────────────

  describe('capture', () => {
    it('keys on the provider event so a repeated failure advances one row', async () => {
      await repository.capture(BASE_CAPTURE);

      expect(prisma.webhook_dead_letters.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            source_external_id: {
              source: 'RAZORPAY',
              external_id: 'payment.captured_pay_123',
            },
          },
        }),
      );
    });

    it('never rewrites the captured payload on a later failure', async () => {
      await repository.capture(BASE_CAPTURE);

      const args = prisma.webhook_dead_letters.upsert.mock.calls[0]![0];
      expect(args.create).toHaveProperty('payload');
      expect(args.update).not.toHaveProperty('payload');
      expect(args.update).not.toHaveProperty('external_id');
    });

    it('resets the row to PENDING so a re-failed entry is retried again', async () => {
      await repository.capture(BASE_CAPTURE);

      const args = prisma.webhook_dead_letters.upsert.mock.calls[0]![0];
      expect(args.update).toMatchObject({
        status: DeadLetterStatus.PENDING,
        attempts: 1,
        next_retry_at: BASE_CAPTURE.nextRetryAt,
      });
    });

    it('stamps the tenant on the row it creates', async () => {
      await repository.capture(BASE_CAPTURE);

      expect(prisma.webhook_dead_letters.upsert.mock.calls[0]![0].create).toMatchObject({
        business_id: BUSINESS_ID,
      });
    });

    it('accepts a delivery with no resolvable tenant', async () => {
      await repository.capture({ ...BASE_CAPTURE, businessId: null });

      expect(prisma.webhook_dead_letters.upsert.mock.calls[0]![0].create).toMatchObject({
        business_id: null,
      });
    });

    it('defaults the optional columns rather than writing undefined', async () => {
      await repository.capture(BASE_CAPTURE);

      const { create } = prisma.webhook_dead_letters.upsert.mock.calls[0]![0];
      expect(create).toMatchObject({
        headers: {},
        error_stack: null,
        correlation_id: null,
        webhook_event_id: null,
        max_attempts: WEBHOOK_MAX_ATTEMPTS,
      });
    });

    it('lets the caller override the attempt budget', async () => {
      await repository.capture({ ...BASE_CAPTURE, maxAttempts: 2 });

      expect(prisma.webhook_dead_letters.upsert.mock.calls[0]![0].create).toMatchObject({
        max_attempts: 2,
      });
    });
  });

  // ── reads ──────────────────────────────────

  describe('findById', () => {
    it('scopes the lookup to the tenant', async () => {
      await repository.findById(BUSINESS_ID, ENTRY_ID);

      expect(prisma.webhook_dead_letters.findFirst).toHaveBeenCalledWith({
        where: { id: ENTRY_ID, business_id: BUSINESS_ID },
      });
    });

    it('keeps a business_id predicate even for a platform-level entry', async () => {
      // Dropping the clause would turn this into a bare primary-key read that
      // any tenant could aim at any row.
      await repository.findById(null, ENTRY_ID);

      expect(prisma.webhook_dead_letters.findFirst).toHaveBeenCalledWith({
        where: { id: ENTRY_ID, business_id: null },
      });
    });
  });

  describe('list', () => {
    it('filters to the tenant and returns newest first', async () => {
      await repository.list(BUSINESS_ID);

      expect(prisma.webhook_dead_letters.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID },
        orderBy: { created_at: 'desc' },
        take: 100,
      });
    });

    it('omits an unsupplied filter instead of sending it as undefined', async () => {
      await repository.list(BUSINESS_ID, { source: 'STRIPE' });

      const { where } = prisma.webhook_dead_letters.findMany.mock.calls[0]![0];
      expect(where).toEqual({ business_id: BUSINESS_ID, source: 'STRIPE' });
      expect('status' in where).toBe(false);
      expect('event_type' in where).toBe(false);
    });

    it('applies every filter when all are supplied', async () => {
      await repository.list(BUSINESS_ID, {
        status: DeadLetterStatus.DISCARDED,
        source: 'RAZORPAY',
        eventType: 'payment.failed',
      });

      expect(prisma.webhook_dead_letters.findMany.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
        status: DeadLetterStatus.DISCARDED,
        source: 'RAZORPAY',
        event_type: 'payment.failed',
      });
    });

    it('caps the page size so a hostile limit cannot pull the whole table', async () => {
      await repository.list(BUSINESS_ID, { limit: 100_000 });

      expect(prisma.webhook_dead_letters.findMany.mock.calls[0]![0].take).toBe(500);
    });
  });

  describe('countByStatus', () => {
    it('counts within the tenant only', async () => {
      await repository.countByStatus(BUSINESS_ID, DeadLetterStatus.PENDING);

      expect(prisma.webhook_dead_letters.count).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, status: DeadLetterStatus.PENDING },
      });
    });
  });

  describe('countPendingGlobal', () => {
    it('returns a bare count across tenants, never rows', async () => {
      prisma.webhook_dead_letters.count.mockResolvedValueOnce(9);

      expect(await repository.countPendingGlobal()).toBe(9);
      expect(prisma.webhook_dead_letters.count).toHaveBeenCalledWith({
        where: { status: DeadLetterStatus.PENDING },
      });
    });
  });

  describe('listDueGlobal', () => {
    it('selects only the id and the tenant discriminator', async () => {
      // The sweep spans every tenant, so it must not carry tenant content out
      // of the query — it re-enters the scoped path per entry.
      await repository.listDueGlobal(NOW, 50);

      expect(prisma.webhook_dead_letters.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: { id: true, business_id: true },
          orderBy: { next_retry_at: 'asc' },
          take: 50,
        }),
      );
    });

    it('claims only entries whose backoff has actually elapsed', async () => {
      await repository.listDueGlobal(NOW, 50);

      expect(prisma.webhook_dead_letters.findMany.mock.calls[0]![0].where).toEqual({
        status: DeadLetterStatus.PENDING,
        next_retry_at: { not: null, lte: NOW },
      });
    });

    it('caps the batch size', async () => {
      await repository.listDueGlobal(NOW, 10_000);

      expect(prisma.webhook_dead_letters.findMany.mock.calls[0]![0].take).toBe(500);
    });
  });

  // ── writes ─────────────────────────────────

  describe('update', () => {
    it('folds the tenant into the write, not just the id', async () => {
      await repository.update(BUSINESS_ID, ENTRY_ID, { attempts: 3 });

      expect(prisma.webhook_dead_letters.update).toHaveBeenCalledWith({
        where: { id: ENTRY_ID, business_id: BUSINESS_ID },
        data: { attempts: 3 },
      });
    });

    it('keeps the predicate on a platform-level entry', async () => {
      await repository.update(null, ENTRY_ID, { attempts: 3 });

      expect(prisma.webhook_dead_letters.update.mock.calls[0]![0].where).toEqual({
        id: ENTRY_ID,
        business_id: null,
      });
    });

    it('passes the patch through untouched, so a partial update stays partial', async () => {
      await repository.update(BUSINESS_ID, ENTRY_ID, { status: DeadLetterStatus.REPLAYED });

      expect(prisma.webhook_dead_letters.update.mock.calls[0]![0].data).toEqual({
        status: DeadLetterStatus.REPLAYED,
      });
    });
  });
});
