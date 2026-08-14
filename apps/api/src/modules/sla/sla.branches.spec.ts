/**
 * SlaService — the default window, tag matching, and null-date serialisation.
 *
 * Three gaps the main spec leaves:
 *
 *   - `getComplianceSummary` defaults to a trailing window when the caller
 *     supplies no dates. That is the dashboard's actual call, and it is the
 *     one nothing pinned.
 *   - `matchesConditions` short-circuits on tags. A policy with a tag
 *     condition must NOT match a conversation lacking those tags — the
 *     failure mode is a VIP policy silently applying to every conversation.
 *   - `toBreachDto` serialises three nullable timestamps. A fresh tracker has
 *     all three null; the DTO has to render `null`, not `"Invalid Date"`.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { sla_policies, sla_breaches } from '@prisma/client';
import { ChannelType } from '@gosumo/shared';
import type { ConversationCreatedEvent } from '@gosumo/shared';

import { SlaService } from './sla.service';
import { SlaRepository } from './sla.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-a000-000000000010';
const POLICY_ID = '00000000-0000-4000-a000-000000000020';
const TRACKER_ID = '00000000-0000-4000-a000-000000000030';

function makePolicy(overrides: Record<string, unknown> = {}) {
  return {
    id: POLICY_ID,
    business_id: BUSINESS_ID,
    name: 'WhatsApp VIP',
    description: null,
    priority: 10,
    is_active: true,
    conditions: {},
    first_response_target_minutes: 15,
    resolution_target_minutes: 60,
    escalation_actions: [],
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  } as unknown as sla_policies;
}

function makeTracker(overrides: Record<string, unknown> = {}) {
  return {
    id: TRACKER_ID,
    business_id: BUSINESS_ID,
    conversation_id: CONVERSATION_ID,
    policy_id: POLICY_ID,
    breach_type: 'FIRST_RESPONSE',
    target_minutes: 15,
    due_at: new Date('2026-06-01T00:15:00Z'),
    met_at: null,
    breached: false,
    breached_at: null,
    escalated: false,
    escalated_at: null,
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  } as unknown as sla_breaches;
}

describe('SlaService — branches', () => {
  let service: SlaService;
  let repo: jest.Mocked<SlaRepository>;

  beforeEach(async () => {
    repo = {
      createPolicy: jest.fn(),
      findActivePolicies: jest.fn().mockResolvedValue([]),
      findAllPolicies: jest.fn().mockResolvedValue([]),
      findPolicyById: jest.fn(),
      updatePolicy: jest.fn(),
      softDeletePolicy: jest.fn(),
      getConversationSummary: jest.fn().mockResolvedValue(null),
      createBreachTrackers: jest.fn(),
      findBreachTracker: jest.fn(),
      findBreachesForConversation: jest.fn().mockResolvedValue([]),
      markMet: jest.fn(),
      markBreachedBatch: jest.fn(),
      markEscalatedBatch: jest.fn(),
      markEscalated: jest.fn(),
      findOverdueUnmetTrackers: jest.fn().mockResolvedValue([]),
      listBreaches: jest.fn(),
      getComplianceStats: jest
        .fn()
        .mockResolvedValue({ total: 0, breached: 0, met: 0 }),
      getBreachCountsByAssignee: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<SlaRepository>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SlaService,
        { provide: SlaRepository, useValue: repo },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(SlaService);
  });

  describe('getComplianceSummary — default window', () => {
    it('ends the window at now when no upper bound is given', async () => {
      const before = Date.now();

      const summary = await service.getComplianceSummary(BUSINESS_ID);

      const to = new Date(summary.to).getTime();
      expect(to).toBeGreaterThanOrEqual(before);
      expect(to).toBeLessThanOrEqual(Date.now());
    });

    it('starts the window a fixed span before the upper bound', async () => {
      const summary = await service.getComplianceSummary(BUSINESS_ID);

      const span =
        new Date(summary.to).getTime() - new Date(summary.from).getTime();
      const days = span / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(0);
      expect(Number.isInteger(days)).toBe(true);
    });

    it('honours an explicit upper bound while defaulting the lower one', async () => {
      const summary = await service.getComplianceSummary(
        BUSINESS_ID,
        undefined,
        '2026-06-30T00:00:00.000Z',
      );

      expect(summary.to).toBe('2026-06-30T00:00:00.000Z');
      expect(new Date(summary.from).getTime()).toBeLessThan(
        new Date(summary.to).getTime(),
      );
    });

    it('honours an explicit lower bound while defaulting the upper one', async () => {
      const summary = await service.getComplianceSummary(
        BUSINESS_ID,
        '2026-06-01T00:00:00.000Z',
      );

      expect(summary.from).toBe('2026-06-01T00:00:00.000Z');
      expect(repo.getComplianceStats).toHaveBeenCalledWith(
        BUSINESS_ID,
        new Date('2026-06-01T00:00:00.000Z'),
        expect.any(Date),
      );
    });
  });

  describe('policy matching — tag conditions', () => {
    const event: ConversationCreatedEvent = {
      businessId: BUSINESS_ID,
      conversationId: CONVERSATION_ID,
    } as ConversationCreatedEvent;

    function conversationWith(tags: string[]): void {
      repo.getConversationSummary.mockResolvedValue({
        channel: ChannelType.WHATSAPP,
        tags,
        createdAt: new Date('2026-06-01T00:00:00Z'),
      });
    }

    it('matches a tag-conditioned policy when the conversation carries the tag', async () => {
      conversationWith(['vip']);
      repo.findActivePolicies.mockResolvedValue([
        makePolicy({ conditions: { tags: ['vip'] } }),
      ]);

      await service.handleConversationCreated(event);

      expect(repo.createBreachTrackers).toHaveBeenCalledTimes(1);
    });

    it('does not apply a tag-conditioned policy to an untagged conversation', async () => {
      conversationWith([]);
      repo.findActivePolicies.mockResolvedValue([
        makePolicy({ conditions: { tags: ['vip'] } }),
      ]);

      await service.handleConversationCreated(event);

      expect(repo.createBreachTrackers).not.toHaveBeenCalled();
    });

    it('does not apply a tag-conditioned policy when only other tags are present', async () => {
      conversationWith(['refund', 'urgent']);
      repo.findActivePolicies.mockResolvedValue([
        makePolicy({ conditions: { tags: ['vip'] } }),
      ]);

      await service.handleConversationCreated(event);

      expect(repo.createBreachTrackers).not.toHaveBeenCalled();
    });

    it('requires both channel and tags when a policy conditions on both', async () => {
      conversationWith(['vip']);
      repo.findActivePolicies.mockResolvedValue([
        makePolicy({
          conditions: { channels: [ChannelType.INSTAGRAM], tags: ['vip'] },
        }),
      ]);

      await service.handleConversationCreated(event);

      expect(repo.createBreachTrackers).not.toHaveBeenCalled();
    });

    it('treats an empty tag list as no tag condition at all', async () => {
      conversationWith([]);
      repo.findActivePolicies.mockResolvedValue([
        makePolicy({ conditions: { tags: [] } }),
      ]);

      await service.handleConversationCreated(event);

      expect(repo.createBreachTrackers).toHaveBeenCalledTimes(1);
    });

    it('skips a conversation the tenant cannot see', async () => {
      repo.getConversationSummary.mockResolvedValue(null);

      await service.handleConversationCreated(event);

      expect(repo.findActivePolicies).not.toHaveBeenCalled();
      expect(repo.createBreachTrackers).not.toHaveBeenCalled();
    });
  });

  describe('toBreachDto — nullable timestamps', () => {
    it('renders all three timestamps as null for a fresh tracker', async () => {
      repo.findBreachesForConversation.mockResolvedValue([makeTracker()]);

      const [dto] = await service.getBreachesForConversation(
        BUSINESS_ID,
        CONVERSATION_ID,
      );

      expect(dto?.metAt).toBeNull();
      expect(dto?.breachedAt).toBeNull();
      expect(dto?.escalatedAt).toBeNull();
      expect(dto?.dueAt).toBe('2026-06-01T00:15:00.000Z');
    });

    it('serialises each timestamp once it is set', async () => {
      repo.findBreachesForConversation.mockResolvedValue([
        makeTracker({
          met_at: new Date('2026-06-01T00:20:00Z'),
          breached: true,
          breached_at: new Date('2026-06-01T00:20:00Z'),
          escalated: true,
          escalated_at: new Date('2026-06-01T00:21:00Z'),
        }),
      ]);

      const [dto] = await service.getBreachesForConversation(
        BUSINESS_ID,
        CONVERSATION_ID,
      );

      expect(dto?.metAt).toBe('2026-06-01T00:20:00.000Z');
      expect(dto?.breachedAt).toBe('2026-06-01T00:20:00.000Z');
      expect(dto?.escalatedAt).toBe('2026-06-01T00:21:00.000Z');
    });
  });

  describe('listener resilience', () => {
    it('swallows a non-Error thrown out of the repository', async () => {
      repo.getConversationSummary.mockRejectedValue('connection reset');

      await expect(
        service.handleConversationCreated({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
        } as ConversationCreatedEvent),
      ).resolves.toBeUndefined();
    });

    it('swallows an Error thrown out of the repository', async () => {
      repo.getConversationSummary.mockRejectedValue(new Error('db down'));

      await expect(
        service.handleConversationCreated({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
        } as ConversationCreatedEvent),
      ).resolves.toBeUndefined();
    });
  });
});
