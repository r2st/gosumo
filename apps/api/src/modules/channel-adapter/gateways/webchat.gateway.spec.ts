import { EventEmitter2 } from '@nestjs/event-emitter';
import { Socket } from 'socket.io';
import { ChannelType } from '@gosumo/shared';
import { WebChatGateway } from './webchat.gateway';
import { PrismaService } from '../../../common/services/prisma.service';
import { ChannelAdapterService } from '../channel-adapter.service';
import { webchatResponseMap } from '../adapters/webchat.adapter';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const WIDGET_ID = '00000000-0000-4000-a000-000000000002';
const CLIENT_ID = '00000000-0000-4000-a000-000000000003';
const CONVERSATION_ID = '00000000-0000-4000-a000-000000000004';

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
      const result = await gateway.handleMessage(second, {
        sessionId: 'session-1',
        text: 'hello again',
      });
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
      const result = await gateway.handleMessage(second, {
        sessionId: 'session-1',
        text: 'anyone?',
      });
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

      expect(result.sessionId).toBeTruthy();
      expect(result.greeting).toBe('Namaste! How can we help?');
      expect(prisma.clients.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ business_id: BUSINESS_ID, name: 'Web Visitor' }),
      });
      expect(prisma.channel_contacts.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: BUSINESS_ID,
          channel: ChannelType.WEB_CHAT,
          external_id: result.sessionId,
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
      expect(gateway['sessions'].get(result.sessionId)).toBe(client);
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
        sessionId: 'returning-session',
      });

      expect(result.sessionId).toBe('returning-session');
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
      const result = await gateway.handleMessage(makeSocket(), {
        sessionId: 'ghost',
        text: 'hello',
      });

      expect(result.received).toBe(false);
      expect(result.messageId).toBeTruthy();
      expect(prisma.messages.create).not.toHaveBeenCalled();
    });

    it('stores the message, bumps the conversation, and emits message.received', async () => {
      await initSession(gateway, prisma, 'socket-msg', 'live-session');
      prisma.messages.create.mockResolvedValue({});
      prisma.conversations.update.mockResolvedValue({});

      const result = await gateway.handleMessage(makeSocket(), {
        sessionId: 'live-session',
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
      await initSession(gateway, prisma, 'socket-err', 'err-session');
      prisma.messages.create.mockRejectedValue(new Error('deadlock detected'));
      const errorSpy = jest.spyOn(gateway['logger'], 'error').mockImplementation();

      const result = await gateway.handleMessage(makeSocket(), {
        sessionId: 'err-session',
        text: 'hi',
      });

      expect(result.received).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('deadlock detected'));
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'message.received',
        expect.anything(),
      );
    });

    it('stringifies a non-Error rejection rather than crashing the socket handler', async () => {
      await initSession(gateway, prisma, 'socket-str', 'str-session');
      prisma.messages.create.mockRejectedValue('connection reset');
      const errorSpy = jest.spyOn(gateway['logger'], 'error').mockImplementation();

      const result = await gateway.handleMessage(makeSocket(), {
        sessionId: 'str-session',
        text: 'hi',
      });

      expect(result.received).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
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
 * way production populates them.
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
  await gateway.handleInit(client, { widgetId: WIDGET_ID, sessionId });
  return client;
}
