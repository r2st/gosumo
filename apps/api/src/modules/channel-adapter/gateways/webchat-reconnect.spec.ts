/**
 * Web-chat reconnection, delivery ordering, and concurrent sockets.
 *
 * `webchat.gateway.spec.ts` covers each mechanism in isolation: the session
 * maps, the token, the ceilings, the outbox. What it does not cover is the
 * thing a visitor with a flaky connection actually experiences, which is those
 * mechanisms interacting — a socket dying mid-conversation, replies piling up,
 * a new socket arriving with the same token while the old one is still open,
 * and a second tab doing all of it again alongside.
 *
 * The invariants asserted here:
 *
 *  1. **Order survives a disconnect.** A visitor who reconnects reads the
 *     backlog in the order the AI produced it. Web chat is a conversation; two
 *     replies delivered backwards are a different conversation.
 *  2. **The live socket is the one that gets the backlog.** The reconnect's
 *     `chat:init` routinely lands *before* the old socket's `disconnect` —
 *     Socket.IO does not notice a dead peer until `pingTimeout` — so "the
 *     socket for this session" is a moving target at exactly the moment the
 *     flush happens.
 *  3. **Concurrent sockets do not cross.** Two tabs are two sessions under one
 *     widget, and every map on this gateway is process-wide across tenants.
 *
 * Ordering is asserted on `emit` call order rather than on the outbox array,
 * because the array is an implementation detail and the order the visitor sees
 * is not.
 */

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Socket } from 'socket.io';

import { WebChatGateway } from './webchat.gateway';
import { PrismaService } from '../../../common/services/prisma.service';
import { ChannelAdapterService } from '../channel-adapter.service';
import {
  enqueueWebChatResponse,
  setWebChatDeliverySink,
  webchatResponseMap,
  WEBCHAT_OUTBOX_MAX_PER_SESSION,
} from '../adapters/webchat.adapter';
import { signWebChatSession } from '../../../common/utils/webchat-session.util';
import { WebChatThrottle } from './webchat-throttle';
import { withMessageSequence } from '../../../common/testing/message-sequence.mock';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const WIDGET_ID = '00000000-0000-4000-a000-000000000002';
const CLIENT_ID = '00000000-0000-4000-a000-000000000003';
const CONVERSATION_ID = '00000000-0000-4000-a000-000000000004';
const OTHER_CLIENT_ID = '00000000-0000-4000-a000-000000000005';
const OTHER_CONVERSATION_ID = '00000000-0000-4000-a000-000000000006';
const SECRET = 'test-jwt-secret';

function token(sessionId: string, widgetId = WIDGET_ID): string {
  return signWebChatSession(widgetId, SECRET, sessionId);
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
    messages: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (fn: (tx: PrismaMock) => Promise<unknown>) => fn(prisma),
  );
  // Teach the double to allocate `messages.sequence` — see the mock's own note.
  return withMessageSequence(prisma);
}

type FakeSocket = Socket & { emit: jest.Mock; disconnect: jest.Mock };

function makeSocket(id: string): FakeSocket {
  return {
    id,
    handshake: { query: {}, headers: {} },
    emit: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as FakeSocket;
}

function makeConfig(): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: unknown) =>
      key === 'jwt.secret' ? SECRET : fallback,
    ),
  } as unknown as ConfigService;
}

/** The `text` of every `chat:response` this socket was sent, in order. */
function delivered(socket: FakeSocket): string[] {
  return socket.emit.mock.calls
    .filter(([event]) => event === 'chat:response')
    .map(([, payload]) => (payload as { text: string }).text);
}

/** Buffer a reply for `sessionId` the way `WebChatAdapter` does. */
function reply(sessionId: string, text: string, at = Date.now()): void {
  enqueueWebChatResponse(
    sessionId,
    { id: `msg-${text}`, text, timestamp: new Date(at) },
    at,
  );
}

describe('WebChatGateway — reconnection and delivery ordering', () => {
  let gateway: WebChatGateway;
  let prisma: PrismaMock;
  let emitter: { emit: jest.Mock };

  /**
   * Drive a real `chat:init` so the session maps are populated exactly the way
   * production populates them — including the flush the handler does on the
   * way out, which is the whole reconnect story.
   */
  async function init(socketId: string, sessionId: string): Promise<FakeSocket> {
    const socket = makeSocket(socketId);
    await gateway.handleInit(socket, {
      widgetId: WIDGET_ID,
      sessionId: token(sessionId),
    });
    return socket;
  }

  beforeEach(() => {
    prisma = makePrisma();
    emitter = { emit: jest.fn() };
    gateway = new WebChatGateway(
      prisma as unknown as PrismaService,
      emitter as unknown as EventEmitter2,
      {} as unknown as ChannelAdapterService,
      makeConfig(),
      new WebChatThrottle(),
    );

    prisma.channel_accounts.findFirst.mockResolvedValue({
      id: WIDGET_ID,
      business_id: BUSINESS_ID,
      metadata: {},
    });
    prisma.channel_contacts.findFirst.mockResolvedValue({ client: { id: CLIENT_ID } });
    prisma.conversations.findFirst.mockResolvedValue({ id: CONVERSATION_ID });

    webchatResponseMap.clear();
  });

  afterEach(() => {
    setWebChatDeliverySink(null);
    webchatResponseMap.clear();
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────
  // Ordering across a disconnect
  // ─────────────────────────────────────────────

  describe('message ordering across disconnect and reconnect', () => {
    it('replays a backlog in the order it was produced', async () => {
      const first = await init('socket-a', 'session-1');
      gateway.handleDisconnect(first);

      reply('session-1', 'one');
      reply('session-1', 'two');
      reply('session-1', 'three');

      const second = await init('socket-b', 'session-1');

      expect(delivered(second)).toEqual(['one', 'two', 'three']);
      // Nothing goes to the socket that was already gone.
      expect(delivered(first)).toEqual([]);
    });

    it('keeps a reply that arrives after the flush behind the backlog', async () => {
      const first = await init('socket-a', 'session-1');
      gateway.handleDisconnect(first);

      reply('session-1', 'buffered');
      const second = await init('socket-b', 'session-1');

      // Live again: the sink delivers this one immediately.
      gateway.onModuleInit();
      reply('session-1', 'live');

      expect(delivered(second)).toEqual(['buffered', 'live']);
    });

    it('leaves nothing buffered once the reconnect has drained it', async () => {
      const first = await init('socket-a', 'session-1');
      gateway.handleDisconnect(first);
      reply('session-1', 'one');
      reply('session-1', 'two');

      await init('socket-b', 'session-1');

      // A backlog that survives its own delivery is replayed on the next
      // reconnect — the visitor reads the same two replies twice.
      expect(webchatResponseMap.has('session-1')).toBe(false);
    });

    it('delivers the remainder in order after a partial failure', async () => {
      const first = await init('socket-a', 'session-1');
      gateway.handleDisconnect(first);

      reply('session-1', 'one');
      reply('session-1', 'two');
      reply('session-1', 'three');

      // A socket that dies part-way through the flush: the first emit lands,
      // the second throws, and the rest must stay queued *in order*.
      const flaky = makeSocket('socket-b');
      let emits = 0;
      flaky.emit.mockImplementation((event: string) => {
        if (event !== 'chat:response') return true;
        emits += 1;
        if (emits > 1) throw new Error('socket closed');
        return true;
      });
      await gateway.handleInit(flaky, { widgetId: WIDGET_ID, sessionId: token('session-1') });

      // `two` was attempted and threw, so only `one` actually reached the
      // visitor and the flush stopped there.
      expect(delivered(flaky)).toEqual(['one', 'two']);
      // Exactly what did not land stays queued, in order — replaying `one`
      // would show the visitor a reply they already have.
      expect(webchatResponseMap.get('session-1')?.map((m) => m.text)).toEqual(['two', 'three']);

      const healthy = await init('socket-c', 'session-1');
      expect(delivered(healthy)).toEqual(['two', 'three']);
    });

    it('replays the newest tail, in order, when the backlog overflowed', async () => {
      const first = await init('socket-a', 'session-1');
      gateway.handleDisconnect(first);

      // A visitor gone long enough for the per-session ceiling to bite. The
      // outbox keeps the tail — what it must not do is keep it shuffled.
      for (let i = 0; i < WEBCHAT_OUTBOX_MAX_PER_SESSION + 5; i += 1) {
        reply('session-1', `m${i}`);
      }

      const second = await init('socket-b', 'session-1');
      const texts = delivered(second);

      expect(texts).toHaveLength(WEBCHAT_OUTBOX_MAX_PER_SESSION);
      expect(texts[0]).toBe('m5');
      expect(texts[texts.length - 1]).toBe(`m${WEBCHAT_OUTBOX_MAX_PER_SESSION + 4}`);
      expect(texts).toEqual([...texts].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
    });

    it('holds the backlog for a visitor who never comes back, rather than dropping it on the floor', () => {
      reply('session-orphan', 'unread');

      expect(gateway.flushSession('session-orphan')).toBe(false);
      expect(webchatResponseMap.get('session-orphan')?.map((m) => m.text)).toEqual(['unread']);
    });
  });

  // ─────────────────────────────────────────────
  // The reconnect race
  // ─────────────────────────────────────────────

  describe('reconnect that overtakes the old socket disconnect', () => {
    it('flushes to the new socket when the old one has not been reaped yet', async () => {
      const old = await init('socket-a', 'session-1');
      // No `handleDisconnect` — Socket.IO has not noticed the peer is gone.
      reply('session-1', 'while-away');

      const fresh = await init('socket-b', 'session-1');

      expect(delivered(fresh)).toEqual(['while-away']);
      expect(delivered(old)).toEqual([]);
    });

    it('keeps the new socket live when the old one disconnects afterwards', async () => {
      const old = await init('socket-a', 'session-1');
      const fresh = await init('socket-b', 'session-1');

      // The late disconnect for the socket that was already superseded.
      gateway.handleDisconnect(old);

      gateway.onModuleInit();
      reply('session-1', 'after-the-race');

      expect(delivered(fresh)).toEqual(['after-the-race']);
    });

    it('still accepts messages from the new socket after the late disconnect', async () => {
      const old = await init('socket-a', 'session-1');
      const fresh = await init('socket-b', 'session-1');
      gateway.handleDisconnect(old);

      const result = await gateway.handleMessage(fresh, { text: 'still here' });

      // The bug this guards: deleting the session unconditionally on the late
      // disconnect wiped the live socket's context, and every message after it
      // answered `received: false` and vanished with nothing surfaced.
      expect(result.received).toBe(true);
      expect(prisma.messages.create).toHaveBeenCalled();
    });

    it('refuses messages from the socket that lost the session', async () => {
      const old = await init('socket-a', 'session-1');
      await init('socket-b', 'session-1');

      const result = await gateway.handleMessage(old, { text: 'from the dead socket' });

      expect(result.received).toBe(false);
      expect(prisma.messages.create).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // Concurrent sockets
  // ─────────────────────────────────────────────

  describe('concurrent connections from one visitor', () => {
    it('routes each session reply only to its own socket', async () => {
      const tabA = await init('socket-a', 'session-a');
      const tabB = await init('socket-b', 'session-b');

      gateway.onModuleInit();
      reply('session-a', 'for-a');
      reply('session-b', 'for-b');

      expect(delivered(tabA)).toEqual(['for-a']);
      expect(delivered(tabB)).toEqual(['for-b']);
    });

    it('writes each tab message to its own conversation', async () => {
      const tabA = await init('socket-a', 'session-a');

      // The second tab resolves to a different thread.
      prisma.channel_contacts.findFirst.mockResolvedValue({ client: { id: OTHER_CLIENT_ID } });
      prisma.conversations.findFirst.mockResolvedValue({ id: OTHER_CONVERSATION_ID });
      const tabB = await init('socket-b', 'session-b');

      await gateway.handleMessage(tabA, { text: 'from a' });
      await gateway.handleMessage(tabB, { text: 'from b' });

      const conversations = prisma.messages.create.mock.calls.map(
        ([args]) => (args as { data: { conversation_id: string } }).data.conversation_id,
      );
      expect(conversations).toEqual([CONVERSATION_ID, OTHER_CONVERSATION_ID]);
    });

    it('does not let a message name another live session', async () => {
      const tabA = await init('socket-a', 'session-a');
      await init('socket-b', 'session-b');

      // `sessionContext` spans every tenant. Honouring a body `sessionId` let
      // any socket post into any other visitor's conversation — under that
      // conversation's businessId — with no forged init needed.
      await gateway.handleMessage(tabA, { text: 'hijack', sessionId: 'session-b' });

      const [args] = prisma.messages.create.mock.calls[0] as [
        { data: { conversation_id: string } },
      ];
      expect(args.data.conversation_id).toBe(CONVERSATION_ID);
    });

    it('leaves the surviving tab working when the other disconnects', async () => {
      const tabA = await init('socket-a', 'session-a');
      const tabB = await init('socket-b', 'session-b');

      gateway.handleDisconnect(tabA);

      gateway.onModuleInit();
      reply('session-b', 'still-delivered');

      expect(delivered(tabB)).toEqual(['still-delivered']);
      expect((await gateway.handleMessage(tabB, { text: 'ok' })).received).toBe(true);
      expect((await gateway.handleMessage(tabA, { text: 'gone' })).received).toBe(false);
    });

    it('releases the earlier session when one socket re-inits as another', async () => {
      const socket = await init('socket-a', 'session-a');
      await gateway.handleInit(socket, {
        widgetId: WIDGET_ID,
        sessionId: token('session-b'),
      });

      // `socketToSession` maps one socket to one session, so the older entry
      // would otherwise sit in `sessions`/`sessionContext` for the life of the
      // process — and resuming is deliberately not rate-limited, so a client
      // replaying tokens grew both maps without opening a single new session.
      reply('session-a', 'orphaned');
      expect(gateway.flushSession('session-a')).toBe(false);

      gateway.onModuleInit();
      reply('session-b', 'current');
      expect(delivered(socket)).toEqual(['current']);
    });

    it('hangs up on every live tab at shutdown so both widgets reconnect', async () => {
      const tabA = await init('socket-a', 'session-a');
      const tabB = await init('socket-b', 'session-b');

      gateway.onModuleDestroy();

      expect(tabA.disconnect).toHaveBeenCalledWith(true);
      expect(tabB.disconnect).toHaveBeenCalledWith(true);
    });

    it('leaves an undelivered reply in the outbox across a restart', async () => {
      await init('socket-a', 'session-a');
      reply('session-a', 'unseen');
      // Nothing has flushed it: no sink is registered in this test.

      gateway.onModuleDestroy();

      // The outbox is module-global and outlives this gateway — the reply is
      // what the visitor has not read yet, and it flushes on the next
      // `chat:init` against the replacement process.
      expect(webchatResponseMap.get('session-a')?.map((m) => m.text)).toEqual(['unseen']);
    });
  });
});
