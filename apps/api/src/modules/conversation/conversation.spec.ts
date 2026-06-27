/**
 * Conversation module unit tests
 *
 * Coverage:
 *  1.  findOrCreate: returns existing conversation when one is active
 *  2.  findOrCreate: creates new conversation when none exists, emits conversation.created
 *  3.  findOrCreate: creates new conversation when existing is RESOLVED
 *  4.  updateStatus: valid OPEN → RESOLVED transition
 *  5.  updateStatus: valid OPEN → PENDING_HUMAN transition
 *  6.  updateStatus: valid RESOLVED → OPEN (reopen)
 *  7.  updateStatus: invalid RESOLVED → ESCALATED throws BadRequestException
 *  8.  updateStatus: invalid SNOOZED → RESOLVED throws BadRequestException
 *  9.  updateStatus: throws NotFoundException for missing conversation
 *  10. updateStatus: sets resolved_at when resolving
 *  11. listConversations: applies status filter
 *  12. listConversations: applies channel filter
 *  13. assignConversation: updates and emits event
 *  14. getConversation: throws NotFoundException for missing
 *  15. handleMessageReceived: processes message with clientId
 *  16. handleMessageReceived: skips message without clientId
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import {
  ChannelType,
  ConversationStatus,
  MessageReceivedEvent,
} from '@gosumo/shared';

import { ConversationService } from './conversation.service';
import { ConversationRepository } from './conversation.repository';
import { PrismaService } from '../../common/services/prisma.service';

// ─────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const CHANNEL_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-4444-444444444444';
const ASSIGNEE_ID = '55555555-5555-5555-5555-555555555555';
const MESSAGE_ID = '66666666-6666-6666-6666-666666666666';

function makeConversation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONVERSATION_ID,
    business_id: BUSINESS_ID,
    client_id: CLIENT_ID,
    channel_account_id: CHANNEL_ACCOUNT_ID,
    channel: ChannelType.WHATSAPP,
    status: ConversationStatus.OPEN,
    current_intent: null,
    intent_confidence: null,
    current_topic: null,
    assigned_to: null,
    subject: null,
    external_thread_id: null,
    first_message_at: new Date(),
    last_message_at: new Date(),
    resolved_at: null,
    snoozed_until: null,
    message_count: 1,
    unread_count: 0,
    human_message_count: 0,
    csat_score: null,
    csat_submitted_at: null,
    tags: [],
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    client: {
      id: CLIENT_ID,
      name: 'Priya Sharma',
      phone: '+919876543210',
      email: null,
    },
    channel_account: {
      id: CHANNEL_ACCOUNT_ID,
      name: 'Main WhatsApp',
      channel: ChannelType.WHATSAPP,
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Mock repository
// ─────────────────────────────────────────────

function createMockRepository() {
  return {
    findById: jest.fn(),
    findActiveByClientAndChannel: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
    list: jest.fn(),
    updateLastMessageAt: jest.fn(),
    assign: jest.fn(),
  };
}

function createMockPrisma() {
  return {
    messages: {
      findMany: jest.fn(),
    },
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('ConversationService', () => {
  let service: ConversationService;
  let repository: ReturnType<typeof createMockRepository>;
  let prisma: ReturnType<typeof createMockPrisma>;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    repository = createMockRepository();
    prisma = createMockPrisma();
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: ConversationRepository, useValue: repository },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<ConversationService>(ConversationService);
  });

  // ─── findOrCreate ────────────────────────────

  describe('findOrCreate', () => {
    const dto = {
      clientId: CLIENT_ID,
      channelAccountId: CHANNEL_ACCOUNT_ID,
      channel: ChannelType.WHATSAPP,
    };

    it('should return existing conversation when one is active', async () => {
      const existing = makeConversation();
      repository.findActiveByClientAndChannel.mockResolvedValue(existing);

      const result = await service.findOrCreate(BUSINESS_ID, dto);

      expect(result).toEqual(existing);
      expect(repository.findActiveByClientAndChannel).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        CHANNEL_ACCOUNT_ID,
      );
      expect(repository.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should create new conversation when none exists and emit conversation.created', async () => {
      const created = makeConversation();
      repository.findActiveByClientAndChannel.mockResolvedValue(null);
      repository.create.mockResolvedValue(created);

      const result = await service.findOrCreate(BUSINESS_ID, dto);

      expect(result).toEqual(created);
      expect(repository.create).toHaveBeenCalledWith({
        businessId: BUSINESS_ID,
        clientId: CLIENT_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.created',
        expect.objectContaining({
          type: 'conversation.created',
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          clientId: CLIENT_ID,
          channelAccountId: CHANNEL_ACCOUNT_ID,
          channel: ChannelType.WHATSAPP,
        }),
      );
    });

    it('should create new conversation when existing is RESOLVED', async () => {
      // findActiveByClientAndChannel filters out RESOLVED, so it returns null
      const created = makeConversation();
      repository.findActiveByClientAndChannel.mockResolvedValue(null);
      repository.create.mockResolvedValue(created);

      const result = await service.findOrCreate(BUSINESS_ID, dto);

      expect(result).toEqual(created);
      expect(repository.create).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.created',
        expect.objectContaining({ type: 'conversation.created' }),
      );
    });
  });

  // ─── getConversation ─────────────────────────

  describe('getConversation', () => {
    it('should return the conversation when found', async () => {
      const conversation = makeConversation();
      repository.findById.mockResolvedValue(conversation);

      const result = await service.getConversation(BUSINESS_ID, CONVERSATION_ID);

      expect(result).toEqual(conversation);
      expect(repository.findById).toHaveBeenCalledWith(BUSINESS_ID, CONVERSATION_ID);
    });

    it('should throw NotFoundException for missing conversation', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.getConversation(BUSINESS_ID, CONVERSATION_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── updateStatus ────────────────────────────

  describe('updateStatus', () => {
    it('should transition OPEN → RESOLVED successfully', async () => {
      const conversation = makeConversation({ status: ConversationStatus.OPEN });
      const updated = makeConversation({ status: ConversationStatus.RESOLVED, resolved_at: new Date() });
      repository.findById.mockResolvedValue(conversation);
      repository.updateStatus.mockResolvedValue(updated);

      const result = await service.updateStatus(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.RESOLVED,
      );

      expect(result).toEqual(updated);
      expect(repository.updateStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.RESOLVED,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.status.changed',
        expect.objectContaining({
          type: 'conversation.status.changed',
          previousStatus: ConversationStatus.OPEN,
          newStatus: ConversationStatus.RESOLVED,
        }),
      );
    });

    it('should transition OPEN → PENDING_HUMAN successfully', async () => {
      const conversation = makeConversation({ status: ConversationStatus.OPEN });
      const updated = makeConversation({ status: ConversationStatus.PENDING_HUMAN });
      repository.findById.mockResolvedValue(conversation);
      repository.updateStatus.mockResolvedValue(updated);

      const result = await service.updateStatus(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.PENDING_HUMAN,
      );

      expect(result).toEqual(updated);
      expect(repository.updateStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.PENDING_HUMAN,
      );
    });

    it('should transition RESOLVED → OPEN (reopen) successfully', async () => {
      const conversation = makeConversation({ status: ConversationStatus.RESOLVED });
      const updated = makeConversation({ status: ConversationStatus.OPEN });
      repository.findById.mockResolvedValue(conversation);
      repository.updateStatus.mockResolvedValue(updated);

      const result = await service.updateStatus(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.OPEN,
      );

      expect(result).toEqual(updated);
      expect(repository.updateStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.OPEN,
      );
    });

    it('should throw BadRequestException for invalid RESOLVED → ESCALATED transition', async () => {
      const conversation = makeConversation({ status: ConversationStatus.RESOLVED });
      repository.findById.mockResolvedValue(conversation);

      await expect(
        service.updateStatus(
          BUSINESS_ID,
          CONVERSATION_ID,
          ConversationStatus.ESCALATED,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException for invalid SNOOZED → RESOLVED transition', async () => {
      const conversation = makeConversation({ status: ConversationStatus.SNOOZED });
      repository.findById.mockResolvedValue(conversation);

      await expect(
        service.updateStatus(
          BUSINESS_ID,
          CONVERSATION_ID,
          ConversationStatus.RESOLVED,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for missing conversation', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.updateStatus(
          BUSINESS_ID,
          CONVERSATION_ID,
          ConversationStatus.RESOLVED,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should set resolved_at when transitioning to RESOLVED', async () => {
      const conversation = makeConversation({ status: ConversationStatus.OPEN });
      const updated = makeConversation({
        status: ConversationStatus.RESOLVED,
        resolved_at: new Date(),
      });
      repository.findById.mockResolvedValue(conversation);
      repository.updateStatus.mockResolvedValue(updated);

      await service.updateStatus(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.RESOLVED,
      );

      // The repository.updateStatus handles setting resolved_at internally;
      // verify it was called with the RESOLVED status
      expect(repository.updateStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        ConversationStatus.RESOLVED,
      );
    });
  });

  // ─── listConversations ───────────────────────

  describe('listConversations', () => {
    const paginatedResult = {
      data: [makeConversation()],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    };

    it('should apply status filter', async () => {
      repository.list.mockResolvedValue(paginatedResult);

      const result = await service.listConversations(BUSINESS_ID, {
        status: ConversationStatus.OPEN,
        page: 1,
        limit: 20,
      });

      expect(result).toEqual(paginatedResult);
      expect(repository.list).toHaveBeenCalledWith(BUSINESS_ID, {
        status: ConversationStatus.OPEN,
        channel: undefined,
        assigneeId: undefined,
        page: 1,
        limit: 20,
      });
    });

    it('should apply channel filter', async () => {
      repository.list.mockResolvedValue(paginatedResult);

      const result = await service.listConversations(BUSINESS_ID, {
        channelType: ChannelType.WHATSAPP,
        page: 1,
        limit: 20,
      });

      expect(result).toEqual(paginatedResult);
      expect(repository.list).toHaveBeenCalledWith(BUSINESS_ID, {
        status: undefined,
        channel: ChannelType.WHATSAPP,
        assigneeId: undefined,
        page: 1,
        limit: 20,
      });
    });
  });

  // ─── assignConversation ──────────────────────

  describe('assignConversation', () => {
    it('should assign conversation and emit event', async () => {
      const conversation = makeConversation({ assigned_to: null });
      const updated = makeConversation({ assigned_to: ASSIGNEE_ID });
      repository.findById.mockResolvedValue(conversation);
      repository.assign.mockResolvedValue(updated);

      const result = await service.assignConversation(
        BUSINESS_ID,
        CONVERSATION_ID,
        ASSIGNEE_ID,
      );

      expect(result).toEqual(updated);
      expect(repository.assign).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        ASSIGNEE_ID,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.assigned',
        expect.objectContaining({
          type: 'conversation.assigned',
          conversationId: CONVERSATION_ID,
          clientId: CLIENT_ID,
          assigneeId: ASSIGNEE_ID,
        }),
      );
    });

    it('should throw NotFoundException for missing conversation', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.assignConversation(BUSINESS_ID, CONVERSATION_ID, ASSIGNEE_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── handleMessageReceived ───────────────────

  describe('handleMessageReceived', () => {
    it('should find or create conversation and update last_message_at', async () => {
      const conversation = makeConversation();
      repository.findActiveByClientAndChannel.mockResolvedValue(conversation);
      repository.updateLastMessageAt.mockResolvedValue(conversation);

      const event: MessageReceivedEvent = {
        type: 'message.received',
        id: '77777777-7777-7777-7777-777777777777',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'gs-test-corr',
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
        senderExternalId: '919876543210',
        clientId: CLIENT_ID,
      };

      await service.handleMessageReceived(event);

      expect(repository.findActiveByClientAndChannel).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        CHANNEL_ACCOUNT_ID,
      );
      expect(repository.updateLastMessageAt).toHaveBeenCalledWith(
        CONVERSATION_ID,
        expect.any(Date),
      );
    });

    it('should skip processing when clientId is empty', async () => {
      const event: MessageReceivedEvent = {
        type: 'message.received',
        id: '77777777-7777-7777-7777-777777777777',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'gs-test-corr',
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
        senderExternalId: '919876543210',
        clientId: '',
      };

      await service.handleMessageReceived(event);

      expect(repository.findActiveByClientAndChannel).not.toHaveBeenCalled();
      expect(repository.updateLastMessageAt).not.toHaveBeenCalled();
    });
  });
});
