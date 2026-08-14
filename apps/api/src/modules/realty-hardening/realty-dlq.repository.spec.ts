/**
 * RealtyDlqRepository unit tests.
 *
 * The dead-letter table holds captured failed operations together with their
 * full payloads, so two properties are worth asserting on the emitted query
 * rather than trusting by inspection:
 *
 *  - **Tenant scoping.** Every read and write names `business_id`. A dead
 *    letter carries the payload of whatever failed — a lead, a visit, a
 *    message — so an unscoped read is a cross-tenant data leak of exactly the
 *    records that were most sensitive to begin with. The one deliberate
 *    exception is `countPendingGlobal`, a platform gauge that returns a number
 *    and no rows.
 *  - **The list bound.** An operator can pass a limit, and the backlog on a
 *    bad day is unbounded. The repository caps it, and the cap is the only
 *    thing standing between a stuck queue and an operator's console pulling
 *    the whole backlog into memory.
 *
 * PrismaService is mocked; the assertions are on the query, not on a DB.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { DeadLetterStatus } from '@prisma/client';

import { RealtyDlqRepository } from './realty-dlq.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_ID = '00000000-0000-4000-a000-000000000002';
const DL_ID = '00000000-0000-4000-a000-000000000100';

describe('RealtyDlqRepository', () => {
  let repository: RealtyDlqRepository;
  let prisma: {
    realty_dead_letters: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
  };

  /** The single argument of the last call to a mock. */
  function lastArg(mock: jest.Mock): Record<string, unknown> {
    return mock.mock.calls[mock.mock.calls.length - 1]![0] as Record<string, unknown>;
  }

  beforeEach(async () => {
    prisma = {
      realty_dead_letters: {
        create: jest.fn().mockResolvedValue({ id: DL_ID }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: DL_ID }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RealtyDlqRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(RealtyDlqRepository);
  });

  // ── create ────────────────────────────────

  describe('create', () => {
    const base = {
      businessId: BUSINESS_ID,
      source: 'realty.visit.reminder',
      operation: 'fireReminder',
      payload: { visitId: 'v1' },
      errorMessage: 'upstream timeout',
      attempts: 3,
    };

    it('captures a failure as PENDING, scoped to the business', async () => {
      await repository.create(base);

      const { data } = lastArg(prisma.realty_dead_letters.create) as {
        data: Record<string, unknown>;
      };
      expect(data['business_id']).toBe(BUSINESS_ID);
      expect(data['status']).toBe(DeadLetterStatus.PENDING);
      expect(data['source']).toBe('realty.visit.reminder');
      expect(data['attempts']).toBe(3);
    });

    it('stores the payload verbatim, so the operation can be replayed', async () => {
      await repository.create({ ...base, payload: { visitId: 'v1', minutesBefore: 60 } });

      const { data } = lastArg(prisma.realty_dead_letters.create) as {
        data: Record<string, unknown>;
      };
      expect(data['payload']).toEqual({ visitId: 'v1', minutesBefore: 60 });
    });

    it('nulls the optional columns rather than leaving them undefined', async () => {
      // Prisma treats `undefined` as "no value supplied" and `null` as an
      // explicit NULL. Passing undefined through for a nullable column is
      // harmless on create but makes the row shape depend on the caller.
      await repository.create(base);

      const { data } = lastArg(prisma.realty_dead_letters.create) as {
        data: Record<string, unknown>;
      };
      expect(data['error_stack']).toBeNull();
      expect(data['correlation_id']).toBeNull();
      expect(data['lead_id']).toBeNull();
      expect(data['conversation_id']).toBeNull();
    });

    it('keeps the optional columns it was given', async () => {
      await repository.create({
        ...base,
        errorStack: 'Error: upstream timeout\n  at x',
        correlationId: 'corr-1',
        leadId: 'lead-1',
        conversationId: 'conv-1',
      });

      const { data } = lastArg(prisma.realty_dead_letters.create) as {
        data: Record<string, unknown>;
      };
      expect(data['correlation_id']).toBe('corr-1');
      expect(data['lead_id']).toBe('lead-1');
      expect(data['conversation_id']).toBe('conv-1');
      expect(data['error_stack']).toContain('upstream timeout');
    });
  });

  // ── findById ──────────────────────────────

  describe('findById', () => {
    it('resolves an id only within its own tenant', async () => {
      await repository.findById(BUSINESS_ID, DL_ID);

      expect(lastArg(prisma.realty_dead_letters.findFirst)['where']).toEqual({
        id: DL_ID,
        business_id: BUSINESS_ID,
      });
    });

    it('does not find another tenant’s dead letter by id alone', async () => {
      // The payload of a dead letter is the record that failed, so an id-only
      // lookup would hand one tenant another's lead or conversation.
      await repository.findById(OTHER_ID, DL_ID);
      expect(lastArg(prisma.realty_dead_letters.findFirst)['where']).toMatchObject({
        business_id: OTHER_ID,
      });
    });
  });

  // ── list ──────────────────────────────────

  describe('list', () => {
    it('scopes to the business and returns newest first', async () => {
      await repository.list(BUSINESS_ID);

      const call = lastArg(prisma.realty_dead_letters.findMany);
      expect(call['where']).toEqual({ business_id: BUSINESS_ID });
      expect(call['orderBy']).toEqual({ created_at: 'desc' });
    });

    it('defaults to 100 rows when the caller names no limit', async () => {
      await repository.list(BUSINESS_ID);
      expect(lastArg(prisma.realty_dead_letters.findMany)['take']).toBe(100);
    });

    it('honours a smaller limit', async () => {
      await repository.list(BUSINESS_ID, { limit: 25 });
      expect(lastArg(prisma.realty_dead_letters.findMany)['take']).toBe(25);
    });

    it('caps the limit at 500 however large a number is asked for', async () => {
      // The backlog is unbounded on a bad day and this is an operator console
      // query; without the cap one request pulls the whole queue into memory.
      await repository.list(BUSINESS_ID, { limit: 10_000 });
      expect(lastArg(prisma.realty_dead_letters.findMany)['take']).toBe(500);
    });

    it('applies each optional filter only when it is supplied', async () => {
      await repository.list(BUSINESS_ID, { status: DeadLetterStatus.PENDING });
      expect(lastArg(prisma.realty_dead_letters.findMany)['where']).toEqual({
        business_id: BUSINESS_ID,
        status: DeadLetterStatus.PENDING,
      });

      await repository.list(BUSINESS_ID, { source: 'realty.visit.reminder' });
      expect(lastArg(prisma.realty_dead_letters.findMany)['where']).toEqual({
        business_id: BUSINESS_ID,
        source: 'realty.visit.reminder',
      });

      await repository.list(BUSINESS_ID, { operation: 'fireReminder' });
      expect(lastArg(prisma.realty_dead_letters.findMany)['where']).toEqual({
        business_id: BUSINESS_ID,
        operation: 'fireReminder',
      });
    });

    it('combines every filter it is given', async () => {
      await repository.list(BUSINESS_ID, {
        status: DeadLetterStatus.REPLAYED,
        source: 'realty.visit.reminder',
        operation: 'fireReminder',
        limit: 10,
      });

      const call = lastArg(prisma.realty_dead_letters.findMany);
      expect(call['where']).toEqual({
        business_id: BUSINESS_ID,
        status: DeadLetterStatus.REPLAYED,
        source: 'realty.visit.reminder',
        operation: 'fireReminder',
      });
      expect(call['take']).toBe(10);
    });
  });

  // ── counts ────────────────────────────────

  describe('counts', () => {
    it('counts one status within one tenant', async () => {
      await repository.countByStatus(BUSINESS_ID, DeadLetterStatus.PENDING);

      expect(lastArg(prisma.realty_dead_letters.count)['where']).toEqual({
        business_id: BUSINESS_ID,
        status: DeadLetterStatus.PENDING,
      });
    });

    it('counts PENDING across all tenants for the platform gauge', async () => {
      // Deliberately unscoped — it feeds the soak-readiness signal and returns
      // a number, never a row, so no tenant data crosses.
      await repository.countPendingGlobal();

      const where = lastArg(prisma.realty_dead_letters.count)['where'] as Record<string, unknown>;
      expect(where).toEqual({ status: DeadLetterStatus.PENDING });
      expect(where['business_id']).toBeUndefined();
    });
  });

  // ── update ────────────────────────────────

  describe('update', () => {
    it('scopes the write to the tenant, not the id alone', async () => {
      await repository.update(BUSINESS_ID, DL_ID, { status: DeadLetterStatus.RESOLVED });

      const call = lastArg(prisma.realty_dead_letters.update);
      expect(call['where']).toEqual({ id: DL_ID, business_id: BUSINESS_ID });
      expect(call['data']).toEqual({ status: DeadLetterStatus.RESOLVED });
    });

    it('passes the patch through without touching the captured payload', async () => {
      // The table is append-mostly: only status and replay bookkeeping move.
      await repository.update(BUSINESS_ID, DL_ID, { attempts: { increment: 1 } });

      const { data } = lastArg(prisma.realty_dead_letters.update) as {
        data: Record<string, unknown>;
      };
      expect(data).toEqual({ attempts: { increment: 1 } });
      expect(data['payload']).toBeUndefined();
    });
  });
});
