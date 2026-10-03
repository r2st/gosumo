/**
 * Branch coverage for ClientIntelligenceService.
 *
 * `client-intelligence.spec.ts` covers the happy paths of each public method.
 * This file goes after the decision points those paths never reach: the scoring
 * ladders (every RFM and engagement bucket), the regex alternatives in fact
 * extraction, the backfill guards that only write a field when the client has
 * none, and the failure branches of the best-effort event handlers.
 *
 * The scoring ladders are asserted against exact scores rather than risk
 * levels. A level assertion passes for a whole band, so an off-by-one in a
 * bucket boundary survives it; the composite score does not.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException } from '@nestjs/common';
import { ChannelType } from '@gosumo/shared';
import type { MessageReceivedEvent, PaymentSuccessEvent } from '@gosumo/shared';
import { ClientIntelligenceService } from './client-intelligence.service';
import {
  ClientIntelligenceRepository,
  ClientWithContacts,
} from './client-intelligence.repository';
import {
  ListClientsQueryDto,
  ChurnRiskLevel,
  ClientSegment,
  TimelineEventType,
} from './dto';
import { Decimal } from '@prisma/client/runtime/library';
import { $Enums } from '@prisma/client';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const CHANNEL_ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';
const MESSAGE_ID = '55555555-5555-5555-5555-555555555555';
const EXTERNAL_ID = '+919876543210';

function makeClient(
  overrides: Partial<Record<string, unknown>> = {},
): ClientWithContacts {
  return {
    id: CLIENT_ID,
    business_id: BUSINESS_ID,
    name: 'Test Client',
    email: 'test@example.com',
    phone: '+919876543210',
    avatar_url: null,
    consumer_user_id: null,
    profile: {},
    opt_outs: {},
    tags: [],
    ltv_score: null,
    churn_risk: null,
    engagement_score: null,
    scores_updated_at: null,
    total_orders: 0,
    total_spent: new Decimal(0),
    last_interaction_at: null,
    first_seen_at: new Date('2026-01-01T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    deleted_at: null,
    channel_contacts: [],
    ...overrides,
  } as ClientWithContacts;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/** RFM payload with every field defaulted so a test states only what it varies. */
function rfm(
  overrides: Partial<{
    lastInteractionAt: Date | null;
    lastOrderAt: Date | null;
    orderCount: number;
    totalSpent: number;
    firstSeenAt: Date;
  }> = {},
) {
  return {
    lastInteractionAt: daysAgo(3),
    lastOrderAt: null,
    orderCount: 0,
    totalSpent: 0,
    firstSeenAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ClientIntelligenceService — branches', () => {
  let service: ClientIntelligenceService;
  let repository: jest.Mocked<ClientIntelligenceRepository>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepository = {
      findOrCreateClient: jest.fn(),
      getClientById: jest.fn(),
      getClientByExternalId: jest.fn(),
      updateClientProfile: jest.fn(),
      listClients: jest.fn(),
      mergeClients: jest.fn(),
      updateIntelligenceScores: jest.fn(),
      writeIntelligenceScores: jest.fn(),
      createChannelContact: jest.fn(),
      findChannelContact: jest.fn(),
      getClientOrderAggregates: jest.fn(),
      getClientRFMData: jest.fn(),
      getRFMDataFromClient: jest.fn(),
      getClientTimelineData: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClientIntelligenceService,
        { provide: ClientIntelligenceRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(ClientIntelligenceService);
    repository = module.get(ClientIntelligenceRepository);
    eventEmitter = module.get(EventEmitter2);
  });

  // ───────────────────────────────────────────────────────────────────
  // Lookups
  // ───────────────────────────────────────────────────────────────────

  describe('getClientProfile', () => {
    it('returns the mapped profile when the client exists', async () => {
      repository.getClientById.mockResolvedValue(makeClient({ total_orders: 3 }));

      const result = await service.getClientProfile(BUSINESS_ID, CLIENT_ID);

      expect(result.id).toBe(CLIENT_ID);
      expect(result.totalOrders).toBe(3);
      expect(repository.getClientById).toHaveBeenCalledWith(BUSINESS_ID, CLIENT_ID);
    });

    it('throws NotFoundException when the client is absent', async () => {
      repository.getClientById.mockResolvedValue(null);

      await expect(
        service.getClientProfile(BUSINESS_ID, CLIENT_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getClientByExternalId', () => {
    it('maps the client when the channel contact resolves', async () => {
      repository.getClientByExternalId.mockResolvedValue(makeClient());

      const result = await service.getClientByExternalId(
        BUSINESS_ID,
        EXTERNAL_ID,
        ChannelType.WHATSAPP,
      );

      expect(result?.id).toBe(CLIENT_ID);
    });

    it('returns null rather than throwing when nothing resolves', async () => {
      repository.getClientByExternalId.mockResolvedValue(null);

      const result = await service.getClientByExternalId(
        BUSINESS_ID,
        EXTERNAL_ID,
        ChannelType.SMS,
      );

      expect(result).toBeNull();
    });
  });

  describe('listClients', () => {
    function page(clients: ClientWithContacts[]) {
      return {
        data: clients,
        total: clients.length,
        page: 1,
        limit: 20,
        totalPages: 1,
      };
    }

    it('prefers `search` over the `q` alias when both are supplied', async () => {
      repository.listClients.mockResolvedValue(page([makeClient()]));

      const query = new ListClientsQueryDto();
      query.search = 'ravi';
      query.q = 'ignored';

      const result = await service.listClients(BUSINESS_ID, query);

      expect(repository.listClients).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ search: 'ravi' }),
      );
      expect(result.data).toHaveLength(1);
    });

    it('falls back to the `q` alias when `search` is absent', async () => {
      repository.listClients.mockResolvedValue(page([]));

      const query = new ListClientsQueryDto();
      query.q = 'priya';

      const result = await service.listClients(BUSINESS_ID, query);

      expect(repository.listClients).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ search: 'priya' }),
      );
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Fact extraction — one test per regex alternative
  // ───────────────────────────────────────────────────────────────────

  describe('extractAndStoreFacts', () => {
    beforeEach(() => {
      repository.getClientById.mockResolvedValue(
        makeClient({ name: null, email: null, phone: null }),
      );
      repository.updateClientProfile.mockResolvedValue(makeClient());
    });

    async function extract(text: string) {
      return service.extractAndStoreFacts(BUSINESS_ID, CLIENT_ID, MESSAGE_ID, text);
    }

    it('reads a name from the contracted "I\'m ..." form', async () => {
      const facts = await extract("I'm Ravi Kumar and I had a question");

      expect(facts).toContainEqual({
        factType: 'name',
        value: 'Ravi Kumar',
        confidence: 0.8,
      });
    });

    it('reads a name from the "call me ..." form', async () => {
      const facts = await extract('Please call me Priya');

      expect(facts).toContainEqual({
        factType: 'name',
        value: 'Priya',
        confidence: 0.8,
      });
    });

    it('stops at the first matching name pattern', async () => {
      // "my name is" wins; "call me" later in the same message is not a second fact.
      const facts = await extract('My name is Anita, but call me Ani');

      expect(facts.filter((f) => f.factType === 'name')).toEqual([
        { factType: 'name', value: 'Anita', confidence: 0.8 },
      ]);
    });

    it('reads a location', async () => {
      const facts = await extract('I live in Bangalore. Can you deliver?');

      expect(facts).toContainEqual({
        factType: 'location',
        value: 'Bangalore',
        confidence: 0.75,
      });
    });

    it('reads an Indian phone number and strips its separators', async () => {
      const facts = await extract('Reach me on +91 98765 43210 any time');

      expect(facts).toContainEqual({
        factType: 'phone',
        value: '+919876543210',
        confidence: 0.9,
      });
    });

    it('reads a stated preference', async () => {
      const facts = await extract('I prefer morning delivery. Thanks!');

      expect(facts).toContainEqual({
        factType: 'preference',
        value: 'morning delivery',
        confidence: 0.7,
      });
    });

    it('discards a preference longer than 100 characters', async () => {
      const rambling = `I want ${'x'.repeat(120)}`;

      const facts = await extract(rambling);

      expect(facts.some((f) => f.factType === 'preference')).toBe(false);
    });

    it('backfills name, email and phone only when the client has none', async () => {
      await extract("My name is Anita. Mail me at anita@example.com or 9876543210.");

      expect(repository.updateClientProfile).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        expect.objectContaining({
          name: 'Anita',
          email: 'anita@example.com',
          phone: '9876543210',
        }),
      );
    });

    it('leaves existing identity fields untouched', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({ name: 'Existing', email: 'old@example.com', phone: '+910000000000' }),
      );

      await extract("My name is Anita. Mail me at anita@example.com or 9876543210.");

      const [, , payload] = repository.updateClientProfile.mock.calls[0]!;
      expect(payload).not.toHaveProperty('name');
      expect(payload).not.toHaveProperty('email');
      expect(payload).not.toHaveProperty('phone');
    });

    it('appends to existing facts rather than replacing them', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({
          name: 'Existing',
          profile: {
            facts: [
              {
                factType: 'location',
                value: 'Pune',
                confidence: 0.75,
                messageId: 'older',
                extractedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        }),
      );

      await extract('My name is Anita');

      const [, , payload] = repository.updateClientProfile.mock.calls[0]!;
      const stored = (payload.profile as { facts: unknown[] }).facts;
      expect(stored).toHaveLength(2);
      expect(stored[0]).toMatchObject({ value: 'Pune' });
      expect(stored[1]).toMatchObject({ value: 'Anita', messageId: MESSAGE_ID });
    });

    it('emits one client.fact.extracted event per fact', async () => {
      await extract('My name is Anita. Mail me at anita@example.com');

      const emitted = eventEmitter.emit.mock.calls.filter(
        ([name]) => name === 'client.fact.extracted',
      );
      expect(emitted).toHaveLength(2);
      expect(emitted[0]![1]).toMatchObject({
        businessId: BUSINESS_ID,
        clientId: CLIENT_ID,
        factType: 'name',
      });
    });

    it('writes nothing when the text carries no facts', async () => {
      const facts = await extract('ok thanks');

      expect(facts).toEqual([]);
      expect(repository.getClientById).not.toHaveBeenCalled();
      expect(repository.updateClientProfile).not.toHaveBeenCalled();
    });

    it('skips the write when the client no longer exists', async () => {
      repository.getClientById.mockResolvedValue(null);

      const facts = await extract('My name is Anita');

      expect(facts).toHaveLength(1);
      expect(repository.updateClientProfile).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Sentiment
  // ───────────────────────────────────────────────────────────────────

  describe('recordSentiment', () => {
    it('is a no-op when the client is gone', async () => {
      repository.getClientById.mockResolvedValue(null);

      await expect(
        service.recordSentiment(BUSINESS_ID, CLIENT_ID, MESSAGE_ID, 0.5),
      ).resolves.toBeUndefined();

      expect(repository.updateClientProfile).not.toHaveBeenCalled();
    });

    it('trims the stored history to the last 100 entries', async () => {
      const history = Array.from({ length: 100 }, (_, i) => ({
        score: 0,
        messageId: `m${i}`,
        recordedAt: '2026-01-01T00:00:00.000Z',
      }));
      repository.getClientById.mockResolvedValue(
        makeClient({ profile: { sentimentHistory: history } }),
      );
      repository.updateClientProfile.mockResolvedValue(makeClient());

      await service.recordSentiment(BUSINESS_ID, CLIENT_ID, MESSAGE_ID, 0.9);

      const [, , payload] = repository.updateClientProfile.mock.calls[0]!;
      const stored = (payload.profile as { sentimentHistory: unknown[] })
        .sentimentHistory;
      expect(stored).toHaveLength(100);
      expect(stored[99]).toMatchObject({ messageId: MESSAGE_ID, score: 0.9 });
      // The oldest entry was dropped, not the newest.
      expect(stored[0]).toMatchObject({ messageId: 'm1' });
    });
  });

  describe('getClientSentimentTrend', () => {
    it('omits the average when nothing falls inside the window', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({
          profile: {
            sentimentHistory: [
              { score: 1, messageId: 'old', recordedAt: '2020-01-01T00:00:00.000Z' },
            ],
          },
        }),
      );

      const result = await service.getClientSentimentTrend(BUSINESS_ID, CLIENT_ID, 7);

      expect(result.entries).toEqual([]);
      expect(result.averageScore).toBeUndefined();
    });

    it('rounds the average to two decimal places', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({
          profile: {
            sentimentHistory: [
              { score: 0.1, messageId: 'a', recordedAt: new Date().toISOString() },
              { score: 0.2, messageId: 'b', recordedAt: new Date().toISOString() },
              { score: 0.5, messageId: 'c', recordedAt: new Date().toISOString() },
            ],
          },
        }),
      );

      const result = await service.getClientSentimentTrend(BUSINESS_ID, CLIENT_ID, 30);

      expect(result.entries).toHaveLength(3);
      expect(result.averageScore).toBe(0.27);
    });

    it('throws NotFoundException for an unknown client', async () => {
      repository.getClientById.mockResolvedValue(null);

      await expect(
        service.getClientSentimentTrend(BUSINESS_ID, CLIENT_ID, 7),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Churn scoring ladders
  // ───────────────────────────────────────────────────────────────────

  describe('getChurnScore — RFM ladders', () => {
    async function score(overrides: Parameters<typeof rfm>[0]): Promise<number> {
      repository.getClientRFMData.mockResolvedValue(rfm(overrides));
      const result = await service.getChurnScore(BUSINESS_ID, CLIENT_ID);
      return result.score;
    }

    // Composite = recency*0.5 + frequency*0.3 + monetary*0.2.
    // Holding two axes flat isolates the third's bucket boundaries.

    it.each([
      ['within a week', 3, 38],
      ['within a fortnight', 10, 46],
      ['within a month', 20, 53],
      ['within two months', 45, 63],
      ['within three months', 75, 73],
      ['beyond three months', 120, 83],
    ])('scores recency %s (%i days) as %i', async (_label, days, expected) => {
      expect(await score({ lastInteractionAt: daysAgo(days) })).toBe(expected);
    });

    it.each([
      ['ten or more orders', 12, 14],
      ['five to nine orders', 7, 19],
      ['three or four orders', 4, 23],
      ['one or two orders', 2, 29],
      ['no orders', 0, 38],
    ])('scores frequency with %s as %i', async (_label, orderCount, expected) => {
      expect(await score({ orderCount })).toBe(expected);
    });

    it.each([
      ['₹50k or more', 60000, 0],
      ['₹10k–50k', 20000, 3],
      ['₹5k–10k', 7000, 6],
      ['₹1k–5k', 2000, 10],
      ['under ₹1k', 100, 14],
    ])('scores spend of %s as %i', async (_label, totalSpent, expected) => {
      expect(await score({ orderCount: 12, totalSpent })).toBe(expected);
    });

    it('falls back to the last order date when there is no interaction', async () => {
      expect(
        await score({ lastInteractionAt: null, lastOrderAt: daysAgo(120) }),
      ).toBe(83);
    });

    it('falls back to first-seen when there is neither', async () => {
      expect(
        await score({
          lastInteractionAt: null,
          lastOrderAt: null,
          firstSeenAt: daysAgo(3),
        }),
      ).toBe(38);
    });

    it.each([
      [0, ChurnRiskLevel.LOW],
      [28, ChurnRiskLevel.LOW],
      [46, ChurnRiskLevel.MEDIUM],
      [73, ChurnRiskLevel.HIGH],
      [83, ChurnRiskLevel.CRITICAL],
    ])('maps score %i to %s', async (expectedScore, expectedLevel) => {
      // Reach each band through the ladders rather than by stubbing the score.
      const byScore: Record<number, Parameters<typeof rfm>[0]> = {
        0: { orderCount: 12, totalSpent: 60000 },
        28: { orderCount: 12, totalSpent: 20000, lastInteractionAt: daysAgo(45) },
        46: { lastInteractionAt: daysAgo(10) },
        73: { lastInteractionAt: daysAgo(75) },
        83: { lastInteractionAt: daysAgo(120) },
      };
      repository.getClientRFMData.mockResolvedValue(rfm(byScore[expectedScore]));

      const result = await service.getChurnScore(BUSINESS_ID, CLIENT_ID);

      expect(result.score).toBe(expectedScore);
      expect(result.riskLevel).toBe(expectedLevel);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Score refresh + engagement ladder
  // ───────────────────────────────────────────────────────────────────

  describe('refreshIntelligenceScores', () => {
    beforeEach(() => {
      repository.getClientOrderAggregates.mockResolvedValue({
        totalRevenue: 0,
        orderCount: 0,
      });
      repository.writeIntelligenceScores.mockResolvedValue(makeClient());
    });

    it('returns without writing when the client is gone', async () => {
      repository.getClientById.mockResolvedValue(null);

      await service.refreshIntelligenceScores(BUSINESS_ID, CLIENT_ID);

      expect(repository.writeIntelligenceScores).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('does not emit a churn event when there is no previous level', async () => {
      // churn_risk null → first ever scoring, so no boundary was crossed.
      repository.getClientById.mockResolvedValue(makeClient({ churn_risk: null }));
      repository.getRFMDataFromClient.mockResolvedValue(
        rfm({ lastInteractionAt: daysAgo(120) }),
      );

      await service.refreshIntelligenceScores(BUSINESS_ID, CLIENT_ID);

      expect(repository.writeIntelligenceScores).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        expect.objectContaining({ churnRisk: 0.83 }),
      );
      expect(
        eventEmitter.emit.mock.calls.filter(([n]) => n === 'client.churn.risk'),
      ).toHaveLength(0);
    });

    it('stores churn and engagement on a 0–1 scale and LTV in rupees', async () => {
      repository.getClientById.mockResolvedValue(makeClient({ churn_risk: null }));
      repository.getRFMDataFromClient.mockResolvedValue(
        rfm({ lastInteractionAt: daysAgo(3), orderCount: 12 }),
      );
      repository.getClientOrderAggregates.mockResolvedValue({
        totalRevenue: 4200,
        orderCount: 12,
      });

      await service.refreshIntelligenceScores(BUSINESS_ID, CLIENT_ID);

      expect(repository.writeIntelligenceScores).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        { churnRisk: 0.14, ltvScore: 4200, engagementScore: 0.9 },
      );
    });

    it.each([
      ['same day', 0, 12, 1],
      ['within a week', 3, 12, 0.9],
      ['within a fortnight', 10, 12, 0.8],
      ['within a month', 20, 12, 0.7],
      ['within two months', 45, 12, 0.6],
      ['beyond two months', 120, 12, 0.5],
    ])(
      'scores engagement recency %s as %f',
      async (_label, days, orderCount, expected) => {
        repository.getClientById.mockResolvedValue(makeClient());
        repository.getRFMDataFromClient.mockResolvedValue(
          rfm({ lastInteractionAt: daysAgo(days), orderCount }),
        );

        await service.refreshIntelligenceScores(BUSINESS_ID, CLIENT_ID);

        expect(repository.writeIntelligenceScores).toHaveBeenCalledWith(
          BUSINESS_ID,
          CLIENT_ID,
          expect.objectContaining({ engagementScore: expected }),
        );
      },
    );

    it.each([
      ['ten or more orders', 12, 0.9],
      ['five to nine orders', 7, 0.8],
      ['three or four orders', 4, 0.7],
      ['one or two orders', 2, 0.6],
      ['no orders', 0, 0.45],
    ])('scores engagement frequency with %s as %f', async (_label, orderCount, expected) => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getRFMDataFromClient.mockResolvedValue(
        rfm({ lastInteractionAt: daysAgo(3), orderCount }),
      );

      await service.refreshIntelligenceScores(BUSINESS_ID, CLIENT_ID);

      expect(repository.writeIntelligenceScores).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        expect.objectContaining({ engagementScore: expected }),
      );
    });

    it('uses first-seen for engagement when the client never interacted', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getRFMDataFromClient.mockResolvedValue(
        rfm({ lastInteractionAt: null, orderCount: 12, firstSeenAt: daysAgo(120) }),
      );

      await service.refreshIntelligenceScores(BUSINESS_ID, CLIENT_ID);

      expect(repository.writeIntelligenceScores).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        expect.objectContaining({ engagementScore: 0.5 }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // AI summary
  // ───────────────────────────────────────────────────────────────────

  describe('getClientSummaryForAI', () => {
    it('returns an empty summary for a blank profile', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({ name: null, churn_risk: null, total_orders: 0, profile: {} }),
      );

      const result = await service.getClientSummaryForAI(BUSINESS_ID, CLIENT_ID);

      expect(result).toEqual({ clientId: CLIENT_ID, summary: '' });
    });

    it('includes the churn level when a score is stored', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({ name: null, churn_risk: new Decimal(0.85) }),
      );

      const result = await service.getClientSummaryForAI(BUSINESS_ID, CLIENT_ID);

      expect(result.summary).toContain(`Churn: ${ChurnRiskLevel.CRITICAL}`);
    });

    it.each([
      ['positive', [0.8, 0.6]],
      ['neutral', [0.1, -0.1]],
      ['negative', [-0.8, -0.6]],
    ])('labels recent mood as %s', async (label, scores) => {
      repository.getClientById.mockResolvedValue(
        makeClient({
          name: null,
          profile: {
            sentimentHistory: scores.map((score, i) => ({
              score,
              messageId: `m${i}`,
              recordedAt: '2026-01-01T00:00:00.000Z',
            })),
          },
        }),
      );

      const result = await service.getClientSummaryForAI(BUSINESS_ID, CLIENT_ID);

      expect(result.summary).toContain(`Mood: ${label}`);
    });

    it('averages only the five most recent sentiment entries', async () => {
      // Ten strongly negative entries followed by five positive ones: a mood of
      // "positive" proves the window, an "negative" would prove it is ignored.
      const history = [
        ...Array.from({ length: 10 }, (_, i) => ({
          score: -1,
          messageId: `old${i}`,
          recordedAt: '2026-01-01T00:00:00.000Z',
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          score: 1,
          messageId: `new${i}`,
          recordedAt: '2026-02-01T00:00:00.000Z',
        })),
      ];
      repository.getClientById.mockResolvedValue(
        makeClient({ name: null, profile: { sentimentHistory: history } }),
      );

      const result = await service.getClientSummaryForAI(BUSINESS_ID, CLIENT_ID);

      expect(result.summary).toContain('Mood: positive');
    });

    it('includes the order count only when the client has ordered', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({ name: null, total_orders: 4 }),
      );

      const result = await service.getClientSummaryForAI(BUSINESS_ID, CLIENT_ID);

      expect(result.summary).toContain('Orders: 4');
    });

    it('keeps the most recently extracted fact of each type', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({
          name: null,
          profile: {
            facts: [
              {
                factType: 'location',
                value: 'Pune',
                confidence: 0.9,
                messageId: 'a',
                extractedAt: '2026-01-01T00:00:00.000Z',
              },
              {
                factType: 'location',
                value: 'Mumbai',
                confidence: 0.9,
                messageId: 'b',
                extractedAt: '2026-06-01T00:00:00.000Z',
              },
            ],
          },
        }),
      );

      const result = await service.getClientSummaryForAI(BUSINESS_ID, CLIENT_ID);

      expect(result.summary).toContain('location: Mumbai');
      expect(result.summary).not.toContain('Pune');
    });

    it('does not repeat the name as a fact line', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({
          name: 'Anita',
          profile: {
            facts: [
              {
                factType: 'name',
                value: 'Anita',
                confidence: 0.8,
                messageId: 'a',
                extractedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        }),
      );

      const result = await service.getClientSummaryForAI(BUSINESS_ID, CLIENT_ID);

      expect(result.summary).toBe('Name: Anita');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Segmentation — the two precedence rungs the base suite skips
  // ───────────────────────────────────────────────────────────────────

  describe('getClientSegment', () => {
    it('classifies a 60–180 day gap with no orders as DORMANT', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getRFMDataFromClient.mockResolvedValue(
        rfm({ lastInteractionAt: daysAgo(90), orderCount: 0 }),
      );

      const result = await service.getClientSegment(BUSINESS_ID, CLIENT_ID);

      expect(result.segment).toBe(ClientSegment.DORMANT);
      expect(result.reason).toContain('60–180');
    });

    it('classifies an established low-churn customer as ACTIVE', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getRFMDataFromClient.mockResolvedValue(
        rfm({
          lastInteractionAt: daysAgo(2),
          orderCount: 4,
          totalSpent: 20000,
          firstSeenAt: daysAgo(400),
        }),
      );

      const result = await service.getClientSegment(BUSINESS_ID, CLIENT_ID);

      expect(result.segment).toBe(ClientSegment.ACTIVE);
      expect(result.reason).toContain('4 order(s)');
    });

    it('treats high spend alone as VIP even without ten orders', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getRFMDataFromClient.mockResolvedValue(
        rfm({ lastInteractionAt: daysAgo(2), orderCount: 2, totalSpent: 90000 }),
      );

      const result = await service.getClientSegment(BUSINESS_ID, CLIENT_ID);

      expect(result.segment).toBe(ClientSegment.VIP);
    });

    it('does not call a dormant high-value client VIP', async () => {
      // ≥₹50k spent but 90 days silent — VIP requires activity within 60 days.
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getRFMDataFromClient.mockResolvedValue(
        rfm({ lastInteractionAt: daysAgo(90), orderCount: 12, totalSpent: 90000 }),
      );

      const result = await service.getClientSegment(BUSINESS_ID, CLIENT_ID);

      expect(result.segment).not.toBe(ClientSegment.VIP);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Timeline fallbacks
  // ───────────────────────────────────────────────────────────────────

  describe('getClientTimeline', () => {
    it('falls back to derived titles and created_at timestamps', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getClientTimelineData.mockResolvedValue({
        conversations: [
          {
            id: 'conv-1',
            channel: $Enums.ChannelType.INSTAGRAM,
            status: $Enums.ConversationStatus.OPEN,
            subject: null,
            created_at: new Date('2026-03-01T10:00:00Z'),
            last_message_at: null,
          },
        ],
        orders: [],
        bookings: [],
        payments: [
          {
            id: 'pay-1',
            status: $Enums.PaymentStatus.PENDING,
            amount: new Decimal(250.5),
            method: null,
            created_at: new Date('2026-02-01T10:00:00Z'),
          },
        ],
      });

      const result = await service.getClientTimeline(BUSINESS_ID, CLIENT_ID);

      const conversation = result.events.find(
        (e) => e.type === TimelineEventType.CONVERSATION,
      );
      const payment = result.events.find((e) => e.type === TimelineEventType.PAYMENT);

      expect(conversation?.title).toBe('Conversation on INSTAGRAM');
      expect(conversation?.timestamp).toBe('2026-03-01T10:00:00.000Z');
      expect(payment?.title).toBe('Payment');
      expect(payment?.amountPaise).toBe(25050);
    });

    it('defaults the limit to 50', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getClientTimelineData.mockResolvedValue({
        conversations: [],
        orders: [],
        bookings: [],
        payments: [],
      });

      await service.getClientTimeline(BUSINESS_ID, CLIENT_ID);

      expect(repository.getClientTimelineData).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        50,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Event handlers — every one is best-effort and must swallow failures
  // ───────────────────────────────────────────────────────────────────

  describe('event handlers', () => {
    function messageEvent(
      overrides: Partial<MessageReceivedEvent> = {},
    ): MessageReceivedEvent {
      return {
        id: 'evt1',
        type: 'message.received',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr1',
        messageId: MESSAGE_ID,
        conversationId: 'conv1',
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
        senderExternalId: EXTERNAL_ID,
        clientId: CLIENT_ID,
        ...overrides,
      } as MessageReceivedEvent;
    }

    it('skips message.received with no messageId', async () => {
      await service.handleMessageReceived(messageEvent({ messageId: '' }));

      expect(repository.updateClientProfile).not.toHaveBeenCalled();
    });

    it('swallows a repository failure on message.received', async () => {
      repository.updateClientProfile.mockRejectedValue(new Error('db down'));

      await expect(
        service.handleMessageReceived(messageEvent()),
      ).resolves.toBeUndefined();
    });

    it('swallows a non-Error rejection on message.received', async () => {
      repository.updateClientProfile.mockRejectedValue('string failure');

      await expect(
        service.handleMessageReceived(messageEvent()),
      ).resolves.toBeUndefined();
    });

    it('refreshes scores on order.delivered', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getRFMDataFromClient.mockResolvedValue(rfm());
      repository.getClientOrderAggregates.mockResolvedValue({
        totalRevenue: 100,
        orderCount: 1,
      });
      repository.writeIntelligenceScores.mockResolvedValue(makeClient());

      await service.handleOrderDelivered({
        businessId: BUSINESS_ID,
        clientId: CLIENT_ID,
        orderId: 'order-1',
      });

      expect(repository.writeIntelligenceScores).toHaveBeenCalled();
    });

    it('swallows a failure on order.delivered', async () => {
      repository.getClientById.mockRejectedValue(new Error('db down'));

      await expect(
        service.handleOrderDelivered({
          businessId: BUSINESS_ID,
          clientId: CLIENT_ID,
          orderId: 'order-1',
        }),
      ).resolves.toBeUndefined();
    });

    it('refreshes scores on payment.success', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getRFMDataFromClient.mockResolvedValue(rfm());
      repository.getClientOrderAggregates.mockResolvedValue({
        totalRevenue: 100,
        orderCount: 1,
      });
      repository.writeIntelligenceScores.mockResolvedValue(makeClient());

      await service.handlePaymentSuccess({
        businessId: BUSINESS_ID,
        clientId: CLIENT_ID,
      } as PaymentSuccessEvent);

      expect(repository.writeIntelligenceScores).toHaveBeenCalled();
    });

    it('swallows a failure on payment.success', async () => {
      repository.getClientById.mockRejectedValue('string failure');

      await expect(
        service.handlePaymentSuccess({
          businessId: BUSINESS_ID,
          clientId: CLIENT_ID,
        } as PaymentSuccessEvent),
      ).resolves.toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // DTO mapping
  // ───────────────────────────────────────────────────────────────────

  describe('profile mapping', () => {
    it('unwraps the Decimal score columns', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({
          ltv_score: new Decimal(1234.5),
          churn_risk: new Decimal(0.42),
          engagement_score: new Decimal(0.75),
          total_spent: new Decimal(9999.99),
        }),
      );

      const result = await service.getClientProfile(BUSINESS_ID, CLIENT_ID);

      expect(result.ltvScore).toBe(1234.5);
      expect(result.churnRisk).toBe(0.42);
      expect(result.engagementScore).toBe(0.75);
      expect(result.totalSpent).toBe(9999.99);
    });

    it('maps channel contacts when the relation is loaded', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({
          channel_contacts: [
            {
              id: 'cc-1',
              channel: $Enums.ChannelType.WHATSAPP,
              external_id: EXTERNAL_ID,
              display_name: 'Anita',
              profile_pic_url: null,
              is_opted_in: true,
              first_seen_at: new Date('2026-01-01T00:00:00Z'),
              last_seen_at: new Date('2026-02-01T00:00:00Z'),
            },
          ],
        }),
      );

      const result = await service.getClientProfile(BUSINESS_ID, CLIENT_ID);

      expect(result.channelContacts).toEqual([
        {
          id: 'cc-1',
          channel: ChannelType.WHATSAPP,
          externalId: EXTERNAL_ID,
          displayName: 'Anita',
          profilePicUrl: null,
          isOptedIn: true,
          firstSeenAt: new Date('2026-01-01T00:00:00Z'),
          lastSeenAt: new Date('2026-02-01T00:00:00Z'),
        },
      ]);
    });

    it('leaves channel contacts unset when the relation was not selected', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({ channel_contacts: undefined }),
      );

      const result = await service.getClientProfile(BUSINESS_ID, CLIENT_ID);

      expect(result.channelContacts).toBeUndefined();
    });

    it('defaults absent profile and opt-out blobs to empty objects', async () => {
      repository.getClientById.mockResolvedValue(
        makeClient({ profile: null, opt_outs: null }),
      );

      const result = await service.getClientProfile(BUSINESS_ID, CLIENT_ID);

      expect(result.profile).toEqual({});
      expect(result.optOuts).toEqual({});
    });
  });
  // ───────────────────────────────────────────────────────────────────
  // Null profile blobs — every reader defaults them
  // ───────────────────────────────────────────────────────────────────

  /**
   * `profile` is nullable JSONB and starts null on a freshly-created client.
   * Every reader has to default it before indexing, or the first message from a
   * brand-new customer throws on a property read of null.
   */
  describe('a client whose profile blob is still null', () => {
    beforeEach(() => {
      repository.getClientById.mockResolvedValue(makeClient({ profile: null }));
      repository.updateClientProfile.mockResolvedValue(makeClient());
    });

    it('stores the first extracted fact', async () => {
      await service.extractAndStoreFacts(
        BUSINESS_ID,
        CLIENT_ID,
        MESSAGE_ID,
        'my email is asha@example.com',
      );

      const patch = repository.updateClientProfile.mock.calls[0]![2] as {
        profile: { facts: unknown[] };
      };
      expect(patch.profile.facts).toHaveLength(1);
    });

    it('records the first sentiment reading', async () => {
      await service.recordSentiment(BUSINESS_ID, CLIENT_ID, MESSAGE_ID, 0.5);

      const patch = repository.updateClientProfile.mock.calls[0]![2] as {
        profile: { sentimentHistory: unknown[] };
      };
      expect(patch.profile.sentimentHistory).toHaveLength(1);
    });

    it('reports an empty sentiment trend', async () => {
      const trend = await service.getClientSentimentTrend(BUSINESS_ID, CLIENT_ID, 30);
      expect(trend.entries).toEqual([]);
    });

    it('builds an AI summary with no stored facts or sentiment', async () => {
      const { summary } = await service.getClientSummaryForAI(BUSINESS_ID, CLIENT_ID);
      expect(typeof summary).toBe('string');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Change tracking on a profile update
  // ───────────────────────────────────────────────────────────────────

  /**
   * The emitted event names which fields moved. Downstream listeners act on
   * that list, so a field that updates without being named is a silent change.
   */
  describe('updateClientProfile change tracking', () => {
    beforeEach(() => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.updateClientProfile.mockResolvedValue(makeClient());
    });

    function changedFields(): string[] {
      const call = eventEmitter.emit.mock.calls.find(
        (c) => c[0] === 'client.profile.updated',
      );
      return (call?.[1] as { changedFields: string[] }).changedFields;
    }

    it.each([
      ['name', { name: 'Asha' }],
      ['email', { email: 'asha@example.com' }],
      ['phone', { phone: '+919812345678' }],
      ['avatarUrl', { avatarUrl: 'https://cdn.example/a.png' }],
      ['profile', { profile: { vip: true } }],
    ])('names %s when only that field is supplied', async (field, dto) => {
      await service.updateClientProfile(BUSINESS_ID, CLIENT_ID, dto);
      expect(changedFields()).toEqual([field]);
    });

    it('names every field when the whole profile is replaced', async () => {
      await service.updateClientProfile(BUSINESS_ID, CLIENT_ID, {
        name: 'Asha',
        email: 'asha@example.com',
        phone: '+919812345678',
        avatarUrl: 'https://cdn.example/a.png',
        profile: { vip: true },
      });

      expect(changedFields()).toEqual([
        'name',
        'email',
        'phone',
        'avatarUrl',
        'profile',
      ]);
    });

    /** A no-op patch must not announce a change nobody made. */
    it('emits nothing for an empty patch', async () => {
      await service.updateClientProfile(BUSINESS_ID, CLIENT_ID, {});

      expect(
        eventEmitter.emit.mock.calls.some((c) => c[0] === 'client.profile.updated'),
      ).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // AI summary length cap
  // ───────────────────────────────────────────────────────────────────

  /**
   * The summary is injected into the AI prompt, so it is capped at 300 chars.
   * A client with a long fact list is the case that actually reaches the cap.
   */
  it('truncates an over-long AI summary to 300 characters', async () => {
    const facts = Array.from({ length: 40 }, (_, i) => ({
      factType: `preference_${i}`,
      value: `a fairly long stored preference value number ${i}`,
      confidence: 0.9,
      extractedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      messageId: MESSAGE_ID,
    }));
    repository.getClientById.mockResolvedValue(
      makeClient({ profile: { facts } }),
    );

    const { summary } = await service.getClientSummaryForAI(BUSINESS_ID, CLIENT_ID);

    expect(summary).toHaveLength(300);
    expect(summary.endsWith('...')).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────
  // Last-activity fallback chain
  // ───────────────────────────────────────────────────────────────────

  /**
   * Recency drives both the churn score and the segment. It falls back
   * interaction → order → first seen, so a client who has ordered but never
   * messaged is dated from the order, and one who has done neither from signup
   * rather than from "now" (which would read as perfectly recent).
   */
  describe('recency falls back through the activity chain', () => {
    beforeEach(() => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.writeIntelligenceScores.mockResolvedValue(makeClient());
      repository.getClientOrderAggregates.mockResolvedValue({
        totalRevenue: 0,
        orderCount: 0,
      });
    });

    /** The churn score the refresh actually persisted, as a 0–1 fraction. */
    function churnRiskWritten(): number {
      const patch = repository.writeIntelligenceScores.mock.calls[0]![2] as {
        churnRisk: number;
      };
      return patch.churnRisk;
    }

    it('dates a never-messaged client from its last order', async () => {
      repository.getRFMDataFromClient.mockResolvedValue(
        rfm({ lastInteractionAt: null, lastOrderAt: daysAgo(400) }),
      );

      await service.refreshIntelligenceScores(BUSINESS_ID, CLIENT_ID);
      expect(churnRiskWritten()).toBeGreaterThanOrEqual(0.8);
    });

    it('dates a client with no activity at all from first seen', async () => {
      repository.getRFMDataFromClient.mockResolvedValue(
        rfm({
          lastInteractionAt: null,
          lastOrderAt: null,
          firstSeenAt: daysAgo(400),
        }),
      );

      await service.refreshIntelligenceScores(BUSINESS_ID, CLIENT_ID);
      expect(churnRiskWritten()).toBeGreaterThanOrEqual(0.8);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Non-Error rejections in the best-effort paths
  // ───────────────────────────────────────────────────────────────────

  /**
   * A driver-level reject is not always an Error instance. Each of these paths
   * formats the failure into a log line, so a non-Error must stringify rather
   * than read `.message` off it and log "undefined".
   */
  describe('non-Error rejections', () => {
    /**
     * Extraction is pure and already done by the time storage is attempted, so a
     * storage failure still returns what was lifted — the caller gets the facts
     * even though they did not land on the profile.
     */
    it('still returns the extracted facts when storing them fails', async () => {
      repository.getClientById.mockRejectedValue('connection reset');

      await expect(
        service.extractAndStoreFacts(
          BUSINESS_ID,
          CLIENT_ID,
          MESSAGE_ID,
          'my email is a@b.com',
        ),
      ).resolves.toEqual([expect.objectContaining({ factType: 'email' })]);
    });

    it('swallows a non-Error during sentiment recording', async () => {
      repository.getClientById.mockRejectedValue('connection reset');

      await expect(
        service.recordSentiment(BUSINESS_ID, CLIENT_ID, MESSAGE_ID, 0.5),
      ).resolves.toBeUndefined();
    });

    it('swallows a non-Error on order.delivered', async () => {
      repository.getClientById.mockRejectedValue('connection reset');

      await expect(
        service.handleOrderDelivered({
          businessId: BUSINESS_ID,
          clientId: CLIENT_ID,
          orderId: 'order-1',
        }),
      ).resolves.toBeUndefined();
    });

    it('swallows a non-Error on payment.success', async () => {
      repository.getClientById.mockRejectedValue('connection reset');

      await expect(
        service.handlePaymentSuccess({
          businessId: BUSINESS_ID,
          clientId: CLIENT_ID,
        } as PaymentSuccessEvent),
      ).resolves.toBeUndefined();
    });
  });
});
