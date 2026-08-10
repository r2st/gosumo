/**
 * Cross-module tenant-isolation tests for repository writes.
 *
 * Root rule (CLAUDE.md #1): every WHERE clause on a tenant table must include
 * `businessId`. Historically many repository mutators accepted a `businessId`
 * argument and then discarded it, issuing `update({ where: { id } })` — a
 * primary-key write with no tenant predicate. Those paths were only safe
 * because the calling service happened to do a scoped read first, so a single
 * missing guard anywhere upstream became a cross-tenant write.
 *
 * These tests assert the predicate directly at the repository boundary, which
 * is the layer the rule is written about. PrismaService is mocked; the
 * assertion is on the query shape, not on a database result.
 *
 * Adding a new tenant-scoped mutator? Add it to CASES below.
 */

import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from './../common/services/prisma.service';
import { CannedResponseRepository } from './canned-response/canned-response.repository';
import { CatalogRepository } from './catalog/catalog.repository';
import { ContactRepository } from './contact/contact.repository';
import { ConversationRepository } from './conversation/conversation.repository';
import { CouponRepository } from './order/coupon.repository';
import { MessageRepository } from './message/message.repository';
import { RealtyInventoryRepository } from './realty-inventory/realty-inventory.repository';
import { RealtyLeadsRepository } from './realty-leads/realty-leads.repository';
import { SlaRepository } from './sla/sla.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS_ID = '00000000-0000-4000-a000-000000000002';
const RECORD_ID = '00000000-0000-4000-b000-000000000001';

/**
 * A Prisma double that records every call. Any model/operation is accepted;
 * reads resolve to a benign row so repository code that post-processes a
 * result does not explode.
 */
function makeRecordingPrisma(): {
  prisma: PrismaService;
  calls: Array<{ model: string; op: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = [];

  const row = {
    id: RECORD_ID,
    business_id: BUSINESS_ID,
    tags: [],
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  };

  const modelProxy = (model: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) => (args: Record<string, unknown> = {}) => {
          calls.push({ model, op, args });
          if (op === 'count') return Promise.resolve(0);
          if (op === 'findMany' || op === 'groupBy') return Promise.resolve([]);
          if (op === 'updateMany' || op === 'deleteMany') return Promise.resolve({ count: 1 });
          return Promise.resolve(row);
        },
      },
    );

  const prisma = new Proxy(
    {},
    {
      get: (_t, model: string) => {
        if (model === '$transaction') {
          return (arg: unknown) =>
            typeof arg === 'function'
              ? (arg as (tx: unknown) => unknown)(prisma)
              : Promise.all(arg as unknown[]);
        }
        if (model === 'then') return undefined; // not a thenable
        return modelProxy(model);
      },
    },
  ) as unknown as PrismaService;

  return { prisma, calls };
}

async function buildRepo<T>(RepoClass: new (...args: never[]) => T, prisma: PrismaService): Promise<T> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [RepoClass, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return module.get(RepoClass);
}

/**
 * Each case invokes one repository mutator that takes (businessId, id, ...).
 * `run` performs the call; the harness asserts the emitted Prisma `where`
 * carried the tenant predicate.
 */
type Case = {
  name: string;
  repo: new (...args: never[]) => unknown;
  run: (repo: never, businessId: string, id: string) => Promise<unknown>;
};

const CASES: Case[] = [
  {
    name: 'CannedResponseRepository.update',
    repo: CannedResponseRepository,
    run: (r: CannedResponseRepository, b, id) => r.update(b, id, { title: 'x' }),
  },
  {
    name: 'CannedResponseRepository.softDelete',
    repo: CannedResponseRepository,
    run: (r: CannedResponseRepository, b, id) => r.softDelete(b, id),
  },
  {
    name: 'CannedResponseRepository.incrementUsage',
    repo: CannedResponseRepository,
    run: (r: CannedResponseRepository, b, id) => r.incrementUsage(b, id),
  },
  {
    name: 'ContactRepository.update',
    repo: ContactRepository,
    run: (r: ContactRepository, b, id) => r.update(b, id, { name: 'x' }),
  },
  {
    name: 'ContactRepository.updateSegment',
    repo: ContactRepository,
    run: (r: ContactRepository, b, id) => r.updateSegment(b, id, { name: 'x' }),
  },
  {
    name: 'ContactRepository.softDeleteSegment',
    repo: ContactRepository,
    run: (r: ContactRepository, b, id) => r.softDeleteSegment(b, id),
  },
  {
    name: 'SlaRepository.updatePolicy',
    repo: SlaRepository,
    run: (r: SlaRepository, b, id) => r.updatePolicy(b, id, { name: 'x' }),
  },
  {
    name: 'SlaRepository.softDeletePolicy',
    repo: SlaRepository,
    run: (r: SlaRepository, b, id) => r.softDeletePolicy(b, id),
  },
  {
    name: 'CouponRepository.softDelete',
    repo: CouponRepository,
    run: (r: CouponRepository, b, id) => r.softDelete(b, id),
  },
  {
    name: 'RealtyLeadsRepository.softDelete',
    repo: RealtyLeadsRepository,
    run: (r: RealtyLeadsRepository, b, id) => r.softDelete(b, id),
  },
  {
    name: 'RealtyInventoryRepository.softDeleteProject',
    repo: RealtyInventoryRepository,
    run: (r: RealtyInventoryRepository, b, id) => r.softDeleteProject(b, id),
  },
  {
    name: 'RealtyInventoryRepository.softDeleteUnit',
    repo: RealtyInventoryRepository,
    run: (r: RealtyInventoryRepository, b, id) => r.softDeleteUnit(b, id),
  },
  {
    name: 'CatalogRepository.softDeleteCategory',
    repo: CatalogRepository,
    run: (r: CatalogRepository, b, id) => r.softDeleteCategory(b, id),
  },
  {
    name: 'CatalogRepository.softDeleteItem',
    repo: CatalogRepository,
    run: (r: CatalogRepository, b, id) => r.softDeleteItem(b, id),
  },
  {
    name: 'CatalogRepository.softDeleteVariant',
    repo: CatalogRepository,
    run: (r: CatalogRepository, b, id) => r.softDeleteVariant(b, id),
  },
];

describe('Repository tenant isolation — mutations carry a business_id predicate', () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s scopes its write to the caller business',
    async (_name, testCase) => {
      const { prisma, calls } = makeRecordingPrisma();
      const repo = await buildRepo(testCase.repo, prisma);

      await testCase.run(repo as never, BUSINESS_ID, RECORD_ID);

      const writes = calls.filter((c) =>
        ['update', 'updateMany', 'delete', 'deleteMany'].includes(c.op),
      );
      expect(writes.length).toBeGreaterThan(0);

      for (const call of writes) {
        const where = call.args['where'] as Record<string, unknown> | undefined;
        expect(where).toBeDefined();
        // The predicate must name the tenant — a bare primary-key write
        // would happily mutate another business's row.
        expect(where).toMatchObject({ business_id: BUSINESS_ID });
      }
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s uses the passed business, not a hardcoded or stale one',
    async (_name, testCase) => {
      const { prisma, calls } = makeRecordingPrisma();
      const repo = await buildRepo(testCase.repo, prisma);

      await testCase.run(repo as never, OTHER_BUSINESS_ID, RECORD_ID);

      const writes = calls.filter((c) =>
        ['update', 'updateMany', 'delete', 'deleteMany'].includes(c.op),
      );
      for (const call of writes) {
        const where = call.args['where'] as Record<string, unknown>;
        expect(where['business_id']).toBe(OTHER_BUSINESS_ID);
      }
    },
  );
});

describe('Repository tenant isolation — conversation and message writes', () => {
  it('ConversationRepository.assign scopes to the business', async () => {
    const { prisma, calls } = makeRecordingPrisma();
    const repo = await buildRepo(ConversationRepository, prisma);

    await repo.assign(BUSINESS_ID, RECORD_ID, 'agent-1');

    const update = calls.find((c) => c.model === 'conversations' && c.op === 'update');
    expect(update?.args['where']).toMatchObject({
      id: RECORD_ID,
      business_id: BUSINESS_ID,
    });
  });

  it('MessageRepository.updateStatus scopes to the business', async () => {
    const { prisma, calls } = makeRecordingPrisma();
    const repo = await buildRepo(MessageRepository, prisma);

    await repo.updateStatus(BUSINESS_ID, RECORD_ID, 'DELIVERED' as never, {});

    const update = calls.find((c) => c.model === 'messages' && c.op === 'update');
    expect(update?.args['where']).toMatchObject({
      id: RECORD_ID,
      business_id: BUSINESS_ID,
    });
  });

  it('MessageRepository.attachAIMetadata scopes to the business', async () => {
    const { prisma, calls } = makeRecordingPrisma();
    const repo = await buildRepo(MessageRepository, prisma);

    await repo.attachAIMetadata(BUSINESS_ID, RECORD_ID, { is_ai_generated: true });

    const update = calls.find((c) => c.model === 'messages' && c.op === 'update');
    expect(update?.args['where']).toMatchObject({ business_id: BUSINESS_ID });
  });
});
