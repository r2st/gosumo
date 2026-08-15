/**
 * Message ↔ conversation critical flows — integration test.
 *
 * The unit specs for these two modules each mock the other, which means the
 * handoff between them — the part that is actually wired by events rather than
 * by a function call — is asserted nowhere. This file wires the *real*
 * ConversationService and MessageService into a real Nest container with a real
 * EventEmitter2, so the `@OnEvent` registrations are themselves under test, and
 * drives the flows that carry live customer traffic:
 *
 *   message.received      → conversation found or created, last_message_at bumped
 *   message.received      → a RESOLVED / SNOOZED thread auto-reopens
 *   storeInboundMessage   → message.stored emitted, deduplicated by external_id
 *   message.stored        → human replies counted, AI replies not
 *   task.resolved         → ESCALATED returns to OPEN
 *   ai.response.approved  → PENDING_HUMAN returns to OPEN
 *   resolve / snooze      → state machine + open-task interlock
 *
 * Only the I/O edges are faked: Prisma (behind both repositories), the Bull
 * queue, and TenantService. The two fakes are real in-memory stores rather than
 * jest.fn()s returning canned rows, because what is under test *is* the
 * bookkeeping — a repository mock that always returns the same conversation
 * would pass every assertion here while production created a new thread per
 * message.
 *
 * What this catches that the unit specs cannot: an `@OnEvent` name that no
 * longer matches what the emitter sends, a reopen path that updates status
 * without telling anyone, a dedupe that stores the message anyway, or a
 * counter incremented for the wrong sender type.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bull';
import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { conversations, messages } from '@prisma/client';
import {
  ChannelType,
  ConversationStatus,
  MessageDirection,
  MessageReceivedEvent,
  MessageStatus,
  MessageStoredEvent,
} from '@gosumo/shared';

import { PrismaService } from '../../src/common/services/prisma.service';
import { TenantService } from '../../src/modules/tenant/tenant.service';
import { ConversationService } from '../../src/modules/conversation/conversation.service';
import {
  ConversationRepository,
  CreateConversationData,
  UpdateConversationData,
} from '../../src/modules/conversation/conversation.repository';
import { CONVERSATION_QUEUE } from '../../src/modules/conversation/conversation.constants';
import { MessageService } from '../../src/modules/message/message.service';
import {
  CreateMessageData,
  MessageRepository,
} from '../../src/modules/message/message.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS_ID = '00000000-0000-4000-a000-0000000000b2';
const CLIENT_ID = '00000000-0000-4000-a000-000000000010';
const CHANNEL_ACCOUNT_ID = '00000000-0000-4000-a000-000000000020';
const AGENT_ID = '00000000-0000-4000-a000-000000000030';

// ─────────────────────────────────────────────
// In-memory stores
//
// These implement the repository surface the two services actually call, with
// the semantics the services depend on: business scoping on every read, a
// status-blind newest-first thread lookup (which is what lets a resolved thread
// reopen instead of forking), and creation defaults matching the real Prisma
// writes.
// ─────────────────────────────────────────────

class FakeConversationRepository {
  private readonly rows = new Map<string, conversations>();
  private seq = 0;

  async findById(businessId: string, id: string): Promise<conversations | null> {
    const row = this.rows.get(id);
    // Scope on read exactly as the Prisma query does; a fake that ignored
    // businessId would let a cross-tenant test pass.
    return row && row.business_id === businessId && !row.deleted_at ? row : null;
  }

  async findLatestByClientAndChannel(
    businessId: string,
    clientId: string,
    channelAccountId: string,
  ): Promise<conversations | null> {
    // Status-blind, newest first — matching the real query. A RESOLVED thread
    // comes back so the handler can reopen it instead of forking a duplicate.
    const matches = [...this.rows.values()]
      .filter(
        (row) =>
          row.business_id === businessId &&
          row.client_id === clientId &&
          row.channel_account_id === channelAccountId &&
          !row.deleted_at,
      )
      .sort(
        (a, b) =>
          (b.last_message_at?.getTime() ?? 0) - (a.last_message_at?.getTime() ?? 0),
      );
    return matches[0] ?? null;
  }

  async create(data: CreateConversationData): Promise<conversations> {
    const now = new Date();
    this.seq += 1;
    const row = {
      id: `conv-${this.seq}`,
      business_id: data.businessId,
      client_id: data.clientId,
      channel_account_id: data.channelAccountId,
      channel: data.channel,
      status: ConversationStatus.OPEN,
      assigned_to: null,
      first_message_at: now,
      last_message_at: now,
      resolved_at: null,
      snoozed_until: null,
      subject: null,
      current_topic: null,
      csat_score: null,
      csat_submitted_at: null,
      message_count: 0,
      unread_count: 0,
      human_message_count: 0,
      tags: [] as string[],
      metadata: {},
      created_at: now,
      updated_at: now,
      deleted_at: null,
    } as unknown as conversations;
    this.rows.set(row.id, row);
    return row;
  }

  async updateStatus(
    businessId: string,
    id: string,
    status: ConversationStatus,
  ): Promise<conversations> {
    const row = await this.require(businessId, id);
    const next = { ...row, status } as conversations;
    if (status === ConversationStatus.RESOLVED) {
      next.resolved_at = new Date();
    } else if (status === ConversationStatus.OPEN) {
      next.resolved_at = null;
    }
    this.rows.set(id, next);
    return next;
  }

  /**
   * Compare-and-swap, same contract as the real repository: the write only
   * lands if the row is still in `expectedStatus`, and a caller that lost gets
   * `null` rather than a silent overwrite. Modelling the losing branch here is
   * the point — a fake that always succeeds cannot tell the two apart.
   */
  async transitionStatus(
    businessId: string,
    id: string,
    expectedStatus: ConversationStatus,
    status: ConversationStatus,
    extra: Omit<UpdateConversationData, 'status'> = {},
  ): Promise<conversations | null> {
    const row = await this.findById(businessId, id);
    if (!row || row.status !== expectedStatus) return null;

    const data: UpdateConversationData = { ...extra, status };
    if (status === ConversationStatus.RESOLVED) {
      data.resolvedAt = extra.resolvedAt ?? new Date();
    } else if (status === ConversationStatus.OPEN) {
      data.resolvedAt = null;
    }
    return this.update(businessId, id, data);
  }

  async update(
    businessId: string,
    id: string,
    data: UpdateConversationData,
  ): Promise<conversations> {
    const row = await this.require(businessId, id);
    const next = { ...row } as conversations;
    // `undefined` leaves a column untouched, `null` clears it — the same
    // distinction the real repository makes.
    if (data.status !== undefined) next.status = data.status;
    if (data.assignedTo !== undefined) next.assigned_to = data.assignedTo;
    if (data.resolvedAt !== undefined) next.resolved_at = data.resolvedAt;
    if (data.snoozedUntil !== undefined) next.snoozed_until = data.snoozedUntil;
    if (data.tags !== undefined) next.tags = data.tags;
    if (data.csatScore !== undefined) next.csat_score = data.csatScore as never;
    if (data.csatSubmittedAt !== undefined) next.csat_submitted_at = data.csatSubmittedAt;
    if (data.metadata !== undefined) next.metadata = data.metadata as never;
    this.rows.set(id, next);
    return next;
  }

  async updateLastMessageAt(
    businessId: string,
    id: string,
    at: Date,
  ): Promise<void> {
    const row = await this.findById(businessId, id);
    if (!row) return;
    this.rows.set(id, { ...row, last_message_at: at } as conversations);
  }

  async incrementHumanMessageCount(businessId: string, id: string): Promise<void> {
    const row = await this.findById(businessId, id);
    if (!row) return;
    this.rows.set(id, {
      ...row,
      human_message_count: row.human_message_count + 1,
    } as conversations);
  }

  async assign(businessId: string, id: string, assigneeId: string): Promise<conversations> {
    return this.update(businessId, id, { assignedTo: assigneeId });
  }

  private async require(businessId: string, id: string): Promise<conversations> {
    const row = await this.findById(businessId, id);
    if (!row) {
      throw new NotFoundException(`Conversation not found: ${id}`);
    }
    return row;
  }
}

class FakeMessageRepository {
  private readonly rows: messages[] = [];
  private seq = 0;

  async create(data: CreateMessageData): Promise<messages> {
    this.seq += 1;
    const row = {
      id: `msg-${this.seq}`,
      business_id: data.business_id,
      conversation_id: data.conversation_id,
      channel_account_id: data.channel_account_id,
      direction: data.direction,
      type: data.type ?? 'TEXT',
      status: data.status ?? MessageStatus.PENDING,
      sender_type: data.sender_type,
      sender_id: data.sender_id ?? null,
      content: data.content,
      text_content: data.text_content ?? null,
      external_id: data.external_id ?? null,
      is_ai_generated: data.is_ai_generated ?? false,
      confidence_score: data.confidence_score ?? null,
      ai_decision_id: data.ai_decision_id ?? null,
      metadata: data.metadata ?? {},
      reactions: [],
      delivered_at: null,
      read_at: null,
      failed_at: null,
      failure_reason: null,
      // Monotonic per row so keyset pagination has a stable order without the
      // test depending on how fast it runs.
      created_at: new Date(1_700_000_000_000 + this.seq * 1_000),
    } as unknown as messages;
    this.rows.push(row);
    return row;
  }

  async findById(businessId: string, id: string): Promise<messages | null> {
    return this.rows.find((m) => m.id === id && m.business_id === businessId) ?? null;
  }

  async findByExternalId(businessId: string, externalId: string): Promise<messages | null> {
    return (
      this.rows.find(
        (m) => m.business_id === businessId && m.external_id === externalId,
      ) ?? null
    );
  }

  async findByConversation(
    businessId: string,
    conversationId: string,
    opts: { limit: number; cursor?: { createdAt: string; id: string } },
  ): Promise<messages[]> {
    const scoped = this.rows
      .filter((m) => m.business_id === businessId && m.conversation_id === conversationId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    const start = opts.cursor
      ? scoped.findIndex((m) => m.id === opts.cursor!.id) + 1
      : 0;
    // Over-fetch by one, which is how the service detects `hasMore`.
    return scoped.slice(start, start + opts.limit + 1);
  }

  async getLastN(
    businessId: string,
    conversationId: string,
    n: number,
  ): Promise<messages[]> {
    const scoped = await this.findByConversation(businessId, conversationId, {
      limit: Number.MAX_SAFE_INTEGER - 1,
    });
    return scoped.slice(0, n);
  }

  async updateStatus(
    businessId: string,
    id: string,
    status: MessageStatus,
    timestamps: {
      deliveredAt?: string;
      readAt?: string;
      failedAt?: string;
      failureReason?: string;
    },
  ): Promise<messages> {
    const row = await this.findById(businessId, id);
    if (!row) throw new NotFoundException(id);
    row.status = status;
    if (timestamps.deliveredAt) row.delivered_at = new Date(timestamps.deliveredAt);
    if (timestamps.readAt) row.read_at = new Date(timestamps.readAt);
    if (timestamps.failedAt) row.failed_at = new Date(timestamps.failedAt);
    if (timestamps.failureReason) row.failure_reason = timestamps.failureReason;
    return row;
  }

  async getStats(
    businessId: string,
    conversationId: string,
  ): Promise<{
    total: number;
    inbound: number;
    outbound: number;
    aiGenerated: number;
    byStatus: Record<string, number>;
  }> {
    const scoped = this.rows.filter(
      (m) => m.business_id === businessId && m.conversation_id === conversationId,
    );
    const byStatus: Record<string, number> = {};
    for (const m of scoped) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
    return {
      total: scoped.length,
      inbound: scoped.filter((m) => m.direction === MessageDirection.INBOUND).length,
      outbound: scoped.filter((m) => m.direction === MessageDirection.OUTBOUND).length,
      aiGenerated: scoped.filter((m) => m.is_ai_generated).length,
      byStatus,
    };
  }

  async createFileUpload(): Promise<never> {
    throw new Error('not used by these flows');
  }

  /** Test affordance — not part of the production surface. */
  all(): messages[] {
    return this.rows;
  }
}

describe('message ↔ conversation flows (integration)', () => {
  let module: TestingModule;
  let events: EventEmitter2;
  let conversationService: ConversationService;
  let messageService: MessageService;
  let conversationRepo: FakeConversationRepository;
  let messageRepo: FakeMessageRepository;
  let openTaskCount: number;
  let queuedJobs: { name: string; data: unknown; opts: unknown }[];

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    conversationRepo = new FakeConversationRepository();
    messageRepo = new FakeMessageRepository();
    openTaskCount = 0;
    queuedJobs = [];

    module = await Test.createTestingModule({
      // A real emitter with the production configuration, so the `@OnEvent`
      // bindings on both services are the ones being exercised.
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [
        ConversationService,
        MessageService,
        { provide: ConversationRepository, useValue: conversationRepo },
        { provide: MessageRepository, useValue: messageRepo },
        {
          provide: PrismaService,
          useValue: { tasks: { count: jest.fn(async () => openTaskCount) } },
        },
        {
          provide: TenantService,
          useValue: {
            // Membership is checked against (business, member), not business
            // alone — the whole point of the guard is that a *member id from
            // another tenant* is refused on a correctly-scoped request.
            assertAssignableTeamMember: jest.fn(async (businessId: string, memberId: string) => {
              if (businessId !== BUSINESS_ID || memberId !== AGENT_ID) {
                throw new NotFoundException('Team member not found');
              }
            }),
            filterAssignableTeamMembers: jest.fn(
              async (businessId: string, memberIds: string[]) =>
                businessId === BUSINESS_ID ? memberIds.filter((id) => id === AGENT_ID) : [],
            ),
          },
        },
        {
          provide: getQueueToken(CONVERSATION_QUEUE),
          useValue: {
            add: jest.fn(async (name: string, data: unknown, opts: unknown) => {
              queuedJobs.push({ name, data, opts });
            }),
          },
        },
      ],
    }).compile();

    await module.init();

    events = module.get(EventEmitter2);
    conversationService = module.get(ConversationService);
    messageService = module.get(MessageService);
  });

  afterEach(async () => {
    await module.close();
  });

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  /**
   * `MessageService` emits `message.stored` with a plain `emit()`, which invokes
   * async listeners without awaiting them. Draining the microtask queue is what
   * makes the listener's effects observable; asserting immediately would race it
   * and fail intermittently.
   */
  const flushEvents = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));

  const inboundEvent = (
    overrides: Partial<MessageReceivedEvent> = {},
  ): MessageReceivedEvent =>
    ({
      type: 'message.received',
      id: 'evt-1',
      timestamp: new Date().toISOString(),
      businessId: BUSINESS_ID,
      correlationId: 'corr-1',
      messageId: 'ext-1',
      conversationId: null,
      clientId: CLIENT_ID,
      channelAccountId: CHANNEL_ACCOUNT_ID,
      channel: ChannelType.WHATSAPP,
      ...overrides,
    }) as unknown as MessageReceivedEvent;

  const receive = async (
    overrides: Partial<MessageReceivedEvent> = {},
  ): Promise<void> => {
    await events.emitAsync('message.received', inboundEvent(overrides));
  };

  const storeInbound = (
    conversationId: string,
    externalId: string,
    text = 'hello',
  ): Promise<messages> =>
    messageService.storeInboundMessage(BUSINESS_ID, {
      conversationId,
      channelAccountId: CHANNEL_ACCOUNT_ID,
      channel: ChannelType.WHATSAPP,
      senderType: 'CLIENT',
      senderId: CLIENT_ID,
      content: { type: 'TEXT', text },
      textContent: text,
      externalId,
    } as Parameters<MessageService['storeInboundMessage']>[1]);

  const storeOutbound = (
    conversationId: string,
    senderType: string,
    overrides: Record<string, unknown> = {},
  ): Promise<messages> =>
    messageService.storeOutboundMessage(BUSINESS_ID, {
      conversationId,
      channelAccountId: CHANNEL_ACCOUNT_ID,
      channel: ChannelType.WHATSAPP,
      senderType,
      senderId: AGENT_ID,
      content: { type: 'TEXT', text: 'reply' },
      textContent: 'reply',
      ...overrides,
    } as Parameters<MessageService['storeOutboundMessage']>[1]);

  /** Drive an inbound event and hand back the conversation it landed on. */
  const receiveAndGet = async (): Promise<conversations> => {
    await receive();
    const conversation = await conversationRepo.findLatestByClientAndChannel(
      BUSINESS_ID,
      CLIENT_ID,
      CHANNEL_ACCOUNT_ID,
    );
    if (!conversation) throw new Error('expected a conversation to exist');
    return conversation;
  };

  // ─────────────────────────────────────────────

  describe('inbound message → conversation', () => {
    it('creates a conversation for a client with no active thread', async () => {
      const created: unknown[] = [];
      events.on('conversation.created', (e) => created.push(e));

      const conversation = await receiveAndGet();

      expect(conversation.status).toBe(ConversationStatus.OPEN);
      expect(conversation.client_id).toBe(CLIENT_ID);
      expect(created).toHaveLength(1);
    });

    it('reuses the active thread instead of forking a second one', async () => {
      const first = await receiveAndGet();
      const second = await receiveAndGet();

      // One active conversation per (business, client, channel account) is the
      // invariant the whole inbox depends on.
      expect(second.id).toBe(first.id);
    });

    it('bumps last_message_at on every inbound message', async () => {
      const first = await receiveAndGet();
      const before = first.last_message_at;

      await new Promise((r) => setTimeout(r, 5));
      const after = (await receiveAndGet()).last_message_at;

      expect(after!.getTime()).toBeGreaterThan(before!.getTime());
    });

    it('ignores an event whose client has not been resolved yet', async () => {
      await receive({ clientId: null as unknown as string });

      expect(
        await conversationRepo.findLatestByClientAndChannel(
          BUSINESS_ID,
          CLIENT_ID,
          CHANNEL_ACCOUNT_ID,
        ),
      ).toBeNull();
    });

    it('keeps a repository failure from escaping into the emitter', async () => {
      jest
        .spyOn(conversationRepo, 'updateLastMessageAt')
        .mockRejectedValueOnce(new Error('connection lost'));

      // The handler runs on an event, not a request — throwing here would take
      // down whatever else is listening to the same message.
      await expect(receive()).resolves.toBeUndefined();
    });
  });

  describe('auto-reopen on a new customer message', () => {
    /**
     * The module's documented rule (`modules/conversation/CLAUDE.md`): "a
     * resolved conversation is auto-reopened when a new message arrives from
     * the same client; never create a duplicate."
     *
     * This used to be the one place the code disagreed with that doc —
     * `findOrCreate` looked the thread up through a query that filtered
     * RESOLVED out, so the client got a second thread and the RESOLVED arm of
     * the reopen branch was dead code. The lookup is status-blind now; these
     * two tests are what keeps it that way.
     */
    it('reopens the RESOLVED thread rather than starting a second one', async () => {
      const conversation = await receiveAndGet();
      await conversationService.resolveConversation(BUSINESS_ID, conversation.id);

      await receive();

      const reopened = await conversationRepo.findById(
        BUSINESS_ID,
        conversation.id,
      );
      expect(reopened!.status).toBe(ConversationStatus.OPEN);
      // Reopening clears the resolution timestamp, so the SLA clock restarts.
      expect(reopened!.resolved_at).toBeNull();
      // …and the lookup still lands on that same single thread.
      const latest = await conversationRepo.findLatestByClientAndChannel(
        BUSINESS_ID,
        CLIENT_ID,
        CHANNEL_ACCOUNT_ID,
      );
      expect(latest!.id).toBe(conversation.id);
    });

    it('emits RESOLVED → OPEN for the reopened thread, and no second conversation.created', async () => {
      const conversation = await receiveAndGet();
      await conversationService.resolveConversation(BUSINESS_ID, conversation.id);

      const changes: unknown[] = [];
      const created: unknown[] = [];
      events.on('conversation.status.changed', (e) => changes.push(e));
      events.on('conversation.created', (e) => created.push(e));

      await receive();

      expect(changes).toEqual([
        expect.objectContaining({
          conversationId: conversation.id,
          previousStatus: ConversationStatus.RESOLVED,
          newStatus: ConversationStatus.OPEN,
        }),
      ]);
      expect(created).toEqual([]);
    });

    it('reopens a SNOOZED thread before its wake job is due', async () => {
      const conversation = await receiveAndGet();
      await conversationService.snoozeConversation(
        BUSINESS_ID,
        conversation.id,
        new Date(Date.now() + 60 * 60 * 1000),
      );

      await receive();

      expect(
        (await conversationRepo.findById(BUSINESS_ID, conversation.id))!.status,
      ).toBe(ConversationStatus.OPEN);
    });

    it('leaves an already-OPEN thread alone', async () => {
      const conversation = await receiveAndGet();
      const changes: unknown[] = [];
      events.on('conversation.status.changed', (e) => changes.push(e));

      await receive();

      // A status-changed event for OPEN → OPEN would be noise every dashboard
      // client has to filter out.
      expect(changes).toEqual([]);
      expect(
        (await conversationRepo.findById(BUSINESS_ID, conversation.id))!.status,
      ).toBe(ConversationStatus.OPEN);
    });
  });

  describe('message storage', () => {
    it('emits message.stored for an inbound message', async () => {
      const conversation = await receiveAndGet();
      const stored: MessageStoredEvent[] = [];
      events.on('message.stored', (e) => stored.push(e as MessageStoredEvent));

      const message = await storeInbound(conversation.id, 'ext-100');

      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        messageId: message.id,
        conversationId: conversation.id,
        direction: MessageDirection.INBOUND,
        channel: ChannelType.WHATSAPP,
      });
    });

    it('deduplicates a redelivered inbound message by external id', async () => {
      const conversation = await receiveAndGet();
      const first = await storeInbound(conversation.id, 'ext-dup');
      const stored: unknown[] = [];
      events.on('message.stored', (e) => stored.push(e));

      const second = await storeInbound(conversation.id, 'ext-dup', 'hello again');

      // Channels retry; storing twice would double-count and re-trigger the AI.
      expect(second.id).toBe(first.id);
      expect(messageRepo.all()).toHaveLength(1);
      expect(stored).toEqual([]);
    });

    it('scopes dedupe to the business, so two tenants can share an external id', async () => {
      const conversation = await receiveAndGet();
      await storeInbound(conversation.id, 'ext-shared');

      const other = await messageService.storeInboundMessage(OTHER_BUSINESS_ID, {
        conversationId: 'conv-other',
        channelAccountId: CHANNEL_ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
        senderType: 'CLIENT',
        senderId: CLIENT_ID,
        content: { type: 'TEXT', text: 'hi' },
        textContent: 'hi',
        externalId: 'ext-shared',
      } as Parameters<MessageService['storeInboundMessage']>[1]);

      // Channel message ids are only unique within the channel account, so a
      // global dedupe would silently drop another tenant's message.
      expect(messageRepo.all()).toHaveLength(2);
      expect(other.business_id).toBe(OTHER_BUSINESS_ID);
    });

    it('refuses to read a message belonging to another tenant', async () => {
      const conversation = await receiveAndGet();
      const message = await storeInbound(conversation.id, 'ext-tenant');

      await expect(
        messageService.getMessageById(OTHER_BUSINESS_ID, message.id),
      ).rejects.toThrow(NotFoundException);
    });

    it('records the reply pointer for a threaded message', async () => {
      const conversation = await receiveAndGet();
      const root = await storeInbound(conversation.id, 'ext-root');

      const reply = await storeOutbound(conversation.id, 'HUMAN_AGENT', {
        replyToMessageId: root.id,
      });

      expect(reply.metadata).toMatchObject({ reply_to_message_id: root.id });
    });
  });

  describe('human-reply accounting (message.stored listener)', () => {
    it('counts an outbound message sent by a human agent', async () => {
      const conversation = await receiveAndGet();

      await storeOutbound(conversation.id, 'HUMAN_AGENT');
      await flushEvents();

      expect(
        (await conversationRepo.findById(BUSINESS_ID, conversation.id))!
          .human_message_count,
      ).toBe(1);
    });

    it('does not count an AI reply as a human handoff', async () => {
      const conversation = await receiveAndGet();

      await storeOutbound(conversation.id, 'AI', {
        isAiGenerated: true,
        confidenceScore: 0.95,
      });
      await flushEvents();

      // human_message_count drives the AI-containment metric; counting AI
      // replies would report every autonomous conversation as human-handled.
      expect(
        (await conversationRepo.findById(BUSINESS_ID, conversation.id))!
          .human_message_count,
      ).toBe(0);
    });

    it('does not count an inbound message from the customer', async () => {
      const conversation = await receiveAndGet();

      await storeInbound(conversation.id, 'ext-inbound-count');
      await flushEvents();

      expect(
        (await conversationRepo.findById(BUSINESS_ID, conversation.id))!
          .human_message_count,
      ).toBe(0);
    });
  });

  describe('lifecycle interlocks', () => {
    it('refuses to resolve while an open HITL task references the thread', async () => {
      const conversation = await receiveAndGet();
      openTaskCount = 1;

      await expect(
        conversationService.resolveConversation(BUSINESS_ID, conversation.id),
      ).rejects.toThrow(ConflictException);
      expect(
        (await conversationRepo.findById(BUSINESS_ID, conversation.id))!.status,
      ).toBe(ConversationStatus.OPEN);
    });

    it('rejects a transition the state machine does not allow', async () => {
      const conversation = await receiveAndGet();
      await conversationService.resolveConversation(BUSINESS_ID, conversation.id);

      // RESOLVED may only go back to OPEN.
      await expect(
        conversationService.updateStatus(
          BUSINESS_ID,
          conversation.id,
          ConversationStatus.ESCALATED,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('schedules a wake job when a thread is snoozed', async () => {
      const conversation = await receiveAndGet();
      const until = new Date(Date.now() + 2 * 60 * 60 * 1000);

      await conversationService.snoozeConversation(BUSINESS_ID, conversation.id, until);

      expect(queuedJobs).toHaveLength(1);
      expect(queuedJobs[0]!.opts).toMatchObject({
        jobId: expect.stringContaining(conversation.id),
      });
    });

    it('refuses a snooze beyond the 7-day maximum', async () => {
      const conversation = await receiveAndGet();

      await expect(
        conversationService.snoozeConversation(
          BUSINESS_ID,
          conversation.id,
          new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(queuedJobs).toEqual([]);
    });

    it('refuses to escalate to another tenant’s team member', async () => {
      const conversation = await receiveAndGet();

      // `assigned_to` arrives in the request body, unscoped by @TenantId(), and
      // its foreign key is satisfied by any real member row — so without the
      // membership check this write would succeed against another business.
      await expect(
        conversationService.escalateConversation(BUSINESS_ID, conversation.id, {
          assignedToMemberId: 'member-from-another-business',
        }),
      ).rejects.toThrow(NotFoundException);

      // Refused before the write, not rolled back after it.
      const untouched = await conversationRepo.findById(BUSINESS_ID, conversation.id);
      expect(untouched!.status).toBe(ConversationStatus.OPEN);
      expect(untouched!.assigned_to).toBeNull();
    });

    it('allows an escalation to this tenant’s own team member', async () => {
      const conversation = await receiveAndGet();

      await conversationService.escalateConversation(BUSINESS_ID, conversation.id, {
        assignedToMemberId: AGENT_ID,
      });

      const escalated = await conversationRepo.findById(BUSINESS_ID, conversation.id);
      expect(escalated!.status).toBe(ConversationStatus.ESCALATED);
      expect(escalated!.assigned_to).toBe(AGENT_ID);
    });
  });

  describe('task.resolved / ai.response.approved listeners', () => {
    it('returns an ESCALATED thread to OPEN when its task is resolved', async () => {
      const conversation = await receiveAndGet();
      await conversationService.escalateConversation(BUSINESS_ID, conversation.id, {});

      await events.emitAsync('task.resolved', {
        type: 'task.resolved',
        businessId: BUSINESS_ID,
        conversationId: conversation.id,
        resolvedByMemberId: AGENT_ID,
      });

      expect(
        (await conversationRepo.findById(BUSINESS_ID, conversation.id))!.status,
      ).toBe(ConversationStatus.OPEN);
    });

    it('leaves a thread that is not ESCALATED untouched on task.resolved', async () => {
      const conversation = await receiveAndGet();

      await events.emitAsync('task.resolved', {
        type: 'task.resolved',
        businessId: BUSINESS_ID,
        conversationId: conversation.id,
        resolvedByMemberId: AGENT_ID,
      });

      expect(
        (await conversationRepo.findById(BUSINESS_ID, conversation.id))!.status,
      ).toBe(ConversationStatus.OPEN);
    });

    it('returns a PENDING_HUMAN thread to OPEN when a draft is approved', async () => {
      const conversation = await receiveAndGet();
      await conversationService.updateStatus(
        BUSINESS_ID,
        conversation.id,
        ConversationStatus.PENDING_HUMAN,
      );

      await events.emitAsync('ai.response.approved', {
        type: 'ai.response.approved',
        businessId: BUSINESS_ID,
        conversationId: conversation.id,
        approvedByMemberId: AGENT_ID,
      });

      expect(
        (await conversationRepo.findById(BUSINESS_ID, conversation.id))!.status,
      ).toBe(ConversationStatus.OPEN);
    });

    it('ignores an approval for a conversation that no longer exists', async () => {
      await expect(
        events.emitAsync('ai.response.approved', {
          type: 'ai.response.approved',
          businessId: BUSINESS_ID,
          conversationId: 'conv-missing',
          approvedByMemberId: AGENT_ID,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('message retrieval', () => {
    it('pages through a conversation newest-first without repeating a message', async () => {
      const conversation = await receiveAndGet();
      for (let i = 0; i < 5; i += 1) {
        await storeInbound(conversation.id, `ext-page-${i}`, `message ${i}`);
      }

      const firstPage = await messageService.getConversationMessages(
        BUSINESS_ID,
        conversation.id,
        { limit: 2 } as Parameters<MessageService['getConversationMessages']>[2],
      );
      expect(firstPage.data).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);

      const secondPage = await messageService.getConversationMessages(
        BUSINESS_ID,
        conversation.id,
        { limit: 2, cursor: firstPage.cursor! } as Parameters<
          MessageService['getConversationMessages']
        >[2],
      );

      const ids = [...firstPage.data, ...secondPage.data].map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      // Newest first: the last message stored leads the first page.
      expect(firstPage.data[0]!.text_content).toBe('message 4');
    });

    it('rejects a corrupt pagination cursor', async () => {
      const conversation = await receiveAndGet();

      await expect(
        messageService.getConversationMessages(BUSINESS_ID, conversation.id, {
          cursor: 'not-base64-json',
        } as Parameters<MessageService['getConversationMessages']>[2]),
      ).rejects.toThrow(BadRequestException);
    });

    it('reports stats across both directions of a conversation', async () => {
      const conversation = await receiveAndGet();
      await storeInbound(conversation.id, 'ext-s1');
      await storeOutbound(conversation.id, 'AI', {
        isAiGenerated: true,
        confidenceScore: 0.9,
      });
      await storeOutbound(conversation.id, 'HUMAN_AGENT');

      const stats = await messageService.getMessageStats(BUSINESS_ID, conversation.id);

      expect(stats).toMatchObject({
        total: 3,
        inbound: 1,
        outbound: 2,
        aiGenerated: 1,
      });
    });

    it('returns nothing for a conversation belonging to another tenant', async () => {
      const conversation = await receiveAndGet();
      await storeInbound(conversation.id, 'ext-iso');

      expect(
        await messageService.getLastNMessages(OTHER_BUSINESS_ID, conversation.id, 10),
      ).toEqual([]);
    });
  });

  describe('delivery status (message.sent / message.failed listeners)', () => {
    it('marks a message SENT when the channel confirms it', async () => {
      const conversation = await receiveAndGet();
      const message = await storeOutbound(conversation.id, 'AI', {
        externalId: 'wamid-1',
      });

      await events.emitAsync('message.sent', {
        type: 'message.sent',
        businessId: BUSINESS_ID,
        messageId: message.id,
        externalMessageId: 'wamid-1',
      });

      expect((await messageRepo.findById(BUSINESS_ID, message.id))!.status).toBe(
        MessageStatus.SENT,
      );
    });

    it('marks a message FAILED with the reason the channel gave', async () => {
      const conversation = await receiveAndGet();
      const message = await storeOutbound(conversation.id, 'AI');

      await events.emitAsync('message.failed', {
        type: 'message.failed',
        businessId: BUSINESS_ID,
        messageId: message.id,
        reason: 'recipient opted out',
      });

      const updated = await messageRepo.findById(BUSINESS_ID, message.id);
      expect(updated!.status).toBe(MessageStatus.FAILED);
      expect(updated!.failure_reason).toBe('recipient opted out');
    });

    it('ignores a delivery receipt for an unknown external id', async () => {
      await expect(
        events.emitAsync('message.sent', {
          type: 'message.sent',
          businessId: BUSINESS_ID,
          messageId: 'msg-missing',
          externalMessageId: 'wamid-unknown',
        }),
      ).resolves.toBeDefined();
    });
  });
});
