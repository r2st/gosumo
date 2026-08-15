/**
 * The critical path, end to end, for every channel.
 *
 * A message arriving is the one flow the whole product is: it must normalize,
 * become rows, announce itself, wake the conversation, and reach the AI. Each
 * leg is well covered in isolation — the adapters have their own suites, the
 * persistence path has one, `ConversationService` and `AiEngineService` have
 * theirs — and the joint between them is covered by nothing.
 *
 * That joint is `message.received`, and it has an unusual shape: there are
 * **two producers**. `ChannelAdapterService.persistAndAnnounce` emits it for
 * every HTTP channel; `WebChatGateway.handleMessage` builds and emits its own,
 * because web chat is a socket and never passes through the service. So the
 * event has to be right twice, from two files that share no code.
 *
 * And the consumers fail *silently* when it is not. Every one of them guards:
 *
 *   - `AiEngineService`      skips an event with no `conversationId`/`messageId`
 *   - `ConversationService`  skips an event with no `clientId`
 *   - `RealtyLeadsService`   skips an event with no `senderPhone`
 *   - the realty bridge      resolves delivery from `senderExternalId`
 *
 * Each guard is a `logger.debug` and a `return`. A channel whose event lost a
 * field therefore stops being answered by the AI, or stops bumping its
 * conversation, with no error, no failed test, and no log above debug — the
 * inbox simply goes quiet for that one channel while the other four look fine.
 *
 * So this suite drives all five channels through their real entry point, and
 * for each one asserts the event carries what every consumer needs, then hands
 * that exact event to the real `ConversationService` and `AiEngineService`
 * handlers and checks neither takes its skip branch.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bull';
import { Socket } from 'socket.io';
import { withMessageSequence } from '../common/testing/message-sequence.mock';
import {
  ChannelType,
  MessageContentType,
  MessageReceivedEvent,
  NormalizedMessage,
  RawRequest,
} from '@gosumo/shared';

import { ChannelAdapterService } from './channel-adapter/channel-adapter.service';
import { WebChatGateway } from './channel-adapter/gateways/webchat.gateway';
import { WebChatThrottle } from './channel-adapter/gateways/webchat-throttle';
import { PrismaService } from './../common/services/prisma.service';
import { WebhookDlqService } from './webhook-log/webhook-dlq.service';
import { ConversationLockService } from './../common/services/conversation-lock.service';
import { ConversationService } from './conversation/conversation.service';
import { ConversationRepository } from './conversation/conversation.repository';
import { TenantService } from './tenant/tenant.service';
import { CONVERSATION_QUEUE } from './conversation/conversation.constants';
import { AiEngineService } from './ai-engine/ai-engine.service';
import { ContextLoaderService } from './ai-engine/pipeline/context-loader.service';
import { RealtyTenantService } from './ai-engine/realty/realty-tenant.service';
import { signWebChatSession } from './../common/utils/webchat-session.util';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-b000-000000000001';
const CLIENT_ID = '00000000-0000-4000-c000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-e000-000000000001';
const MESSAGE_ROW_ID = '00000000-0000-4000-f000-000000000001';
const WIDGET_ID = '00000000-0000-4000-a000-000000000009';
const SECRET = 'critical-path-secret';

/**
 * One case per channel: how a message arrives, and what the sender's channel
 * address looks like when it does.
 *
 * `senderPhone` says whether the channel carries a phone identity at all —
 * WhatsApp and SMS do, and it must arrive E.164-normalized; the other three do
 * not, and a session id or a handle forced into a phone field is corruption
 * rather than a fallback, so consumers keyed on a person must skip instead.
 */
interface ChannelCase {
  channel: ChannelType;
  /** The sender id exactly as the channel delivers it. */
  senderExternalId: string;
  /** The E.164 phone the event must carry, or null when the channel has none. */
  expectedPhone: string | null;
}

const HTTP_CHANNELS: ChannelCase[] = [
  { channel: ChannelType.WHATSAPP, senderExternalId: '919876543210', expectedPhone: '+919876543210' },
  { channel: ChannelType.SMS, senderExternalId: '919876543211', expectedPhone: '+919876543211' },
  { channel: ChannelType.INSTAGRAM, senderExternalId: 'IG_SCOPED_USER_1', expectedPhone: null },
  { channel: ChannelType.EMAIL, senderExternalId: 'buyer@example.com', expectedPhone: null },
];

function normalizedFor(c: ChannelCase): NormalizedMessage {
  return {
    id: 'envelope-id',
    externalId: `ext_${c.channel}`,
    channel: c.channel,
    channelAccountId: `ACCOUNT_EXTERNAL_${c.channel}`,
    direction: 'INBOUND',
    sender: { externalId: c.senderExternalId, displayName: 'Priya Sharma' },
    content: { type: MessageContentType.TEXT, text: 'Do you have 2BHK in Andheri?' },
    timestamp: new Date('2026-08-15T10:00:00Z'),
    raw: {},
    metadata: {},
  } as NormalizedMessage;
}

function stubAdapter(c: ChannelCase) {
  return {
    channelType: c.channel,
    validateWebhook: jest.fn().mockReturnValue(true),
    parseInbound: jest.fn().mockReturnValue(normalizedFor(c)),
    sendMessage: jest.fn(),
    sendTemplate: jest.fn(),
    sendInteractive: jest.fn(),
    getCapabilities: jest.fn().mockReturnValue({ channelType: c.channel }),
  };
}

const REQ: RawRequest = { headers: {}, body: {}, rawBody: Buffer.from('{}') };

// ─────────────────────────────────────────────
// Prisma doubles
// ─────────────────────────────────────────────

function httpPrisma(channel: ChannelType) {
  const conversations = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: CONVERSATION_ID }),
    update: jest.fn().mockResolvedValue({}),
  };
  const messages = { create: jest.fn().mockResolvedValue({ id: MESSAGE_ROW_ID }) };
  return {
    doubles: { conversations, messages },
    // `withMessageSequence` teaches the double the two things storing a message
    // now needs: a `$transaction`, and a `conversations.update` that hands back
    // the claimed `message_seq`. Without it the allocator reads `undefined`.
    prisma: withMessageSequence({
      channel_accounts: {
        findFirst: jest.fn().mockResolvedValue({
          id: ACCOUNT_ID,
          business_id: BUSINESS_ID,
          channel,
          external_id: `ACCOUNT_EXTERNAL_${channel}`,
          is_active: true,
        }),
      },
      channel_contacts: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'contact-1',
          client_id: CLIENT_ID,
          client: { id: CLIENT_ID },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      clients: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: CLIENT_ID }),
        update: jest.fn().mockResolvedValue({}),
      },
      conversations,
      messages,
      webhook_events: {
        create: jest.fn().mockResolvedValue({ id: 'evt_1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    }) as unknown as PrismaService,
  };
}

function webchatPrisma() {
  const conversations = {
    findFirst: jest.fn().mockResolvedValue({ id: CONVERSATION_ID }),
    create: jest.fn().mockResolvedValue({ id: CONVERSATION_ID }),
    update: jest.fn().mockResolvedValue({}),
  };
  const messages = { create: jest.fn().mockResolvedValue({ id: MESSAGE_ROW_ID }) };
  const prisma = {
    channel_accounts: {
      findFirst: jest.fn().mockResolvedValue({
        id: WIDGET_ID,
        business_id: BUSINESS_ID,
        metadata: {},
      }),
    },
    channel_contacts: {
      findFirst: jest.fn().mockResolvedValue({ client: { id: CLIENT_ID } }),
      create: jest.fn(),
    },
    clients: { create: jest.fn() },
    conversations,
    messages,
    $transaction: jest.fn(),
  };
  withMessageSequence(prisma);
  return { doubles: { conversations, messages }, prisma };
}

function webchatSocket(id = 'socket-1'): Socket {
  return {
    id,
    handshake: { query: {}, headers: {} },
    emit: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as Socket;
}

// ─────────────────────────────────────────────
// Driving each channel to its emitted event
// ─────────────────────────────────────────────

interface Arrival {
  event: MessageReceivedEvent;
  /** The conversation row the arrival touched, for the "conversation updated" leg. */
  conversations: { update: jest.Mock; create: jest.Mock };
  messages: { create: jest.Mock };
}

async function arriveOverHttp(c: ChannelCase): Promise<Arrival> {
  const { prisma, doubles } = httpPrisma(c.channel);
  const emitter = { emit: jest.fn() };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ChannelAdapterService,
      { provide: PrismaService, useValue: prisma },
      { provide: EventEmitter2, useValue: emitter },
      {
        provide: WebhookDlqService,
        useValue: { capture: jest.fn(), registerReplayer: jest.fn() },
      },
      ConversationLockService,
    ],
  }).compile();

  const service = module.get(ChannelAdapterService);
  service.onModuleInit();
  service.registerAdapter(stubAdapter(c) as never);

  await service.handleInboundWebhook(c.channel, REQ, BUSINESS_ID);

  const call = emitter.emit.mock.calls.find(([name]) => name === 'message.received');
  if (!call) throw new Error(`${c.channel} emitted no message.received`);
  return {
    event: call[1] as MessageReceivedEvent,
    conversations: doubles.conversations,
    messages: doubles.messages,
  };
}

async function arriveOverWebSocket(): Promise<Arrival> {
  const { prisma, doubles } = webchatPrisma();
  const emitter = { emit: jest.fn() };

  const gateway = new WebChatGateway(
    prisma as unknown as PrismaService,
    emitter as unknown as EventEmitter2,
    {} as unknown as ChannelAdapterService,
    {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'jwt.secret' ? SECRET : fallback,
      ),
    } as unknown as ConfigService,
    new WebChatThrottle(),
  );

  const socket = webchatSocket();
  await gateway.handleInit(socket, {
    widgetId: WIDGET_ID,
    sessionId: signWebChatSession(WIDGET_ID, SECRET, 'session-1'),
  });
  await gateway.handleMessage(socket, { text: 'Do you have 2BHK in Andheri?' });

  const call = emitter.emit.mock.calls.find(([name]) => name === 'message.received');
  if (!call) throw new Error('web chat emitted no message.received');
  return {
    event: call[1] as MessageReceivedEvent,
    conversations: doubles.conversations,
    messages: doubles.messages,
  };
}

/** Every channel, keyed by how it arrives. */
const ARRIVALS: Array<[string, () => Promise<Arrival>, ChannelCase | null]> = [
  ...HTTP_CHANNELS.map(
    (c) => [c.channel, () => arriveOverHttp(c), c] as [string, () => Promise<Arrival>, ChannelCase],
  ),
  ['WEB_CHAT', arriveOverWebSocket, null],
];

describe('critical path — a message arrives on every channel', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────
  // Normalize → store
  // ─────────────────────────────────────────────

  describe('the message becomes a row', () => {
    it.each(ARRIVALS)('%s stores the inbound message under the resolved tenant', async (
      _label,
      arrive,
    ) => {
      const { messages } = await arrive();

      expect(messages.create).toHaveBeenCalledTimes(1);
      const data = (messages.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
      expect(data['business_id']).toBe(BUSINESS_ID);
      expect(data['conversation_id']).toBe(CONVERSATION_ID);
      expect(data['direction']).toBe('INBOUND');
    });
  });

  // ─────────────────────────────────────────────
  // The announced event
  // ─────────────────────────────────────────────

  describe('the announced event satisfies every consumer', () => {
    it.each(ARRIVALS)('%s emits exactly one message.received', async (_label, arrive) => {
      const { event } = await arrive();
      expect(event.type).toBe('message.received');
    });

    /**
     * The fields with a named consumer that silently drops the message without
     * them. Not a schema check — the type already does that for the producer
     * that annotates its literal; this is the runtime check that the values
     * were actually *resolved* rather than left as the empty string the
     * partial-event path publishes.
     */
    it.each(ARRIVALS)('%s resolves every id a consumer guards on', async (_label, arrive) => {
      const { event } = await arrive();

      // AiEngineService skips without these two.
      expect(event.conversationId).toBeTruthy();
      expect(event.messageId).toBeTruthy();
      // ConversationService skips without this one.
      expect(event.clientId).toBeTruthy();
      // ConversationService.findOrCreate needs both of these.
      expect(event.channelAccountId).toBeTruthy();
      expect(event.channel).toBeTruthy();
      // The realty bridge addresses its reply with this.
      expect(event.senderExternalId).toBeTruthy();
      // Every tenant-scoped consumer needs this, and RLS is the backstop.
      expect(event.businessId).toBe(BUSINESS_ID);
      // The trace that ties the pipeline's logs to this arrival.
      expect(event.correlationId).toBeTruthy();
    });

    it.each(ARRIVALS)('%s publishes the stored row id, not the envelope id', async (
      _label,
      arrive,
    ) => {
      const { event, messages } = await arrive();

      // `normalized.id` is a UUID the adapter minted for the in-memory
      // envelope; `messages.id` is what everything downstream joins on.
      // Publishing the former publishes an id nothing can be looked up by.
      const written = (messages.create.mock.calls[0]![0] as { data: { id?: string } }).data;
      expect(event.messageId).toBe(written.id ?? MESSAGE_ROW_ID);
      expect(event.messageId).not.toBe('envelope-id');
    });

    it.each(HTTP_CHANNELS.map((c) => [c.channel, c] as [string, ChannelCase]))(
      '%s carries the sender address exactly as the channel sent it',
      async (_label, c) => {
        const { event } = await arriveOverHttp(c);

        // A routing address, not an identity: it is what an outbound reply is
        // addressed to, so it must never be rewritten into a canonical form.
        expect(event.senderExternalId).toBe(c.senderExternalId);
      },
    );

    it.each(HTTP_CHANNELS.map((c) => [c.channel, c] as [string, ChannelCase]))(
      '%s carries a phone identity only when the channel has one',
      async (_label, c) => {
        const { event } = await arriveOverHttp(c);

        if (c.expectedPhone) {
          // Every store keyed on a person holds E.164. A `wa_id` matched
          // against rows written as `+91…` silently finds nothing: duplicate
          // leads, cadences that never stop, consent lookups that miss.
          expect(event.senderPhone).toBe(c.expectedPhone);
        } else {
          expect(event.senderPhone).toBeUndefined();
        }
      },
    );

    it('web chat carries no phone identity at all', async () => {
      const { event } = await arriveOverWebSocket();

      // A session id in a phone column is corruption, not a fallback.
      expect(event.senderPhone).toBeUndefined();
      expect(event.senderExternalId).toBe('session-1');
      expect(event.channel).toBe(ChannelType.WEB_CHAT);
    });
  });

  // ─────────────────────────────────────────────
  // The conversation leg
  // ─────────────────────────────────────────────

  describe('the conversation is woken by the announced event', () => {
    /** The real handler, with only its collaborators doubled. */
    async function buildConversationService(): Promise<{
      service: ConversationService;
      repository: { updateLastMessageAt: jest.Mock; updateStatus: jest.Mock };
      findOrCreate: jest.SpyInstance;
    }> {
      const repository = {
        updateLastMessageAt: jest.fn().mockResolvedValue({}),
        updateStatus: jest.fn().mockResolvedValue({}),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ConversationService,
          { provide: ConversationRepository, useValue: repository },
          { provide: PrismaService, useValue: {} },
          { provide: EventEmitter2, useValue: { emit: jest.fn() } },
          { provide: TenantService, useValue: {} },
          { provide: getQueueToken(CONVERSATION_QUEUE), useValue: { add: jest.fn() } },
        ],
      }).compile();

      const service = module.get(ConversationService);
      const findOrCreate = jest
        .spyOn(service, 'findOrCreate')
        .mockResolvedValue({ id: CONVERSATION_ID, status: 'OPEN', client_id: CLIENT_ID } as never);

      return { service, repository, findOrCreate };
    }

    it.each(ARRIVALS)('%s bumps last_message_at rather than being skipped', async (
      _label,
      arrive,
    ) => {
      const { event } = await arrive();
      const { service, repository } = await buildConversationService();

      await service.handleMessageReceived(event);

      // The skip branch is a `logger.debug` and a `return`, so its only
      // observable is this call not happening.
      expect(repository.updateLastMessageAt).toHaveBeenCalledWith(
        BUSINESS_ID,
        CONVERSATION_ID,
        expect.any(Date),
      );
    });

    it.each(ARRIVALS)('%s resolves its thread within the announcing tenant', async (
      _label,
      arrive,
    ) => {
      const { event } = await arrive();
      const { service, findOrCreate } = await buildConversationService();

      await service.handleMessageReceived(event);

      expect(findOrCreate).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          clientId: event.clientId,
          channelAccountId: event.channelAccountId,
          channel: event.channel,
        }),
      );
    });

    it.each(ARRIVALS)('%s reopens a resolved thread when the customer writes back', async (
      _label,
      arrive,
    ) => {
      const { event } = await arrive();
      const { service, repository } = await buildConversationService();
      jest
        .spyOn(service, 'findOrCreate')
        .mockResolvedValue({ id: CONVERSATION_ID, status: 'RESOLVED', client_id: CLIENT_ID } as never);

      await service.handleMessageReceived(event);

      expect(repository.updateStatus).toHaveBeenCalledWith(BUSINESS_ID, CONVERSATION_ID, 'OPEN');
    });
  });

  // ─────────────────────────────────────────────
  // The AI leg
  // ─────────────────────────────────────────────

  describe('the AI pipeline is reached by the announced event', () => {
    /**
     * `AiEngineService` takes nineteen collaborators and this exercises one
     * method, so everything but the four the guard path actually touches is a
     * bare object. What is being asserted is the *guard*, not the pipeline: the
     * pipeline has its own suites, and none of them can tell you whether a
     * given channel's event gets past the door.
     */
    function buildAiEngine(options: { realty?: boolean; actionable?: boolean } = {}): {
      service: AiEngineService;
      processMessage: jest.SpyInstance;
    } {
      const unused = {} as never;
      const contextLoader = {
        hasActionableContent: jest.fn().mockResolvedValue(options.actionable ?? true),
      } as unknown as ContextLoaderService;
      const realtyTenants = {
        isRealtyTenant: jest.fn().mockResolvedValue(options.realty ?? false),
      } as unknown as RealtyTenantService;

      // Constructed positionally rather than through the container: wiring a
      // testing module would mean modelling fourteen collaborators this path
      // never touches, and each one is a place for the test to drift from the
      // handler it is about.
      const service = new AiEngineService(
        unused, // prisma
        contextLoader,
        unused, // intentClassifier
        unused, // rag
        unused, // promptAssembler
        unused, // llm
        unused, // responseParser
        unused, // confidence
        unused, // router
        unused, // catalogMatch
        unused, // guardrails
        unused, // reviewQueue
        unused, // knowledgeIngestion
        unused, // embeddings
        unused, // repository
        unused, // channelAdapter
        { emit: jest.fn() } as unknown as EventEmitter2,
        realtyTenants,
        new ConversationLockService(),
      );

      const processMessage = jest
        .spyOn(service as unknown as { processMessage: () => Promise<unknown> }, 'processMessage')
        .mockResolvedValue({} as never);

      return { service, processMessage };
    }

    it.each(ARRIVALS)('%s reaches processMessage rather than being skipped', async (
      _label,
      arrive,
    ) => {
      const { event } = await arrive();
      const { service, processMessage } = buildAiEngine();

      await service.handleMessageReceived(event);

      expect(processMessage).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          messageId: event.messageId,
          correlationId: event.correlationId,
        }),
      );
    });

    it.each(ARRIVALS)('%s is handed to the realty loop instead on a realty tenant', async (
      _label,
      arrive,
    ) => {
      const { event } = await arrive();
      const { service, processMessage } = buildAiEngine({ realty: true });

      await service.handleMessageReceived(event);

      // Both pipelines running over one message is two replies to one
      // customer, and the realty bridge owns these.
      expect(processMessage).not.toHaveBeenCalled();
    });

    it.each(ARRIVALS)('%s is dropped before the LLM when it carries nothing', async (
      _label,
      arrive,
    ) => {
      const { event } = await arrive();
      const { service, processMessage } = buildAiEngine({ actionable: false });

      await service.handleMessageReceived(event);

      // A blank turn drives an intent classification and a generation, both
      // billed, both reasoning over an empty customer message.
      expect(processMessage).not.toHaveBeenCalled();
    });

    it('serializes two arrivals on one conversation, in order', async () => {
      const { event } = await arriveOverHttp(HTTP_CHANNELS[0]!);
      const { service, processMessage } = buildAiEngine();

      const order: string[] = [];
      processMessage.mockImplementation(async (_b: string, arg: { messageId: string }) => {
        order.push(`start:${arg.messageId}`);
        await new Promise((resolve) => setImmediate(resolve));
        order.push(`end:${arg.messageId}`);
      });

      await Promise.all([
        service.handleMessageReceived({ ...event, messageId: 'm-1' }),
        service.handleMessageReceived({ ...event, messageId: 'm-2' }),
      ]);

      // `emit` does not await listeners, so two messages a second apart
      // otherwise run the pipeline concurrently over one conversation and the
      // replies land in whichever order the LLM finishes.
      expect(order).toEqual(['start:m-1', 'end:m-1', 'start:m-2', 'end:m-2']);
    });
  });
});
