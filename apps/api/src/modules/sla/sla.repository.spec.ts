/**
 * SlaRepository unit tests.
 *
 * The branch-heavy parts are the two all-optional builders and the tracker
 * writes that encode SLA semantics in the row itself:
 *
 *   - `createPolicy` defaults `priority` and `isActive`, and `0`/`false` have to
 *     survive those defaults — a `||` would silently promote a
 *     lowest-priority catch-all policy or reactivate a disabled one.
 *   - `updatePolicy` is a sparse patch: an omitted field must be absent from
 *     the `data`, while an explicit `null` description must be written.
 *   - `markMet` derives `breached_at` from the `breached` flag, which is what
 *     separates an on-time completion from a late one.
 *   - `createBreachTrackers` computes both due dates from the conversation's
 *     creation time; the minute-to-millisecond arithmetic is pinned here.
 *
 * Every query must carry `business_id`; that is asserted throughout.
 *
 * PrismaService is mocked — assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ChannelType } from '@gosumo/shared';

import { SlaRepository } from './sla.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const POLICY_ID = '00000000-0000-4000-b000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-c000-000000000001';
const TRACKER_ID = '00000000-0000-4000-d000-000000000001';

const FROM = new Date('2026-06-01T00:00:00Z');
const TO = new Date('2026-06-30T00:00:00Z');
const NOW = new Date('2026-06-15T12:00:00Z');

describe('SlaRepository', () => {
  let repository: SlaRepository;
  let prisma: {
    sla_policies: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    sla_breaches: {
      createMany: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
    conversations: { findFirst: jest.Mock };
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      sla_policies: {
        create: jest.fn().mockResolvedValue({ id: POLICY_ID }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: POLICY_ID }),
      },
      sla_breaches: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: TRACKER_ID }),
        count: jest.fn().mockResolvedValue(0),
      },
      conversations: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [SlaRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(SlaRepository);
  });

  describe('createPolicy', () => {
    const base = {
      name: 'Gold',
      conditions: { channels: [ChannelType.WHATSAPP] },
      firstResponseTargetMinutes: 15,
      resolutionTargetMinutes: 240,
      escalationActions: [{ type: 'NOTIFY' as const, target: 'owner' }],
    };

    it('defaults priority to 0 and is_active to true', async () => {
      await repository.createPolicy(BUSINESS_ID, base);

      expect(prisma.sla_policies.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: BUSINESS_ID,
          priority: 0,
          is_active: true,
        }),
      });
    });

    it('keeps an explicit priority of 0 rather than re-defaulting it', async () => {
      await repository.createPolicy(BUSINESS_ID, { ...base, priority: 0 });

      const { data } = prisma.sla_policies.create.mock.calls[0]?.[0];
      expect(data.priority).toBe(0);
    });

    it('keeps isActive=false — a policy created disabled stays disabled', async () => {
      await repository.createPolicy(BUSINESS_ID, { ...base, isActive: false });

      const { data } = prisma.sla_policies.create.mock.calls[0]?.[0];
      expect(data.is_active).toBe(false);
    });

    it('stores the supplied priority and both minute targets', async () => {
      await repository.createPolicy(BUSINESS_ID, { ...base, priority: 50 });

      expect(prisma.sla_policies.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          priority: 50,
          first_response_target_minutes: 15,
          resolution_target_minutes: 240,
        }),
      });
    });
  });

  describe('policy reads', () => {
    it('findActivePolicies excludes deleted and inactive rows, highest priority first', async () => {
      await repository.findActivePolicies(BUSINESS_ID);

      expect(prisma.sla_policies.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, deleted_at: null, is_active: true },
        orderBy: { priority: 'desc' },
      });
    });

    it('findAllPolicies keeps inactive rows but still excludes deleted ones', async () => {
      await repository.findAllPolicies(BUSINESS_ID);

      expect(prisma.sla_policies.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, deleted_at: null },
        orderBy: { priority: 'desc' },
      });
    });

    it('findPolicyById scopes to the tenant and skips soft-deleted rows', async () => {
      await repository.findPolicyById(BUSINESS_ID, POLICY_ID);

      expect(prisma.sla_policies.findFirst).toHaveBeenCalledWith({
        where: { id: POLICY_ID, business_id: BUSINESS_ID, deleted_at: null },
      });
    });
  });

  describe('updatePolicy', () => {
    async function dataFor(
      patch: Parameters<SlaRepository['updatePolicy']>[2],
    ): Promise<Record<string, unknown>> {
      await repository.updatePolicy(BUSINESS_ID, POLICY_ID, patch);
      return prisma.sla_policies.update.mock.calls[0]?.[0].data as Record<
        string,
        unknown
      >;
    }

    it('writes nothing for an empty patch', async () => {
      const data = await dataFor({});

      expect(data).toEqual({});
    });

    it('scopes the update to the tenant', async () => {
      await repository.updatePolicy(BUSINESS_ID, POLICY_ID, { name: 'Silver' });

      expect(prisma.sla_policies.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: POLICY_ID, business_id: BUSINESS_ID },
        }),
      );
    });

    it('patches only the supplied fields', async () => {
      const data = await dataFor({ name: 'Silver', priority: 10 });

      expect(data).toEqual({ name: 'Silver', priority: 10 });
      expect(data).not.toHaveProperty('is_active');
      expect(data).not.toHaveProperty('conditions');
    });

    it('writes an explicit null description rather than skipping it', async () => {
      const data = await dataFor({ description: null });

      expect(data).toEqual({ description: null });
    });

    it('writes priority 0 and is_active false', async () => {
      const data = await dataFor({ priority: 0, isActive: false });

      expect(data).toEqual({ priority: 0, is_active: false });
    });

    it('patches conditions, both targets, and escalation actions', async () => {
      const data = await dataFor({
        conditions: { tags: ['vip'] },
        firstResponseTargetMinutes: 5,
        resolutionTargetMinutes: 60,
        escalationActions: [{ type: 'REASSIGN', target: 'lead' }],
      });

      expect(data).toEqual({
        conditions: { tags: ['vip'] },
        first_response_target_minutes: 5,
        resolution_target_minutes: 60,
        escalation_actions: [{ type: 'REASSIGN', target: 'lead' }],
      });
    });
  });

  describe('softDeletePolicy', () => {
    it('stamps deleted_at under the tenant scope instead of deleting the row', async () => {
      await repository.softDeletePolicy(BUSINESS_ID, POLICY_ID);

      const call = prisma.sla_policies.update.mock.calls[0]?.[0];
      expect(call.where).toEqual({ id: POLICY_ID, business_id: BUSINESS_ID });
      expect(call.data.deleted_at).toBeInstanceOf(Date);
    });
  });

  describe('getConversationSummary', () => {
    it('returns null when the conversation belongs to another tenant', async () => {
      prisma.conversations.findFirst.mockResolvedValue(null);

      await expect(
        repository.getConversationSummary(BUSINESS_ID, CONVERSATION_ID),
      ).resolves.toBeNull();
    });

    it('projects only the fields policy matching needs', async () => {
      prisma.conversations.findFirst.mockResolvedValue({
        channel: 'WHATSAPP',
        tags: ['vip'],
        created_at: NOW,
      });

      const summary = await repository.getConversationSummary(
        BUSINESS_ID,
        CONVERSATION_ID,
      );

      expect(summary).toEqual({
        channel: ChannelType.WHATSAPP,
        tags: ['vip'],
        createdAt: NOW,
      });
      expect(prisma.conversations.findFirst).toHaveBeenCalledWith({
        where: { id: CONVERSATION_ID, business_id: BUSINESS_ID },
        select: { channel: true, tags: true, created_at: true },
      });
    });
  });

  describe('createBreachTrackers', () => {
    it('creates both clocks with due dates offset from the conversation start', async () => {
      await repository.createBreachTrackers(
        BUSINESS_ID,
        CONVERSATION_ID,
        POLICY_ID,
        NOW,
        15,
        240,
      );

      const { data, skipDuplicates } =
        prisma.sla_breaches.createMany.mock.calls[0]?.[0];
      expect(skipDuplicates).toBe(true);
      expect(data).toHaveLength(2);

      const [firstResponse, resolution] = data;
      expect(firstResponse).toMatchObject({
        business_id: BUSINESS_ID,
        conversation_id: CONVERSATION_ID,
        policy_id: POLICY_ID,
        breach_type: 'FIRST_RESPONSE',
        target_minutes: 15,
      });
      expect(firstResponse.due_at.toISOString()).toBe('2026-06-15T12:15:00.000Z');
      expect(resolution).toMatchObject({
        breach_type: 'RESOLUTION',
        target_minutes: 240,
      });
      expect(resolution.due_at.toISOString()).toBe('2026-06-15T16:00:00.000Z');
    });

    it('skips duplicates so a replayed conversation.created does not double-track', async () => {
      await repository.createBreachTrackers(
        BUSINESS_ID,
        CONVERSATION_ID,
        POLICY_ID,
        NOW,
        15,
        240,
      );

      expect(prisma.sla_breaches.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });
  });

  describe('tracker reads', () => {
    it('findBreachTracker scopes by tenant, conversation, and clock type', async () => {
      await repository.findBreachTracker(
        BUSINESS_ID,
        CONVERSATION_ID,
        'FIRST_RESPONSE',
      );

      expect(prisma.sla_breaches.findFirst).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          conversation_id: CONVERSATION_ID,
          breach_type: 'FIRST_RESPONSE',
        },
      });
    });

    it('findBreachesForConversation returns both clocks for the conversation', async () => {
      await repository.findBreachesForConversation(BUSINESS_ID, CONVERSATION_ID);

      expect(prisma.sla_breaches.findMany).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          conversation_id: CONVERSATION_ID,
        },
      });
    });

    it('findOverdueUnmetTrackers selects unmet, not-yet-breached, past-due rows', async () => {
      await repository.findOverdueUnmetTrackers(BUSINESS_ID, NOW, 100);

      expect(prisma.sla_breaches.findMany).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          met_at: null,
          breached: false,
          due_at: { lt: NOW },
        },
        take: 100,
      });
    });
  });

  describe('tracker writes', () => {
    it('markMet clears breached_at for an on-time completion', async () => {
      await repository.markMet(BUSINESS_ID, TRACKER_ID, NOW, false);

      expect(prisma.sla_breaches.update).toHaveBeenCalledWith({
        where: { id: TRACKER_ID, business_id: BUSINESS_ID },
        data: { met_at: NOW, breached: false, breached_at: null },
      });
    });

    it('markMet stamps breached_at for a late completion', async () => {
      await repository.markMet(BUSINESS_ID, TRACKER_ID, NOW, true);

      expect(prisma.sla_breaches.update).toHaveBeenCalledWith({
        where: { id: TRACKER_ID, business_id: BUSINESS_ID },
        data: { met_at: NOW, breached: true, breached_at: NOW },
      });
    });

    it('markBreachedOnly flips the flag without claiming the clock was met', async () => {
      await repository.markBreachedOnly(BUSINESS_ID, TRACKER_ID, NOW);

      const call = prisma.sla_breaches.update.mock.calls[0]?.[0];
      expect(call.where).toEqual({ id: TRACKER_ID, business_id: BUSINESS_ID });
      expect(call.data).toEqual({ breached: true, breached_at: NOW });
      expect(call.data).not.toHaveProperty('met_at');
    });

    it('markEscalated records the escalation under the tenant scope', async () => {
      await repository.markEscalated(BUSINESS_ID, TRACKER_ID, NOW);

      expect(prisma.sla_breaches.update).toHaveBeenCalledWith({
        where: { id: TRACKER_ID, business_id: BUSINESS_ID },
        data: { escalated: true, escalated_at: NOW },
      });
    });
  });

  describe('listBreaches', () => {
    it('defaults to page 1 with a limit of 20 and no status filters', async () => {
      const result = await repository.listBreaches(BUSINESS_ID, {});

      expect(prisma.sla_breaches.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID },
        orderBy: { due_at: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it('keeps breached=false and escalated=false rather than dropping them as falsy', async () => {
      await repository.listBreaches(BUSINESS_ID, {
        breached: false,
        escalated: false,
      });

      const where = prisma.sla_breaches.findMany.mock.calls[0]?.[0].where;
      expect(where).toEqual({
        business_id: BUSINESS_ID,
        breached: false,
        escalated: false,
      });
    });

    it('filters to breached-but-not-escalated trackers', async () => {
      await repository.listBreaches(BUSINESS_ID, {
        breached: true,
        escalated: false,
      });

      const where = prisma.sla_breaches.findMany.mock.calls[0]?.[0].where;
      expect(where).toMatchObject({ breached: true, escalated: false });
    });

    it('paginates and reports the page count', async () => {
      prisma.sla_breaches.count.mockResolvedValue(41);

      const result = await repository.listBreaches(BUSINESS_ID, {
        page: 2,
        limit: 10,
      });

      expect(prisma.sla_breaches.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(result.totalPages).toBe(5);
      expect(result.total).toBe(41);
    });
  });

  describe('getComplianceStats', () => {
    it('counts total, breached, and met against the same window', async () => {
      prisma.sla_breaches.count
        .mockResolvedValueOnce(120)
        .mockResolvedValueOnce(9)
        .mockResolvedValueOnce(111);

      const stats = await repository.getComplianceStats(BUSINESS_ID, FROM, TO);

      expect(stats).toEqual({ total: 120, breached: 9, met: 111 });
      for (const call of prisma.sla_breaches.count.mock.calls) {
        expect(call[0].where).toMatchObject({
          business_id: BUSINESS_ID,
          due_at: { gte: FROM, lt: TO },
        });
      }
    });

    it('treats a met tracker as one with a non-null met_at', async () => {
      await repository.getComplianceStats(BUSINESS_ID, FROM, TO);

      const metWhere = prisma.sla_breaches.count.mock.calls[2]?.[0].where;
      expect(metWhere.met_at).toEqual({ not: null });
    });
  });

  describe('getBreachCountsByAssignee', () => {
    it('maps the raw rows into the agent-performance shape', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { assignee_id: 'agent-1', breached_count: 2, total_count: 20 },
        { assignee_id: 'agent-2', breached_count: 0, total_count: 15 },
      ]);

      const rows = await repository.getBreachCountsByAssignee(
        BUSINESS_ID,
        FROM,
        TO,
      );

      expect(rows).toEqual([
        { assigneeId: 'agent-1', breachedCount: 2, totalCount: 20 },
        { assigneeId: 'agent-2', breachedCount: 0, totalCount: 15 },
      ]);
    });

    it('parameterises the tenant and window into the raw query', async () => {
      await repository.getBreachCountsByAssignee(BUSINESS_ID, FROM, TO);

      const params = prisma.$queryRaw.mock.calls[0]?.slice(1);
      expect(params).toEqual([BUSINESS_ID, FROM, TO]);
    });

    it('returns an empty list when nobody was assigned in the window', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(
        repository.getBreachCountsByAssignee(BUSINESS_ID, FROM, TO),
      ).resolves.toEqual([]);
    });
  });
});
