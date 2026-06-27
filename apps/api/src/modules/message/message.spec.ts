import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { MessageType } from '@prisma/client';
import { ChannelType, MessageDirection, MessageStatus } from '@gosumo/shared';
import { MessageService, PaginatedMessages } from './message.service';
import { MessageRepository } from './message.repository';
import {
  StoreInboundMessageDto,
  StoreOutboundMessageDto,
  MessagePaginationQueryDto,
  UpdateDeliveryStatusDto,
  AttachAIMetadataDto,
} from './dto';

// ─────────────────────────────────────────────
// Test constants
// ─────────────────────────────────────────────

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const CONVERSATION_ID = '22222222-2222-2222-2222-222222222222';
const CHANNEL_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-4444-444444444444';
const EXTERNAL_ID = 'wamid.abc123';

// ─────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────

function makeMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MESSAGE_ID,
    business_id: BUSINESS_ID,
    conversation_id: CONVERSATION_ID,
    channel_account_id: CHANNEL_ACCOUNT_ID,
    direction: MessageDirection.INBOUND,
    type: MessageType.TEXT,
    status: MessageStatus.PENDING,
    sender_type: 'CLIENT',
    sender_id: null,
    content: { type: 'TEXT', text: 'Hello' },
    text_content: 'Hello',
    external_id: EXTERNAL_ID,
    external_status: null,
    delivered_at: null,
    read_at: null,
    failed_at: null,
    failure_reason: null,
    ai_decision_id: null,
    is_ai_generated: false,
    confidence_score: null,
    campaign_id: null,
    reactions: [],
    metadata: {},
    sent_at: null,
    created_at: new Date('2026-06-20T10:00:00Z'),
    updated_at: new Date('2026-06-20T10:00:00Z'),
    ...overrides,
  };
}

function makeInboundDto(overrides: Partial<StoreInboundMessageDto> = {}): StoreInboundMessageDto {
  const dto = new StoreInboundMessageDto();
  dto.conversationId = CONVERSATION_ID;
  dto.channelAccountId = CHANNEL_ACCOUNT_ID;
  dto.channel = ChannelType.WHATSAPP;
  dto.externalId = EXTERNAL_ID;
  dto.senderType = 'CLIENT';
  dto.content = { type: 'TEXT', text: 'Hello' };
  dto.textContent = 'Hello';
  return Object.assign(dto, overrides);
}

function makeOutboundDto(overrides: Partial<StoreOutboundMessageDto> = {}): StoreOutboundMessageDto {
  const dto = new StoreOutboundMessageDto();
  dto.conversationId = CONVERSATION_ID;
  dto.channelAccountId = CHANNEL_ACCOUNT_ID;
  dto.channel = ChannelType.WHATSAPP;
  dto.senderType = 'AI';
  dto.content = { type: 'TEXT', text: 'Hi there!' };
  dto.textContent = 'Hi there!';
  dto.isAiGenerated = true;
  dto.confidenceScore = 0.95;
  return Object.assign(dto, overrides);
}

// ─────────────────────────────────────────────
// Mock repository
// ─────────────────────────────────────────────

function createMockRepository() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    findByConversation: jest.fn(),
    findByExternalId: jest.fn(),
    getLastN: jest.fn(),
    updateStatus: jest.fn(),
    search: jest.fn(),
    attachAIMetadata: jest.fn(),
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('MessageService', () => {
  let service: MessageService;
  let repository: ReturnType<typeof createMockRepository>;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    repository = createMockRepository();
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageService,
        { provide: MessageRepository, useValue: repository },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<MessageService>(MessageService);
  });

  // ─── storeInboundMessage ────────────────────

  describe('storeInboundMessage', () => {
    it('should create an inbound message and emit message.stored event', async () => {
      const dto = makeInboundDto();
      const created = makeMessage();

      repository.findByExternalId.mockResolvedValue(null);
      repository.create.mockResolvedValue(created);

      const result = await service.storeInboundMessage(BUSINESS_ID, dto);

      expect(result).toEqual(created);
      expect(repository.findByExternalId).toHaveBeenCalledWith(EXTERNAL_ID);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          business_id: BUSINESS_ID,
          conversation_id: CONVERSATION_ID,
          channel_account_id: CHANNEL_ACCOUNT_ID,
          direction: MessageDirection.INBOUND,
          status: MessageStatus.PENDING,
          sender_type: 'CLIENT',
          content: { type: 'TEXT', text: 'Hello' },
          text_content: 'Hello',
          external_id: EXTERNAL_ID,
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'message.stored',
        expect.objectContaining({
          type: 'message.stored',
          businessId: BUSINESS_ID,
          messageId: MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          channelAccountId: CHANNEL_ACCOUNT_ID,
          channel: ChannelType.WHATSAPP,
          direction: MessageDirection.INBOUND,
          senderType: 'CLIENT',
        }),
      );
    });

    it('should deduplicate by external_id and return existing message', async () => {
      const dto = makeInboundDto();
      const existing = makeMessage();

      repository.findByExternalId.mockResolvedValue(existing);

      const result = await service.storeInboundMessage(BUSINESS_ID, dto);

      expect(result).toEqual(existing);
      expect(repository.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ─── storeOutboundMessage ───────────────────

  describe('storeOutboundMessage', () => {
    it('should create an outbound message and emit message.stored event', async () => {
      const dto = makeOutboundDto();
      const created = makeMessage({
        direction: MessageDirection.OUTBOUND,
        sender_type: 'AI',
        is_ai_generated: true,
        confidence_score: 0.95,
        content: { type: 'TEXT', text: 'Hi there!' },
        text_content: 'Hi there!',
        external_id: null,
      });

      repository.create.mockResolvedValue(created);

      const result = await service.storeOutboundMessage(BUSINESS_ID, dto);

      expect(result).toEqual(created);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          business_id: BUSINESS_ID,
          direction: MessageDirection.OUTBOUND,
          status: MessageStatus.PENDING,
          sender_type: 'AI',
          is_ai_generated: true,
          confidence_score: 0.95,
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'message.stored',
        expect.objectContaining({
          type: 'message.stored',
          direction: MessageDirection.OUTBOUND,
          senderType: 'AI',
        }),
      );
    });
  });

  // ─── getConversationMessages ────────────────

  describe('getConversationMessages', () => {
    it('should return messages without cursor (first page)', async () => {
      const messages = [
        makeMessage({ id: 'aaa', created_at: new Date('2026-06-20T12:00:00Z') }),
        makeMessage({ id: 'bbb', created_at: new Date('2026-06-20T11:00:00Z') }),
      ];

      repository.findByConversation.mockResolvedValue(messages);

      const query = new MessagePaginationQueryDto();
      query.limit = 20;

      const result: PaginatedMessages = await service.getConversationMessages(
        BUSINESS_ID,
        CONVERSATION_ID,
        query,
      );

      expect(result.data).toEqual(messages);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
      expect(repository.findByConversation).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        { limit: 20, cursor: undefined },
      );
    });

    it('should handle cursor-based pagination and detect hasMore', async () => {
      // Return limit+1 results to signal hasMore
      const limit = 2;
      const messages = [
        makeMessage({ id: 'aaa', created_at: new Date('2026-06-20T12:00:00Z') }),
        makeMessage({ id: 'bbb', created_at: new Date('2026-06-20T11:00:00Z') }),
        makeMessage({ id: 'ccc', created_at: new Date('2026-06-20T10:00:00Z') }),
      ];

      repository.findByConversation.mockResolvedValue(messages);

      // Create a valid cursor
      const cursorObj = { createdAt: '2026-06-20T13:00:00Z', id: 'zzz' };
      const encodedCursor = Buffer.from(JSON.stringify(cursorObj)).toString('base64');

      const query = new MessagePaginationQueryDto();
      query.limit = limit;
      query.cursor = encodedCursor;

      const result: PaginatedMessages = await service.getConversationMessages(
        BUSINESS_ID,
        CONVERSATION_ID,
        query,
      );

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).not.toBeNull();

      // Verify the cursor was parsed and passed to repository
      expect(repository.findByConversation).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        {
          limit,
          cursor: { createdAt: '2026-06-20T13:00:00Z', id: 'zzz' },
        },
      );
    });

    it('should return hasMore=false when fewer results than limit', async () => {
      const messages = [
        makeMessage({ id: 'aaa', created_at: new Date('2026-06-20T12:00:00Z') }),
      ];

      repository.findByConversation.mockResolvedValue(messages);

      const query = new MessagePaginationQueryDto();
      query.limit = 20;

      const result: PaginatedMessages = await service.getConversationMessages(
        BUSINESS_ID,
        CONVERSATION_ID,
        query,
      );

      expect(result.data).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
    });
  });

  // ─── cursor encoding/decoding roundtrip ─────

  describe('cursor encoding/decoding', () => {
    it('should encode and decode cursor correctly in a roundtrip', async () => {
      const limit = 1;
      const msgDate = new Date('2026-06-20T12:00:00Z');

      // Return limit+1 results so a cursor is generated
      const messages = [
        makeMessage({ id: 'msg-1', created_at: msgDate }),
        makeMessage({ id: 'msg-2', created_at: new Date('2026-06-20T11:00:00Z') }),
      ];

      repository.findByConversation.mockResolvedValue(messages);

      const query = new MessagePaginationQueryDto();
      query.limit = limit;

      const firstPage = await service.getConversationMessages(
        BUSINESS_ID,
        CONVERSATION_ID,
        query,
      );

      expect(firstPage.cursor).not.toBeNull();

      // Decode the cursor and verify it contains the last item's data
      const decoded = JSON.parse(
        Buffer.from(firstPage.cursor!, 'base64').toString(),
      ) as { createdAt: string; id: string };

      expect(decoded.id).toBe('msg-1');
      expect(decoded.createdAt).toBe(msgDate.toISOString());

      // Use the cursor in a second page request
      repository.findByConversation.mockResolvedValue([]);

      const query2 = new MessagePaginationQueryDto();
      query2.limit = limit;
      query2.cursor = firstPage.cursor!;

      await service.getConversationMessages(BUSINESS_ID, CONVERSATION_ID, query2);

      expect(repository.findByConversation).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        {
          limit,
          cursor: { createdAt: msgDate.toISOString(), id: 'msg-1' },
        },
      );
    });

    it('should throw BadRequestException for an invalid cursor', async () => {
      const query = new MessagePaginationQueryDto();
      query.limit = 20;
      query.cursor = 'not-valid-base64!!!';

      await expect(
        service.getConversationMessages(BUSINESS_ID, CONVERSATION_ID, query),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── searchMessages ─────────────────────────

  describe('searchMessages', () => {
    it('should pass query and filters to repository', async () => {
      const results = [makeMessage()];
      repository.search.mockResolvedValue(results);

      const filters = {
        conversationId: CONVERSATION_ID,
        dateFrom: '2026-06-01T00:00:00Z',
        dateTo: '2026-06-30T23:59:59Z',
      };

      const result = await service.searchMessages(BUSINESS_ID, 'Hello', filters);

      expect(result).toEqual(results);
      expect(repository.search).toHaveBeenCalledWith(BUSINESS_ID, 'Hello', filters);
    });
  });

  // ─── updateDeliveryStatus ───────────────────

  describe('updateDeliveryStatus', () => {
    it('should update status and timestamps on an existing message', async () => {
      const existing = makeMessage();
      const updated = makeMessage({
        status: MessageStatus.DELIVERED,
        delivered_at: new Date('2026-06-20T10:01:00Z'),
      });

      repository.findById.mockResolvedValue(existing);
      repository.updateStatus.mockResolvedValue(updated);

      const dto = new UpdateDeliveryStatusDto();
      dto.status = MessageStatus.DELIVERED;
      dto.deliveredAt = '2026-06-20T10:01:00Z';

      const result = await service.updateDeliveryStatus(BUSINESS_ID, MESSAGE_ID, dto);

      expect(result).toEqual(updated);
      expect(repository.findById).toHaveBeenCalledWith(BUSINESS_ID, MESSAGE_ID);
      expect(repository.updateStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        MESSAGE_ID,
        MessageStatus.DELIVERED,
        {
          deliveredAt: '2026-06-20T10:01:00Z',
          readAt: undefined,
          failedAt: undefined,
          failureReason: undefined,
        },
      );
    });

    it('should throw NotFoundException when message does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      const dto = new UpdateDeliveryStatusDto();
      dto.status = MessageStatus.DELIVERED;

      await expect(
        service.updateDeliveryStatus(BUSINESS_ID, MESSAGE_ID, dto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── attachAIMetadata ──────────────────────

  describe('attachAIMetadata', () => {
    it('should update AI fields on an existing message', async () => {
      const existing = makeMessage();
      const updated = makeMessage({
        is_ai_generated: true,
        confidence_score: 0.92,
        ai_decision_id: '55555555-5555-5555-5555-555555555555',
      });

      repository.findById.mockResolvedValue(existing);
      repository.attachAIMetadata.mockResolvedValue(updated);

      const dto = new AttachAIMetadataDto();
      dto.isAiGenerated = true;
      dto.confidenceScore = 0.92;
      dto.aiDecisionId = '55555555-5555-5555-5555-555555555555';

      const result = await service.attachAIMetadata(BUSINESS_ID, MESSAGE_ID, dto);

      expect(result).toEqual(updated);
      expect(repository.findById).toHaveBeenCalledWith(BUSINESS_ID, MESSAGE_ID);
      expect(repository.attachAIMetadata).toHaveBeenCalledWith(
        BUSINESS_ID,
        MESSAGE_ID,
        {
          is_ai_generated: true,
          confidence_score: 0.92,
          ai_decision_id: '55555555-5555-5555-5555-555555555555',
        },
      );
    });

    it('should throw NotFoundException when message does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      const dto = new AttachAIMetadataDto();
      dto.isAiGenerated = true;

      await expect(
        service.attachAIMetadata(BUSINESS_ID, MESSAGE_ID, dto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── getLastNMessages ──────────────────────

  describe('getLastNMessages', () => {
    it('should return last N messages when conversation has messages', async () => {
      const messages = [
        makeMessage({ id: 'aaa', created_at: new Date('2026-06-20T12:00:00Z') }),
        makeMessage({ id: 'bbb', created_at: new Date('2026-06-20T11:00:00Z') }),
      ];

      // Probe returns at least one message (ownership check passes)
      repository.findByConversation.mockResolvedValue([messages[0]]);
      repository.getLastN.mockResolvedValue(messages);

      const result = await service.getLastNMessages(BUSINESS_ID, CONVERSATION_ID, 5);

      expect(result).toEqual(messages);
      expect(repository.findByConversation).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        { limit: 1 },
      );
      expect(repository.getLastN).toHaveBeenCalledWith(CONVERSATION_ID, 5);
    });

    it('should return empty array when conversation has no messages for this business', async () => {
      repository.findByConversation.mockResolvedValue([]);

      const result = await service.getLastNMessages(BUSINESS_ID, CONVERSATION_ID, 5);

      expect(result).toEqual([]);
      expect(repository.getLastN).not.toHaveBeenCalled();
    });
  });

  // ─── getMessageById ────────────────────────

  describe('getMessageById', () => {
    it('should return the message when found', async () => {
      const message = makeMessage();
      repository.findById.mockResolvedValue(message);

      const result = await service.getMessageById(BUSINESS_ID, MESSAGE_ID);

      expect(result).toEqual(message);
      expect(repository.findById).toHaveBeenCalledWith(BUSINESS_ID, MESSAGE_ID);
    });

    it('should throw NotFoundException when message is not found', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.getMessageById(BUSINESS_ID, MESSAGE_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
