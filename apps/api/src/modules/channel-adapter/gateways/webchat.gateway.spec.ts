import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { Socket } from 'socket.io';
import { ChannelType, MessageContentType } from '@gosumo/shared';
import {
  WebChatGateway,
  webChatCorsOptions,
  readInitPayload,
  WEBCHAT_MAX_FRAME_BYTES,
  WEBCHAT_MAX_MESSAGE_CHARS,
  WEBCHAT_MAX_SESSION_TOKEN_CHARS,
  WEBCHAT_MAX_SOCKETS_PER_IP,
  WEBCHAT_MAX_WIDGET_ID_CHARS,
} from './webchat.gateway';
import { PrismaService } from '../../../common/services/prisma.service';
import { ChannelAdapterService } from '../channel-adapter.service';
import {
  WebChatAdapter,
  enqueueWebChatResponse,
  setWebChatDeliverySink,
  webchatResponseMap,
} from '../adapters/webchat.adapter';
import {
  signWebChatSession,
  verifyWebChatSession,
} from '../../../common/utils/webchat-session.util';
import { WebChatThrottle, WEBCHAT_THROTTLE_RULES } from './webchat-throttle';
import { ConversationLockService } from '../../../common/services/conversation-lock.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const WIDGET_ID = '00000000-0000-4000-a000-000000000002';
const CLIENT_ID = '00000000-0000-4000-a000-000000000003';
const CONVERSATION_ID = '00000000-0000-4000-a000-000000000004';
const OTHER_WIDGET_ID = '00000000-0000-4000-a000-000000000005';
const SECRET = 'test-jwt-secret';

/** Mint the signed token a widget would replay to resume `sessionId`. */
function token(sessionId: string, widgetId = WIDGET_ID, secret = SECRET): string {
  return signWebChatSession(widgetId, secret, sessionId);
}

/** The raw session id inside a token the gateway handed back. */
function rawSessionId(issued: string): string {
  const session = verifyWebChatSession(issued, SECRET);
  if (!session) throw new Error('gateway issued an unverifiable session token');
  return session.sessionId;
}

type PrismaMock = {
  channel_accounts: { findFirst: jest.Mock };
  channel_contacts: { findFirst: jest.Mock; create: jest.Mock };
  clients: { create: jest.Mock };
  conversations: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  messages: { create: jest.Mock };
  $transaction: jest.Mock;
};

function makePrisma(): PrismaMock {
  const prisma: PrismaMock = {
    channel_accounts: { findFirst: jest.fn() },
    channel_contacts: { findFirst: jest.fn(), create: jest.fn() },
    clients: { create: jest.fn() },
    conversations: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    messages: { create: jest.fn() },
    // The client+contact pair is written in one interactive transaction so a
    // lost race rolls the orphan client back with it. The fake hands the same
    // delegates to the callback, which is what a real `tx` is for these calls.
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (fn: (tx: PrismaMock) => Promise<unknown>) => fn(prisma),
  );
  return prisma;
}

/** The P2002 Prisma raises when the loser of a find-or-create race inserts. */
function uniqueViolation(): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
    meta: { target: ['channel_account_id', 'external_id'] },
  });
}

function makeSocket(id = 'socket-1', query: Record<string, unknown> = {}): Socket {
  return {
    id,
    handshake: { query },
    emit: jest.fn(),
    // Real sockets can be hung up on, and shutdown does exactly that.
    disconnect: jest.fn(),
  } as unknown as Socket;
}

/**
 * A socket whose handshake reveals a caller address. `makeSocket` deliberately
 * does not — an unidentifiable caller is not chargeable — so the throttle tests
 * are the only ones that need this.
 */
function makeSocketFrom(id: string, address: string): Socket {
  return {
    id,
    handshake: { query: {}, address, headers: {} },
    emit: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as Socket;
}

/** A socket the connection ceiling can count: it reveals a caller and can be hung up on. */
function makeCountedSocket(
  id: string,
  address: string | undefined,
  forwardedFor?: string,
): Socket & { disconnect: jest.Mock } {
  return {
    id,
    handshake: {
      query: {},
      address,
      headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    },
    emit: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as Socket & { disconnect: jest.Mock };
}

function makeConfig(secret: string = SECRET): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: unknown) =>
      key === 'jwt.secret' ? secret : fallback,
    ),
  } as unknown as ConfigService;
}

describe('webChatCorsOptions', () => {
  it('defaults to any origin with credentials OFF', () => {
    // The widget is embedded on customer sites, so the wildcard is the honest
    // default — but pairing it with credentials is the combination browsers
    // refuse outright, which broke every credentialed handshake rather than
    // permitting one.
    expect(webChatCorsOptions(undefined)).toEqual({ origin: '*', credentials: false });
  });

  it('turns credentials back on once real origins are named', () => {
    expect(webChatCorsOptions('https://shop.example, https://www.shop.example')).toEqual({
      origin: ['https://shop.example', 'https://www.shop.example'],
      credentials: true,
    });
  });

  it('reads WEBCHAT_ALLOWED_ORIGINS when no argument is given', () => {
    const previous = process.env['WEBCHAT_ALLOWED_ORIGINS'];
    process.env['WEBCHAT_ALLOWED_ORIGINS'] = 'https://shop.example';
    try {
      expect(webChatCorsOptions()).toEqual({
        origin: 'https://shop.example',
        credentials: true,
      });
    } finally {
      if (previous === undefined) delete process.env['WEBCHAT_ALLOWED_ORIGINS'];
      else process.env['WEBCHAT_ALLOWED_ORIGINS'] = previous;
    }
  });
});

describe('gateway transport options', () => {
  /** Where Nest stores the `@WebSocketGateway({...})` argument. */
  function gatewayOptions(): Record<string, unknown> {
    return (Reflect.getMetadata('websockets:gateway_options', WebChatGateway) ??
      {}) as Record<string, unknown>;
  }

  it('caps the frame size at the transport, not just in the handler', () => {
    // WEBCHAT_MAX_MESSAGE_CHARS is checked after Engine.IO has buffered the
    // whole frame and parsed it. Engine.IO's own default is 1 MB, so every
    // rejected message still cost a megabyte of buffering and parsing first —
    // and `chat:init`, which has no length ceiling of its own, could be sent
    // at that size indefinitely.
    expect(gatewayOptions()['maxHttpBufferSize']).toBe(WEBCHAT_MAX_FRAME_BYTES);
  });

  it('leaves room for the longest legitimate message', () => {
    // 4 bytes per character is the UTF-8 worst case (emoji), plus the event
    // name and the JSON envelope. A cap below that would refuse a message the
    // handler is documented to accept.
    expect(WEBCHAT_MAX_FRAME_BYTES).toBeGreaterThan(WEBCHAT_MAX_MESSAGE_CHARS * 4);
  });

  it('still serves the widget from anywhere', () => {
    // The frame cap is not an origin policy — the widget is embedded on
    // customer sites and the CORS default has to stay open.
    expect(gatewayOptions()['namespace']).toBe('/webchat');
    expect(gatewayOptions()['cors']).toEqual(
      expect.objectContaining({ origin: expect.anything() }),
    );
  });
});

describe('WebChatGateway', () => {
  let gateway: WebChatGateway;
  let prisma: PrismaMock;
  let eventEmitter: { emit: jest.Mock };
  let throttle: WebChatThrottle;

  beforeEach(() => {
    prisma = makePrisma();
    eventEmitter = { emit: jest.fn() };
    throttle = new WebChatThrottle();
    gateway = new WebChatGateway(
      prisma as unknown as PrismaService,
      eventEmitter as unknown as EventEmitter2,
      {} as unknown as ChannelAdapterService,
      makeConfig(),
      throttle,
    );
    webchatResponseMap.clear();
  });

  afterEach(() => {
    webchatResponseMap.clear();
  });

  // ─────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────

  describe('handleConnection', () => {
    it('logs the widgetId when the handshake carries one', () => {
      const logSpy = jest.spyOn(gateway['logger'], 'log').mockImplementation();
      gateway.handleConnection(makeSocket('socket-a', { widgetId: WIDGET_ID }));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(WIDGET_ID));
    });

    it('falls back to "none" when the handshake omits widgetId', () => {
      const logSpy = jest.spyOn(gateway['logger'], 'log').mockImplementation();
      gateway.handleConnection(makeSocket('socket-b'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('widgetId=none'));
    });
  });

  /**
   * `WebChatThrottle` rations events. A socket that connects and then says
   * nothing is charged by none of its buckets, yet still costs an Engine.IO
   * session and its buffers for as long as it is held — so opening sockets in
   * a loop was an unrationed way to exhaust the process.
   */
  describe('connection ceiling', () => {
    beforeEach(() => {
      jest.spyOn(gateway['logger'], 'log').mockImplementation();
      jest.spyOn(gateway['logger'], 'warn').mockImplementation();
    });

    it('admits sockets up to the per-IP ceiling', () => {
      for (let i = 0; i < WEBCHAT_MAX_SOCKETS_PER_IP; i++) {
        const socket = makeCountedSocket(`ok-${i}`, '203.0.113.5');
        gateway.handleConnection(socket);
        expect(socket.disconnect).not.toHaveBeenCalled();
      }
      expect(gateway.liveSocketsFor('203.0.113.5')).toBe(WEBCHAT_MAX_SOCKETS_PER_IP);
    });

    it('disconnects the one past the ceiling', () => {
      for (let i = 0; i < WEBCHAT_MAX_SOCKETS_PER_IP; i++) {
        gateway.handleConnection(makeCountedSocket(`fill-${i}`, '203.0.113.6'));
      }

      const excess = makeCountedSocket('excess', '203.0.113.6');
      gateway.handleConnection(excess);

      expect(excess.disconnect).toHaveBeenCalledWith(true);
      // Refused sockets are not counted, so the caller is not pushed further
      // over the line by its own retries.
      expect(gateway.liveSocketsFor('203.0.113.6')).toBe(WEBCHAT_MAX_SOCKETS_PER_IP);
    });

    it('frees the slot when a socket disconnects', () => {
      const socket = makeCountedSocket('transient', '203.0.113.7');
      gateway.handleConnection(socket);
      expect(gateway.liveSocketsFor('203.0.113.7')).toBe(1);

      gateway.handleDisconnect(socket);

      expect(gateway.liveSocketsFor('203.0.113.7')).toBe(0);
      // The key goes with the last socket — an IP key space is caller-
      // controlled, so a counter that only grew would be the leak the
      // ceiling exists to prevent.
      expect(gateway['socketsPerIp'].size).toBe(0);
      expect(gateway['socketIp'].size).toBe(0);
    });

    it('counts each caller separately', () => {
      for (let i = 0; i < WEBCHAT_MAX_SOCKETS_PER_IP; i++) {
        gateway.handleConnection(makeCountedSocket(`a-${i}`, '203.0.113.8'));
      }

      const other = makeCountedSocket('b-0', '198.51.100.4');
      gateway.handleConnection(other);

      expect(other.disconnect).not.toHaveBeenCalled();
      expect(gateway.liveSocketsFor('198.51.100.4')).toBe(1);
    });

    it('reads the forwarded address, not the proxy that delivered it', () => {
      // Every socket arrives from Caddy in production; counting on the peer
      // address would collapse every visitor onto one bucket and lock the
      // widget out entirely.
      const socket = makeCountedSocket('fwd', '10.0.0.1', '203.0.113.9');
      gateway.handleConnection(socket);

      expect(gateway.liveSocketsFor('203.0.113.9')).toBe(1);
      expect(gateway.liveSocketsFor('10.0.0.1')).toBe(0);
    });

    it('admits a socket whose caller cannot be identified', () => {
      // An unidentifiable caller is not chargeable — grouping them all under
      // one key would let any one of them lock out the rest.
      const socket = makeCountedSocket('anon', undefined);
      gateway.handleConnection(socket);

      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(gateway['socketIp'].size).toBe(0);
    });

    it('does not double-free when disconnect fires twice', () => {
      const first = makeCountedSocket('dup-1', '203.0.113.10');
      const second = makeCountedSocket('dup-2', '203.0.113.10');
      gateway.handleConnection(first);
      gateway.handleConnection(second);

      gateway.handleDisconnect(first);
      gateway.handleDisconnect(first);

      expect(gateway.liveSocketsFor('203.0.113.10')).toBe(1);
    });
  });

  describe('handleDisconnect', () => {
    it('clears every session map when the socket had a session', async () => {
      const client = await initSession(gateway, prisma, 'socket-c');

      gateway.handleDisconnect(client);

      expect(gateway['sessions'].size).toBe(0);
      expect(gateway['socketToSession'].size).toBe(0);
      expect(gateway['sessionContext'].size).toBe(0);
    });

    /**
     * The widget stores its sessionId and reconnects with it, and Socket.IO
     * only notices the old socket is gone once pingTimeout elapses — so the
     * reconnect's `chat:init` routinely arrives before the old socket's
     * disconnect. The teardown used to fire on the sessionId regardless of
     * which socket owned it, wiping the socket and context that had just
     * replaced it. The visitor kept an open connection and a sessionId, and
     * every message after that was silently dropped.
     */
    it('keeps the live session when a superseded socket disconnects late', async () => {
      const first = await initSession(gateway, prisma, 'socket-old', 'session-1');
      const second = await initSession(gateway, prisma, 'socket-new', 'session-1');

      // The blip finally registers, after the reconnect has already re-inited.
      gateway.handleDisconnect(first);

      // The reconnected socket still receives outbound replies...
      expect(
        gateway.sendToClient('session-1', {
          id: 'm1',
          text: 'still connected',
          timestamp: new Date('2026-08-14T00:00:00Z'),
        }),
      ).toBe(true);
      expect(second.emit).toHaveBeenCalledWith(
        'chat:response',
        expect.objectContaining({ text: 'still connected' }),
      );

      // ...and its inbound messages are still accepted.
      prisma.messages.create.mockResolvedValue({ id: 'm2' });
      const result = await gateway.handleMessage(second, { text: 'hello again' });
      expect(result.received).toBe(true);
    });

    it('still tears the session down when the socket that owns it disconnects', async () => {
      const first = await initSession(gateway, prisma, 'socket-old', 'session-1');
      const second = await initSession(gateway, prisma, 'socket-new', 'session-1');

      gateway.handleDisconnect(first);
      gateway.handleDisconnect(second);

      expect(
        gateway.sendToClient('session-1', {
          id: 'm1',
          text: 'nobody home',
          timestamp: new Date('2026-08-14T00:00:00Z'),
        }),
      ).toBe(false);
      const result = await gateway.handleMessage(second, { text: 'anyone?' });
      expect(result.received).toBe(false);
    });

    it('is a no-op for a socket that never initialised a session', () => {
      gateway.handleDisconnect(makeSocket('socket-unknown'));
      expect(gateway['sessions'].size).toBe(0);
    });

    /**
     * `socketToSession` maps one socket to exactly one session, so a socket that
     * inits a second session silently overwrites the first mapping — and the
     * disconnect that follows only ever tears down the last one. Everything
     * named by the earlier init stayed in `sessions` and `sessionContext` for
     * the life of the process, holding a dead socket and that visitor's
     * businessId/conversationId. Nothing bounded it: resuming a session is
     * deliberately not rate-limited, so a client replaying tokens it had already
     * been issued grew both maps without ever opening a new session.
     */
    it('releases an earlier session when one socket inits a second one', async () => {
      const client = await initSession(gateway, prisma, 'socket-multi', 'session-1');
      await gateway.handleInit(client, {
        widgetId: WIDGET_ID,
        sessionId: token('session-2'),
      });

      gateway.handleDisconnect(client);

      expect(gateway['sessions'].size).toBe(0);
      expect(gateway['socketToSession'].size).toBe(0);
      expect(gateway['sessionContext'].size).toBe(0);
    });

    /**
     * Releasing the superseded session must not disturb a *different* socket
     * that has since taken it over — the reconnect race above already moves a
     * session between sockets, and the release has to lose to it.
     */
    it('does not release a session another socket has already taken over', async () => {
      const first = await initSession(gateway, prisma, 'socket-a', 'session-1');
      // session-1 moves to a new socket, as it does on every reconnect.
      const second = await initSession(gateway, prisma, 'socket-b', 'session-1');
      // The old socket is then reused for a different session.
      await gateway.handleInit(first, {
        widgetId: WIDGET_ID,
        sessionId: token('session-2'),
      });

      expect(gateway['sessions'].get('session-1')).toBe(second);
      expect(gateway['sessionContext'].has('session-1')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────
  // chat:init
  // ─────────────────────────────────────────────

  describe('handleInit', () => {
    it('rejects an unknown widgetId without touching client/conversation tables', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);

      const result = await gateway.handleInit(makeSocket(), { widgetId: 'nope' });

      expect(result).toEqual({ sessionId: '', greeting: 'Widget not found' });
      expect(prisma.clients.create).not.toHaveBeenCalled();
      expect(prisma.conversations.create).not.toHaveBeenCalled();
    });

    it('scopes the widget lookup to an active, non-deleted WEB_CHAT account', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);

      await gateway.handleInit(makeSocket(), { widgetId: WIDGET_ID });

      expect(prisma.channel_accounts.findFirst).toHaveBeenCalledWith({
        where: {
          id: WIDGET_ID,
          channel: ChannelType.WEB_CHAT,
          is_active: true,
          deleted_at: null,
        },
      });
    });

    it('creates a client and a conversation on a first visit and returns the widget greeting', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue({
        id: WIDGET_ID,
        business_id: BUSINESS_ID,
        metadata: { greeting: 'Namaste! How can we help?' },
      });
      prisma.channel_contacts.findFirst.mockResolvedValue(null);
      prisma.clients.create.mockImplementation(({ data }) => ({ ...data }));
      prisma.channel_contacts.create.mockResolvedValue({});
      prisma.conversations.findFirst.mockResolvedValue(null);
      prisma.conversations.create.mockImplementation(({ data }) => ({ ...data }));

      const client = makeSocket('socket-init');
      const result = await gateway.handleInit(client, { widgetId: WIDGET_ID });

      // What the visitor receives is the signed token; what is persisted and
      // keyed on is the raw id inside it.
      const sessionId = rawSessionId(result.sessionId);
      expect(result.sessionId).not.toBe(sessionId);
      expect(result.greeting).toBe('Namaste! How can we help?');
      expect(prisma.clients.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ business_id: BUSINESS_ID, name: 'Web Visitor' }),
      });
      expect(prisma.channel_contacts.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: BUSINESS_ID,
          channel: ChannelType.WEB_CHAT,
          external_id: sessionId,
        }),
      });
      // A brand-new conversation announces itself.
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.created',
        expect.objectContaining({
          businessId: BUSINESS_ID,
          channel: ChannelType.WEB_CHAT,
        }),
      );
      expect(gateway['sessions'].get(sessionId)).toBe(client);
    });

    it('falls back to the default greeting when metadata carries none', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue({
        id: WIDGET_ID,
        business_id: BUSINESS_ID,
        metadata: {},
      });
      prisma.channel_contacts.findFirst.mockResolvedValue(null);
      prisma.clients.create.mockImplementation(({ data }) => ({ ...data }));
      prisma.channel_contacts.create.mockResolvedValue({});
      prisma.conversations.findFirst.mockResolvedValue(null);
      prisma.conversations.create.mockImplementation(({ data }) => ({ ...data }));

      const result = await gateway.handleInit(makeSocket(), { widgetId: WIDGET_ID });

      expect(result.greeting).toBe('Hello! How can we help you today?');
    });

    it('reuses the existing client and conversation on a returning session', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue({
        id: WIDGET_ID,
        business_id: BUSINESS_ID,
        metadata: null,
      });
      prisma.channel_contacts.findFirst.mockResolvedValue({
        id: 'contact-1',
        client: { id: CLIENT_ID, business_id: BUSINESS_ID },
      });
      prisma.conversations.findFirst.mockResolvedValue({
        id: CONVERSATION_ID,
        business_id: BUSINESS_ID,
      });

      const result = await gateway.handleInit(makeSocket(), {
        widgetId: WIDGET_ID,
        sessionId: token('returning-session'),
      });

      expect(rawSessionId(result.sessionId)).toBe('returning-session');
      // Default greeting survives a null metadata column.
      expect(result.greeting).toBe('Hello! How can we help you today?');
      expect(prisma.clients.create).not.toHaveBeenCalled();
      expect(prisma.channel_contacts.create).not.toHaveBeenCalled();
      expect(prisma.conversations.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'conversation.created',
        expect.anything(),
      );
      expect(gateway['sessionContext'].get('returning-session')).toEqual({
        businessId: BUSINESS_ID,
        channelAccountId: WIDGET_ID,
        clientId: CLIENT_ID,
        conversationId: CONVERSATION_ID,
      });
    });

    it('creates a fresh client when the channel contact exists but has no linked client', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue({
        id: WIDGET_ID,
        business_id: BUSINESS_ID,
        metadata: {},
      });
      prisma.channel_contacts.findFirst.mockResolvedValue({ id: 'contact-2', client: null });
      prisma.clients.create.mockImplementation(({ data }) => ({ ...data }));
      prisma.channel_contacts.create.mockResolvedValue({});
      prisma.conversations.findFirst.mockResolvedValue(null);
      prisma.conversations.create.mockImplementation(({ data }) => ({ ...data }));

      await gateway.handleInit(makeSocket(), { widgetId: WIDGET_ID });

      expect(prisma.clients.create).toHaveBeenCalled();
    });

    it('reuses the visitor thread whatever its status, so a RESOLVED one is not duplicated', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue({
        id: WIDGET_ID,
        business_id: BUSINESS_ID,
        metadata: {},
      });
      prisma.channel_contacts.findFirst.mockResolvedValue({
        client: { id: CLIENT_ID },
      });
      prisma.conversations.findFirst.mockResolvedValue({ id: CONVERSATION_ID });

      await gateway.handleInit(makeSocket(), { widgetId: WIDGET_ID });

      expect(prisma.conversations.findFirst).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          client_id: CLIENT_ID,
          channel_account_id: WIDGET_ID,
          deleted_at: null,
        },
        orderBy: { created_at: 'desc' },
      });
    });
  });

  // ─────────────────────────────────────────────
  // chat:message
  // ─────────────────────────────────────────────

  describe('handleMessage', () => {
    it('refuses a message for a session it never initialised', async () => {
      const result = await gateway.handleMessage(makeSocket(), { text: 'hello' });

      expect(result.received).toBe(false);
      expect(result.messageId).toBeTruthy();
      expect(prisma.messages.create).not.toHaveBeenCalled();
    });

    it('stores the message, bumps the conversation, and emits message.received', async () => {
      const client = await initSession(gateway, prisma, 'socket-msg', 'live-session');
      prisma.messages.create.mockResolvedValue({});
      prisma.conversations.update.mockResolvedValue({});

      const result = await gateway.handleMessage(client, {
        text: 'Is the 3BHK still available?',
      });

      expect(result.received).toBe(true);
      expect(prisma.messages.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: BUSINESS_ID,
          conversation_id: CONVERSATION_ID,
          direction: 'INBOUND',
          sender_type: 'CLIENT',
          sender_id: CLIENT_ID,
          text_content: 'Is the 3BHK still available?',
          external_id: 'webchat_' + result.messageId,
        }),
      });
      // The conversation bump is tenant-scoped — never a bare id lookup.
      expect(prisma.conversations.update).toHaveBeenCalledWith({
        where: { id: CONVERSATION_ID, business_id: BUSINESS_ID },
        data: expect.objectContaining({ last_message_at: expect.any(Date) }),
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'message.received',
        expect.objectContaining({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          clientId: CLIENT_ID,
          senderExternalId: 'live-session',
          channel: ChannelType.WEB_CHAT,
        }),
      );
    });

    it('swallows an Error thrown by the write and reports received: false', async () => {
      const client = await initSession(gateway, prisma, 'socket-err', 'err-session');
      prisma.messages.create.mockRejectedValue(new Error('deadlock detected'));
      const errorSpy = jest.spyOn(gateway['logger'], 'error').mockImplementation();

      const result = await gateway.handleMessage(client, { text: 'hi' });

      expect(result.received).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('deadlock detected'));
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'message.received',
        expect.anything(),
      );
    });

    it('stringifies a non-Error rejection rather than crashing the socket handler', async () => {
      const client = await initSession(gateway, prisma, 'socket-str', 'str-session');
      prisma.messages.create.mockRejectedValue('connection reset');
      const errorSpy = jest.spyOn(gateway['logger'], 'error').mockImplementation();

      const result = await gateway.handleMessage(client, { text: 'hi' });

      expect(result.received).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
    });
  });

  // ─────────────────────────────────────────────
  // Session security
  // ─────────────────────────────────────────────

  describe('session security', () => {
    /**
     * `chat:init` resumes a thread from an id the browser supplies. Handed a
     * raw id it could not tell one it minted from one somebody typed, so naming
     * another visitor's session inherited their client, their conversation, and
     * — because init also repoints the outbound socket map — every reply meant
     * for them. The widget id that scopes the lookup is public: it sits in the
     * page source of every site running the widget.
     */
    describe('chat:init session tokens', () => {
      beforeEach(() => {
        prisma.channel_accounts.findFirst.mockResolvedValue({
          id: WIDGET_ID,
          business_id: BUSINESS_ID,
          metadata: {},
        });
        prisma.channel_contacts.findFirst.mockResolvedValue(null);
        prisma.clients.create.mockImplementation(({ data }) => ({ ...data }));
        prisma.channel_contacts.create.mockResolvedValue({});
        prisma.conversations.findFirst.mockResolvedValue(null);
        prisma.conversations.create.mockImplementation(({ data }) => ({ ...data }));
      });

      it('never hands the visitor the raw session id', () => {
        // The stored id and the id on the wire must differ, or the wire value
        // is once again a resume credential anyone can copy.
        expect(token('sess-1')).not.toBe('sess-1');
      });

      it('does not resume a session named by an unsigned id', async () => {
        jest.spyOn(gateway['logger'], 'warn').mockImplementation();

        const result = await gateway.handleInit(makeSocket('attacker'), {
          widgetId: WIDGET_ID,
          sessionId: 'victim-session',
        });

        // A fresh session is issued instead, so the victim's contact row is
        // never looked up and their thread is never joined.
        expect(rawSessionId(result.sessionId)).not.toBe('victim-session');
        expect(prisma.channel_contacts.findFirst).not.toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ external_id: 'victim-session' }),
          }),
        );
      });

      it('does not resume a session named by a token signed with another secret', async () => {
        jest.spyOn(gateway['logger'], 'warn').mockImplementation();
        const forged = token('victim-session', WIDGET_ID, 'attacker-secret');

        const result = await gateway.handleInit(makeSocket('attacker'), {
          widgetId: WIDGET_ID,
          sessionId: forged,
        });

        expect(rawSessionId(result.sessionId)).not.toBe('victim-session');
      });

      it('does not resume a token minted for a different widget', async () => {
        jest.spyOn(gateway['logger'], 'warn').mockImplementation();
        const otherTenants = token('victim-session', OTHER_WIDGET_ID);

        const result = await gateway.handleInit(makeSocket('attacker'), {
          widgetId: WIDGET_ID,
          sessionId: otherTenants,
        });

        expect(rawSessionId(result.sessionId)).not.toBe('victim-session');
      });

      it('leaves the victim holding the live socket when a hijack is attempted', async () => {
        const victim = await initSession(gateway, prisma, 'socket-victim', 'victim-session');
        jest.spyOn(gateway['logger'], 'warn').mockImplementation();

        await gateway.handleInit(makeSocket('socket-attacker'), {
          widgetId: WIDGET_ID,
          sessionId: 'victim-session',
        });

        // Outbound replies still land on the victim's socket, not the attacker's.
        expect(gateway['sessions'].get('victim-session')).toBe(victim);
      });

      it('logs the rejection so a hijack attempt is visible in the audit trail', async () => {
        const warnSpy = jest.spyOn(gateway['logger'], 'warn').mockImplementation();

        await gateway.handleInit(makeSocket('attacker'), {
          widgetId: WIDGET_ID,
          sessionId: 'victim-session',
        });

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Rejected WebChat session token'),
        );
      });

      it('resumes normally when the visitor replays the token it was issued', async () => {
        const first = await gateway.handleInit(makeSocket('socket-a'), {
          widgetId: WIDGET_ID,
        });

        prisma.channel_contacts.findFirst.mockResolvedValue({ client: { id: CLIENT_ID } });
        prisma.conversations.findFirst.mockResolvedValue({ id: CONVERSATION_ID });

        const second = await gateway.handleInit(makeSocket('socket-b'), {
          widgetId: WIDGET_ID,
          sessionId: first.sessionId,
        });

        expect(rawSessionId(second.sessionId)).toBe(rawSessionId(first.sessionId));
      });

      it('refuses to open a session at all when no signing secret is configured', async () => {
        const unsigned = new WebChatGateway(
          prisma as unknown as PrismaService,
          eventEmitter as unknown as EventEmitter2,
          {} as unknown as ChannelAdapterService,
          makeConfig(''),
          new WebChatThrottle(),
        );
        const errorSpy = jest.spyOn(unsigned['logger'], 'error').mockImplementation();

        const result = await unsigned.handleInit(makeSocket(), { widgetId: WIDGET_ID });

        // Fail closed: without a key every token would be forgeable, so the
        // channel stays shut rather than reverting to the unauthenticated form.
        expect(result).toEqual({ sessionId: '', greeting: 'Chat is unavailable right now' });
        expect(prisma.clients.create).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('jwt.secret'));
      });
    });

    /**
     * `sessionContext` is a process-wide map spanning every tenant. Trusting the
     * body's `sessionId` let any connected socket post into any other live
     * visitor's conversation — under that conversation's businessId — just by
     * naming its session. No forged init and no database read were required.
     */
    describe('chat:message socket binding', () => {
      it('refuses a message naming a session the socket does not own', async () => {
        await initSession(gateway, prisma, 'socket-victim', 'victim-session');
        const attacker = makeSocket('socket-attacker');
        const warnSpy = jest.spyOn(gateway['logger'], 'warn').mockImplementation();

        const result = await gateway.handleMessage(attacker, {
          sessionId: 'victim-session',
          text: 'injected into someone else thread',
        });

        expect(result.received).toBe(false);
        expect(prisma.messages.create).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalledWith(
          'message.received',
          expect.anything(),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('no initialized session'),
        );
      });

      it('ignores a body sessionId that names another session and uses the socket own', async () => {
        await initSession(gateway, prisma, 'socket-other', 'other-session');
        const mine = await initSession(gateway, prisma, 'socket-mine', 'my-session');
        prisma.messages.create.mockResolvedValue({});
        prisma.conversations.update.mockResolvedValue({});

        await gateway.handleMessage(mine, {
          sessionId: 'other-session',
          text: 'hello',
        });

        // The message is attributed to this socket's session, not the one named.
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'message.received',
          expect.objectContaining({
            senderExternalId: 'my-session',
            metadata: { sessionId: 'my-session' },
          }),
        );
      });

      it('stops accepting messages from a socket once it has disconnected', async () => {
        const client = await initSession(gateway, prisma, 'socket-bye', 'bye-session');
        jest.spyOn(gateway['logger'], 'log').mockImplementation();
        jest.spyOn(gateway['logger'], 'warn').mockImplementation();

        gateway.handleDisconnect(client);
        const result = await gateway.handleMessage(client, { text: 'after the fact' });

        expect(result.received).toBe(false);
        expect(prisma.messages.create).not.toHaveBeenCalled();
      });
    });
  });

  // ─────────────────────────────────────────────
  // Inbound payload validation
  // ─────────────────────────────────────────────

  /**
   * `data` here is a parsed socket frame. The global `ValidationPipe` covers
   * HTTP routes and never sees a Socket.IO event, so whatever the widget puts
   * on the wire reaches Prisma and the AI pipeline exactly as sent.
   */
  describe('chat:message body validation', () => {
    beforeEach(() => {
      jest.spyOn(gateway['logger'], 'warn').mockImplementation();
    });

    it('refuses a message longer than the ceiling without storing or emitting it', async () => {
      // The throttle bounds how *many* messages a session sends, which is the
      // wrong dimension for the two costs that scale with size: the stored row
      // and the per-token LLM call behind `message.received`.
      const client = await initSession(gateway, prisma, 'socket-big', 'big-session');
      prisma.messages.create.mockResolvedValue({});
      eventEmitter.emit.mockClear();

      const result = await gateway.handleMessage(client, {
        text: 'x'.repeat(WEBCHAT_MAX_MESSAGE_CHARS + 1),
      });

      expect(result.received).toBe(false);
      expect(prisma.messages.create).not.toHaveBeenCalled();
      expect(
        eventEmitter.emit.mock.calls.filter((c) => c[0] === 'message.received'),
      ).toHaveLength(0);
    });

    it('accepts a message exactly at the ceiling', async () => {
      // The boundary is inclusive; an off-by-one here silently truncates the
      // longest legitimate turn a visitor can send.
      const client = await initSession(gateway, prisma, 'socket-edge', 'edge-session');
      prisma.messages.create.mockResolvedValue({});
      prisma.conversations.update.mockResolvedValue({});

      const result = await gateway.handleMessage(client, {
        text: 'x'.repeat(WEBCHAT_MAX_MESSAGE_CHARS),
      });

      expect(result.received).toBe(true);
      expect(prisma.messages.create).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a number', 42],
      ['an object', { toString: () => 'nope' }],
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
    ])('refuses %s as the message body', async (_label, body) => {
      const client = await initSession(gateway, prisma, `socket-${_label}`, `s-${_label}`);
      prisma.messages.create.mockResolvedValue({});

      const result = await gateway.handleMessage(client, {
        text: body as unknown as string,
      });

      expect(result.received).toBe(false);
      expect(prisma.messages.create).not.toHaveBeenCalled();
    });

    it.each([
      ['spaces', '   '],
      ['a tab and a newline', '\t\n'],
      ['a non-breaking space', ' '],
      ['a zero-width space', '​'],
      ['a byte-order mark', '﻿'],
    ])('refuses %s, which is an empty message wearing a costume', async (_label, body) => {
      // `text.length === 0` refused `""` and accepted every one of these. Each
      // one is stored as a blank row, dropped again by the transcript loader,
      // and in between drives an intent classification and a generation — two
      // billed LLM calls over a message the model sees as empty. A widget that
      // submits on Enter produces them by accident all day.
      const client = await initSession(gateway, prisma, `blank-${_label}`, `b-${_label}`);
      prisma.messages.create.mockResolvedValue({});
      eventEmitter.emit.mockClear();

      const result = await gateway.handleMessage(client, { text: body });

      expect(result.received).toBe(false);
      expect(prisma.messages.create).not.toHaveBeenCalled();
      expect(
        eventEmitter.emit.mock.calls.filter((c) => c[0] === 'message.received'),
      ).toHaveLength(0);
    });

    it.each([
      ['a lone emoji, which is a complete answer', '👍'],
      ['a ZWJ emoji sequence, whose joiners must not read as blank', '👨‍👩‍👧‍👦'],
      ['text padded with invisible characters', '​ hello ﻿'],
      ['Devanagari', 'नमस्ते'],
    ])('still accepts %s', async (_label, body) => {
      const client = await initSession(gateway, prisma, `ok-${_label}`, `o-${_label}`);
      prisma.messages.create.mockResolvedValue({});
      prisma.conversations.update.mockResolvedValue({});

      const result = await gateway.handleMessage(client, { text: body });

      expect(result.received).toBe(true);
      expect(prisma.messages.create).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a bare string', 'hello'],
      ['a number', 7],
    ])('refuses %s as the whole frame rather than throwing on it', async (_label, frame) => {
      // The declared parameter type is a compile-time fiction — Socket.IO
      // hands over whatever JSON arrived. Reading `.text` off a non-object
      // threw, which turned a malformed frame into an exception instead of a
      // refusal the widget can act on.
      const client = await initSession(gateway, prisma, `frame-${_label}`, `f-${_label}`);
      prisma.messages.create.mockResolvedValue({});

      const result = await gateway.handleMessage(client, frame);

      expect(result.received).toBe(false);
      expect(prisma.messages.create).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // chat:init body validation
  // ─────────────────────────────────────────────

  describe('chat:init body validation', () => {
    beforeEach(() => {
      jest.spyOn(gateway['logger'], 'warn').mockImplementation();
    });

    /**
     * The one that matters: `widgetId` is passed straight into
     * `channel_accounts.findFirst({ where: { id: widgetId } })`, and Prisma is
     * as happy with a filter object there as with a string. A visitor sending
     * `{"not": "<some uuid>"}` therefore matched *whatever active web-chat
     * account came first*, in any business — and the handler went on to create
     * a `clients` row under that business's `business_id`. The widget id is the
     * only thing between an anonymous socket and a tenant.
     */
    it('refuses a Prisma filter object as the widgetId, without querying', async () => {
      const client = makeSocket('socket-injected');

      const result = await gateway.handleInit(client, {
        widgetId: { not: '00000000-0000-4000-a000-000000000009' },
      });

      expect(result.sessionId).toBe('');
      expect(prisma.channel_accounts.findFirst).not.toHaveBeenCalled();
      expect(prisma.clients.create).not.toHaveBeenCalled();
      expect(gateway['sessions'].size).toBe(0);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a bare string', WIDGET_ID],
      ['a number', 1],
      ['an array', [WIDGET_ID]],
    ])('refuses %s as the init frame', async (_label, frame) => {
      const result = await gateway.handleInit(makeSocket(`init-${_label}`), frame);

      expect(result.sessionId).toBe('');
      expect(prisma.channel_accounts.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a widgetId longer than the ceiling before it reaches a query', async () => {
      const result = await gateway.handleInit(makeSocket('socket-long'), {
        widgetId: 'x'.repeat(WEBCHAT_MAX_WIDGET_ID_CHARS + 1),
      });

      expect(result.sessionId).toBe('');
      expect(prisma.channel_accounts.findFirst).not.toHaveBeenCalled();
    });

    it('charges nothing against the throttle for a malformed frame', async () => {
      // Refusing before the throttle keeps a junk frame from spending the
      // quota of the visitors sharing that IP.
      const consume = jest.spyOn(throttle, 'consume');

      await gateway.handleInit(makeSocket('socket-junk'), { widgetId: 42 });

      expect(consume).not.toHaveBeenCalled();
    });

    it('ignores a non-string sessionId and issues a fresh session', async () => {
      // An unusable token already means "start a new session" — which is what
      // an absent one does. Passing it on threw inside the HMAC verifier.
      prisma.channel_accounts.findFirst.mockResolvedValue({
        id: WIDGET_ID,
        business_id: BUSINESS_ID,
        metadata: {},
      });
      prisma.channel_contacts.findFirst.mockResolvedValue({ client: { id: CLIENT_ID } });
      prisma.conversations.findFirst.mockResolvedValue({ id: CONVERSATION_ID });

      const result = await gateway.handleInit(makeSocket('socket-badtoken'), {
        widgetId: WIDGET_ID,
        sessionId: { not: '' },
      });

      expect(result.sessionId).not.toBe('');
      expect(verifyWebChatSession(result.sessionId, SECRET, WIDGET_ID)).not.toBeNull();
    });
  });

  describe('readInitPayload', () => {
    it('accepts a well-formed body', () => {
      expect(readInitPayload({ widgetId: WIDGET_ID })).toEqual({ widgetId: WIDGET_ID });
    });

    it('keeps a plausible session token', () => {
      const issued = token('session-1');
      expect(readInitPayload({ widgetId: WIDGET_ID, sessionId: issued })).toEqual({
        widgetId: WIDGET_ID,
        sessionId: issued,
      });
    });

    it.each([
      ['a filter object', { not: '' }],
      ['a number', 5],
      ['an array', []],
      ['null', null],
      ['an empty string', ''],
    ])('rejects %s as widgetId', (_label, widgetId) => {
      expect(readInitPayload({ widgetId })).toBeNull();
    });

    it('drops an over-long session token but keeps the widget', () => {
      const payload = readInitPayload({
        widgetId: WIDGET_ID,
        sessionId: 'x'.repeat(WEBCHAT_MAX_SESSION_TOKEN_CHARS + 1),
      });
      expect(payload).toEqual({ widgetId: WIDGET_ID });
    });

    it('accepts a widgetId exactly at the ceiling', () => {
      const widgetId = 'x'.repeat(WEBCHAT_MAX_WIDGET_ID_CHARS);
      expect(readInitPayload({ widgetId })).toEqual({ widgetId });
    });
  });

  // ─────────────────────────────────────────────
  // Abuse ceilings
  // ─────────────────────────────────────────────

  /**
   * The gateway is a Socket.IO namespace, so neither `JwtAuthGuard` nor
   * `AuthThrottleGuard` (which returns early on a non-HTTP context) reaches it.
   * It is the one surface designed to be hit by anonymous visitors from
   * arbitrary websites, and both of its events do unbounded work.
   */
  describe('rate limiting', () => {
    beforeEach(() => {
      jest.spyOn(gateway['logger'], 'warn').mockImplementation();
      prisma.channel_accounts.findFirst.mockResolvedValue({
        id: WIDGET_ID,
        business_id: BUSINESS_ID,
        metadata: {},
      });
      prisma.channel_contacts.findFirst.mockResolvedValue(null);
      prisma.clients.create.mockImplementation(({ data }) => ({ ...data }));
      prisma.channel_contacts.create.mockResolvedValue({});
      prisma.conversations.findFirst.mockResolvedValue(null);
      prisma.conversations.create.mockImplementation(({ data }) => ({ ...data }));
    });

    it('stops one host minting unbounded clients and conversations', async () => {
      const { limit } = WEBCHAT_THROTTLE_RULES.session;

      for (let i = 0; i < limit; i += 1) {
        const ok = await gateway.handleInit(makeSocketFrom(`s-${i}`, '9.9.9.9'), {
          widgetId: WIDGET_ID,
        });
        expect(ok.sessionId).toBeTruthy();
      }
      const blocked = await gateway.handleInit(makeSocketFrom('s-over', '9.9.9.9'), {
        widgetId: WIDGET_ID,
      });

      expect(blocked).toEqual({
        sessionId: '',
        greeting: 'Too many chat sessions. Please try again shortly.',
      });
      // The ceiling has to bind before the inserts, not after them.
      expect(prisma.clients.create).toHaveBeenCalledTimes(limit);
      expect(prisma.conversations.create).toHaveBeenCalledTimes(limit);
    });

    it('rations per caller, so one abuser does not close the widget for everyone', async () => {
      const { limit } = WEBCHAT_THROTTLE_RULES.session;
      for (let i = 0; i < limit + 1; i += 1) {
        await gateway.handleInit(makeSocketFrom(`s-${i}`, '9.9.9.9'), { widgetId: WIDGET_ID });
      }

      const other = await gateway.handleInit(makeSocketFrom('other', '10.0.0.1'), {
        widgetId: WIDGET_ID,
      });

      expect(other.sessionId).toBeTruthy();
    });

    it('never charges a visitor for resuming, however often their connection drops', async () => {
      // Reconnect replay is the case the signed token exists to serve; charging
      // it would punish exactly the visitor the feature is for.
      const first = await gateway.handleInit(makeSocketFrom('s-0', '9.9.9.9'), {
        widgetId: WIDGET_ID,
      });
      prisma.channel_contacts.findFirst.mockResolvedValue({ client: { id: CLIENT_ID } });
      prisma.conversations.findFirst.mockResolvedValue({ id: CONVERSATION_ID });

      for (let i = 0; i < WEBCHAT_THROTTLE_RULES.session.limit * 2; i += 1) {
        const again = await gateway.handleInit(makeSocketFrom(`r-${i}`, '9.9.9.9'), {
          widgetId: WIDGET_ID,
          sessionId: first.sessionId,
        });
        expect(rawSessionId(again.sessionId)).toBe(rawSessionId(first.sessionId));
      }
    });

    it('charges a rejected token as a new session, so forging is not a way around the ceiling', async () => {
      const { limit } = WEBCHAT_THROTTLE_RULES.session;

      for (let i = 0; i < limit; i += 1) {
        await gateway.handleInit(makeSocketFrom(`s-${i}`, '9.9.9.9'), {
          widgetId: WIDGET_ID,
          sessionId: 'unsigned-' + i,
        });
      }
      const blocked = await gateway.handleInit(makeSocketFrom('s-over', '9.9.9.9'), {
        widgetId: WIDGET_ID,
        sessionId: 'unsigned-over',
      });

      expect(blocked.sessionId).toBe('');
    });

    it('stops a socket looping unknown widgetIds from querying the database forever', async () => {
      // Every other ceiling on this gateway is charged *after* the widget has
      // been resolved, and an unknown widgetId returns before any of them. So
      // the `channel_accounts` lookup itself — against a pool this deployment
      // shares with another service — was the one piece of work an anonymous
      // socket could repeat without limit.
      const { limit } = WEBCHAT_THROTTLE_RULES.init;
      prisma.channel_accounts.findFirst.mockResolvedValue(null);

      for (let i = 0; i < limit; i += 1) {
        await gateway.handleInit(makeSocketFrom(`junk-${i}`, '9.9.9.9'), {
          widgetId: 'no-such-widget-' + i,
        });
      }
      expect(prisma.channel_accounts.findFirst).toHaveBeenCalledTimes(limit);

      const blocked = await gateway.handleInit(makeSocketFrom('junk-over', '9.9.9.9'), {
        widgetId: 'no-such-widget-over',
      });

      expect(blocked.sessionId).toBe('');
      // The point of the bucket: no further query was issued.
      expect(prisma.channel_accounts.findFirst).toHaveBeenCalledTimes(limit);
    });

    it('rations init per caller, so one looping socket does not lock the widget out', async () => {
      const { limit } = WEBCHAT_THROTTLE_RULES.init;
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      for (let i = 0; i < limit + 1; i += 1) {
        await gateway.handleInit(makeSocketFrom(`junk-${i}`, '9.9.9.9'), {
          widgetId: 'no-such-widget',
        });
      }

      prisma.channel_accounts.findFirst.mockResolvedValue({
        id: WIDGET_ID,
        business_id: BUSINESS_ID,
        metadata: {},
      });
      const other = await gateway.handleInit(makeSocketFrom('other', '10.0.0.1'), {
        widgetId: WIDGET_ID,
      });

      expect(other.sessionId).toBeTruthy();
    });

    it('caps the messages a single session can push into the AI pipeline', async () => {
      const client = await initSession(gateway, prisma, 'socket-flood', 'flood-session');
      prisma.messages.create.mockResolvedValue({});
      prisma.conversations.update.mockResolvedValue({});
      const { limit } = WEBCHAT_THROTTLE_RULES.message;

      for (let i = 0; i < limit; i += 1) {
        const ok = await gateway.handleMessage(client, { text: 'msg ' + i });
        expect(ok.received).toBe(true);
      }
      const blocked = await gateway.handleMessage(client, { text: 'one too many' });

      expect(blocked.received).toBe(false);
      expect(prisma.messages.create).toHaveBeenCalledTimes(limit);
      // A throttled message must not reach the pipeline either.
      expect(
        eventEmitter.emit.mock.calls.filter(([name]) => name === 'message.received'),
      ).toHaveLength(limit);
    });

    it('caps a host across sessions, not just within one', async () => {
      prisma.messages.create.mockResolvedValue({});
      prisma.conversations.update.mockResolvedValue({});
      prisma.channel_contacts.findFirst.mockResolvedValue({ client: { id: CLIENT_ID } });
      prisma.conversations.findFirst.mockResolvedValue({ id: CONVERSATION_ID });

      const { limit: perSession } = WEBCHAT_THROTTLE_RULES.message;
      const { limit: perIp } = WEBCHAT_THROTTLE_RULES.messageIp;
      const sessionsNeeded = Math.ceil(perIp / perSession) + 1;

      let sent = 0;
      let refused = 0;
      for (let s = 0; s < sessionsNeeded; s += 1) {
        const sock = makeSocketFrom(`sock-${s}`, '9.9.9.9');
        await gateway.handleInit(sock, { widgetId: WIDGET_ID, sessionId: token(`sess-${s}`) });
        for (let i = 0; i < perSession; i += 1) {
          const r = await gateway.handleMessage(sock, { text: 'x' });
          if (r.received) sent += 1;
          else refused += 1;
        }
      }

      // Spreading across fresh sessions cannot buy more than the host ceiling.
      expect(sent).toBe(perIp);
      expect(refused).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────
  // Outbound delivery
  // ─────────────────────────────────────────────

  describe('sendToClient', () => {
    it('emits chat:response on the registered socket', async () => {
      const client = await initSession(gateway, prisma, 'socket-out', 'out-session');
      const at = new Date('2026-08-13T10:00:00.000Z');

      const ok = gateway.sendToClient('out-session', { id: 'm1', text: 'Yes it is', timestamp: at });

      expect(ok).toBe(true);
      expect(client.emit).toHaveBeenCalledWith('chat:response', {
        messageId: 'm1',
        text: 'Yes it is',
        timestamp: at.toISOString(),
      });
    });

    it('returns false when the session has no live socket', () => {
      const warnSpy = jest.spyOn(gateway['logger'], 'warn').mockImplementation();

      const ok = gateway.sendToClient('gone', {
        id: 'm2',
        text: 'anyone?',
        timestamp: new Date(),
      });

      expect(ok).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('gone'));
    });
  });

  describe('deliverPendingMessages', () => {
    it('flushes queued messages to a connected session and clears the queue', async () => {
      const client = await initSession(gateway, prisma, 'socket-flush', 'flush-session');
      const at = new Date('2026-08-13T11:00:00.000Z');
      webchatResponseMap.set('flush-session', [
        { id: 'a', text: 'first', timestamp: at },
        { id: 'b', text: 'second', timestamp: at },
      ]);

      gateway.deliverPendingMessages();

      expect(client.emit).toHaveBeenCalledTimes(2);
      expect(client.emit).toHaveBeenCalledWith('chat:response', {
        messageId: 'a',
        text: 'first',
        timestamp: at.toISOString(),
      });
      expect(webchatResponseMap.has('flush-session')).toBe(false);
    });

    it('skips sessions with an empty queue', async () => {
      const client = await initSession(gateway, prisma, 'socket-empty', 'empty-session');
      webchatResponseMap.set('empty-session', []);

      gateway.deliverPendingMessages();

      expect(client.emit).not.toHaveBeenCalled();
      // An empty queue is left in place — `continue` runs before the delete.
      expect(webchatResponseMap.has('empty-session')).toBe(true);
    });

    it('keeps messages queued when the session has disconnected', () => {
      const at = new Date('2026-08-13T12:00:00.000Z');
      webchatResponseMap.set('offline-session', [{ id: 'c', text: 'held', timestamp: at }]);

      gateway.deliverPendingMessages();

      expect(webchatResponseMap.get('offline-session')).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────
  // Outbox delivery
  //
  // The gateway is the only thing in the process that can reach a visitor's
  // socket, and `WebChatAdapter` is the only thing that produces replies.
  // Nothing joined the two: the adapter's writes to `webchatResponseMap` were
  // read by `deliverPendingMessages()`, which no caller anywhere invoked. Every
  // AI reply to a web-chat visitor was therefore buffered, never sent, and
  // never freed. These cover the join.
  // ─────────────────────────────────────────────

  describe('outbox delivery', () => {
    afterEach(() => {
      setWebChatDeliverySink(null);
    });

    it('delivers a reply the adapter sends to a live session, and keeps nothing', async () => {
      const client = await initSession(gateway, prisma, 'socket-sink', 'sink-session');
      gateway.onModuleInit();

      const adapter = new WebChatAdapter({
        get: jest.fn().mockReturnValue(''),
      } as unknown as ConfigService);
      await adapter.sendMessage({
        channelAccountId: WIDGET_ID,
        recipientExternalId: 'sink-session',
        content: { type: MessageContentType.TEXT, text: 'three 2BHKs in Wakad' },
      });

      expect(client.emit).toHaveBeenCalledWith(
        'chat:response',
        expect.objectContaining({ text: 'three 2BHKs in Wakad' }),
      );
      expect(webchatResponseMap.has('sink-session')).toBe(false);
    });

    it('releases the sink on teardown so a dead gateway is not called again', async () => {
      const client = await initSession(gateway, prisma, 'socket-teardown', 'teardown-session');
      gateway.onModuleInit();
      gateway.onModuleDestroy();

      enqueueWebChatResponse('teardown-session', {
        id: 'm1',
        text: 'after shutdown',
        timestamp: new Date(),
      });

      expect(client.emit).not.toHaveBeenCalled();
      expect(webchatResponseMap.get('teardown-session')).toHaveLength(1);
    });

    it('flushes replies buffered while the visitor was between sockets', async () => {
      // The reply lands with nobody connected — the sink fires and finds no
      // socket, so the message waits.
      gateway.onModuleInit();
      enqueueWebChatResponse('reconnect-session', {
        id: 'm1',
        text: 'sorry for the wait',
        timestamp: new Date('2026-08-13T13:00:00.000Z'),
      });
      expect(webchatResponseMap.get('reconnect-session')).toHaveLength(1);

      // Reconnecting is the next moment it becomes deliverable; nothing else
      // will push it, because the sink only fires on a new send.
      const client = await initSession(gateway, prisma, 'socket-back', 'reconnect-session');

      expect(client.emit).toHaveBeenCalledWith('chat:response', {
        messageId: 'm1',
        text: 'sorry for the wait',
        timestamp: '2026-08-13T13:00:00.000Z',
      });
      expect(webchatResponseMap.has('reconnect-session')).toBe(false);
    });
  });

  describe('flushSession', () => {
    it('reports false, and holds the backlog, when the session has no socket', () => {
      webchatResponseMap.set('no-socket', [
        { id: 'm1', text: 'held', timestamp: new Date() },
      ]);

      expect(gateway.flushSession('no-socket')).toBe(false);
      expect(webchatResponseMap.get('no-socket')).toHaveLength(1);
    });

    it('reports false for a session with nothing buffered', async () => {
      await initSession(gateway, prisma, 'socket-nothing', 'nothing-session');

      expect(gateway.flushSession('nothing-session')).toBe(false);
    });

    it('re-queues what did not go out when the socket fails part-way', async () => {
      const client = await initSession(gateway, prisma, 'socket-partial', 'partial-session');
      const emit = client.emit as unknown as jest.Mock;
      emit.mockImplementationOnce(() => undefined).mockImplementationOnce(() => {
        throw new Error('socket closed mid-emit');
      });
      const at = new Date('2026-08-13T14:00:00.000Z');
      webchatResponseMap.set('partial-session', [
        { id: 'a', text: 'first', timestamp: at },
        { id: 'b', text: 'second', timestamp: at },
        { id: 'c', text: 'third', timestamp: at },
      ]);

      expect(gateway.flushSession('partial-session')).toBe(true);

      // Only the one that actually went out is dropped — replaying it would
      // show the visitor the same message twice.
      expect(webchatResponseMap.get('partial-session')?.map((m) => m.id)).toEqual(['b', 'c']);
    });
  });

  /**
   * Teardown used to clear the delivery sink and stop there. That stops new
   * replies reaching a socket but leaves the socket connected and all five maps
   * populated, so the visitor's widget sat on an open connection to a process
   * that had stopped answering — a silent hang, until Nest tore the Engine.IO
   * server down underneath it with no `disconnect` the client could react to.
   *
   * Sockets that connected but never completed `chat:init` are not disconnected
   * here: the gateway holds their id, not the socket, and they carry no session
   * state to lose. Nest closes the server under them, which is the same outcome
   * they would get anyway.
   */
  describe('shutdown', () => {
    it('hangs up on every live session so the widget reconnects to the replacement', async () => {
      const a = await initSession(gateway, prisma, 'socket-a', 'session-a');
      const b = await initSession(gateway, prisma, 'socket-b', 'session-b');

      gateway.onModuleDestroy();

      expect((a as unknown as { disconnect: jest.Mock }).disconnect).toHaveBeenCalledWith(true);
      expect((b as unknown as { disconnect: jest.Mock }).disconnect).toHaveBeenCalledWith(true);
    });

    it('forgets the session, so nothing keyed on a dead socket survives', async () => {
      await initSession(gateway, prisma, 'socket-forget', 'session-forget');
      webchatResponseMap.set('session-forget', [
        { id: 'm1', text: 'buffered', timestamp: new Date() },
      ]);

      gateway.onModuleDestroy();

      // No socket is known for the session any more — the map that would have
      // held it (and its businessId, and its conversationId) is empty.
      expect(gateway.flushSession('session-forget')).toBe(false);
    });

    it('refuses a message from a socket whose session it has released', async () => {
      const client = await initSession(gateway, prisma, 'socket-after', 'session-after');

      gateway.onModuleDestroy();
      const result = await gateway.handleMessage(client, { text: 'still there?' });

      expect(result.received).toBe(false);
      expect(prisma.messages.create).not.toHaveBeenCalled();
    });

    it('gives every per-IP connection slot back', () => {
      const client = makeCountedSocket('socket-ip', '203.0.113.9');
      gateway.handleConnection(client);
      expect(gateway.liveSocketsFor('203.0.113.9')).toBe(1);

      gateway.onModuleDestroy();

      // A counter keyed on a caller-controlled address is the one map that must
      // never outlive the sockets it counts.
      expect(gateway.liveSocketsFor('203.0.113.9')).toBe(0);
    });

    it('keeps closing the rest after one socket throws', async () => {
      const bad = await initSession(gateway, prisma, 'socket-bad', 'session-bad');
      const good = await initSession(gateway, prisma, 'socket-good', 'session-good');
      (bad as unknown as { disconnect: jest.Mock }).disconnect.mockImplementation(() => {
        throw new Error('socket already gone');
      });

      expect(() => gateway.onModuleDestroy()).not.toThrow();
      expect((good as unknown as { disconnect: jest.Mock }).disconnect).toHaveBeenCalled();
    });

    it('leaves buffered replies in the outbox rather than dropping them', async () => {
      await initSession(gateway, prisma, 'socket-outbox', 'session-outbox');
      webchatResponseMap.set('session-outbox', [
        { id: 'm1', text: 'undelivered', timestamp: new Date() },
      ]);

      gateway.onModuleDestroy();

      // The outbox is module-global and survives this gateway. Clearing it here
      // would discard a reply the visitor has not seen; it ages out on its own
      // TTL instead.
      expect(webchatResponseMap.get('session-outbox')).toHaveLength(1);
    });

    it('is safe to call with nothing connected', () => {
      expect(() => gateway.onModuleDestroy()).not.toThrow();
    });
  });
});

/**
 * Drive a real `chat:init` so the gateway's session maps are populated the same
 * way production populates them. `sessionId` is the raw id the maps key on; the
 * widget replays it wrapped in a signed token, so that is what is handed over.
 */
async function initSession(
  gateway: WebChatGateway,
  prisma: PrismaMock,
  socketId: string,
  sessionId = 'session-1',
): Promise<Socket> {
  prisma.channel_accounts.findFirst.mockResolvedValue({
    id: WIDGET_ID,
    business_id: BUSINESS_ID,
    metadata: {},
  });
  prisma.channel_contacts.findFirst.mockResolvedValue({ client: { id: CLIENT_ID } });
  prisma.conversations.findFirst.mockResolvedValue({ id: CONVERSATION_ID });

  const client = makeSocket(socketId);
  await gateway.handleInit(client, { widgetId: WIDGET_ID, sessionId: token(sessionId) });
  return client;
}

// ─────────────────────────────────────────────
// Concurrent init — one visitor, one thread
// ─────────────────────────────────────────────

/**
 * `chat:init` is find-or-create twice over — the client, then the conversation
 * — and a visitor drives two of them at once without meaning to: the widget
 * re-inits with the same token on every reconnect, and a second tab replays it
 * too. Concurrently both reads miss, both write, and one visitor becomes two
 * clients on two threads that the operator sees as two different people.
 *
 * Two things close it, and both are tested here: the in-process lock, which
 * serializes the pair, and the `(channel_account_id, external_id)` unique
 * constraint recovery underneath it, which is what holds when the lock does not
 * (a second instance, or a test that wires no lock).
 */
describe('WebChatGateway — concurrent init for one session', () => {
  let gateway: WebChatGateway;
  let prisma: PrismaMock;
  let eventEmitter: { emit: jest.Mock };
  let lock: ConversationLockService;

  /** A store that behaves like the contact table's unique constraint. */
  function wireStore(): { contacts: Map<string, { client: unknown }> } {
    const contacts = new Map<string, { client: unknown }>();

    prisma.channel_accounts.findFirst.mockResolvedValue({
      id: WIDGET_ID,
      business_id: BUSINESS_ID,
      metadata: {},
    });

    prisma.channel_contacts.findFirst.mockImplementation(async ({ where }) => {
      return contacts.get(where.external_id as string) ?? null;
    });
    prisma.clients.create.mockImplementation(async ({ data }) => ({ ...data }));
    prisma.channel_contacts.create.mockImplementation(async ({ data }) => {
      const key = data.external_id as string;
      if (contacts.has(key)) throw uniqueViolation();
      contacts.set(key, { client: { id: data.client_id, business_id: BUSINESS_ID } });
      return data;
    });

    const conversations = new Map<string, { id: string }>();
    prisma.conversations.findFirst.mockImplementation(async ({ where }) => {
      return conversations.get(where.client_id as string) ?? null;
    });
    prisma.conversations.create.mockImplementation(async ({ data }) => {
      conversations.set(data.client_id as string, { id: data.id as string });
      return { ...data };
    });

    return { contacts };
  }

  beforeEach(() => {
    prisma = makePrisma();
    eventEmitter = { emit: jest.fn() };
    lock = new ConversationLockService();
    gateway = new WebChatGateway(
      prisma as unknown as PrismaService,
      eventEmitter as unknown as EventEmitter2,
      {} as unknown as ChannelAdapterService,
      makeConfig(),
      new WebChatThrottle(),
      lock,
    );
    webchatResponseMap.clear();
  });

  afterEach(() => {
    webchatResponseMap.clear();
  });

  it('gives two simultaneous resumes of one session a single client and a single conversation', async () => {
    wireStore();
    const sessionId = 'session-shared';
    const resume = { widgetId: WIDGET_ID, sessionId: token(sessionId) };

    await Promise.all([
      gateway.handleInit(makeSocket('socket-a'), resume),
      gateway.handleInit(makeSocket('socket-b'), resume),
    ]);

    expect(prisma.clients.create).toHaveBeenCalledTimes(1);
    expect(prisma.conversations.create).toHaveBeenCalledTimes(1);
    // One thread means one `conversation.created`; two would fan a duplicate
    // out across every module that listens for a new customer.
    expect(
      eventEmitter.emit.mock.calls.filter((c) => c[0] === 'conversation.created'),
    ).toHaveLength(1);
  });

  it('still serializes when the two inits interleave inside the find-or-create', async () => {
    wireStore();
    // Make the contact read slow, which is the window the lock exists to close:
    // without it both inits read "no contact" before either writes one.
    const realFind = prisma.channel_contacts.findFirst.getMockImplementation()!;
    prisma.channel_contacts.findFirst.mockImplementation(async (args) => {
      await new Promise((r) => setTimeout(r, 5));
      return realFind(args);
    });
    const resume = { widgetId: WIDGET_ID, sessionId: token('session-slow') };

    await Promise.all([
      gateway.handleInit(makeSocket('socket-a'), resume),
      gateway.handleInit(makeSocket('socket-b'), resume),
    ]);

    expect(prisma.clients.create).toHaveBeenCalledTimes(1);
    expect(prisma.conversations.create).toHaveBeenCalledTimes(1);
  });

  it('leaves distinct sessions untouched — the lock is per session, not global', async () => {
    wireStore();

    await Promise.all([
      gateway.handleInit(makeSocket('socket-a'), {
        widgetId: WIDGET_ID,
        sessionId: token('session-one'),
      }),
      gateway.handleInit(makeSocket('socket-b'), {
        widgetId: WIDGET_ID,
        sessionId: token('session-two'),
      }),
    ]);

    expect(prisma.clients.create).toHaveBeenCalledTimes(2);
    expect(prisma.conversations.create).toHaveBeenCalledTimes(2);
  });

  it('recovers from a lost race at the unique constraint, with no orphan client left behind', async () => {
    // No lock wired: this is the cross-process case, where the constraint is
    // the only thing standing between two inits.
    const unlocked = new WebChatGateway(
      prisma as unknown as PrismaService,
      eventEmitter as unknown as EventEmitter2,
      {} as unknown as ChannelAdapterService,
      makeConfig(),
      new WebChatThrottle(),
    );
    const store = wireStore();
    const sessionId = 'session-raced';
    // The winner got there between our read and our write.
    prisma.channel_contacts.findFirst
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => store.contacts.get(sessionId) ?? null);
    store.contacts.set(sessionId, {
      client: { id: CLIENT_ID, business_id: BUSINESS_ID },
    });

    const result = await unlocked.handleInit(makeSocket('socket-late'), {
      widgetId: WIDGET_ID,
      sessionId: token(sessionId),
    });

    // The visitor is served, not 500'd, and lands on the winner's client.
    expect(rawSessionId(result.sessionId)).toBe(sessionId);
    expect(unlocked['sessionContext'].get(sessionId)?.clientId).toBe(CLIENT_ID);
    // The client insert happened inside the transaction that then failed, so
    // it rolled back with it rather than orphaning a "Web Visitor" row.
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('rethrows a unique violation it cannot resolve to a contact', async () => {
    wireStore();
    // P2002 on some *other* constraint: nothing to re-read, so returning a
    // client id that is not there would be worse than the error.
    prisma.channel_contacts.findFirst.mockResolvedValue(null);
    prisma.channel_contacts.create.mockImplementation(async () => {
      throw uniqueViolation();
    });

    // Surfaced, not swallowed into a session pointing at a client that does not
    // exist — the visitor's widget retries an init it can see failed.
    await expect(
      gateway.handleInit(makeSocket('socket-x'), {
        widgetId: WIDGET_ID,
        sessionId: token('session-unresolvable'),
      }),
    ).rejects.toThrow('Unique constraint failed');
    expect(gateway['sessionContext'].size).toBe(0);
  });
});
