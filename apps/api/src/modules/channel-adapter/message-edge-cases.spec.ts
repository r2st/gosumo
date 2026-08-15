/**
 * ChannelAdapterService — message edge cases at the channel boundary.
 *
 * Three things this module does that nothing else can do for it:
 *
 *  1. **It is the only place the provider's own send time is available.** Every
 *     adapter parses `NormalizedMessage.timestamp` and the persistence path
 *     dropped it, leaving `created_at` — delivery order — as the only time on
 *     the row. Delivery order and send order diverge precisely when a provider
 *     redelivers, which is the case the whole retry design assumes will happen.
 *
 *  2. **It is the only place the sender's channel address is available.** The
 *     AI pipeline resolves its reply recipient from `metadata.senderExternalId`,
 *     and nothing wrote it, so the generic assistant's `deliver()` bailed on a
 *     missing recipient for every message it ever handled.
 *
 *  3. **It is the last place an over-length body can be stopped.** Adapters have
 *     declared `maxMessageLength` since the interface was written; nothing read
 *     one, so an AI reply too long for Instagram or Twilio went to the provider
 *     and came back a 400.
 *
 * The metadata assertions are as much about what is *absent*: `normalized.raw`
 * / `normalized.metadata` carry provider-shaped keys whose meaning is
 * channel-local, and one client can hold conversations on several channels at
 * once. A field earns its way onto a message row by name, never by spread.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ChannelType,
  MessageContentType,
  NormalizedMessage,
  OutboundMessage,
  RawRequest,
} from '@gosumo/shared';

import {
  ChannelAdapterService,
  normalizedSentAt,
  SENT_AT_MAX_SKEW_MS,
} from './channel-adapter.service';
import { PrismaService } from '../../common/services/prisma.service';
import { ConversationLockService } from '../../common/services/conversation-lock.service';
import { withMessageSequence } from '../../common/testing/message-sequence.mock';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const RESOLVED_BUSINESS_ID = '00000000-0000-4000-a000-000000000002';
const ACCOUNT_ID = '00000000-0000-4000-b000-000000000001';
const CLIENT_ID = '00000000-0000-4000-c000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-e000-000000000001';

const WA_ID = '919876543210';
const SENT_AT = new Date('2026-08-01T10:00:00.000Z');

const REQ: RawRequest = { headers: {}, body: { any: 'payload' }, rawBody: Buffer.from('{}') };

function makeNormalized(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'msg_1',
    externalId: 'wamid.EXTERNAL_1',
    channel: ChannelType.WHATSAPP,
    channelAccountId: 'PHONE_NUMBER_ID_1',
    direction: 'INBOUND',
    sender: { externalId: WA_ID, displayName: 'Priya Sharma' },
    content: { type: MessageContentType.TEXT, text: 'Hello there' },
    timestamp: SENT_AT,
    metadata: { storyId: 'ig_story_9', signatureHeader: 'sha256=abc' },
    ...overrides,
  } as NormalizedMessage;
}

interface Doubles {
  prisma: PrismaService;
  messages: { create: jest.Mock };
}

function makePrisma(): Doubles {
  const messages = { create: jest.fn().mockResolvedValue({ id: 'm1' }) };
  const prismaDouble: Record<string, unknown> = {
    channel_accounts: {
      findFirst: jest.fn().mockResolvedValue({
        id: ACCOUNT_ID,
        business_id: RESOLVED_BUSINESS_ID,
        channel: ChannelType.WHATSAPP,
        external_id: 'PHONE_NUMBER_ID_1',
        is_active: true,
      }),
    },
    channel_contacts: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'contact_1',
        client_id: CLIENT_ID,
        client: { id: CLIENT_ID, phone: '+919876543210' },
      }),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    clients: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    conversations: {
      findFirst: jest.fn().mockResolvedValue({ id: CONVERSATION_ID, status: 'OPEN' }),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    messages,
    webhook_events: {
      create: jest.fn().mockResolvedValue({ id: 'evt_1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  withMessageSequence(prismaDouble);
  const prisma = prismaDouble as unknown as PrismaService;

  return { prisma, messages };
}

/** Adapter double: signature passes, parse works, capabilities are declarable. */
function makeAdapter(normalized: NormalizedMessage, maxMessageLength = 4096) {
  return {
    channelType: normalized.channel,
    validateWebhook: jest.fn().mockReturnValue(true),
    parseInbound: jest.fn().mockReturnValue(normalized),
    sendMessage: jest.fn().mockResolvedValue({ success: true, externalMessageId: 'x1' }),
    sendTemplate: jest.fn(),
    sendInteractive: jest.fn(),
    getCapabilities: jest
      .fn()
      .mockReturnValue({ channelType: normalized.channel, maxMessageLength }),
  };
}

describe('ChannelAdapterService — message edge cases', () => {
  let service: ChannelAdapterService;
  let db: Doubles;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    db = makePrisma();
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelAdapterService,
        { provide: PrismaService, useValue: db.prisma },
        { provide: EventEmitter2, useValue: emitter },
        ConversationLockService,
      ],
    }).compile();

    service = module.get(ChannelAdapterService);
  });

  async function inbound(normalized: NormalizedMessage): Promise<void> {
    service.registerAdapter(makeAdapter(normalized) as never);
    await service.handleInboundWebhook(normalized.channel, REQ, BUSINESS_ID);
  }

  /** The `data` object the message row was created with. */
  function storedMessage(): Record<string, unknown> {
    expect(db.messages.create).toHaveBeenCalled();
    return (db.messages.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
  }

  // ── Provider send time ──────────────────────────────────

  describe('the provider send time', () => {
    it('is stored on the message row', async () => {
      await inbound(makeNormalized());
      expect(storedMessage()['sent_at']).toEqual(SENT_AT);
    });

    it('survives a redelivery arriving long after the fact', async () => {
      // The whole point of the column: this row is written now, but it belongs
      // four minutes ago in the thread. Ordering on `created_at` would file it
      // after replies that were sent while it was in flight.
      const late = makeNormalized({
        externalId: 'wamid.LATE',
        timestamp: new Date('2026-08-01T09:56:00.000Z'),
      });
      await inbound(late);
      expect(storedMessage()['sent_at']).toEqual(new Date('2026-08-01T09:56:00.000Z'));
    });

    it('degrades to null rather than failing the insert on an unparseable time', async () => {
      // An adapter handed a junk provider field produces `new Date(NaN)`, which
      // Prisma rejects — and rejecting the write loses the customer's message
      // over a field nothing reads synchronously.
      await inbound(makeNormalized({ timestamp: new Date('not a date') }));
      expect(storedMessage()['sent_at']).toBeNull();
      expect(db.messages.create).toHaveBeenCalled();
    });
  });

  describe('normalizedSentAt', () => {
    const now = new Date('2026-08-01T12:00:00.000Z');

    it('accepts a Date and a parseable string alike', () => {
      expect(normalizedSentAt(SENT_AT, now)).toEqual(SENT_AT);
      expect(normalizedSentAt('2026-08-01T10:00:00.000Z', now)).toEqual(SENT_AT);
    });

    it('rejects a time further ahead of us than clock skew explains', () => {
      // Believed, it would pin the message to the top of the thread forever.
      const wayAhead = new Date(now.getTime() + SENT_AT_MAX_SKEW_MS + 1000);
      expect(normalizedSentAt(wayAhead, now)).toBeNull();
    });

    it('allows modest skew, which is ordinary between two clocks', () => {
      const slightlyAhead = new Date(now.getTime() + 60_000);
      expect(normalizedSentAt(slightlyAhead, now)).toEqual(slightlyAhead);
    });

    it('keeps an old timestamp — a late redelivery is the case it describes', () => {
      const old = new Date('2020-01-01T00:00:00.000Z');
      expect(normalizedSentAt(old, now)).toEqual(old);
    });

    it('rejects null and undefined without throwing', () => {
      expect(normalizedSentAt(null, now)).toBeNull();
      expect(normalizedSentAt(undefined, now)).toBeNull();
    });
  });

  // ── Sender address, and only the sender address ─────────

  describe('the stored message metadata', () => {
    it('carries the sender address the AI replies to', async () => {
      await inbound(makeNormalized());
      expect(storedMessage()['metadata']).toEqual({ senderExternalId: WA_ID });
    });

    it('does not carry the raw channel-specific extras', async () => {
      // `storyId` is an Instagram concept and `signatureHeader` is a transport
      // detail. Neither means anything on the client's other channels, and both
      // would be read back by anything walking `messages.metadata` generically.
      await inbound(makeNormalized());
      const metadata = storedMessage()['metadata'] as Record<string, unknown>;
      expect(metadata['storyId']).toBeUndefined();
      expect(metadata['signatureHeader']).toBeUndefined();
      expect(Object.keys(metadata)).toEqual(['senderExternalId']);
    });

    it('keeps each channel to its own address for the same client', async () => {
      await inbound(makeNormalized());
      const fromWhatsApp = storedMessage()['metadata'];

      db.messages.create.mockClear();
      await inbound(
        makeNormalized({
          externalId: 'email.EXTERNAL_1',
          channel: ChannelType.EMAIL,
          sender: { externalId: 'priya@example.com', displayName: 'Priya Sharma' },
        }),
      );

      expect(fromWhatsApp).toEqual({ senderExternalId: WA_ID });
      expect(storedMessage()['metadata']).toEqual({ senderExternalId: 'priya@example.com' });
    });
  });

  // ── Outbound length ceiling ─────────────────────────────

  describe('an outbound body over the channel ceiling', () => {
    function outbound(text: string): OutboundMessage {
      return {
        channelAccountId: ACCOUNT_ID,
        recipientExternalId: WA_ID,
        content: { type: MessageContentType.TEXT, text },
      };
    }

    /** Register an adapter for `channel` declaring `limit`, and return it. */
    function withLimit(channel: ChannelType, limit: number) {
      const adapter = makeAdapter(makeNormalized({ channel }), limit);
      service.registerAdapter(adapter as never);
      return adapter;
    }

    it('is refused before the provider is called', async () => {
      // Instagram caps direct messages at 1000. A 1500-character AI reply used
      // to be handed straight to Meta, which answered with a 400 whose text
      // differs per channel — predictable, and expensive to diagnose.
      const adapter = withLimit(ChannelType.INSTAGRAM, 1000);

      const result = await service.sendMessage(
        ChannelType.INSTAGRAM,
        outbound('x'.repeat(1500)),
        BUSINESS_ID,
      );

      expect(adapter.sendMessage).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toContain('1500');
      expect(result.error).toContain('1000');
    });

    it('emits message.failed naming the real reason', async () => {
      withLimit(ChannelType.SMS, 1600);

      await service.sendMessage(ChannelType.SMS, outbound('y'.repeat(2000)), BUSINESS_ID);

      const failed = emitter.emit.mock.calls.find((c) => c[0] === 'message.failed');
      expect(failed).toBeDefined();
      expect(failed![1]).toEqual(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          channel: ChannelType.SMS,
          recipientExternalId: WA_ID,
          reason: expect.stringContaining('over the SMS limit of 1600'),
        }),
      );
    });

    it('is not truncated — half an answer sent confidently is worse', async () => {
      const adapter = withLimit(ChannelType.INSTAGRAM, 1000);
      await service.sendMessage(
        ChannelType.INSTAGRAM,
        outbound('z'.repeat(1500)),
        BUSINESS_ID,
      );
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it('lets a body exactly on the limit through', async () => {
      const adapter = withLimit(ChannelType.INSTAGRAM, 1000);
      const result = await service.sendMessage(
        ChannelType.INSTAGRAM,
        outbound('a'.repeat(1000)),
        BUSINESS_ID,
      );
      expect(adapter.sendMessage).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('measures an image caption, which is what the limit applies to there', async () => {
      const adapter = withLimit(ChannelType.WHATSAPP, 1024);
      const result = await service.sendMessage(
        ChannelType.WHATSAPP,
        {
          channelAccountId: ACCOUNT_ID,
          recipientExternalId: WA_ID,
          content: {
            type: MessageContentType.IMAGE,
            mediaUrl: 'https://cdn.example.com/a.jpg',
            caption: 'c'.repeat(2000),
          },
        } as unknown as OutboundMessage,
        BUSINESS_ID,
      );
      expect(adapter.sendMessage).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });

    it('leaves content with no text at all alone', async () => {
      const adapter = withLimit(ChannelType.WHATSAPP, 10);
      const result = await service.sendMessage(
        ChannelType.WHATSAPP,
        {
          channelAccountId: ACCOUNT_ID,
          recipientExternalId: WA_ID,
          content: { type: MessageContentType.LOCATION, latitude: 19.07, longitude: 72.87 },
        } as unknown as OutboundMessage,
        BUSINESS_ID,
      );
      expect(adapter.sendMessage).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('sends unhindered when the adapter declares no usable limit', async () => {
      const adapter = makeAdapter(makeNormalized({ channel: ChannelType.WEB_CHAT }), 0);
      service.registerAdapter(adapter as never);

      const result = await service.sendMessage(
        ChannelType.WEB_CHAT,
        outbound('q'.repeat(50_000)),
        BUSINESS_ID,
      );
      expect(adapter.sendMessage).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('counts an emoji by the units the provider counts', async () => {
      // A limit expressed in characters is a limit on UTF-16 code units, which
      // is what `String.length` reports and what the providers bill. 600 family
      // emoji are well past Instagram's 1000 despite "reading" as 600 glyphs.
      const adapter = withLimit(ChannelType.INSTAGRAM, 1000);
      const result = await service.sendMessage(
        ChannelType.INSTAGRAM,
        outbound('👨‍👩‍👧‍👦'.repeat(600)),
        BUSINESS_ID,
      );
      expect(adapter.sendMessage).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });
  });
});
