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
import { NotFoundException, BadRequestException } from '@nestjs/common';
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

    // The DTO bounds each field alone; only the service sees the pair. An
    // IMAGE declaring `text/html` is the combination that matters — these rows
    // carry `is_public`, so it is a stored-XSS setup for whatever serves the
    // object, and `image/*` is what makes it look benign in a listing.
    it.each([
      ['html on an image', 'IMAGE', 'text/html'],
      ['a script on a sticker', 'STICKER', 'application/javascript'],
      ['audio on a video', 'VIDEO', 'audio/mpeg'],
      ['a bare token with no subtype', 'IMAGE', 'image'],
      ['a type with a parameter', 'IMAGE', 'image/jpeg; charset=utf-8'],
    ])('rejects %s', async (_label, type, mimeType) => {
      repository.findById.mockResolvedValue(makeMessage());

      await expect(
        service.attachMedia(BUSINESS_ID, MESSAGE_ID, {
          type,
          filename: 'x.bin',
          mimeType,
          sizeBytes: 10,
          storageKey: 'biz/x.bin',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.createFileUpload).not.toHaveBeenCalled();
    });

    it.each([
      ['a jpeg image', 'IMAGE', 'image/jpeg'],
      ['a webp sticker', 'STICKER', 'image/webp'],
      ['an mp4 video', 'VIDEO', 'video/mp4'],
      ['an ogg voice note', 'AUDIO', 'audio/ogg'],
      // A document legitimately spans every family, so it is unconstrained.
      ['a pdf document', 'DOCUMENT', 'application/pdf'],
      ['a zip document', 'DOCUMENT', 'application/zip'],
    ])('accepts %s', async (_label, type, mimeType) => {
      repository.findById.mockResolvedValue(makeMessage());
      repository.createFileUpload.mockResolvedValue({ id: 'file-1' });

      await expect(
        service.attachMedia(BUSINESS_ID, MESSAGE_ID, {
          type,
          filename: 'x.bin',
          mimeType,
          sizeBytes: 10,
          storageKey: 'biz/x.bin',
        }),
      ).resolves.toEqual({ id: 'file-1' });
    });
  });

  // ─── media from inbound content ──────────────
  //
  // This path writes the same `file_uploads` row without ever going through
  // `AttachMediaDto`, and its input is an inbound channel payload — the least
  // trusted source in the platform. It has to repeat the DTO's checks.

  describe('media on an inbound message', () => {
    function makeInbound(content: Record<string, unknown>): StoreInboundMessageDto {
      const dto = new StoreInboundMessageDto();
      dto.conversationId = CONVERSATION_ID;
      dto.channelAccountId = CHANNEL_ACCOUNT_ID;
      dto.channel = ChannelType.WHATSAPP;
      dto.externalId = 'wamid.media';
      dto.senderType = 'CLIENT';
      dto.content = content;
      return dto;
    }

    beforeEach(() => {
      repository.findByExternalId.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeMessage({ type: MessageType.IMAGE }));
      repository.createFileUpload.mockResolvedValue({});
    });

    it('drops the attachment rather than storing a traversal key', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        makeInbound({ type: 'IMAGE', storageKey: 'biz/../../etc/passwd' }),
      );

      expect(repository.createFileUpload).not.toHaveBeenCalled();
      // The message itself is append-only and must still be stored — losing it
      // over its attachment metadata would be the worse failure.
      expect(repository.create).toHaveBeenCalled();
    });

    it('drops the attachment rather than storing a URL as a key', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        makeInbound({ type: 'IMAGE', storageKey: 'https://evil.test/p.jpg' }),
      );

      expect(repository.createFileUpload).not.toHaveBeenCalled();
    });

    it('replaces a path-shaped filename with a safe generated one', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        makeInbound({
          type: 'IMAGE',
          storageKey: 'biz/img/x.jpg',
          filename: '../../.ssh/authorized_keys',
        }),
      );

      expect(repository.createFileUpload).toHaveBeenCalledWith(
        expect.objectContaining({ filename: `image-${MESSAGE_ID}` }),
      );
    });

    it('falls back to an opaque mime type when the declared one lies', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        makeInbound({
          type: 'IMAGE',
          storageKey: 'biz/img/x.jpg',
          mimeType: 'text/html',
        }),
      );

      expect(repository.createFileUpload).toHaveBeenCalledWith(
        expect.objectContaining({ mime_type: 'application/octet-stream' }),
      );
    });

    it('clamps a declared size that would overflow the int4 column', async () => {
      // Reaching Postgres with this is a 500; the message is already stored,
      // so the descriptive metadata is clamped rather than lost.
      await service.storeInboundMessage(
        BUSINESS_ID,
        makeInbound({
          type: 'IMAGE',
          storageKey: 'biz/img/x.jpg',
          sizeBytes: 1e15,
        }),
      );

      const call = repository.createFileUpload.mock.calls[0][0];
      expect(call.size_bytes).toBe(100 * 1024 * 1024);
      expect(call.size_bytes).toBeLessThan(2 ** 31);
    });

    it('clamps a negative size to zero', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        makeInbound({ type: 'IMAGE', storageKey: 'biz/img/x.jpg', sizeBytes: -9 }),
      );

      expect(repository.createFileUpload).toHaveBeenCalledWith(
        expect.objectContaining({ size_bytes: 0 }),
      );
    });

    it('still stores an entirely well-formed attachment unchanged', async () => {
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
          storage_key: 'biz/img/x.jpg',
          mime_type: 'image/jpeg',
          filename: 'x.jpg',
          size_bytes: 1024,
          cdn_url: 'https://cdn.gosumo/x.jpg',
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

  // ─── delivery-status handler resilience ──────

  /**
   * Both handlers sit on the event bus, so a throw escapes into the emitter and
   * takes down whatever else is listening on the same event. They swallow by
   * design — a status stamp that misses is recoverable, a crashed bus is not.
   */
  describe('delivery-status handler resilience', () => {
    function sentEvent(overrides: Partial<MessageSentEvent> = {}): MessageSentEvent {
      return {
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
        ...overrides,
      } as MessageSentEvent;
    }

    function failedEvent(overrides: Partial<MessageFailedEvent> = {}): MessageFailedEvent {
      return {
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
        ...overrides,
      } as MessageFailedEvent;
    }

    /** Some providers ack without an id; there is nothing to match on. */
    it('ignores a sent event carrying no provider message id', async () => {
      await service.handleMessageSent(sentEvent({ externalMessageId: undefined }));
      expect(repository.findByExternalId).not.toHaveBeenCalled();
      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    it('swallows a repository failure on message.sent', async () => {
      repository.findByExternalId.mockRejectedValue(new Error('db down'));
      await expect(service.handleMessageSent(sentEvent())).resolves.toBeUndefined();
    });

    it('ignores a failed event for a message this tenant cannot see', async () => {
      repository.findById.mockResolvedValue(null);
      await service.handleMessageFailed(failedEvent());
      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    it('swallows a repository failure on message.failed', async () => {
      repository.findById.mockRejectedValue(new Error('db down'));
      await expect(service.handleMessageFailed(failedEvent())).resolves.toBeUndefined();
    });

    /** A rejected non-Error (a string, a Prisma reject) must still log cleanly. */
    it('survives a thrown non-Error value', async () => {
      repository.findById.mockRejectedValue('connection reset');
      await expect(service.handleMessageFailed(failedEvent())).resolves.toBeUndefined();
    });
  });

  // ─── metadata assembly ───────────────────────

  describe('metadata assembly on store', () => {
    function inbound(overrides: Partial<StoreInboundMessageDto> = {}): StoreInboundMessageDto {
      const dto = new StoreInboundMessageDto();
      dto.conversationId = CONVERSATION_ID;
      dto.channelAccountId = CHANNEL_ACCOUNT_ID;
      dto.channel = ChannelType.WHATSAPP;
      dto.externalId = 'wamid.meta';
      dto.senderType = 'CLIENT';
      dto.content = { type: 'TEXT', text: 'Hello' };
      dto.textContent = 'Hello';
      return Object.assign(dto, overrides);
    }

    beforeEach(() => {
      repository.findByExternalId.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeMessage());
    });

    function storedMetadata(): unknown {
      return repository.create.mock.calls[0]![0].metadata;
    }

    /** No metadata and no reply pointer must leave the column untouched. */
    it('omits metadata entirely when there is nothing to store', async () => {
      await service.storeInboundMessage(BUSINESS_ID, inbound());
      expect(storedMetadata()).toBeUndefined();
    });

    it('stores caller metadata as-is', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        inbound({ metadata: { source: 'webhook' } }),
      );
      expect(storedMetadata()).toEqual({ source: 'webhook' });
    });

    it('records a reply pointer with no other metadata', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        inbound({ replyToMessageId: 'msg-parent' }),
      );
      expect(storedMetadata()).toEqual({ reply_to_message_id: 'msg-parent' });
    });

    it('merges the reply pointer into caller metadata', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        inbound({ metadata: { source: 'webhook' }, replyToMessageId: 'msg-parent' }),
      );
      expect(storedMetadata()).toEqual({
        source: 'webhook',
        reply_to_message_id: 'msg-parent',
      });
    });
  });

  // ─── media persistence ───────────────────────

  describe('media persistence on store', () => {
    function inboundWith(content: Record<string, unknown>): StoreInboundMessageDto {
      const dto = new StoreInboundMessageDto();
      dto.conversationId = CONVERSATION_ID;
      dto.channelAccountId = CHANNEL_ACCOUNT_ID;
      dto.channel = ChannelType.WHATSAPP;
      dto.externalId = 'wamid.media';
      dto.senderType = 'CLIENT';
      dto.content = content;
      return dto;
    }

    beforeEach(() => {
      repository.findByExternalId.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeMessage());
      repository.createFileUpload.mockResolvedValue({ id: 'file-1' });
    });

    it('writes no upload row for a text message', async () => {
      await service.storeInboundMessage(BUSINESS_ID, inboundWith({ type: 'TEXT', text: 'hi' }));
      expect(repository.createFileUpload).not.toHaveBeenCalled();
    });

    it('writes no upload row for content with no type at all', async () => {
      await service.storeInboundMessage(BUSINESS_ID, inboundWith({ text: 'hi' }));
      expect(repository.createFileUpload).not.toHaveBeenCalled();
    });

    /**
     * Media arrives at the webhook before it has been re-uploaded to GoSumo
     * storage. Until the storage key exists there is nothing to reference, so
     * the message stores and the upload row waits.
     */
    it('defers the upload row until the media has a storage key', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        inboundWith({ type: 'IMAGE', url: 'https://cdn.example/x.jpg' }),
      );
      expect(repository.createFileUpload).not.toHaveBeenCalled();
    });

    it('accepts a snake_case storage key from the provider payload', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        inboundWith({ type: 'IMAGE', storage_key: 'biz/img.jpg' }),
      );
      expect(repository.createFileUpload).toHaveBeenCalledWith(
        expect.objectContaining({ storage_key: 'biz/img.jpg' }),
      );
    });

    it('fills sane defaults for a bare media payload', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        inboundWith({ type: 'AUDIO', storageKey: 'biz/note.ogg' }),
      );

      expect(repository.createFileUpload).toHaveBeenCalledWith({
        business_id: BUSINESS_ID,
        message_id: MESSAGE_ID,
        type: FileUploadType.AUDIO,
        filename: `audio-${MESSAGE_ID}`,
        mime_type: 'application/octet-stream',
        size_bytes: 0,
        storage_key: 'biz/note.ogg',
        cdn_url: undefined,
        width: undefined,
        height: undefined,
      });
    });

    it('carries a fully-described media payload through unchanged', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        inboundWith({
          type: 'IMAGE',
          storageKey: 'biz/photo.jpg',
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 20_480,
          url: 'https://cdn.example/photo.jpg',
          width: 1024,
          height: 768,
        }),
      );

      expect(repository.createFileUpload).toHaveBeenCalledWith({
        business_id: BUSINESS_ID,
        message_id: MESSAGE_ID,
        type: FileUploadType.IMAGE,
        filename: 'photo.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 20_480,
        storage_key: 'biz/photo.jpg',
        cdn_url: 'https://cdn.example/photo.jpg',
        width: 1024,
        height: 768,
      });
    });

    /** A sticker is stored as an IMAGE upload — there is no sticker file type. */
    it('files a sticker under the image upload type', async () => {
      await service.storeInboundMessage(
        BUSINESS_ID,
        inboundWith({ type: 'STICKER', storageKey: 'biz/s.webp' }),
      );
      expect(repository.createFileUpload).toHaveBeenCalledWith(
        expect.objectContaining({ type: FileUploadType.IMAGE }),
      );
    });

    /**
     * The message is the record of what the customer said; a failed side-table
     * write must not lose it. The upload row is recoverable, the message is not.
     */
    it('still stores the message when the upload row fails to write', async () => {
      repository.createFileUpload.mockRejectedValue(new Error('s3 metadata write failed'));

      const stored = await service.storeInboundMessage(
        BUSINESS_ID,
        inboundWith({ type: 'DOCUMENT', storageKey: 'biz/doc.pdf' }),
      );

      expect(stored).toBeDefined();
      expect(eventEmitter.emit).toHaveBeenCalledWith('message.stored', expect.anything());
    });

    it('persists media on the outbound path too', async () => {
      const dto = new StoreOutboundMessageDto();
      dto.conversationId = CONVERSATION_ID;
      dto.channelAccountId = CHANNEL_ACCOUNT_ID;
      dto.channel = ChannelType.WHATSAPP;
      dto.senderType = 'AI';
      dto.content = { type: 'VIDEO', storageKey: 'biz/clip.mp4' };

      await service.storeOutboundMessage(BUSINESS_ID, dto);

      expect(repository.createFileUpload).toHaveBeenCalledWith(
        expect.objectContaining({ type: FileUploadType.VIDEO, storage_key: 'biz/clip.mp4' }),
      );
    });
  });

  // ─── media listing ───────────────────────────

  describe('getMessageMedia', () => {
    it('lists the uploads attached to a visible message', async () => {
      repository.findById.mockResolvedValue(makeMessage());
      repository.findFileUploadsByMessage.mockResolvedValue([{ id: 'file-1' }]);

      expect(await service.getMessageMedia(BUSINESS_ID, MESSAGE_ID)).toEqual([
        { id: 'file-1' },
      ]);
      expect(repository.findFileUploadsByMessage).toHaveBeenCalledWith(
        BUSINESS_ID,
        MESSAGE_ID,
      );
    });

    /** The tenant check has to happen before the uploads are read, not after. */
    it('refuses to list uploads for a message outside the tenant', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.getMessageMedia(BUSINESS_ID, MESSAGE_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.findFileUploadsByMessage).not.toHaveBeenCalled();
    });
  });

  // ─── cursor decoding ─────────────────────────

  /**
   * The cursor is client-supplied base64. A structurally valid but incomplete
   * payload must be rejected as loudly as garbage — a cursor missing `id` would
   * otherwise produce a keyset predicate with an undefined tiebreaker.
   */
  describe('pagination cursor decoding', () => {
    function cursorFor(payload: unknown): string {
      return Buffer.from(JSON.stringify(payload)).toString('base64');
    }

    it.each([
      ['a missing id', { createdAt: '2026-06-20T10:00:00Z' }],
      ['a missing timestamp', { id: MESSAGE_ID }],
      ['an empty object', {}],
    ])('rejects a cursor with %s', async (_label, payload) => {
      await expect(
        service.getConversationMessages(BUSINESS_ID, CONVERSATION_ID, {
          cursor: cursorFor(payload),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a complete cursor and passes it to the repository', async () => {
      repository.findByConversation.mockResolvedValue([]);

      await service.getConversationMessages(BUSINESS_ID, CONVERSATION_ID, {
        cursor: cursorFor({ createdAt: '2026-06-20T10:00:00Z', id: MESSAGE_ID }),
        limit: 5,
      });

      expect(repository.findByConversation).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        { limit: 5, cursor: { createdAt: '2026-06-20T10:00:00Z', id: MESSAGE_ID } },
      );
    });
  });

  // ─── reactions column tolerance ──────────────

  /**
   * `reactions` is a JSON column, so a legacy or hand-edited row can hold
   * something that is not an array. Reading it must degrade to empty rather
   * than hand a non-iterable to the caller.
   */
  describe('reactions column tolerance', () => {
    it.each([
      ['a JSON object', { thumbsUp: 1 }],
      ['a JSON null', null],
      ['a bare string', 'thumbsup'],
    ])('reads %s as no reactions', async (_label, raw) => {
      repository.findById.mockResolvedValue(makeMessage({ reactions: raw }));
      repository.setReactions.mockImplementation(
        async (_b: string, _id: string, reactions: unknown) =>
          makeMessage({ reactions }),
      );

      await service.addReaction(BUSINESS_ID, MESSAGE_ID, {
        emoji: '👍',
        senderId: SENDER_ID,
      });

      expect(repository.setReactions).toHaveBeenCalledWith(
        BUSINESS_ID,
        MESSAGE_ID,
        [expect.objectContaining({ emoji: '👍' })],
      );
    });
  });
});
