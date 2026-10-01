/**
 * Cross-module tenant-isolation tests for repository queries.
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
 * `repository-contract.spec.ts` is the exhaustive sweep — it drives every
 * method on every repository and fails on any unscoped query. This file is the
 * targeted counterpart: it names each closed hole, pins the exact predicate,
 * and asserts the tenant is the one *passed in* rather than a captured
 * constant — a distinction the sweep cannot make for a method it drives with a
 * single tenant id.
 *
 * Adding a new tenant-scoped mutator? Add it to CASES below.
 */

import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from './../common/services/prisma.service';
import { AddressRepository } from './order/address.repository';
import { AiEngineRepository } from './ai-engine/ai-engine.repository';
import { AuthRepository } from './auth/auth.repository';
import { BookingRepository } from './booking/booking.repository';
import { CannedResponseRepository } from './canned-response/canned-response.repository';
import { CartRepository } from './order/cart.repository';
import { CatalogRepository } from './catalog/catalog.repository';
import { ClientIntelligenceRepository } from './client-intelligence/client-intelligence.repository';
import { ContactRepository } from './contact/contact.repository';
import { ConversationRepository } from './conversation/conversation.repository';
import { CouponRepository } from './order/coupon.repository';
import { HitlRepository } from './hitl/hitl.repository';
import { MessageRepository } from './message/message.repository';
import { NotificationRepository } from './notification/notification.repository';
import { OrderRepository } from './order/order.repository';
import { PaymentRepository } from './payment/payment.repository';
import { RealtyDlqRepository } from './realty-hardening/realty-dlq.repository';
import { RealtyExchangeRepository } from './realty-exchange/realty-exchange.repository';
import { RealtyIntegrationsRepository } from './realty-integrations/realty-integrations.repository';
import { RealtyInventoryRepository } from './realty-inventory/realty-inventory.repository';
import { RealtyLeadsRepository } from './realty-leads/realty-leads.repository';
import { SlaRepository } from './sla/sla.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS_ID = '00000000-0000-4000-a000-000000000002';
const RECORD_ID = '00000000-0000-4000-b000-000000000001';
/** Second record id, for mutators that operate on a pair of rows. */
const SECOND_RECORD_ID = '00000000-0000-4000-b000-000000000002';

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
    profile: {},
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    // Columns a repository reads back off the row it just fetched. Omitting
    // them makes the method throw before its later writes, which is silently
    // read as "this mutator emitted no unscoped write".
    name: null,
    email: null,
    phone: null,
    avatar_url: null,
    total_orders: 0,
    total_spent: { toNumber: () => 0 },
    last_interaction_at: null,
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

  // ── Closed in round 3 ──────────────────────────────────────────────
  //
  // Each of these previously wrote by primary key alone. Most were preceded by
  // a scoped `findFirst`, which made them safe in the shape they happened to be
  // in; the rest never received a `businessId` at all. Both classes are pinned
  // here so a future edit cannot quietly reopen the gap.

  {
    name: 'AddressRepository.update',
    repo: AddressRepository,
    run: (r: AddressRepository, b, id) => r.update(b, id, { city: 'Pune' }),
  },
  {
    name: 'AddressRepository.softDelete',
    repo: AddressRepository,
    run: (r: AddressRepository, b, id) => r.softDelete(b, id),
  },
  {
    name: 'AuthRepository.updateTeamMember',
    repo: AuthRepository,
    run: (r: AuthRepository, b, id) => r.updateTeamMember(b, id, { name: 'x' }),
  },
  {
    name: 'AuthRepository.updateLastLogin',
    repo: AuthRepository,
    run: (r: AuthRepository, b, id) => r.updateLastLogin(b, id),
  },
  {
    name: 'AuthRepository.linkGoogleAccount',
    repo: AuthRepository,
    run: (r: AuthRepository, b, id) => r.linkGoogleAccount(b, id, 'google-1', null),
  },
  {
    name: 'BookingRepository.updateBooking',
    repo: BookingRepository,
    run: (r: BookingRepository, b, id) => r.updateBooking(b, id, { notes: 'x' }),
  },
  {
    name: 'BookingRepository.deleteBlock',
    repo: BookingRepository,
    run: (r: BookingRepository, b, id) => r.deleteBlock(b, id),
  },
  {
    name: 'BookingRepository.updateConnection',
    repo: BookingRepository,
    run: (r: BookingRepository, b, id) => r.updateConnection(b, id, { sync_enabled: false }),
  },
  {
    name: 'BookingRepository.deleteConnection',
    repo: BookingRepository,
    run: (r: BookingRepository, b, id) => r.deleteConnection(b, id),
  },
  {
    name: 'CartRepository.updateItemQuantity',
    repo: CartRepository,
    run: (r: CartRepository, b, id) => r.updateItemQuantity(b, id, 2),
  },
  {
    name: 'CartRepository.removeItem',
    repo: CartRepository,
    run: (r: CartRepository, b, id) => r.removeItem(b, id),
  },
  {
    name: 'CartRepository.clearItems',
    repo: CartRepository,
    run: (r: CartRepository, b, id) => r.clearItems(b, id),
  },
  {
    name: 'CartRepository.clearCoupon',
    repo: CartRepository,
    run: (r: CartRepository, b, id) => r.clearCoupon(b, id),
  },
  {
    name: 'CartRepository.markConverted',
    repo: CartRepository,
    run: (r: CartRepository, b, id) => r.markConverted(b, id, RECORD_ID),
  },
  {
    name: 'CartRepository.touch',
    repo: CartRepository,
    run: (r: CartRepository, b, id) => r.touch(b, id),
  },
  {
    name: 'CatalogRepository.updateItem',
    repo: CatalogRepository,
    run: (r: CatalogRepository, b, id) => r.updateItem(b, id, { name: 'x' }),
  },
  {
    name: 'CatalogRepository.updateItemStock',
    repo: CatalogRepository,
    run: (r: CatalogRepository, b, id) => r.updateItemStock(b, id, -1),
  },
  {
    name: 'CatalogRepository.updateVariantStock',
    repo: CatalogRepository,
    run: (r: CatalogRepository, b, id) => r.updateVariantStock(b, id, -1),
  },
  {
    name: 'ClientIntelligenceRepository.updateClientProfile',
    repo: ClientIntelligenceRepository,
    run: (r: ClientIntelligenceRepository, b, id) => r.updateClientProfile(b, id, { name: 'x' }),
  },
  {
    name: 'ClientIntelligenceRepository.updateIntelligenceScores',
    repo: ClientIntelligenceRepository,
    run: (r: ClientIntelligenceRepository, b, id) =>
      r.updateIntelligenceScores(b, id, { ltvScore: 10 }),
  },
  {
    name: 'ConversationRepository.update',
    repo: ConversationRepository,
    run: (r: ConversationRepository, b, id) => r.update(b, id, { subject: 'x' }),
  },
  {
    name: 'ConversationRepository.updateLastMessageAt',
    repo: ConversationRepository,
    run: (r: ConversationRepository, b, id) => r.updateLastMessageAt(b, id, new Date(0)),
  },
  {
    name: 'ConversationRepository.incrementHumanMessageCount',
    repo: ConversationRepository,
    run: (r: ConversationRepository, b, id) => r.incrementHumanMessageCount(b, id),
  },
  {
    name: 'CouponRepository.incrementUsage',
    repo: CouponRepository,
    run: (r: CouponRepository, b, id) => r.incrementUsage(b, id),
  },
  {
    name: 'HitlRepository.updateTask',
    repo: HitlRepository,
    run: (r: HitlRepository, b, id) => r.updateTask(b, id, { priority: 'HIGH' as never }),
  },
  {
    name: 'MessageRepository.setReactions',
    repo: MessageRepository,
    run: (r: MessageRepository, b, id) => r.setReactions(b, id, []),
  },
  {
    name: 'OrderRepository.updateOrderStatus',
    repo: OrderRepository,
    run: (r: OrderRepository, b, id) => r.updateOrderStatus(b, id, 'DRAFT' as never, 'CONFIRMED' as never),
  },
  {
    name: 'PaymentRepository.updatePaymentStatus',
    repo: PaymentRepository,
    run: (r: PaymentRepository, b, id) => r.updatePaymentStatus(b, id, { status: 'PAID' }),
  },
  {
    name: 'PaymentRepository.updateRefundStatus',
    repo: PaymentRepository,
    run: (r: PaymentRepository, b, id) => r.updateRefundStatus(b, id, { status: 'PROCESSED' }),
  },
  {
    name: 'PaymentRepository.updateInvoiceStatus',
    repo: PaymentRepository,
    run: (r: PaymentRepository, b, id) => r.updateInvoiceStatus(b, id, { status: 'PAID' }),
  },
  {
    // The conditional settlement claim. Its WHERE carries both the tenant and
    // the "not already terminal" predicate; dropping the tenant half would make
    // one gateway webhook able to settle another business's refund by id.
    name: 'PaymentRepository.claimRefundSettlement',
    repo: PaymentRepository,
    run: (r: PaymentRepository, b, id) =>
      r.claimRefundSettlement(b, id, { status: 'COMPLETED' }),
  },
  {
    name: 'RealtyDlqRepository.update',
    repo: RealtyDlqRepository,
    run: (r: RealtyDlqRepository, b, id) => r.update(b, id, { attempts: 2 }),
  },
  {
    name: 'RealtyExchangeRepository.updateResaleListing',
    repo: RealtyExchangeRepository,
    run: (r: RealtyExchangeRepository, b, id) => r.updateResaleListing(b, id, { locality: 'x' }),
  },
  {
    name: 'RealtyExchangeRepository.softDeleteResaleListing',
    repo: RealtyExchangeRepository,
    run: (r: RealtyExchangeRepository, b, id) => r.softDeleteResaleListing(b, id),
  },
  {
    name: 'RealtyIntegrationsRepository.recordSync',
    repo: RealtyIntegrationsRepository,
    run: (r: RealtyIntegrationsRepository, b, id) => r.recordSync(b, id, null),
  },
  {
    name: 'SlaRepository.markMet',
    repo: SlaRepository,
    run: (r: SlaRepository, b, id) => r.markMet(b, id, new Date(0), false),
  },
  {
    // Batch sweep writes are still tenant-scoped: the id list narrows the rows,
    // business_id is what stops it reaching another tenant's trackers.
    name: 'SlaRepository.markBreachedBatch',
    repo: SlaRepository,
    run: (r: SlaRepository, b, id) => r.markBreachedBatch(b, [id], new Date(0)),
  },
  {
    name: 'SlaRepository.markEscalatedBatch',
    repo: SlaRepository,
    run: (r: SlaRepository, b, id) => r.markEscalatedBatch(b, [id], new Date(0)),
  },
  {
    name: 'SlaRepository.markEscalated',
    repo: SlaRepository,
    run: (r: SlaRepository, b, id) => r.markEscalated(b, id, new Date(0)),
  },
  {
    // Nine writes across six tables inside one transaction. The six relation
    // moves were scoped; the two `clients.update` calls that finish the merge
    // were bare primary-key writes, so a merge driven with a foreign primary id
    // rewrote and then soft-deleted another business's client record.
    name: 'ClientIntelligenceRepository.mergeClients',
    repo: ClientIntelligenceRepository,
    run: (r: ClientIntelligenceRepository, b, id) => r.mergeClients(b, id, SECOND_RECORD_ID),
  },
];

/**
 * Syndications are two-party by construction: the originator writes through
 * `business_id`, the counterparty through `to_business_id`. A predicate pinned
 * to `business_id` alone would lock the counterparty out of the transitions it
 * legitimately drives, so these are asserted separately from the CASES sweep —
 * the requirement is that the write names the caller on *one* of the two sides,
 * never that it names no side at all.
 */
const TWO_PARTY_CASES: Case[] = [
  {
    name: 'RealtyExchangeRepository.updateSyndication',
    repo: RealtyExchangeRepository,
    run: (r: RealtyExchangeRepository, b, id) => r.updateSyndication(b, id, { state: 'CLOSED' as never }),
  },
  {
    name: 'RealtyExchangeRepository.softDeleteSyndication',
    repo: RealtyExchangeRepository,
    run: (r: RealtyExchangeRepository, b, id) => r.softDeleteSyndication(b, id),
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

describe('Repository tenant isolation — two-party exchange writes', () => {
  it.each(TWO_PARTY_CASES.map((c) => [c.name, c] as const))(
    '%s names the caller on one side of the deal',
    async (_name, testCase) => {
      const { prisma, calls } = makeRecordingPrisma();
      const repo = await buildRepo(testCase.repo, prisma);

      await testCase.run(repo as never, BUSINESS_ID, RECORD_ID);

      const writes = calls.filter((c) => c.op === 'update' || c.op === 'updateMany');
      expect(writes.length).toBeGreaterThan(0);

      for (const call of writes) {
        const where = call.args['where'] as Record<string, unknown>;
        const or = where['OR'] as Array<Record<string, unknown>> | undefined;
        expect(or).toBeDefined();
        // Exactly the originator column and the counterparty column, both
        // pinned to the caller — not an open predicate that any business
        // satisfies.
        expect(or).toEqual([
          { business_id: BUSINESS_ID },
          { to_business_id: BUSINESS_ID },
        ]);
      }
    },
  );

  it.each(TWO_PARTY_CASES.map((c) => [c.name, c] as const))(
    '%s cannot be driven by a business that is party to neither side',
    async (_name, testCase) => {
      const { prisma, calls } = makeRecordingPrisma();
      const repo = await buildRepo(testCase.repo, prisma);

      await testCase.run(repo as never, OTHER_BUSINESS_ID, RECORD_ID);

      for (const call of calls.filter((c) => c.op === 'update' || c.op === 'updateMany')) {
        const where = call.args['where'] as Record<string, unknown>;
        // Whatever the caller passed is what both sides are tested against, so
        // an outsider matches no row rather than matching every row.
        expect(where['OR']).toEqual([
          { business_id: OTHER_BUSINESS_ID },
          { to_business_id: OTHER_BUSINESS_ID },
        ]);
        expect(JSON.stringify(where)).not.toContain(BUSINESS_ID);
      }
    },
  );
});

/**
 * Reads whose signature gained a `businessId` in round 3.
 *
 * These were the sharper half of the gap: a write by bare primary key needs an
 * attacker to know an id, but an unscoped read on `external_id` or
 * `conversation_id` hands back another business's rows for an identifier the
 * other business chose. Each is asserted to put the tenant in the query itself
 * rather than filtering the result afterwards.
 */
describe('Repository tenant isolation — reads closed in round 3', () => {
  const READ_CASES: Case[] = [
    {
      name: 'AuthRepository.findTeamMemberById',
      repo: AuthRepository,
      run: (r: AuthRepository, b, id) => r.findTeamMemberById(b, id),
    },
    {
      name: 'MessageRepository.findByExternalId',
      repo: MessageRepository,
      run: (r: MessageRepository, b) => r.findByExternalId(b, 'wamid.external'),
    },
    {
      name: 'MessageRepository.getLastN',
      repo: MessageRepository,
      run: (r: MessageRepository, b, id) => r.getLastN(b, id, 10),
    },
    {
      name: 'CartRepository.findItemByProduct',
      repo: CartRepository,
      run: (r: CartRepository, b, id) => r.findItemByProduct(b, id, RECORD_ID, null),
    },
    {
      name: 'AiEngineRepository.getLastMessages',
      repo: AiEngineRepository,
      run: (r: AiEngineRepository, b, id) => r.getLastMessages(b, id, 10),
    },
    {
      name: 'AiEngineRepository.getRecentIntents',
      repo: AiEngineRepository,
      run: (r: AiEngineRepository, b, id) => r.getRecentIntents(b, id, 10),
    },
    {
      name: 'NotificationRepository.listActiveTriggersForEvent',
      repo: NotificationRepository,
      run: (r: NotificationRepository, b) => r.listActiveTriggersForEvent(b, 'order.created'),
    },
  ];

  it.each(READ_CASES.map((c) => [c.name, c] as const))(
    '%s filters on business_id in the query, not after it',
    async (_name, testCase) => {
      const { prisma, calls } = makeRecordingPrisma();
      const repo = await buildRepo(testCase.repo, prisma);

      await testCase.run(repo as never, BUSINESS_ID, RECORD_ID);

      const reads = calls.filter((c) => c.op === 'findFirst' || c.op === 'findMany');
      expect(reads.length).toBeGreaterThan(0);
      for (const call of reads) {
        expect(call.args['where']).toMatchObject({ business_id: BUSINESS_ID });
      }
    },
  );

  it.each(READ_CASES.map((c) => [c.name, c] as const))(
    '%s reads the business it was handed, never a remembered one',
    async (_name, testCase) => {
      const { prisma, calls } = makeRecordingPrisma();
      const repo = await buildRepo(testCase.repo, prisma);

      await testCase.run(repo as never, OTHER_BUSINESS_ID, RECORD_ID);

      for (const call of calls.filter((c) => c.op === 'findFirst' || c.op === 'findMany')) {
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
