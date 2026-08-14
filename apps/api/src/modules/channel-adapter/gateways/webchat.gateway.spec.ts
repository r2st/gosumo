import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Socket } from 'socket.io';
import { ChannelType } from '@gosumo/shared';
import { WebChatGateway } from './webchat.gateway';
import { PrismaService } from '../../../common/services/prisma.service';
import { ChannelAdapterService } from '../channel-adapter.service';
import { webchatResponseMap } from '../adapters/webchat.adapter';
import {
  signWebChatSession,
  verifyWebChatSession,
} from '../../../common/utils/webchat-session.util';

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
};

function makePrisma(): PrismaMock {
  return {
    channel_accounts: { findFirst: jest.fn() },
    channel_contacts: { findFirst: jest.fn(), create: jest.fn() },
    clients: { create: jest.fn() },
    conversations: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    messages: { create: jest.fn() },
  };
}

function makeSocket(id = 'socket-1', query: Record<string, unknown> = {}): Socket {
  return {
    id,
    handshake: { query },
    emit: jest.fn(),
  } as unknown as Socket;
}

function makeConfig(secret: string = SECRET): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: unknown) =>
      key === 'jwt.secret' ? secret : fallback,
    ),
  } as unknown as ConfigService;
}

describe('WebChatGateway', () => {
  let gateway: WebChatGateway;
  let prisma: PrismaMock;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(() => {
    prisma = makePrisma();
    eventEmitter = { emit: jest.fn() };
    gateway = new WebChatGateway(
      prisma as unknown as PrismaService,
      eventEmitter as unknown as EventEmitter2,
      {} as unknown as ChannelAdapterService,
      makeConfig(),
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
