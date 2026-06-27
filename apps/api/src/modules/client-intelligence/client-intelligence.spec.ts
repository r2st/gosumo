import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ChannelType } from '@gosumo/shared';
import { ClientIntelligenceService } from './client-intelligence.service';
import { ClientIntelligenceRepository, ClientWithContacts } from './client-intelligence.repository';
import {
  FindOrCreateClientDto,
  UpdateClientProfileDto,
  ChurnRiskLevel,
  ClientSegment,
  TimelineEventType,
} from './dto';
import { Decimal } from '@prisma/client/runtime/library';
import { $Enums } from '@prisma/client';

// ─────────────────────────────────────────────
// Test constants
// ─────────────────────────────────────────────

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const SECONDARY_CLIENT_ID = '33333333-3333-3333-3333-333333333333';
const CHANNEL_ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';
const MESSAGE_ID = '55555555-5555-5555-5555-555555555555';
const EXTERNAL_ID = '+919876543210';

// ─────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────

function makeClient(overrides: Partial<Record<string, unknown>> = {}): ClientWithContacts {
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

function makeDto(overrides: Partial<FindOrCreateClientDto> = {}): FindOrCreateClientDto {
  const dto = new FindOrCreateClientDto();
  dto.externalId = EXTERNAL_ID;
  dto.channelType = ChannelType.WHATSAPP;
  dto.channelAccountId = CHANNEL_ACCOUNT_ID;
  dto.name = 'Test Client';
  return Object.assign(dto, overrides);
}

// ─────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────

describe('ClientIntelligenceService', () => {
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
      createChannelContact: jest.fn(),
      findChannelContact: jest.fn(),
      getClientOrderAggregates: jest.fn(),
      getClientRFMData: jest.fn(),
      getClientTimelineData: jest.fn(),
    };

    const mockEventEmitter = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClientIntelligenceService,
        { provide: ClientIntelligenceRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<ClientIntelligenceService>(ClientIntelligenceService);
    repository = module.get(ClientIntelligenceRepository);
    eventEmitter = module.get(EventEmitter2);
  });

  // ───────────────────────────────────────────────────────────────────
  // findOrCreateClient
  // ───────────────────────────────────────────────────────────────────

  describe('findOrCreateClient', () => {
    it('should create a new client when none exists', async () => {
      const client = makeClient();
      repository.findOrCreateClient.mockResolvedValue(client);

      const result = await service.findOrCreateClient(BUSINESS_ID, makeDto());

      expect(result.id).toBe(CLIENT_ID);
      expect(result.name).toBe('Test Client');
      expect(repository.findOrCreateClient).toHaveBeenCalledWith(
        BUSINESS_ID,
        EXTERNAL_ID,
        ChannelType.WHATSAPP,
        CHANNEL_ACCOUNT_ID,
        { name: 'Test Client', phone: undefined, email: undefined },
      );
    });

    it('should return existing client if already exists', async () => {
      const existingClient = makeClient({ total_orders: 5 });
      repository.findOrCreateClient.mockResolvedValue(existingClient);

      const result = await service.findOrCreateClient(BUSINESS_ID, makeDto());

      expect(result.id).toBe(CLIENT_ID);
      expect(result.totalOrders).toBe(5);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // updateClientProfile
  // ───────────────────────────────────────────────────────────────────

  describe('updateClientProfile', () => {
    it('should update profile and emit event', async () => {
      const client = makeClient();
      const updatedClient = makeClient({ name: 'Updated Name' });
      repository.getClientById.mockResolvedValue(client);
      repository.updateClientProfile.mockResolvedValue(updatedClient);

      const dto = new UpdateClientProfileDto();
      dto.name = 'Updated Name';

      const result = await service.updateClientProfile(BUSINESS_ID, CLIENT_ID, dto);

      expect(result.name).toBe('Updated Name');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'client.profile.updated',
        expect.objectContaining({
          type: 'client.profile.updated',
          businessId: BUSINESS_ID,
          clientId: CLIENT_ID,
          changedFields: ['name'],
          updatedBy: 'HUMAN',
        }),
      );
    });

    it('should throw NotFoundException for unknown client', async () => {
      repository.getClientById.mockResolvedValue(null);

      const dto = new UpdateClientProfileDto();
      dto.name = 'Updated Name';

      await expect(
        service.updateClientProfile(BUSINESS_ID, CLIENT_ID, dto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // mergeClients
  // ───────────────────────────────────────────────────────────────────

  describe('mergeClients', () => {
    it('should merge clients and emit event', async () => {
      const mergedClient = makeClient({
        total_orders: 10,
        total_spent: new Decimal(50000),
      });
      repository.mergeClients.mockResolvedValue(mergedClient);

      const result = await service.mergeClients(
        BUSINESS_ID,
        CLIENT_ID,
        SECONDARY_CLIENT_ID,
      );

      expect(result.totalOrders).toBe(10);
      expect(repository.mergeClients).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        SECONDARY_CLIENT_ID,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'client.profile.updated',
        expect.objectContaining({
          clientId: CLIENT_ID,
          changedFields: ['merged'],
          updatedBy: 'SYSTEM',
        }),
      );
    });

    it('should throw BadRequestException when merging same client', async () => {
      await expect(
        service.mergeClients(BUSINESS_ID, CLIENT_ID, CLIENT_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // getChurnScore
  // ───────────────────────────────────────────────────────────────────

  describe('getChurnScore', () => {
    it('should calculate LOW churn for active client with many orders', async () => {
      repository.getClientRFMData.mockResolvedValue({
        lastInteractionAt: new Date(), // today
        lastOrderAt: new Date(),
        orderCount: 15,
        totalSpent: 100000,
        firstSeenAt: new Date('2025-01-01T00:00:00Z'),
      });

      const result = await service.getChurnScore(BUSINESS_ID, CLIENT_ID);

      expect(result.riskLevel).toBe(ChurnRiskLevel.LOW);
      expect(result.score).toBeLessThanOrEqual(30);
    });

    it('should calculate HIGH churn for inactive client with few orders', async () => {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 91);

      repository.getClientRFMData.mockResolvedValue({
        lastInteractionAt: ninetyDaysAgo,
        lastOrderAt: ninetyDaysAgo,
        orderCount: 0,
        totalSpent: 0,
        firstSeenAt: new Date('2025-01-01T00:00:00Z'),
      });

      const result = await service.getChurnScore(BUSINESS_ID, CLIENT_ID);

      expect(result.riskLevel).toBe(ChurnRiskLevel.CRITICAL);
      expect(result.score).toBeGreaterThanOrEqual(81);
    });

    it('should calculate MEDIUM churn for moderately active client', async () => {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 35);

      repository.getClientRFMData.mockResolvedValue({
        lastInteractionAt: thirtyDaysAgo,
        lastOrderAt: thirtyDaysAgo,
        orderCount: 2,
        totalSpent: 3000,
        firstSeenAt: new Date('2025-06-01T00:00:00Z'),
      });

      const result = await service.getChurnScore(BUSINESS_ID, CLIENT_ID);

      expect(result.riskLevel).toBe(ChurnRiskLevel.MEDIUM);
      expect(result.score).toBeGreaterThanOrEqual(31);
      expect(result.score).toBeLessThanOrEqual(60);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // getLTVEstimate
  // ───────────────────────────────────────────────────────────────────

  describe('getLTVEstimate', () => {
    it('should sum order values and convert to paise', async () => {
      const client = makeClient();
      repository.getClientById.mockResolvedValue(client);
      repository.getClientOrderAggregates.mockResolvedValue({
        totalRevenue: 15000, // rupees
        orderCount: 3,
      });

      const result = await service.getLTVEstimate(BUSINESS_ID, CLIENT_ID);

      expect(result.totalRevenuePaise).toBe(1500000);
      expect(result.orderCount).toBe(3);
      expect(result.avgOrderValuePaise).toBe(500000);
    });

    it('should return zero LTV for client with no orders', async () => {
      const client = makeClient();
      repository.getClientById.mockResolvedValue(client);
      repository.getClientOrderAggregates.mockResolvedValue({
        totalRevenue: 0,
        orderCount: 0,
      });

      const result = await service.getLTVEstimate(BUSINESS_ID, CLIENT_ID);

      expect(result.totalRevenuePaise).toBe(0);
      expect(result.orderCount).toBe(0);
      expect(result.avgOrderValuePaise).toBe(0);
    });

    it('should throw NotFoundException for unknown client', async () => {
      repository.getClientById.mockResolvedValue(null);

      await expect(
        service.getLTVEstimate(BUSINESS_ID, CLIENT_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // getClientSummaryForAI
  // ───────────────────────────────────────────────────────────────────

  describe('getClientSummaryForAI', () => {
    it('should respect 300 char limit', async () => {
      const client = makeClient({
        name: 'A Very Long Client Name That Goes On And On',
        churn_risk: new Decimal(0.5),
        total_orders: 10,
        profile: {
          sentimentHistory: [
            { score: 0.8, messageId: 'msg1', recordedAt: new Date().toISOString() },
          ],
          facts: [
            { factType: 'location', value: 'Mumbai', confidence: 0.9, messageId: 'msg1', extractedAt: new Date().toISOString() },
            { factType: 'preference', value: 'organic products and natural skincare items', confidence: 0.8, messageId: 'msg2', extractedAt: new Date().toISOString() },
          ],
        },
      });
      repository.getClientById.mockResolvedValue(client);

      const result = await service.getClientSummaryForAI(BUSINESS_ID, CLIENT_ID);

      expect(result.summary.length).toBeLessThanOrEqual(300);
      expect(result.clientId).toBe(CLIENT_ID);
    });

    it('should exclude facts with confidence < 0.7', async () => {
      const client = makeClient({
        name: 'Test',
        profile: {
          facts: [
            { factType: 'location', value: 'Delhi', confidence: 0.5, messageId: 'msg1', extractedAt: new Date().toISOString() },
            { factType: 'preference', value: 'red color', confidence: 0.9, messageId: 'msg2', extractedAt: new Date().toISOString() },
          ],
        },
      });
      repository.getClientById.mockResolvedValue(client);

      const result = await service.getClientSummaryForAI(BUSINESS_ID, CLIENT_ID);

      expect(result.summary).not.toContain('Delhi');
      expect(result.summary).toContain('red color');
    });

    it('should throw NotFoundException for unknown client', async () => {
      repository.getClientById.mockResolvedValue(null);

      await expect(
        service.getClientSummaryForAI(BUSINESS_ID, CLIENT_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // recordSentiment
  // ───────────────────────────────────────────────────────────────────

  describe('recordSentiment', () => {
    it('should clamp out-of-range positive values to 1.0', async () => {
      const client = makeClient({ profile: {} });
      repository.getClientById.mockResolvedValue(client);
      repository.updateClientProfile.mockResolvedValue(client);

      await service.recordSentiment(BUSINESS_ID, CLIENT_ID, MESSAGE_ID, 5.0);

      expect(repository.updateClientProfile).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        expect.objectContaining({
          profile: expect.objectContaining({
            sentimentHistory: expect.arrayContaining([
              expect.objectContaining({ score: 1.0 }),
            ]),
          }),
        }),
      );
    });

    it('should clamp out-of-range negative values to -1.0', async () => {
      const client = makeClient({ profile: {} });
      repository.getClientById.mockResolvedValue(client);
      repository.updateClientProfile.mockResolvedValue(client);

      await service.recordSentiment(BUSINESS_ID, CLIENT_ID, MESSAGE_ID, -3.5);

      expect(repository.updateClientProfile).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        expect.objectContaining({
          profile: expect.objectContaining({
            sentimentHistory: expect.arrayContaining([
              expect.objectContaining({ score: -1.0 }),
            ]),
          }),
        }),
      );
    });

    it('should store valid scores as-is', async () => {
      const client = makeClient({ profile: {} });
      repository.getClientById.mockResolvedValue(client);
      repository.updateClientProfile.mockResolvedValue(client);

      await service.recordSentiment(BUSINESS_ID, CLIENT_ID, MESSAGE_ID, 0.5);

      expect(repository.updateClientProfile).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        expect.objectContaining({
          profile: expect.objectContaining({
            sentimentHistory: expect.arrayContaining([
              expect.objectContaining({ score: 0.5 }),
            ]),
          }),
        }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // refreshIntelligenceScores
  // ───────────────────────────────────────────────────────────────────

  describe('refreshIntelligenceScores', () => {
    it('should emit churn event on boundary crossing', async () => {
      // Client currently at LOW risk (churn_risk = 0.2)
      const client = makeClient({ churn_risk: new Decimal(0.2) });
      repository.getClientById.mockResolvedValue(client);

      // RFM data that would result in HIGH score (>60)
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 65);
      repository.getClientRFMData.mockResolvedValue({
        lastInteractionAt: sixtyDaysAgo,
        lastOrderAt: sixtyDaysAgo,
        orderCount: 1,
        totalSpent: 500,
        firstSeenAt: new Date('2025-01-01T00:00:00Z'),
      });

      repository.getClientOrderAggregates.mockResolvedValue({
        totalRevenue: 500,
        orderCount: 1,
      });

      repository.updateIntelligenceScores.mockResolvedValue(client);

      await service.refreshIntelligenceScores(BUSINESS_ID, CLIENT_ID);

      // Should emit churn risk event because level changed from LOW to something higher
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'client.churn.risk',
        expect.objectContaining({
          businessId: BUSINESS_ID,
          clientId: CLIENT_ID,
          previousRiskLevel: ChurnRiskLevel.LOW,
        }),
      );
    });

    it('should NOT emit churn event when level stays the same', async () => {
      // Client currently at LOW risk (churn_risk = 0.1)
      const client = makeClient({ churn_risk: new Decimal(0.1) });
      repository.getClientById.mockResolvedValue(client);

      // RFM data that keeps the score in LOW range
      repository.getClientRFMData.mockResolvedValue({
        lastInteractionAt: new Date(), // today
        lastOrderAt: new Date(),
        orderCount: 20,
        totalSpent: 100000,
        firstSeenAt: new Date('2025-01-01T00:00:00Z'),
      });

      repository.getClientOrderAggregates.mockResolvedValue({
        totalRevenue: 100000,
        orderCount: 20,
      });

      repository.updateIntelligenceScores.mockResolvedValue(client);

      await service.refreshIntelligenceScores(BUSINESS_ID, CLIENT_ID);

      // Should NOT emit churn risk event
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'client.churn.risk',
        expect.anything(),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // extractAndStoreFacts
  // ───────────────────────────────────────────────────────────────────

  describe('extractAndStoreFacts', () => {
    it('should extract name from "my name is ..." pattern', async () => {
      const client = makeClient({ name: null, profile: {} });
      repository.getClientById.mockResolvedValue(client);
      repository.updateClientProfile.mockResolvedValue(client);

      const facts = await service.extractAndStoreFacts(
        BUSINESS_ID,
        CLIENT_ID,
        MESSAGE_ID,
        'Hello, my name is Priya Sharma and I want to order some products.',
      );

      const nameFact = facts.find((f) => f.factType === 'name');
      expect(nameFact).toBeDefined();
      expect(nameFact?.value).toBe('Priya Sharma');
      expect(nameFact?.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('should extract email from text', async () => {
      const client = makeClient({ email: null, profile: {} });
      repository.getClientById.mockResolvedValue(client);
      repository.updateClientProfile.mockResolvedValue(client);

      const facts = await service.extractAndStoreFacts(
        BUSINESS_ID,
        CLIENT_ID,
        MESSAGE_ID,
        'Please send the invoice to priya@example.com thanks',
      );

      const emailFact = facts.find((f) => f.factType === 'email');
      expect(emailFact).toBeDefined();
      expect(emailFact?.value).toBe('priya@example.com');
      expect(emailFact?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should not throw on extraction failure (best-effort)', async () => {
      repository.getClientById.mockRejectedValue(new Error('DB error'));

      // Should not throw — intelligence is best-effort
      const facts = await service.extractAndStoreFacts(
        BUSINESS_ID,
        CLIENT_ID,
        MESSAGE_ID,
        'my name is Test User',
      );

      // Facts may be empty array (extraction ran but storage failed)
      expect(Array.isArray(facts)).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // getClientSentimentTrend
  // ───────────────────────────────────────────────────────────────────

  describe('getClientSentimentTrend', () => {
    it('should return entries within the requested time range', async () => {
      const now = new Date();
      const fiveDaysAgo = new Date(now);
      fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
      const fiftyDaysAgo = new Date(now);
      fiftyDaysAgo.setDate(fiftyDaysAgo.getDate() - 50);

      const client = makeClient({
        profile: {
          sentimentHistory: [
            { score: 0.8, messageId: 'msg1', recordedAt: fiveDaysAgo.toISOString() },
            { score: -0.2, messageId: 'msg2', recordedAt: fiftyDaysAgo.toISOString() },
          ],
        },
      });
      repository.getClientById.mockResolvedValue(client);

      const result = await service.getClientSentimentTrend(BUSINESS_ID, CLIENT_ID, 30);

      // Only the 5-days-ago entry should be within 30-day window
      expect(result.entries.length).toBe(1);
      expect(result.entries[0]!.score).toBe(0.8);
      expect(result.days).toBe(30);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // getClientSegment
  // ───────────────────────────────────────────────────────────────────

  describe('getClientSegment', () => {
    function daysAgo(n: number): Date {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return d;
    }

    it('should classify a high-value active client as VIP', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getClientRFMData.mockResolvedValue({
        lastInteractionAt: new Date(),
        lastOrderAt: new Date(),
        orderCount: 15,
        totalSpent: 120000,
        firstSeenAt: new Date('2024-01-01T00:00:00Z'),
      });

      const result = await service.getClientSegment(BUSINESS_ID, CLIENT_ID);

      expect(result.segment).toBe(ClientSegment.VIP);
      expect(result.orderCount).toBe(15);
    });

    it('should classify a recently acquired client with no orders as NEW', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getClientRFMData.mockResolvedValue({
        lastInteractionAt: new Date(),
        lastOrderAt: null,
        orderCount: 0,
        totalSpent: 0,
        firstSeenAt: daysAgo(5),
      });

      const result = await service.getClientSegment(BUSINESS_ID, CLIENT_ID);

      expect(result.segment).toBe(ClientSegment.NEW);
    });

    it('should classify an existing customer with high churn as AT_RISK', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getClientRFMData.mockResolvedValue({
        lastInteractionAt: daysAgo(70),
        lastOrderAt: daysAgo(70),
        orderCount: 1,
        totalSpent: 500,
        firstSeenAt: new Date('2024-01-01T00:00:00Z'),
      });

      const result = await service.getClientSegment(BUSINESS_ID, CLIENT_ID);

      expect(result.segment).toBe(ClientSegment.AT_RISK);
      expect([ChurnRiskLevel.HIGH, ChurnRiskLevel.CRITICAL]).toContain(
        result.churnRiskLevel,
      );
    });

    it('should classify a long-inactive client as LOST', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getClientRFMData.mockResolvedValue({
        lastInteractionAt: daysAgo(200),
        lastOrderAt: daysAgo(200),
        orderCount: 3,
        totalSpent: 8000,
        firstSeenAt: new Date('2023-01-01T00:00:00Z'),
      });

      const result = await service.getClientSegment(BUSINESS_ID, CLIENT_ID);

      expect(result.segment).toBe(ClientSegment.LOST);
      expect(result.daysSinceLastActivity).toBeGreaterThan(180);
    });

    it('should throw NotFoundException for unknown client', async () => {
      repository.getClientById.mockResolvedValue(null);

      await expect(
        service.getClientSegment(BUSINESS_ID, CLIENT_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // getClientTimeline
  // ───────────────────────────────────────────────────────────────────

  describe('getClientTimeline', () => {
    it('should merge sources into a newest-first timeline with paise amounts', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getClientTimelineData.mockResolvedValue({
        conversations: [
          {
            id: 'conv-1',
            channel: $Enums.ChannelType.WHATSAPP,
            status: $Enums.ConversationStatus.OPEN,
            subject: 'Order query',
            created_at: new Date('2026-03-01T10:00:00Z'),
            last_message_at: new Date('2026-03-02T10:00:00Z'),
          },
        ],
        orders: [
          {
            id: 'order-1',
            order_number: 'ORD-1001',
            status: $Enums.OrderStatus.DELIVERED,
            total: new Decimal(1500),
            placed_at: new Date('2026-03-05T10:00:00Z'),
          },
        ],
        bookings: [
          {
            id: 'booking-1',
            status: $Enums.BookingStatus.CONFIRMED,
            start_at: new Date('2026-04-01T10:00:00Z'),
            created_at: new Date('2026-02-01T10:00:00Z'),
          },
        ],
        payments: [
          {
            id: 'pay-1',
            status: $Enums.PaymentStatus.SUCCESS,
            amount: new Decimal(1500),
            method: $Enums.PaymentMethod.UPI,
            created_at: new Date('2026-03-05T11:00:00Z'),
          },
        ],
      });

      const result = await service.getClientTimeline(BUSINESS_ID, CLIENT_ID, 50);

      expect(result.total).toBe(4);
      // Newest first: payment (Mar 5 11:00) before order (Mar 5 10:00)
      expect(result.events[0]!.type).toBe(TimelineEventType.PAYMENT);
      expect(result.events[1]!.type).toBe(TimelineEventType.ORDER);
      expect(result.events[1]!.amountPaise).toBe(150000);
      // Booking (created Feb 1) is oldest
      expect(result.events[result.events.length - 1]!.type).toBe(
        TimelineEventType.BOOKING,
      );
    });

    it('should respect the limit', async () => {
      repository.getClientById.mockResolvedValue(makeClient());
      repository.getClientTimelineData.mockResolvedValue({
        conversations: [
          {
            id: 'conv-1',
            channel: $Enums.ChannelType.WHATSAPP,
            status: $Enums.ConversationStatus.OPEN,
            subject: null,
            created_at: new Date('2026-03-01T10:00:00Z'),
            last_message_at: null,
          },
          {
            id: 'conv-2',
            channel: $Enums.ChannelType.SMS,
            status: $Enums.ConversationStatus.RESOLVED,
            subject: null,
            created_at: new Date('2026-03-02T10:00:00Z'),
            last_message_at: null,
          },
        ],
        orders: [],
        bookings: [],
        payments: [],
      });

      const result = await service.getClientTimeline(BUSINESS_ID, CLIENT_ID, 1);

      expect(result.events.length).toBe(1);
      expect(result.total).toBe(1);
    });

    it('should throw NotFoundException for unknown client', async () => {
      repository.getClientById.mockResolvedValue(null);

      await expect(
        service.getClientTimeline(BUSINESS_ID, CLIENT_ID, 50),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Event handlers
  // ───────────────────────────────────────────────────────────────────

  describe('handleMessageReceived', () => {
    it('should update last_interaction_at', async () => {
      repository.updateClientProfile.mockResolvedValue(makeClient());

      await service.handleMessageReceived({
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
      });

      expect(repository.updateClientProfile).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        expect.objectContaining({
          lastInteractionAt: expect.any(Date),
        }),
      );
    });

    it('should skip if clientId is empty', async () => {
      await service.handleMessageReceived({
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
        clientId: '',
      });

      expect(repository.updateClientProfile).not.toHaveBeenCalled();
    });
  });
});
