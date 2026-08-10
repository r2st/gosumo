/**
 * ChannelAdapterService — inbound persistence, dedupe, and outbound event branches.
 *
 * `channel-adapter.spec.ts` mocks `channel_accounts.findFirst` to null, which
 * is deliberate there: it pins the degraded path where no account resolves and
 * the service still emits a partial `message.received`. The consequence is that
 * everything *after* a successful lookup — find-or-create the client, the
 * contact, the conversation, then store the message — has never run under test.
 *
 * That block is where an inbound message actually becomes rows, and it is
 * almost entirely conditionals:
 *
 *   - first-contact vs returning-contact,
 *   - phone normalization that applies to WhatsApp/SMS and to nothing else,
 *   - a backfill that must fill a blank phone and must not touch a corrected one,
 *   - open-conversation reuse vs opening a new one,
 *   - text extraction for the denormalized preview column.
 *
 * Every one of those has a wrong branch that loses or corrupts a customer's
 * identity silently — a second client row for a buyer we already know, or a
 * phone overwritten with a worse value.
 *
 * Also covered: the `webhook_events` dedupe (a P2002 means the provider
 * redelivered; anything else must fail *open*, because dropping a real message
 * is worse than processing it twice), and the `?? fallback` arms in the
 * outbound `message.sent` / `message.failed` payloads.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import {
  ChannelType,
  MessageContentType,
  NormalizedMessage,
  RawRequest,
  SendResult,
} from '@gosumo/shared';

import { ChannelAdapterService } from './channel-adapter.service';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const RESOLVED_BUSINESS_ID = '00000000-0000-4000-a000-000000000002';
const ACCOUNT_ID = '00000000-0000-4000-b000-000000000001';
const CLIENT_ID = '00000000-0000-4000-c000-000000000001';
const CONTACT_ID = '00000000-0000-4000-d000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-e000-000000000001';

/** A raw sender id as WhatsApp sends it — a wa_id, not E.164. */
const WA_ID = '919876543210';
const E164 = '+919876543210';

function makeNormalized(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'msg_1',
    externalId: 'wamid.EXTERNAL_1',
    channel: ChannelType.WHATSAPP,
    channelAccountId: 'PHONE_NUMBER_ID_1',
    direction: 'INBOUND',
    sender: { externalId: WA_ID, displayName: 'Priya Sharma' },
    content: { type: MessageContentType.TEXT, text: 'Hello there' },
    timestamp: new Date('2026-08-01T10:00:00Z'),
    raw: {},
    ...overrides,
  } as NormalizedMessage;
}

interface PrismaDoubles {
  prisma: PrismaService;
  channel_accounts: { findFirst: jest.Mock };
  channel_contacts: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  clients: { create: jest.Mock; update: jest.Mock };
  conversations: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  messages: { create: jest.Mock };
  webhook_events: { create: jest.Mock };
}

/** Prisma double whose `channel_accounts` lookup *succeeds* by default. */
function makePrisma(): PrismaDoubles {
  const channel_accounts = {
    findFirst: jest.fn().mockResolvedValue({
      id: ACCOUNT_ID,
      business_id: RESOLVED_BUSINESS_ID,
      channel: ChannelType.WHATSAPP,
      external_id: 'PHONE_NUMBER_ID_1',
      is_active: true,
    }),
  };
  const channel_contacts = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({
      id: CONTACT_ID,
      client_id: CLIENT_ID,
      client: { id: CLIENT_ID, phone: E164 },
    }),
    update: jest.fn().mockResolvedValue({}),
  };
  const clients = {
    create: jest.fn().mockResolvedValue({ id: CLIENT_ID }),
    update: jest.fn().mockResolvedValue({}),
  };
  const conversations = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: CONVERSATION_ID }),
    update: jest.fn().mockResolvedValue({}),
  };
  const messages = { create: jest.fn().mockResolvedValue({ id: 'm1' }) };
  const webhook_events = { create: jest.fn().mockResolvedValue({ id: 'evt_1' }) };

  return {
    prisma: {
      channel_accounts,
      channel_contacts,
      clients,
      conversations,
      messages,
      webhook_events,
    } as unknown as PrismaService,
    channel_accounts,
    channel_contacts,
    clients,
    conversations,
    messages,
    webhook_events,
  };
}

/** Adapter double whose signature always passes and whose parse always works. */
function makeAdapter(normalized: NormalizedMessage) {
  return {
    channelType: normalized.channel,
    validateWebhook: jest.fn().mockReturnValue(true),
    parseInbound: jest.fn().mockReturnValue(normalized),
    sendMessage: jest.fn(),
    sendTemplate: jest.fn(),
    sendInteractive: jest.fn(),
    getCapabilities: jest.fn().mockReturnValue({ channelType: normalized.channel }),
  };
}

const REQ: RawRequest = { headers: {}, body: { any: 'payload' }, rawBody: Buffer.from('{}') };

describe('ChannelAdapterService — inbound persistence', () => {
  let service: ChannelAdapterService;
  let db: PrismaDoubles;
  let emitter: { emit: jest.Mock };

  async function build(): Promise<void> {
    db = makePrisma();
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelAdapterService,
        { provide: PrismaService, useValue: db.prisma },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(ChannelAdapterService);
  }

  beforeEach(build);

  /** Register a stub adapter for `channel` returning `normalized`, then drive it. */
  async function inbound(
    normalized: NormalizedMessage,
    channel: ChannelType = ChannelType.WHATSAPP,
  ): Promise<NormalizedMessage> {
    service.registerAdapter(makeAdapter(normalized) as never);
    return service.handleInboundWebhook(channel, REQ, BUSINESS_ID);
  }

  // ── First contact ───────────────────────────────────────

  describe('a sender we have never seen', () => {
    it('creates the client and the channel contact', async () => {
      await inbound(makeNormalized());

      expect(db.clients.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: RESOLVED_BUSINESS_ID,
          name: 'Priya Sharma',
          phone: E164,
        }),
      });
      expect(db.channel_contacts.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            business_id: RESOLVED_BUSINESS_ID,
            client_id: CLIENT_ID,
            channel_account_id: ACCOUNT_ID,
            external_id: WA_ID,
          }),
        }),
      );
    });

    it('normalizes a WhatsApp wa_id into the E.164 the clients table expects', async () => {
      // WhatsApp sends `919876543210` — no plus. Stored raw, it matches nothing
      // that looks up by E.164: notification recipients, consent, lead merge.
      await inbound(makeNormalized());

      const data = db.clients.create.mock.calls[0]?.[0].data as Record<string, unknown>;
      expect(data['phone']).toBe(E164);
    });

    it('keeps the raw sender id as the phone when it will not normalize', async () => {
      // Better a non-canonical phone than none: the contact stays reachable and
      // an operator can correct it.
      await inbound(makeNormalized({ sender: { externalId: '12345', displayName: 'X' } }));

      const data = db.clients.create.mock.calls[0]?.[0].data as Record<string, unknown>;
      expect(data['phone']).toBe('12345');
    });

    it('does not invent a phone for a non-phone channel', async () => {
      await inbound(
        makeNormalized({
          channel: ChannelType.EMAIL,
          sender: { externalId: 'buyer@example.com', displayName: 'Buyer' },
        }),
        ChannelType.EMAIL,
      );

      const data = db.clients.create.mock.calls[0]?.[0].data as Record<string, unknown>;
      expect(data['phone']).toBeUndefined();
      // Email senders populate the email column instead.
      expect(data['email']).toBe('buyer@example.com');
    });

    it('leaves email unset for a phone channel', async () => {
      await inbound(makeNormalized());

      const data = db.clients.create.mock.calls[0]?.[0].data as Record<string, unknown>;
      expect(data['email']).toBeUndefined();
    });

    it('falls back to the sender id when the provider sends no display name', async () => {
      await inbound(makeNormalized({ sender: { externalId: WA_ID, displayName: '' } }));

      const data = db.clients.create.mock.calls[0]?.[0].data as Record<string, unknown>;
      expect(data['name']).toBe(WA_ID);
    });
  });

  // ── Returning contact ───────────────────────────────────

  describe('a sender we already know', () => {
    beforeEach(() => {
      db.channel_contacts.findFirst.mockResolvedValue({
        id: CONTACT_ID,
        client_id: CLIENT_ID,
        client: { id: CLIENT_ID, phone: E164 },
      });
    });

    it('touches last_seen_at instead of creating a duplicate client', async () => {
      await inbound(makeNormalized());

      expect(db.clients.create).not.toHaveBeenCalled();
      expect(db.channel_contacts.create).not.toHaveBeenCalled();
      expect(db.channel_contacts.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CONTACT_ID, business_id: RESOLVED_BUSINESS_ID },
        }),
      );
    });

    it('backfills a phone that was never stored', async () => {
      // Contacts created before phone normalization existed have no phone at
      // all, which leaves them unreachable for WhatsApp/SMS notifications.
      db.channel_contacts.findFirst.mockResolvedValue({
        id: CONTACT_ID,
        client_id: CLIENT_ID,
        client: { id: CLIENT_ID, phone: null },
      });

      await inbound(makeNormalized());

      expect(db.clients.update).toHaveBeenCalledWith({
        where: { id: CLIENT_ID, business_id: RESOLVED_BUSINESS_ID },
        data: { phone: E164 },
      });
    });

    it('never overwrites a phone that is already set', async () => {
      // An operator may have corrected it; the wa_id is not more authoritative.
      await inbound(makeNormalized());
      expect(db.clients.update).not.toHaveBeenCalled();
    });

    it('does not backfill on a channel with no phone to offer', async () => {
      db.channel_contacts.findFirst.mockResolvedValue({
        id: CONTACT_ID,
        client_id: CLIENT_ID,
        client: { id: CLIENT_ID, phone: null },
      });

      await inbound(
        makeNormalized({
          channel: ChannelType.EMAIL,
          sender: { externalId: 'buyer@example.com', displayName: 'Buyer' },
        }),
        ChannelType.EMAIL,
      );

      expect(db.clients.update).not.toHaveBeenCalled();
    });

    it('survives a contact row that carries no joined client', async () => {
      db.channel_contacts.findFirst.mockResolvedValue({
        id: CONTACT_ID,
        client_id: CLIENT_ID,
        client: null,
      });

      await inbound(makeNormalized());

      // `client?.phone` is undefined, so the blank-phone backfill applies.
      expect(db.clients.update).toHaveBeenCalled();
    });
  });

  // ── Conversation threading ──────────────────────────────

  describe('conversation threading', () => {
    it('opens a conversation when none is live', async () => {
      await inbound(makeNormalized());

      expect(db.conversations.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: RESOLVED_BUSINESS_ID,
          client_id: CLIENT_ID,
          channel_account_id: ACCOUNT_ID,
          status: 'OPEN',
        }),
      });
    });

    it('excludes resolved threads when looking for a live one', async () => {
      await inbound(makeNormalized());

      const where = db.conversations.findFirst.mock.calls[0]?.[0].where as Record<
        string,
        unknown
      >;
      expect(where['status']).toEqual({ notIn: ['RESOLVED'] });
      expect(where['business_id']).toBe(RESOLVED_BUSINESS_ID);
    });

    it('reuses a live conversation and bumps last_message_at', async () => {
      db.conversations.findFirst.mockResolvedValue({ id: CONVERSATION_ID });

      await inbound(makeNormalized());

      expect(db.conversations.create).not.toHaveBeenCalled();
      expect(db.conversations.update).toHaveBeenCalledWith({
        where: { id: CONVERSATION_ID, business_id: RESOLVED_BUSINESS_ID },
        data: { last_message_at: expect.any(Date) },
      });
    });
  });

  // ── Message row ─────────────────────────────────────────

  describe('the stored message', () => {
    it('denormalizes the text for conversation previews', async () => {
      await inbound(makeNormalized());

      expect(db.messages.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: RESOLVED_BUSINESS_ID,
          conversation_id: CONVERSATION_ID,
          type: MessageContentType.TEXT,
          text_content: 'Hello there',
          external_id: 'wamid.EXTERNAL_1',
        }),
      });
    });

    it('leaves text_content unset for content that has no text', async () => {
      await inbound(
        makeNormalized({
          content: { type: MessageContentType.IMAGE, mediaUrl: 'https://x.test/i.jpg' } as never,
        }),
      );

      const data = db.messages.create.mock.calls[0]?.[0].data as Record<string, unknown>;
      expect(data['text_content']).toBeUndefined();
      expect(data['type']).toBe(MessageContentType.IMAGE);
    });

    it('ignores a non-string text field rather than storing it', async () => {
      await inbound(
        makeNormalized({
          content: { type: MessageContentType.TEXT, text: { nested: true } } as never,
        }),
      );

      const data = db.messages.create.mock.calls[0]?.[0].data as Record<string, unknown>;
      expect(data['text_content']).toBeUndefined();
    });

    it('defaults an absent content type to TEXT', async () => {
      await inbound(makeNormalized({ content: { text: 'no type' } as never }));

      const data = db.messages.create.mock.calls[0]?.[0].data as Record<string, unknown>;
      expect(data['type']).toBe('TEXT');
    });
  });

  // ── The emitted event ───────────────────────────────────

  describe('message.received', () => {
    it('carries the resolved tenant, client and conversation', async () => {
      await inbound(makeNormalized());

      expect(emitter.emit).toHaveBeenCalledWith(
        'message.received',
        expect.objectContaining({
          businessId: RESOLVED_BUSINESS_ID,
          clientId: CLIENT_ID,
          conversationId: CONVERSATION_ID,
          channelAccountId: ACCOUNT_ID,
          senderExternalId: WA_ID,
        }),
      );
    });

    it('still emits — with the caller\'s tenant — when persistence throws', async () => {
      // Losing the message entirely is worse than losing its enrichment: the AI
      // pipeline downstream can still answer the customer.
      db.conversations.findFirst.mockRejectedValue(new Error('db down'));

      await expect(inbound(makeNormalized())).resolves.toBeDefined();

      expect(emitter.emit).toHaveBeenCalledWith(
        'message.received',
        expect.objectContaining({ businessId: RESOLVED_BUSINESS_ID, conversationId: '' }),
      );
    });

    it('handles a non-Error rejection without masking it', async () => {
      db.conversations.findFirst.mockRejectedValue('a string, not an Error');

      await expect(inbound(makeNormalized())).resolves.toBeDefined();
      expect(emitter.emit).toHaveBeenCalledWith('message.received', expect.anything());
    });
  });

  // ── Idempotency ─────────────────────────────────────────

  describe('duplicate webhook deliveries', () => {
    it('processes a first delivery and records it', async () => {
      await inbound(makeNormalized());

      expect(db.webhook_events.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            source: ChannelType.WHATSAPP,
            external_id: 'wamid.EXTERNAL_1',
            signature_valid: true,
            processed: true,
          }),
        }),
      );
      expect(db.messages.create).toHaveBeenCalled();
    });

    it('skips reprocessing when the unique constraint rejects the insert', async () => {
      // P2002 on (source, external_id) is how a redelivery announces itself.
      db.webhook_events.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '5.0.0',
        }),
      );

      const result = await inbound(makeNormalized());

      expect(result.externalId).toBe('wamid.EXTERNAL_1');
      // Returned early: nothing was written and no event was emitted.
      expect(db.messages.create).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('fails OPEN on an unrelated database error', async () => {
      // A dedupe table that is down must not become a message-dropping filter.
      db.webhook_events.create.mockRejectedValue(new Error('connection reset'));

      await inbound(makeNormalized());

      expect(db.messages.create).toHaveBeenCalled();
      expect(emitter.emit).toHaveBeenCalledWith('message.received', expect.anything());
    });

    it('fails open on a Prisma error that is not a uniqueness violation', async () => {
      db.webhook_events.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('other', {
          code: 'P2003',
          clientVersion: '5.0.0',
        }),
      );

      await inbound(makeNormalized());
      expect(db.messages.create).toHaveBeenCalled();
    });

    it('skips the dedupe entirely when the adapter has no stable external id', async () => {
      // WebChat mints a fresh id per call, so a lookup would never hit and the
      // insert is pure cost.
      await inbound(makeNormalized({ externalId: '' }));

      expect(db.webhook_events.create).not.toHaveBeenCalled();
      expect(emitter.emit).toHaveBeenCalledWith('message.received', expect.anything());
    });
  });
});

// ─────────────────────────────────────────────
// Outbound event payloads
// ─────────────────────────────────────────────

/**
 * `sendTemplate` and `sendInteractive` build their events from a run of
 * `?? fallback` expressions. The fallbacks matter: a `message.sent` with an
 * empty `messageId` is unjoinable against anything, and a `message.failed` with
 * `reason: undefined` tells an operator nothing.
 */
describe('ChannelAdapterService — outbound send events', () => {
  let service: ChannelAdapterService;
  let emitter: { emit: jest.Mock };
  let adapter: ReturnType<typeof makeAdapter>;

  beforeEach(async () => {
    emitter = { emit: jest.fn() };
    adapter = makeAdapter(makeNormalized());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelAdapterService,
        { provide: PrismaService, useValue: makePrisma().prisma },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(ChannelAdapterService);
    service.registerAdapter(adapter as never);
  });

  const TEMPLATE = {
    recipientExternalId: WA_ID,
    channelAccountId: ACCOUNT_ID,
    templateName: 'site_visit_reminder',
    languageCode: 'en',
    parameters: [],
  };

  const INTERACTIVE = {
    recipientExternalId: WA_ID,
    channelAccountId: ACCOUNT_ID,
    body: 'Pick a slot',
    buttons: [{ id: 'b1', title: 'Sat 11am' }],
  };

  const ok = (over: Partial<SendResult> = {}): SendResult =>
    ({ success: true, externalMessageId: 'wamid.OUT_1', attempts: 1, ...over }) as SendResult;
  const fail = (over: Partial<SendResult> = {}): SendResult =>
    ({ success: false, error: 'Meta 503', attempts: 3, ...over }) as SendResult;

  describe('sendTemplate', () => {
    it('emits message.sent with the provider id and a latency', async () => {
      adapter.sendTemplate.mockResolvedValue(ok());

      await service.sendTemplate(
        ChannelType.WHATSAPP,
        TEMPLATE as never,
        BUSINESS_ID,
        'corr-1',
      );

      expect(emitter.emit).toHaveBeenCalledWith(
        'message.sent',
        expect.objectContaining({
          type: 'message.sent',
          businessId: BUSINESS_ID,
          correlationId: 'corr-1',
          externalMessageId: 'wamid.OUT_1',
          recipientExternalId: WA_ID,
          latencyMs: expect.any(Number),
        }),
      );
    });

    it('substitutes a generated id when the caller supplied no correlation id', async () => {
      adapter.sendTemplate.mockResolvedValue(ok());

      await service.sendTemplate(ChannelType.WHATSAPP, TEMPLATE as never, BUSINESS_ID);

      const [, event] = emitter.emit.mock.calls[0] as [string, { messageId: string }];
      expect(event.messageId).toEqual(expect.any(String));
      expect(event.messageId).not.toBe('');
    });

    it('substitutes an empty string when the provider returned no message id', async () => {
      adapter.sendTemplate.mockResolvedValue(ok({ externalMessageId: undefined }));

      await service.sendTemplate(ChannelType.WHATSAPP, TEMPLATE as never, BUSINESS_ID);

      expect(emitter.emit).toHaveBeenCalledWith(
        'message.sent',
        expect.objectContaining({ externalMessageId: '' }),
      );
    });

    it('emits message.failed with the provider error and attempt count', async () => {
      adapter.sendTemplate.mockResolvedValue(fail());

      await service.sendTemplate(ChannelType.WHATSAPP, TEMPLATE as never, BUSINESS_ID);

      expect(emitter.emit).toHaveBeenCalledWith(
        'message.failed',
        expect.objectContaining({ reason: 'Meta 503', attempts: 3 }),
      );
    });

    it('names the failure even when the adapter reported none', async () => {
      adapter.sendTemplate.mockResolvedValue(fail({ error: undefined, attempts: undefined }));

      await service.sendTemplate(ChannelType.WHATSAPP, TEMPLATE as never, BUSINESS_ID);

      expect(emitter.emit).toHaveBeenCalledWith(
        'message.failed',
        expect.objectContaining({ reason: 'Unknown error', attempts: 1 }),
      );
    });
  });

  describe('sendInteractive', () => {
    it('returns the adapter result on success', async () => {
      adapter.sendInteractive.mockResolvedValue(ok());

      const result = await service.sendInteractive(
        ChannelType.WHATSAPP,
        INTERACTIVE as never,
        BUSINESS_ID,
        'corr-2',
      );

      expect(result.success).toBe(true);
      expect(adapter.sendInteractive).toHaveBeenCalledWith(INTERACTIVE);
    });

    it('returns the failure rather than throwing', async () => {
      // The caller decides whether a failed button prompt is fatal.
      adapter.sendInteractive.mockResolvedValue(fail());

      const result = await service.sendInteractive(
        ChannelType.WHATSAPP,
        INTERACTIVE as never,
        BUSINESS_ID,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Meta 503');
    });
  });
});
