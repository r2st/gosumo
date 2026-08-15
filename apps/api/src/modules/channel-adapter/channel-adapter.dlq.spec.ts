/**
 * ChannelAdapterService — inbound dead-lettering, replay, and per-sender
 * serialization.
 *
 * The loss this covers is silent by construction. `webhook_events` records a
 * delivery *before* it is processed, so the row is the dedupe claim for every
 * later redelivery of that message. When processing then threw, the old code
 * logged and moved on: the provider's retry — the only retry that existed —
 * came back and was discarded as a duplicate, and the customer's message was
 * gone with a 200 on the wire and a healthy-looking `webhook_events` row
 * marked `processed: true`.
 *
 * So the tests here are about what happens *after* a failure: that the payload
 * is parked, that a replay re-runs exactly the message that failed (and only
 * that one, out of a batch), and that the delivery is not marked processed
 * until it actually is.
 *
 * The second half covers the concurrency the batch loop cannot: two webhook
 * POSTs from the same buyer arriving together, each running find-or-create for
 * the same contact and conversation.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ChannelType,
  MessageContentType,
  NormalizedMessage,
  RawRequest,
} from '@gosumo/shared';
import { ChannelAdapterService } from './channel-adapter.service';
import { PrismaService } from '../../common/services/prisma.service';
import { WebhookDlqService } from '../webhook-log/webhook-dlq.service';
import { ConversationLockService } from '../../common/services/conversation-lock.service';
import { withMessageSequence } from '../../common/testing/message-sequence.mock';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000002';
const RESOLVED_BUSINESS_ID = '00000000-0000-4000-a000-000000000009';
const ACCOUNT_ID = '111111111111111';
const WA_ID = '919999900001';

function makeNormalized(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'envelope-uuid',
    channel: ChannelType.WHATSAPP,
    channelAccountId: ACCOUNT_ID,
    externalId: 'wamid.ONE',
    sender: { externalId: WA_ID, displayName: 'Priya' },
    content: { type: MessageContentType.TEXT, text: 'hi' },
    timestamp: new Date().toISOString(),
    ...overrides,
  } as NormalizedMessage;
}

const REQ: RawRequest = {
  headers: { 'x-hub-signature-256': 'sha256=abc' },
  body: { entry: [{ id: 'e1' }] },
};

/** Prisma doubles whose happy path resolves an account, contact and conversation. */
function makePrisma() {
  const channel_accounts = {
    findFirst: jest.fn().mockResolvedValue({
      id: 'acct-row',
      business_id: RESOLVED_BUSINESS_ID,
    }),
  };
  const channel_contacts = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'contact-1', client_id: 'client-1' }),
    update: jest.fn().mockResolvedValue({}),
  };
  const clients = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'client-1' }),
    update: jest.fn().mockResolvedValue({}),
  };
  const conversations = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
    update: jest.fn().mockResolvedValue({}),
  };
  const messages = { create: jest.fn().mockResolvedValue({ id: 'msg-1' }) };
  const webhook_events = {
    create: jest.fn().mockResolvedValue({ id: 'evt_1' }),
    update: jest.fn().mockResolvedValue({}),
  };

  return {
    prisma: withMessageSequence({
      channel_accounts,
      channel_contacts,
      clients,
      conversations,
      messages,
      webhook_events,
    }) as unknown as PrismaService,
    channel_accounts,
    channel_contacts,
    clients,
    conversations,
    messages,
    webhook_events,
  };
}

type Doubles = ReturnType<typeof makePrisma>;

/** Adapter double: signature always passes, batch parser returns `parsed`. */
function makeAdapter(parsed: NormalizedMessage[]) {
  return {
    channelType: ChannelType.WHATSAPP,
    validateWebhook: jest.fn().mockReturnValue(true),
    parseInbound: jest.fn().mockReturnValue(parsed[0]),
    parseInboundAll: jest.fn().mockReturnValue(parsed),
    sendMessage: jest.fn(),
    sendTemplate: jest.fn(),
    sendInteractive: jest.fn(),
    getCapabilities: jest.fn().mockReturnValue({ channelType: ChannelType.WHATSAPP }),
  };
}

describe('ChannelAdapterService — inbound dead-lettering and replay', () => {
  let service: ChannelAdapterService;
  let db: Doubles;
  let emitter: { emit: jest.Mock };
  let dlq: { capture: jest.Mock; registerReplayer: jest.Mock };
  /** source → the replay handler the service registered for it. */
  let replayers: Map<string, (payload: Record<string, unknown>) => Promise<void>>;

  async function build(): Promise<void> {
    db = makePrisma();
    emitter = { emit: jest.fn() };
    replayers = new Map();
    dlq = {
      capture: jest.fn().mockResolvedValue({ id: 'dl_1' }),
      registerReplayer: jest.fn((source: string, handler) => {
        replayers.set(source, handler);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelAdapterService,
        { provide: PrismaService, useValue: db.prisma },
        { provide: EventEmitter2, useValue: emitter },
        { provide: WebhookDlqService, useValue: dlq },
        ConversationLockService,
      ],
    }).compile();

    service = module.get(ChannelAdapterService);
    service.onModuleInit();
  }

  beforeEach(build);

  /** Drive one inbound webhook whose payload parses to `parsed`. */
  async function inbound(parsed: NormalizedMessage[]): Promise<void> {
    service.registerAdapter(makeAdapter(parsed) as never);
    await service.handleInboundWebhookBatch(ChannelType.WHATSAPP, REQ, BUSINESS_ID);
  }

  // ── Registration ────────────────────────────────────────

  describe('replayer registration', () => {
    it('registers one replayer per channel', () => {
      // The DLQ keys its registry on the captured `source`, which for a channel
      // webhook is the ChannelType. A channel with no replayer would have its
      // entries fail every attempt until they were auto-discarded.
      for (const channel of Object.values(ChannelType)) {
        expect(replayers.has(channel)).toBe(true);
      }
    });
  });

  // ── Replay ──────────────────────────────────────────────

  describe('replaying a captured delivery', () => {
    /** Fail one delivery, then hand its captured payload back to the replayer. */
    async function captureThenReplay(parsed: NormalizedMessage[]): Promise<void> {
      db.conversations.findFirst.mockRejectedValueOnce(new Error('db down'));
      await inbound(parsed);

      const [delivery] = dlq.capture.mock.calls[0] as [{ payload: Record<string, unknown> }];
      const replay = replayers.get(ChannelType.WHATSAPP)!;
      await replay(delivery.payload);
    }

    it('stores the message the second time around', async () => {
      await captureThenReplay([makeNormalized()]);

      expect(db.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            conversation_id: 'conv-1',
            external_id: 'wamid.ONE',
          }),
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        'message.received',
        expect.objectContaining({ conversationId: 'conv-1', messageId: 'msg-1' }),
      );
    });

    it('closes out the webhook_events row the failed attempt left open', async () => {
      await captureThenReplay([makeNormalized()]);

      expect(db.webhook_events.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'evt_1' },
          data: expect.objectContaining({ processed: true }),
        }),
      );
    });

    it('does not re-record the delivery, which would collide with its own claim', async () => {
      // The `webhook_events` row already exists; a replay that inserted again
      // would hit P2002 and be read as "duplicate — skip", quietly refusing to
      // ever recover the message.
      await captureThenReplay([makeNormalized()]);

      expect(db.webhook_events.create).toHaveBeenCalledTimes(1);
    });

    it('replays only the message that failed, not its batch siblings', async () => {
      // Meta packs several messages into one POST and each gets its own
      // `webhook_events` row and its own outcome. Replaying the whole body
      // would re-deliver the siblings that already succeeded.
      const first = makeNormalized({ externalId: 'wamid.ONE' });
      const second = makeNormalized({ id: 'envelope-2', externalId: 'wamid.TWO' });

      // Fail only the second message's persistence.
      db.conversations.findFirst
        .mockResolvedValueOnce({ id: 'conv-1' })
        .mockRejectedValueOnce(new Error('db down'));

      await inbound([first, second]);

      expect(dlq.capture).toHaveBeenCalledTimes(1);
      const [delivery] = dlq.capture.mock.calls[0] as [
        { externalId: string; payload: Record<string, unknown> },
      ];
      expect(delivery.externalId).toBe('wamid.TWO');

      db.messages.create.mockClear();
      await replayers.get(ChannelType.WHATSAPP)!(delivery.payload);

      expect(db.messages.create).toHaveBeenCalledTimes(1);
      expect(db.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ external_id: 'wamid.TWO' }),
        }),
      );
    });

    it('fails the attempt when the payload no longer carries that message', async () => {
      db.conversations.findFirst.mockRejectedValueOnce(new Error('db down'));
      await inbound([makeNormalized()]);
      const [delivery] = dlq.capture.mock.calls[0] as [{ payload: Record<string, unknown> }];

      // Re-register an adapter that now parses the same body to a different id.
      service.registerAdapter(
        makeAdapter([makeNormalized({ externalId: 'wamid.OTHER' })]) as never,
      );

      // Throwing is how the DLQ knows to reschedule or discard — a silent
      // success would mark the entry REPLAYED having done nothing.
      await expect(replayers.get(ChannelType.WHATSAPP)!(delivery.payload)).rejects.toThrow(
        /no longer contains/,
      );
    });

    it('rejects a payload with no channel or tenant rather than guessing', async () => {
      await expect(replayers.get(ChannelType.WHATSAPP)!({})).rejects.toThrow(
        /missing its channel or tenant/,
      );
    });

    it('surfaces a still-failing replay to the DLQ', async () => {
      db.conversations.findFirst.mockRejectedValueOnce(new Error('db down'));
      await inbound([makeNormalized()]);
      const [delivery] = dlq.capture.mock.calls[0] as [{ payload: Record<string, unknown> }];

      db.conversations.findFirst.mockRejectedValue(new Error('still down'));

      await expect(replayers.get(ChannelType.WHATSAPP)!(delivery.payload)).rejects.toThrow(
        'still down',
      );
    });
  });

  // ── Serialization ───────────────────────────────────────

  describe('two webhooks from the same sender at once', () => {
    it('opens one conversation, not two', async () => {
      // The find-or-create is a read then a write. Run concurrently, both reads
      // miss and both write — the buyer ends up with two OPEN conversations and
      // a history split across them. The batch loop is already sequential for
      // this reason; separate POSTs need the same guarantee.
      let created = false;
      db.conversations.findFirst.mockImplementation(async () => {
        // A query reads the state as of when it is issued, and answers later.
        // Snapshotting *before* the latency is what makes the read-check-write
        // window real; reading after it would model a DB that has already
        // serialized the two callers, and the race could never reproduce.
        const seen = created;
        await new Promise((r) => setImmediate(r));
        return seen ? { id: 'conv-1' } : null;
      });
      db.conversations.create.mockImplementation(async () => {
        created = true;
        return { id: 'conv-1' };
      });

      const adapter = makeAdapter([makeNormalized()]);
      service.registerAdapter(adapter as never);

      await Promise.all([
        service.handleInboundWebhookBatch(ChannelType.WHATSAPP, REQ, BUSINESS_ID),
        service.handleInboundWebhookBatch(
          ChannelType.WHATSAPP,
          REQ,
          BUSINESS_ID,
          'trace-2',
        ),
      ]);

      expect(db.conversations.create).toHaveBeenCalledTimes(1);
    });

    it('does not serialize two different senders against each other', async () => {
      // A shared lock would turn every concurrent inbound message across the
      // whole platform into a queue behind the slowest one.
      const inFlight = { count: 0, max: 0 };
      db.channel_accounts.findFirst.mockImplementation(async () => {
        inFlight.count += 1;
        inFlight.max = Math.max(inFlight.max, inFlight.count);
        await new Promise((r) => setImmediate(r));
        inFlight.count -= 1;
        return { id: 'acct-row', business_id: RESOLVED_BUSINESS_ID };
      });

      service.registerAdapter(makeAdapter([makeNormalized()]) as never);
      const one = service.handleInboundWebhookBatch(ChannelType.WHATSAPP, REQ, BUSINESS_ID);

      service.registerAdapter(
        makeAdapter([
          makeNormalized({
            externalId: 'wamid.OTHER',
            sender: { externalId: '919999900002', displayName: 'Other' },
          }),
        ]) as never,
      );
      const two = service.handleInboundWebhookBatch(ChannelType.WHATSAPP, REQ, BUSINESS_ID);

      await Promise.all([one, two]);
      expect(inFlight.max).toBeGreaterThan(1);
    });
  });
});
