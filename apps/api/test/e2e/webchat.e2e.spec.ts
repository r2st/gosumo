/**
 * Web Chat channel — end-to-end tests.
 *
 * Web Chat is not an HTTP webhook: it is a Socket.IO gateway on the `/webchat`
 * namespace. These tests connect a real socket.io-client to the running server
 * and exercise the connect → chat:init → chat:message handshake end to end,
 * with PrismaService mocked so no database is required.
 *
 * Coverage:
 *  - Socket.IO connection to the /webchat namespace
 *  - chat:init returns a sessionId and the configured greeting
 *  - chat:message is acknowledged, persisted, and emits message.received
 *  - An invalid widgetId is rejected
 */
import { io, Socket } from 'socket.io-client';

import { createHarness, E2EHarness } from './utils/e2e-harness';

const WIDGET_ID = 'widget-123';

function validWidgetChannel() {
  return {
    id: WIDGET_ID,
    business_id: 'biz-1',
    channel: 'WEB_CHAT',
    is_active: true,
    deleted_at: null,
    metadata: { greeting: 'Welcome to GoSumo!' },
  };
}

/** Connect a client to the /webchat namespace and resolve once connected. */
function connect(baseUrl: string, widgetId: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${baseUrl}/webchat`, {
      transports: ['websocket'],
      query: { widgetId },
      forceNew: true,
      reconnection: false,
    });
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Emit an event with an acknowledgement callback, resolved as a promise. */
function emitAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), 8000);
    socket.emit(event, payload, (ack: T) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

describe('Web Chat channel (e2e)', () => {
  let h: E2EHarness;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    h = await createHarness({
      prisma: {
        channel_accounts: { findFirst: jest.fn().mockResolvedValue(validWidgetChannel()) },
      },
    });
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await h.close();
  });

  beforeEach(() => {
    h.events.length = 0;
  });

  it('establishes a Socket.IO connection on the /webchat namespace', async () => {
    const socket = await connect(h.baseUrl, WIDGET_ID);
    sockets.push(socket);
    expect(socket.connected).toBe(true);
  });

  it('chat:init returns a sessionId and the configured greeting', async () => {
    const socket = await connect(h.baseUrl, WIDGET_ID);
    sockets.push(socket);

    const ack = await emitAck<{ sessionId: string; greeting: string }>(socket, 'chat:init', {
      widgetId: WIDGET_ID,
    });

    expect(ack.sessionId).toBeTruthy();
    expect(ack.greeting).toBe('Welcome to GoSumo!');
  });

  it('exchanges a message: chat:message is acked, persisted, and emits message.received', async () => {
    const socket = await connect(h.baseUrl, WIDGET_ID);
    sockets.push(socket);

    const init = await emitAck<{ sessionId: string; greeting: string }>(socket, 'chat:init', {
      widgetId: WIDGET_ID,
    });

    const ack = await emitAck<{ received: boolean; messageId: string }>(socket, 'chat:message', {
      sessionId: init.sessionId,
      text: 'Hi, do you have availability tomorrow?',
    });

    expect(ack.received).toBe(true);
    expect(ack.messageId).toBeTruthy();

    // Message was persisted…
    expect(h.prisma['messages']!['create']).toHaveBeenCalled();
    // …and a domain event was emitted on the bus.
    expect(h.events.some((e) => e.name === 'message.received')).toBe(true);
  });

  it('rejects an unknown widgetId', async () => {
    // Point the widget lookup at "not found" for this connection.
    (h.prisma['channel_accounts']!['findFirst'] as jest.Mock).mockResolvedValueOnce(null);

    const socket = await connect(h.baseUrl, 'bad-widget');
    sockets.push(socket);

    const ack = await emitAck<{ sessionId: string; greeting: string }>(socket, 'chat:init', {
      widgetId: 'bad-widget',
    });

    expect(ack.sessionId).toBe('');
    expect(ack.greeting).toBe('Widget not found');
  });
});
