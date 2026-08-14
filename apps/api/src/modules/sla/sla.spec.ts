/**
 * SLA module unit tests
 *
 * Coverage:
 *  1. Policy CRUD — validation (resolution >= first-response), 404s
 *  2. conversation.created — matches highest-priority policy by
 *     channel/tags, creates trackers; no match → no trackers
 *  3. message.sent / conversation.resolved — marks the relevant tracker met,
 *     computes breached vs on-time, skips already-met trackers, emits
 *     sla.breached + triggers escalation only on a fresh breach
 *  4. sweepOverdueBreaches — marks overdue unmet trackers breached and escalates
 *  5. compliance summary — rate calculation
 *
 * The repository and EventEmitter2 are mocked; no database is touched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import type { sla_policies, sla_breaches } from '@prisma/client';
import { ChannelType } from '@gosumo/shared';
import type { ConversationCreatedEvent, MessageSentEvent, ConversationResolvedEvent } from '@gosumo/shared';

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
    conditions: { channels: ['WHATSAPP'] },
    first_response_target_minutes: 15,
    resolution_target_minutes: 60,
    escalation_actions: [{ type: 'NOTIFY', target: 'manager' }],
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

describe('SlaService', () => {
  let service: SlaService;
  let repo: jest.Mocked<SlaRepository>;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    repo = {
      createPolicy: jest.fn(),
      findActivePolicies: jest.fn(),
      findAllPolicies: jest.fn(),
      findPolicyById: jest.fn(),
      updatePolicy: jest.fn(),
      softDeletePolicy: jest.fn(),
      getConversationSummary: jest.fn(),
      createBreachTrackers: jest.fn(),
      findBreachTracker: jest.fn(),
      findBreachesForConversation: jest.fn(),
      markMet: jest.fn(),
      markBreachedBatch: jest.fn(),
      markEscalatedBatch: jest.fn(),
      markEscalated: jest.fn(),
      findOverdueUnmetTrackers: jest.fn(),
      listBreaches: jest.fn(),
      getComplianceStats: jest.fn(),
      getBreachCountsByAssignee: jest.fn(),
    } as unknown as jest.Mocked<SlaRepository>;

    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [SlaService, { provide: SlaRepository, useValue: repo }, { provide: EventEmitter2, useValue: emitter }],
    }).compile();

    service = module.get(SlaService);
  });

  // ───────────────────────────────────────────
  // Policy CRUD
  // ───────────────────────────────────────────

  describe('createPolicy', () => {
    it('rejects a resolution target shorter than the first-response target', async () => {
      await expect(
        service.createPolicy(BUSINESS_ID, {
          name: 'Bad',
          conditions: {},
          firstResponseTargetMinutes: 60,
          resolutionTargetMinutes: 15,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates a valid policy', async () => {
      repo.createPolicy.mockResolvedValue(makePolicy());
      const result = await service.createPolicy(BUSINESS_ID, {
        name: 'WhatsApp VIP',
        conditions: { channels: [ChannelType.WHATSAPP] },
        firstResponseTargetMinutes: 15,
        resolutionTargetMinutes: 60,
      });
      expect(result.id).toBe(POLICY_ID);
    });
  });

  describe('getPolicy / updatePolicy / deletePolicy', () => {
    it('throws 404 for a missing policy', async () => {
      repo.findPolicyById.mockResolvedValue(null);
      await expect(service.getPolicy(BUSINESS_ID, POLICY_ID)).rejects.toThrow(NotFoundException);
      await expect(service.updatePolicy(BUSINESS_ID, POLICY_ID, {})).rejects.toThrow(NotFoundException);
      await expect(service.deletePolicy(BUSINESS_ID, POLICY_ID)).rejects.toThrow(NotFoundException);
    });

    it('soft-deletes an existing policy', async () => {
      repo.findPolicyById.mockResolvedValue(makePolicy());
      await service.deletePolicy(BUSINESS_ID, POLICY_ID);
      expect(repo.softDeletePolicy).toHaveBeenCalledWith(BUSINESS_ID, POLICY_ID);
    });
  });

  // ───────────────────────────────────────────
  // conversation.created — policy matching
  // ───────────────────────────────────────────

  describe('handleConversationCreated', () => {
    const event: ConversationCreatedEvent = {
      id: 'evt-1',
      type: 'conversation.created',
      timestamp: '2026-06-01T00:00:00Z',
      businessId: BUSINESS_ID,
      correlationId: 'corr-1',
      conversationId: CONVERSATION_ID,
      clientId: 'client-1',
      channelAccountId: 'chan-acct-1',
      channel: ChannelType.WHATSAPP,
    };

    it('creates trackers when a policy matches the conversation channel', async () => {
      repo.getConversationSummary.mockResolvedValue({
        channel: ChannelType.WHATSAPP,
        tags: [],
        createdAt: new Date('2026-06-01T00:00:00Z'),
      });
      repo.findActivePolicies.mockResolvedValue([makePolicy()]);

      await service.handleConversationCreated(event);

      expect(repo.createBreachTrackers).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        POLICY_ID,
        expect.any(Date),
        15,
        60,
      );
    });

    it('does nothing when no active policy matches the channel', async () => {
      repo.getConversationSummary.mockResolvedValue({
        channel: ChannelType.EMAIL,
        tags: [],
        createdAt: new Date('2026-06-01T00:00:00Z'),
      });
      repo.findActivePolicies.mockResolvedValue([makePolicy()]); // channels: ['WHATSAPP']

      await service.handleConversationCreated(event);

      expect(repo.createBreachTrackers).not.toHaveBeenCalled();
    });

    it('picks the highest-priority match when multiple policies qualify', async () => {
      const low = makePolicy({ id: 'low', priority: 1, conditions: {} });
      const high = makePolicy({ id: 'high', priority: 100, conditions: {} });
      repo.getConversationSummary.mockResolvedValue({
        channel: ChannelType.WHATSAPP,
        tags: [],
        createdAt: new Date('2026-06-01T00:00:00Z'),
      });
      // Repository contract returns policies ordered by priority desc already.
      repo.findActivePolicies.mockResolvedValue([high, low]);

      await service.handleConversationCreated(event);

      expect(repo.createBreachTrackers).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        'high',
        expect.any(Date),
        15,
        60,
      );
    });

    it('swallows errors so a bad lookup never breaks the event pipeline', async () => {
      repo.getConversationSummary.mockRejectedValue(new Error('db down'));
      await expect(service.handleConversationCreated(event)).resolves.toBeUndefined();
    });
  });

  // ───────────────────────────────────────────
  // message.sent / conversation.resolved — tracker checks
  // ───────────────────────────────────────────

  describe('handleMessageSent', () => {
    const event: MessageSentEvent = {
      id: 'evt-2',
      type: 'message.sent',
      timestamp: '2026-06-01T00:20:00Z',
      businessId: BUSINESS_ID,
      correlationId: 'corr-2',
      messageId: 'msg-1',
      conversationId: CONVERSATION_ID,
      channelAccountId: 'chan-acct-1',
      channel: ChannelType.WHATSAPP,
      externalMessageId: 'ext-1',
      recipientExternalId: '+919876543210',
      latencyMs: 500,
    };

    it('marks the FIRST_RESPONSE tracker met and breached when past due_at', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-01T00:20:00Z')); // due_at is 00:15
      repo.findBreachTracker.mockResolvedValue(makeTracker());
      repo.markMet.mockResolvedValue(makeTracker({ met_at: new Date(), breached: true }));
      repo.findPolicyById.mockResolvedValue(makePolicy());

      await service.handleMessageSent(event);

      expect(repo.markMet).toHaveBeenCalledWith(
        BUSINESS_ID,
        TRACKER_ID,
        expect.any(Date),
        true,
      );
      expect(emitter.emit).toHaveBeenCalledWith('sla.breached', expect.objectContaining({ type: 'sla.breached' }));
      expect(emitter.emit).toHaveBeenCalledWith('sla.escalated', expect.objectContaining({ action: 'NOTIFY' }));
      expect(repo.markEscalated).toHaveBeenCalledWith(
        BUSINESS_ID,
        TRACKER_ID,
        expect.any(Date),
      );
      jest.useRealTimers();
    });

    it('marks the tracker met without breach or escalation when on time', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-01T00:10:00Z')); // before due_at 00:15
      repo.findBreachTracker.mockResolvedValue(makeTracker());
      repo.markMet.mockResolvedValue(makeTracker({ met_at: new Date(), breached: false }));

      await service.handleMessageSent(event);

      expect(repo.markMet).toHaveBeenCalledWith(
        BUSINESS_ID,
        TRACKER_ID,
        expect.any(Date),
        false,
      );
      expect(emitter.emit).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('skips a tracker that was already met', async () => {
      repo.findBreachTracker.mockResolvedValue(makeTracker({ met_at: new Date() }));
      await service.handleMessageSent(event);
      expect(repo.markMet).not.toHaveBeenCalled();
    });

    it('does nothing when there is no tracker for the conversation', async () => {
      repo.findBreachTracker.mockResolvedValue(null);
      await service.handleMessageSent(event);
      expect(repo.markMet).not.toHaveBeenCalled();
    });

    it('does not re-escalate a tracker that was already flagged breached (e.g. by the sweep)', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-01T00:20:00Z'));
      repo.findBreachTracker.mockResolvedValue(makeTracker({ breached: true, breached_at: new Date('2026-06-01T00:16:00Z') }));
      repo.markMet.mockResolvedValue(makeTracker({ met_at: new Date(), breached: true }));

      await service.handleMessageSent(event);

      expect(repo.markMet).toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe('handleConversationResolved', () => {
    const event: ConversationResolvedEvent = {
      id: 'evt-3',
      type: 'conversation.resolved',
      timestamp: '2026-06-01T01:00:00Z',
      businessId: BUSINESS_ID,
      correlationId: 'corr-3',
      conversationId: CONVERSATION_ID,
      clientId: 'client-1',
      resolvedBy: 'HUMAN',
      resolutionDurationSeconds: 3600,
    };

    it('checks the RESOLUTION tracker', async () => {
      repo.findBreachTracker.mockResolvedValue(makeTracker({ breach_type: 'RESOLUTION', due_at: new Date('2026-06-01T01:00:00Z') }));
      repo.markMet.mockResolvedValue(makeTracker({ breach_type: 'RESOLUTION', met_at: new Date(), breached: false }));

      await service.handleConversationResolved(event);

      expect(repo.findBreachTracker).toHaveBeenCalledWith(BUSINESS_ID, CONVERSATION_ID, 'RESOLUTION');
    });
  });

  // ───────────────────────────────────────────
  // Sweep
  // ───────────────────────────────────────────

  describe('sweepOverdueBreaches', () => {
    it('marks overdue unmet trackers as breached and escalates each', async () => {
      const overdue = [makeTracker(), makeTracker({ id: 'tracker-2' })];
      repo.findOverdueUnmetTrackers.mockResolvedValue(overdue);
      repo.findPolicyById.mockResolvedValue(makePolicy());

      const result = await service.sweepOverdueBreaches(BUSINESS_ID);

      expect(result.swept).toBe(2);
      expect(emitter.emit).toHaveBeenCalledWith('sla.breached', expect.anything());
      // Both writes are batched: one statement each, not one per tracker.
      expect(repo.markBreachedBatch).toHaveBeenCalledTimes(1);
      expect(repo.markBreachedBatch).toHaveBeenCalledWith(
        BUSINESS_ID,
        [TRACKER_ID, 'tracker-2'],
        expect.any(Date),
      );
      expect(repo.markEscalatedBatch).toHaveBeenCalledTimes(1);
      expect(repo.markEscalatedBatch).toHaveBeenCalledWith(
        BUSINESS_ID,
        [TRACKER_ID, 'tracker-2'],
        expect.any(Date),
      );
    });

    it('emits one sla.breached per tracker even though the write is batched', async () => {
      repo.findOverdueUnmetTrackers.mockResolvedValue([
        makeTracker({ id: 't1' }),
        makeTracker({ id: 't2' }),
        makeTracker({ id: 't3' }),
      ]);
      repo.findPolicyById.mockResolvedValue(makePolicy());

      await service.sweepOverdueBreaches(BUSINESS_ID);

      expect(
        emitter.emit.mock.calls.filter((c: unknown[]) => c[0] === 'sla.breached'),
      ).toHaveLength(3);
    });

    it('reports the breach as breached in the emitted event without reading the row back', async () => {
      // markBreachedBatch writes exactly `breached` and `breached_at`, so the
      // sweep reconstructs the updated row rather than refetching it.
      repo.findOverdueUnmetTrackers.mockResolvedValue([
        makeTracker({ id: 't1', breached: false }),
      ]);
      repo.findPolicyById.mockResolvedValue(makePolicy());

      await service.sweepOverdueBreaches(BUSINESS_ID);

      const breached = emitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === 'sla.breached',
      );
      expect(breached?.[1]).toMatchObject({ conversationId: CONVERSATION_ID });
      // No per-tracker read was needed to build that payload.
      expect(repo.findBreachTracker).not.toHaveBeenCalled();
    });

    it('scopes both batch writes to the tenant', async () => {
      repo.findOverdueUnmetTrackers.mockResolvedValue([makeTracker({ id: 't1' })]);
      repo.findPolicyById.mockResolvedValue(makePolicy());

      await service.sweepOverdueBreaches(BUSINESS_ID);

      expect(repo.markBreachedBatch.mock.calls[0]![0]).toBe(BUSINESS_ID);
      expect(repo.markEscalatedBatch.mock.calls[0]![0]).toBe(BUSINESS_ID);
    });

    it('returns swept: 0 when nothing is overdue', async () => {
      repo.findOverdueUnmetTrackers.mockResolvedValue([]);
      const result = await service.sweepOverdueBreaches(BUSINESS_ID);
      expect(result.swept).toBe(0);
    });

    it('looks each policy up once per sweep, not once per breach', async () => {
      // Five trackers sharing two policies used to cost five identical
      // findPolicyById round trips; the per-sweep cache makes it two.
      const overdue = [
        makeTracker({ id: 't1', policy_id: 'policy-a' }),
        makeTracker({ id: 't2', policy_id: 'policy-a' }),
        makeTracker({ id: 't3', policy_id: 'policy-b' }),
        makeTracker({ id: 't4', policy_id: 'policy-a' }),
        makeTracker({ id: 't5', policy_id: 'policy-b' }),
      ];
      repo.findOverdueUnmetTrackers.mockResolvedValue(overdue);
      repo.findPolicyById.mockImplementation(async (_b: string, id: string) =>
        makePolicy({ id }),
      );

      const result = await service.sweepOverdueBreaches(BUSINESS_ID);

      expect(result.swept).toBe(5);
      expect(repo.findPolicyById).toHaveBeenCalledTimes(2);
      expect(repo.findPolicyById).toHaveBeenCalledWith(BUSINESS_ID, 'policy-a');
      expect(repo.findPolicyById).toHaveBeenCalledWith(BUSINESS_ID, 'policy-b');
      // Every breach still escalates — the cache changes query count, not behaviour.
      expect(repo.markEscalatedBatch).toHaveBeenCalledWith(
        BUSINESS_ID,
        ['t1', 't2', 't3', 't4', 't5'],
        expect.any(Date),
      );
      expect(
        emitter.emit.mock.calls.filter((c: unknown[]) => c[0] === 'sla.escalated'),
      ).toHaveLength(5);
    });

    it('caches a missing policy so a deleted one is not refetched per breach', async () => {
      const overdue = [
        makeTracker({ id: 't1', policy_id: 'gone' }),
        makeTracker({ id: 't2', policy_id: 'gone' }),
        makeTracker({ id: 't3', policy_id: 'gone' }),
      ];
      repo.findOverdueUnmetTrackers.mockResolvedValue(overdue);
      repo.findPolicyById.mockResolvedValue(null);

      const result = await service.sweepOverdueBreaches(BUSINESS_ID);

      expect(result.swept).toBe(3);
      expect(repo.findPolicyById).toHaveBeenCalledTimes(1);
      // No policy ⇒ no escalation actions to run, so the batch is empty.
      expect(repo.markEscalatedBatch).toHaveBeenCalledWith(BUSINESS_ID, [], expect.any(Date));
    });

    it('does not cache across separate sweeps, so a policy edit is picked up', async () => {
      repo.findOverdueUnmetTrackers.mockResolvedValue([makeTracker({ id: 't1' })]);
      repo.findPolicyById.mockResolvedValue(makePolicy());

      await service.sweepOverdueBreaches(BUSINESS_ID);
      await service.sweepOverdueBreaches(BUSINESS_ID);

      expect(repo.findPolicyById).toHaveBeenCalledTimes(2);
    });

    it('still queries the policy on the event-driven single-breach path', async () => {
      repo.findBreachTracker.mockResolvedValue(
        makeTracker({ due_at: new Date('2020-01-01T00:00:00Z') }),
      );
      repo.markMet.mockResolvedValue(makeTracker({ breached: true }));
      repo.findPolicyById.mockResolvedValue(makePolicy());

      await service.handleMessageSent({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      } as never);

      expect(repo.findPolicyById).toHaveBeenCalledTimes(1);
      expect(repo.markEscalated).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────────────────────────
  // Compliance
  // ───────────────────────────────────────────

  describe('getComplianceSummary', () => {
    it('computes the compliance rate as (total - breached) / total', async () => {
      repo.getComplianceStats.mockResolvedValue({ total: 100, breached: 20, met: 80 });
      const result = await service.getComplianceSummary(BUSINESS_ID);
      expect(result.complianceRate).toBe(80);
    });

    it('returns 0% when there are no targets in range (never divides by zero)', async () => {
      repo.getComplianceStats.mockResolvedValue({ total: 0, breached: 0, met: 0 });
      const result = await service.getComplianceSummary(BUSINESS_ID);
      expect(result.complianceRate).toBe(0);
    });
  });
});
