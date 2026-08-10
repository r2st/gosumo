/**
 * Message feature unit tests — content-type resolution, media, reactions,
 * threading, stats, and delivery-status event handlers.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MessageType, FileUploadType } from '@prisma/client';
import {
  ChannelType,
  MessageDirection,
  MessageStatus,
  MessageSentEvent,
  MessageFailedEvent,
} from '@gosumo/shared';
import { MessageService } from './message.service';
import { MessageRepository } from './message.repository';
import { StoreInboundMessageDto, StoreOutboundMessageDto } from './dto';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const CONVERSATION_ID = '22222222-2222-2222-2222-222222222222';
const CHANNEL_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-4444-444444444444';
const SENDER_ID = '55555555-5555-5555-5555-555555555555';

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
    external_id: 'wamid.1',
    reactions: [],
    metadata: {},
    created_at: new Date('2026-06-20T10:00:00Z'),
    updated_at: new Date('2026-06-20T10:00:00Z'),
    ...overrides,
  };
}

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
    createFileUpload: jest.fn(),
    findFileUploadsByMessage: jest.fn(),
    setReactions: jest.fn(),
    findReplies: jest.fn(),
    getStats: jest.fn(),
  };
}

describe('MessageService — features', () => {
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

  // ─── content-type resolution ─────────────────

  describe('content-type resolution on store', () => {
    function makeInbound(content: Record<string, unknown>): StoreInboundMessageDto {
      const dto = new StoreInboundMessageDto();
      dto.conversationId = CONVERSATION_ID;
      dto.channelAccountId = CHANNEL_ACCOUNT_ID;
      dto.channel = ChannelType.WHATSAPP;
      dto.externalId = 'wamid.x';
      dto.senderType = 'CLIENT';
      dto.content = content;
      return dto;
    }

    it('classifies a LOCATION message as MessageType.LOCATION', async () => {
      repository.findByExternalId.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeMessage({ type: MessageType.LOCATION }));

      await service.storeInboundMessage(
        BUSINESS_ID,
        makeInbound({ type: 'LOCATION', latitude: 19.07, longitude: 72.87 }),
      );

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.LOCATION }),
      );
    });

    it('classifies a contact card as INTERACTIVE (no dedicated DB enum)', async () => {
      repository.findByExternalId.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeMessage());

      await service.storeInboundMessage(
        BUSINESS_ID,
        makeInbound({ type: 'CONTACT', contacts: [{ name: 'Asha' }] }),
      );

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.INTERACTIVE }),
      );
    });

    it('persists media into file_uploads when a storage key is present', async () => {
      repository.findByExternalId.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeMessage({ type: MessageType.IMAGE }));
      repository.createFileUpload.mockResolvedValue({});

      await service.storeInboundMessage(
        BUSINESS_ID,
        makeInbound({
          type: 'IMAGE',
          url: 'https://cdn.gosumo/x.jpg',
          storageKey: 'biz/img/x.jpg',
          mimeType: 'image/jpeg',
          filename: 'x.jpg',
          sizeBytes: 1024,
        }),
      );

      expect(repository.createFileUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          type: FileUploadType.IMAGE,
          storage_key: 'biz/img/x.jpg',
          message_id: MESSAGE_ID,
        }),
      );
    });

    it('records reply threading in metadata', async () => {
      const dto = new StoreOutboundMessageDto();
      dto.conversationId = CONVERSATION_ID;
      dto.channelAccountId = CHANNEL_ACCOUNT_ID;
      dto.channel = ChannelType.WHATSAPP;
      dto.senderType = 'AI';
      dto.content = { type: 'TEXT', text: 'reply' };
      dto.replyToMessageId = MESSAGE_ID;
      repository.create.mockResolvedValue(makeMessage());

      await service.storeOutboundMessage(BUSINESS_ID, dto);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ reply_to_message_id: MESSAGE_ID }),
        }),
      );
    });
  });

  // ─── media ───────────────────────────────────

  describe('attachMedia', () => {
    it('creates a file upload for a known message', async () => {
      repository.findById.mockResolvedValue(makeMessage());
      repository.createFileUpload.mockResolvedValue({ id: 'file-1' });

      const result = await service.attachMedia(BUSINESS_ID, MESSAGE_ID, {
        type: 'DOCUMENT',
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        storageKey: 'biz/docs/invoice.pdf',
      });

      expect(result).toEqual({ id: 'file-1' });
      expect(repository.createFileUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          type: FileUploadType.DOCUMENT,
          storage_key: 'biz/docs/invoice.pdf',
        }),
      );
    });
  });

  // ─── reactions ───────────────────────────────

  describe('reactions', () => {
    it('adds a reaction, replacing any prior one from the same sender', async () => {
      repository.findById.mockResolvedValue(
        makeMessage({
          reactions: [{ emoji: '👍', senderId: SENDER_ID, at: 'x' }],
        }),
      );
      repository.setReactions.mockResolvedValue(makeMessage());

      await service.addReaction(BUSINESS_ID, MESSAGE_ID, {
        emoji: '❤️',
        senderId: SENDER_ID,
      });

      const passed = repository.setReactions.mock.calls[0][2];
      expect(passed).toHaveLength(1);
      expect(passed[0].emoji).toBe('❤️');
    });

    it('removes a sender reaction', async () => {
      repository.findById.mockResolvedValue(
        makeMessage({
          reactions: [
            { emoji: '👍', senderId: SENDER_ID, at: 'x' },
            { emoji: '🎉', senderId: 'other', at: 'y' },
          ],
        }),
      );
      repository.setReactions.mockResolvedValue(makeMessage());

      await service.removeReaction(BUSINESS_ID, MESSAGE_ID, SENDER_ID);

      const passed = repository.setReactions.mock.calls[0][2];
      expect(passed).toHaveLength(1);
      expect(passed[0].senderId).toBe('other');
    });
  });

  // ─── threading ───────────────────────────────

  describe('getMessageThread', () => {
    it('returns the root message and its replies', async () => {
      repository.findById.mockResolvedValue(makeMessage());
      repository.findReplies.mockResolvedValue([makeMessage({ id: 'reply-1' })]);

      const result = await service.getMessageThread(BUSINESS_ID, MESSAGE_ID);

      expect(result.root.id).toBe(MESSAGE_ID);
      expect(result.replies).toHaveLength(1);
      expect(repository.findReplies).toHaveBeenCalledWith(BUSINESS_ID, MESSAGE_ID);
    });
  });

  // ─── stats ───────────────────────────────────

  describe('getMessageStats', () => {
    it('delegates to the repository', async () => {
      const stats = {
        total: 5,
        inbound: 2,
        outbound: 3,
        aiGenerated: 3,
        byStatus: { DELIVERED: 5 },
      };
      repository.getStats.mockResolvedValue(stats);

      const result = await service.getMessageStats(BUSINESS_ID, CONVERSATION_ID);
      expect(result).toEqual(stats);
    });
  });

  // ─── delivery-status event handlers ──────────

  describe('handleMessageSent', () => {
    it('marks the matched outbound message SENT', async () => {
      repository.findByExternalId.mockResolvedValue(
        makeMessage({ direction: MessageDirection.OUTBOUND }),
      );
      repository.updateStatus.mockResolvedValue(makeMessage());

      const event: MessageSentEvent = {
        type: 'message.sent',
        id: 'evt',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr',
        messageId: 'gs-id',
        conversationId: CONVERSATION_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
        externalMessageId: 'wamid.1',
        recipientExternalId: '919876543210',
        latencyMs: 120,
      };

      await service.handleMessageSent(event);

      expect(repository.updateStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        MESSAGE_ID,
        MessageStatus.SENT,
        {},
      );
    });

    it('resolves the external id within the event business, not globally', async () => {
      // The tenant lives in the lookup itself: another business's message with
      // the same provider id is simply not visible here, so there is no window
      // in which a foreign row could be reached and then filtered.
      repository.findByExternalId.mockResolvedValue(null);

      const event: MessageSentEvent = {
        type: 'message.sent',
        id: 'evt',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr',
        messageId: 'gs-id',
        conversationId: CONVERSATION_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
        externalMessageId: 'wamid.1',
        recipientExternalId: '919876543210',
        latencyMs: 120,
      };

      await service.handleMessageSent(event);

      expect(repository.findByExternalId).toHaveBeenCalledWith(BUSINESS_ID, 'wamid.1');
      expect(repository.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('handleMessageFailed', () => {
    it('marks the message FAILED with a reason', async () => {
      repository.findById.mockResolvedValue(makeMessage());
      repository.updateStatus.mockResolvedValue(makeMessage());

      const event: MessageFailedEvent = {
        type: 'message.failed',
        id: 'evt',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr',
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
        recipientExternalId: '919876543210',
        reason: 'recipient blocked',
        attempts: 3,
      };

      await service.handleMessageFailed(event);

      expect(repository.updateStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        MESSAGE_ID,
        MessageStatus.FAILED,
        expect.objectContaining({ failureReason: 'recipient blocked' }),
      );
    });
  });
});
