import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChannelType } from '@gosumo/shared';
import type { segments } from '@prisma/client';

import { ContactRepository, type SegmentFilter } from './contact.repository';
import { ContactService } from './contact.service';
import {
  SegmentRoutingService,
  NO_SEGMENT_ROUTING,
} from './segment-routing.service';
import {
  matchesSegmentFilter,
  SEGMENT_FILTER_CRITERIA,
  type ClientSegmentSnapshot,
} from './segment-routing.util';

// ─────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────

const NOW = new Date('2026-08-15T12:00:00Z');

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function snapshot(overrides: Partial<ClientSegmentSnapshot> = {}): ClientSegmentSnapshot {
  return {
    tags: [],
    channels: [ChannelType.WHATSAPP],
    ltvScore: null,
    churnRisk: null,
    engagementScore: null,
    totalOrders: 0,
    totalSpentPaise: 0,
    lastInteractionAt: daysBefore(1),
    firstSeenAt: daysBefore(30),
    conversationCount: 1,
    ...overrides,
  };
}

function segment(overrides: Partial<segments> = {}): segments {
  return {
    id: 'seg-1',
    business_id: 'b1',
    name: 'Segment 1',
    description: null,
    filter: {},
    is_active: true,
    routing_mode: 'HUMAN_ONLY',
    routing_priority: 0,
    auto_execute_threshold: null,
    draft_review_threshold: null,
    routing_assignee_id: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  } as segments;
}

// ─────────────────────────────────────────────
// matchesSegmentFilter
// ─────────────────────────────────────────────

describe('matchesSegmentFilter', () => {
  it('matches every contact for an empty filter, the same answer the SQL form gives', () => {
    expect(matchesSegmentFilter({}, snapshot(), NOW)).toBe(true);
  });

  describe('tags (OR within the list)', () => {
    it('matches when the contact carries any one of the listed tags', () => {
      const s = snapshot({ tags: ['vip'] });
      expect(matchesSegmentFilter({ tags: ['vip', 'wholesale'] }, s, NOW)).toBe(true);
    });

    it('does not match when the contact carries none of them', () => {
      const s = snapshot({ tags: ['retail'] });
      expect(matchesSegmentFilter({ tags: ['vip', 'wholesale'] }, s, NOW)).toBe(false);
    });
  });

  describe('channels', () => {
    it('matches on any overlapping channel', () => {
      const s = snapshot({ channels: [ChannelType.INSTAGRAM, ChannelType.EMAIL] });
      expect(matchesSegmentFilter({ channels: [ChannelType.EMAIL] }, s, NOW)).toBe(true);
    });

    it('does not match a channel the contact has never used', () => {
      const s = snapshot({ channels: [ChannelType.WHATSAPP] });
      expect(matchesSegmentFilter({ channels: [ChannelType.EMAIL] }, s, NOW)).toBe(false);
    });
  });

  describe('scores', () => {
    it('treats an unscored contact as not matching a minimum, as SQL does with NULL', () => {
      expect(matchesSegmentFilter({ minLtv: 100 }, snapshot({ ltvScore: null }), NOW)).toBe(false);
      expect(
        matchesSegmentFilter({ maxChurnRisk: 0.5 }, snapshot({ churnRisk: null }), NOW),
      ).toBe(false);
      expect(
        matchesSegmentFilter({ minEngagement: 0.5 }, snapshot({ engagementScore: null }), NOW),
      ).toBe(false);
    });

    it('applies the bounds inclusively', () => {
      expect(matchesSegmentFilter({ minLtv: 100 }, snapshot({ ltvScore: 100 }), NOW)).toBe(true);
      expect(matchesSegmentFilter({ maxChurnRisk: 0.5 }, snapshot({ churnRisk: 0.5 }), NOW)).toBe(
        true,
      );
      expect(matchesSegmentFilter({ maxChurnRisk: 0.5 }, snapshot({ churnRisk: 0.51 }), NOW)).toBe(
        false,
      );
    });
  });

  describe('purchase history', () => {
    it('reads hasOrders off the order count in both directions', () => {
      expect(matchesSegmentFilter({ hasOrders: true }, snapshot({ totalOrders: 2 }), NOW)).toBe(true);
      expect(matchesSegmentFilter({ hasOrders: true }, snapshot({ totalOrders: 0 }), NOW)).toBe(
        false,
      );
      expect(matchesSegmentFilter({ hasOrders: false }, snapshot({ totalOrders: 0 }), NOW)).toBe(
        true,
      );
    });

    it('bounds the order count from both ends', () => {
      const s = snapshot({ totalOrders: 5 });
      expect(matchesSegmentFilter({ minTotalOrders: 5, maxTotalOrders: 10 }, s, NOW)).toBe(true);
      expect(matchesSegmentFilter({ minTotalOrders: 6 }, s, NOW)).toBe(false);
      expect(matchesSegmentFilter({ maxTotalOrders: 4 }, s, NOW)).toBe(false);
    });

    it('compares lifetime spend in paise', () => {
      // ₹5,000 as the platform stores money everywhere: paise, integer.
      const s = snapshot({ totalSpentPaise: 500_000 });
      expect(matchesSegmentFilter({ minTotalSpentPaise: 500_000 }, s, NOW)).toBe(true);
      expect(matchesSegmentFilter({ minTotalSpentPaise: 500_001 }, s, NOW)).toBe(false);
      expect(matchesSegmentFilter({ maxTotalSpentPaise: 499_999 }, s, NOW)).toBe(false);
    });
  });

  describe('behaviour windows', () => {
    it('matches a recent interaction within the window', () => {
      const s = snapshot({ lastInteractionAt: daysBefore(3) });
      expect(matchesSegmentFilter({ activeWithinDays: 7 }, s, NOW)).toBe(true);
      expect(matchesSegmentFilter({ activeWithinDays: 2 }, s, NOW)).toBe(false);
    });

    it('never counts a contact who has never interacted as recently active', () => {
      const s = snapshot({ lastInteractionAt: null });
      expect(matchesSegmentFilter({ activeWithinDays: 3650 }, s, NOW)).toBe(false);
    });

    it('counts a contact who has never interacted as dormant', () => {
      // The asymmetry is deliberate and is the one case the SQL form needs an
      // explicit `OR IS NULL` for — a never-touched contact has no recent touch.
      const s = snapshot({ lastInteractionAt: null });
      expect(matchesSegmentFilter({ inactiveForDays: 30 }, s, NOW)).toBe(true);
    });

    it('excludes a contact who interacted inside the dormancy window', () => {
      const s = snapshot({ lastInteractionAt: daysBefore(5) });
      expect(matchesSegmentFilter({ inactiveForDays: 30 }, s, NOW)).toBe(false);
      expect(matchesSegmentFilter({ inactiveForDays: 3 }, s, NOW)).toBe(true);
    });

    it('separates new from established contacts by first-seen age', () => {
      const fresh = snapshot({ firstSeenAt: daysBefore(2) });
      const old = snapshot({ firstSeenAt: daysBefore(400) });
      expect(matchesSegmentFilter({ newerThanDays: 7 }, fresh, NOW)).toBe(true);
      expect(matchesSegmentFilter({ newerThanDays: 7 }, old, NOW)).toBe(false);
      expect(matchesSegmentFilter({ olderThanDays: 365 }, old, NOW)).toBe(true);
      expect(matchesSegmentFilter({ olderThanDays: 365 }, fresh, NOW)).toBe(false);
    });

    it('reads hasConversations off the conversation count', () => {
      expect(
        matchesSegmentFilter({ hasConversations: true }, snapshot({ conversationCount: 3 }), NOW),
      ).toBe(true);
      expect(
        matchesSegmentFilter({ hasConversations: true }, snapshot({ conversationCount: 0 }), NOW),
      ).toBe(false);
      expect(
        matchesSegmentFilter({ hasConversations: false }, snapshot({ conversationCount: 0 }), NOW),
      ).toBe(true);
    });
  });

  it('ANDs across criteria — one failing criterion loses the whole match', () => {
    const s = snapshot({ tags: ['vip'], totalOrders: 10 });
    expect(matchesSegmentFilter({ tags: ['vip'], minTotalOrders: 5 }, s, NOW)).toBe(true);
    expect(matchesSegmentFilter({ tags: ['vip'], minTotalOrders: 50 }, s, NOW)).toBe(false);
  });
});

// ─────────────────────────────────────────────
// The two implementations agree on the criteria set
// ─────────────────────────────────────────────

describe('segment filter criteria parity', () => {
  /**
   * The in-memory evaluator and the SQL builder implement the same predicates
   * twice — see `segment-routing.util.ts` for why. A criterion added to one and
   * forgotten in the other is silent and dangerous: a contact the SQL puts in a
   * HUMAN_ONLY segment but the evaluator does not is a contact the AI answers
   * anyway, while the segment page still lists them as protected.
   *
   * This asserts the SQL builder reacts to every criterion the evaluator knows,
   * by feeding each one alone and requiring the WHERE clause to grow.
   */
  const repository = new ContactRepository({} as never);
  const baselineKeys = Object.keys(repository.segmentFilterToWhere('b1', {})).sort();

  /** A value that is meaningful for each criterion, one per name. */
  const sample: Record<(typeof SEGMENT_FILTER_CRITERIA)[number], SegmentFilter> = {
    tags: { tags: ['vip'] },
    channels: { channels: [ChannelType.EMAIL] },
    minLtv: { minLtv: 10 },
    maxChurnRisk: { maxChurnRisk: 0.5 },
    minEngagement: { minEngagement: 0.5 },
    hasOrders: { hasOrders: true },
    minTotalOrders: { minTotalOrders: 3 },
    maxTotalOrders: { maxTotalOrders: 9 },
    minTotalSpentPaise: { minTotalSpentPaise: 100_000 },
    maxTotalSpentPaise: { maxTotalSpentPaise: 900_000 },
    activeWithinDays: { activeWithinDays: 7 },
    inactiveForDays: { inactiveForDays: 30 },
    hasConversations: { hasConversations: true },
    newerThanDays: { newerThanDays: 7 },
    olderThanDays: { olderThanDays: 365 },
  };

  it.each(SEGMENT_FILTER_CRITERIA)('segmentFilterToWhere constrains on %s', (criterion) => {
    const where = repository.segmentFilterToWhere('b1', sample[criterion]);
    expect(Object.keys(where).sort()).not.toEqual(baselineKeys);
  });

  it('has a sample for every criterion the evaluator knows', () => {
    expect(Object.keys(sample).sort()).toEqual([...SEGMENT_FILTER_CRITERIA].sort());
  });

  it('converts paise bounds to the rupee column the SQL side compares against', () => {
    const where = repository.segmentFilterToWhere('b1', { minTotalSpentPaise: 500_000 });
    expect(where.total_spent).toEqual({ gte: 5000 });
  });

  it('lets a never-interacted contact through the dormancy filter, matching the evaluator', () => {
    const where = repository.segmentFilterToWhere('b1', { inactiveForDays: 30 });
    expect(JSON.stringify(where.AND)).toContain('last_interaction_at');
    expect(JSON.stringify(where.AND)).toContain('null');
  });

  it('merges hasOrders with an order-count bound instead of overwriting it', () => {
    const where = repository.segmentFilterToWhere('b1', { hasOrders: true, maxTotalOrders: 5 });
    expect(where.total_orders).toEqual({ gt: 0, lte: 5 });
  });
});

// ─────────────────────────────────────────────
// SegmentRoutingService
// ─────────────────────────────────────────────

describe('SegmentRoutingService', () => {
  function makeService(overrides: {
    findRoutingSegments?: jest.Mock;
    findClientSnapshot?: jest.Mock;
  } = {}) {
    const findRoutingSegments = overrides.findRoutingSegments ?? jest.fn().mockResolvedValue([]);
    const findClientSnapshot =
      overrides.findClientSnapshot ??
      jest.fn().mockResolvedValue({
        tags: ['vip'],
        channels: ['WHATSAPP'],
        ltv_score: null,
        churn_risk: null,
        engagement_score: null,
        total_orders: 0,
        total_spent_paise: 0,
        last_interaction_at: daysBefore(1),
        first_seen_at: daysBefore(30),
        conversation_count: 1,
      });

    const repository = { findRoutingSegments, findClientSnapshot } as unknown as ContactRepository;
    return {
      service: new SegmentRoutingService(repository),
      findRoutingSegments,
      findClientSnapshot,
    };
  }

  it('returns INHERIT without reading the contact when no segment routes', async () => {
    const { service, findClientSnapshot } = makeService();

    await expect(service.resolve('b1', 'cl1', NOW)).resolves.toEqual(NO_SEGMENT_ROUTING);
    // The point of the short-circuit: the tenant that has configured nothing —
    // which is every tenant until someone does — pays one indexed query that
    // returns no rows, and never touches `clients`.
    expect(findClientSnapshot).not.toHaveBeenCalled();
  });

  it('returns INHERIT for a message with no known contact', async () => {
    const { service, findRoutingSegments } = makeService();

    await expect(service.resolve('b1', null, NOW)).resolves.toEqual(NO_SEGMENT_ROUTING);
    expect(findRoutingSegments).not.toHaveBeenCalled();
  });

  it('returns the first matching segment in the order the repository supplies', async () => {
    // The repository orders by priority DESC, created_at ASC; the service must
    // not re-sort or it would silently disagree with what the API reports.
    const { service } = makeService({
      findRoutingSegments: jest.fn().mockResolvedValue([
        segment({ id: 'high', name: 'VIP', routing_priority: 10, filter: { tags: ['vip'] } }),
        segment({ id: 'low', name: 'Everyone', routing_priority: 0, filter: {} }),
      ]),
    });

    const decision = await service.resolve('b1', 'cl1', NOW);
    expect(decision.segmentId).toBe('high');
    expect(decision.segmentName).toBe('VIP');
    expect(decision.mode).toBe('HUMAN_ONLY');
  });

  it('skips a segment whose filter the contact does not satisfy', async () => {
    const { service } = makeService({
      findRoutingSegments: jest.fn().mockResolvedValue([
        segment({ id: 'wholesale', filter: { tags: ['wholesale'] } }),
        segment({ id: 'catch-all', name: 'Catch all', filter: {}, routing_mode: 'AI_ONLY' }),
      ]),
    });

    const decision = await service.resolve('b1', 'cl1', NOW);
    expect(decision.segmentId).toBe('catch-all');
    expect(decision.mode).toBe('AI_ONLY');
  });

  it('carries the matched segment thresholds and assignee through', async () => {
    const { service } = makeService({
      findRoutingSegments: jest.fn().mockResolvedValue([
        segment({
          routing_mode: 'AI_FIRST',
          auto_execute_threshold: 97,
          draft_review_threshold: 80,
          routing_assignee_id: 'tm-9',
        }),
      ]),
    });

    await expect(service.resolve('b1', 'cl1', NOW)).resolves.toMatchObject({
      mode: 'AI_FIRST',
      autoExecuteThreshold: 97,
      draftReviewThreshold: 80,
      assigneeId: 'tm-9',
    });
  });

  it('returns INHERIT when no routing segment matches', async () => {
    const { service } = makeService({
      findRoutingSegments: jest
        .fn()
        .mockResolvedValue([segment({ filter: { tags: ['nobody-has-this'] } })]),
    });

    await expect(service.resolve('b1', 'cl1', NOW)).resolves.toEqual(NO_SEGMENT_ROUTING);
  });

  it('returns INHERIT for a client that does not exist in this business', async () => {
    const { service } = makeService({
      findRoutingSegments: jest.fn().mockResolvedValue([segment()]),
      findClientSnapshot: jest.fn().mockResolvedValue(null),
    });

    await expect(service.resolve('b1', 'ghost', NOW)).resolves.toEqual(NO_SEGMENT_ROUTING);
  });

  describe('failure posture', () => {
    it('falls back to INHERIT when the segment list cannot be read', async () => {
      // Failing closed here would escalate every message on the platform to
      // protect a control that, for almost every tenant, was never configured.
      const { service, findClientSnapshot } = makeService({
        findRoutingSegments: jest.fn().mockRejectedValue(new Error('pg down')),
      });

      await expect(service.resolve('b1', 'cl1', NOW)).resolves.toEqual(NO_SEGMENT_ROUTING);
      expect(findClientSnapshot).not.toHaveBeenCalled();
    });

    it('escalates when a routing segment exists but membership cannot be determined', async () => {
      // Here we know a control exists and only that we cannot tell whether it
      // applies. "The AI does not answer these customers" is a safety rule, so
      // the unknown resolves to the safe side.
      const { service } = makeService({
        findRoutingSegments: jest.fn().mockResolvedValue([segment()]),
        findClientSnapshot: jest.fn().mockRejectedValue(new Error('pg down')),
      });

      const decision = await service.resolve('b1', 'cl1', NOW);
      expect(decision.mode).toBe('HUMAN_ONLY');
      expect(decision.segmentId).toBeNull();
    });
  });
});

// ─────────────────────────────────────────────
// Routing configuration validation
// ─────────────────────────────────────────────

describe('ContactService segment routing configuration', () => {
  function makeService(repoOverrides: Partial<Record<string, jest.Mock>> = {}) {
    const repository = {
      findSegmentByName: jest.fn().mockResolvedValue(null),
      findSegmentById: jest.fn().mockResolvedValue(segment()),
      createSegment: jest.fn().mockImplementation((_b, d) => segment({ name: d.name })),
      updateSegment: jest.fn().mockResolvedValue(segment()),
      countBySegmentFilter: jest.fn().mockResolvedValue(0),
      findById: jest.fn().mockResolvedValue({ id: 'cl1', tags: [] }),
      ...repoOverrides,
    } as unknown as ContactRepository;

    const routing = {
      resolve: jest.fn().mockResolvedValue(NO_SEGMENT_ROUTING),
    } as unknown as SegmentRoutingService;

    return {
      service: new ContactService(repository, { emit: jest.fn() } as unknown as EventEmitter2, routing),
      repository,
      routing,
    };
  }

  it('rejects bands that leave no review window', async () => {
    const { service } = makeService();

    await expect(
      service.createSegment('b1', {
        name: 'Inverted',
        filter: {},
        routing: { mode: 'AI_FIRST', autoExecuteThreshold: 60, draftReviewThreshold: 90 },
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('checks a partial update against the stored value, not against a default', async () => {
    // Lowering only autoExecute must be caught against the draftReview already
    // on the row — validating the payload alone would let it through.
    const { service } = makeService({
      findSegmentById: jest
        .fn()
        .mockResolvedValue(segment({ auto_execute_threshold: 95, draft_review_threshold: 85 })),
    });

    await expect(
      service.updateSegment('b1', 'seg-1', { routing: { autoExecuteThreshold: 70 } } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a partial update that keeps the pair ordered', async () => {
    const { service, repository } = makeService({
      findSegmentById: jest
        .fn()
        .mockResolvedValue(segment({ auto_execute_threshold: 95, draft_review_threshold: 85 })),
    });

    await service.updateSegment('b1', 'seg-1', { routing: { autoExecuteThreshold: 90 } } as never);
    expect(repository.updateSegment).toHaveBeenCalledWith('b1', 'seg-1', {
      name: undefined,
      description: undefined,
      filter: undefined,
      isActive: undefined,
      routing: { autoExecuteThreshold: 90 },
    });
  });

  it('leaves routing untouched when the payload omits it', async () => {
    const { service, repository } = makeService();

    await service.updateSegment('b1', 'seg-1', { name: 'Renamed' } as never);
    expect((repository.updateSegment as jest.Mock).mock.calls[0][2].routing).toBeUndefined();
  });

  it('reports the stored routing on the segment response', async () => {
    const { service } = makeService({
      findSegmentById: jest.fn().mockResolvedValue(
        segment({
          routing_mode: 'HUMAN_ONLY',
          routing_priority: 5,
          auto_execute_threshold: 99,
          routing_assignee_id: 'tm-1',
        }),
      ),
    });

    await expect(service.getSegment('b1', 'seg-1')).resolves.toMatchObject({
      routing: {
        mode: 'HUMAN_ONLY',
        priority: 5,
        autoExecuteThreshold: 99,
        draftReviewThreshold: null,
        assigneeId: 'tm-1',
      },
    });
  });

  it('resolves the routing in force for one contact', async () => {
    const { service, routing } = makeService();
    (routing.resolve as jest.Mock).mockResolvedValue({
      mode: 'HUMAN_ONLY',
      segmentId: 'seg-1',
      segmentName: 'VIP',
      autoExecuteThreshold: null,
      draftReviewThreshold: null,
      assigneeId: null,
    });

    await expect(service.resolveRouting('b1', 'cl1')).resolves.toEqual({
      clientId: 'cl1',
      mode: 'HUMAN_ONLY',
      segmentId: 'seg-1',
      segmentName: 'VIP',
      autoExecuteThreshold: null,
      draftReviewThreshold: null,
      assigneeId: null,
    });
  });
});
