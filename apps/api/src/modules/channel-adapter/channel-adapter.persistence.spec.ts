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
import { WebhookDlqService } from '../webhook-log/webhook-dlq.service';
import { ConversationLockService } from '../../common/services/conversation-lock.service';

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
  clients: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  conversations: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  messages: { create: jest.Mock };
  webhook_events: { create: jest.Mock; update: jest.Mock };
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
    // No client holds this sender's phone/email yet — the first-contact case.
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: CLIENT_ID }),
    update: jest.fn().mockResolvedValue({}),
  };
  const conversations = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: CONVERSATION_ID }),
    update: jest.fn().mockResolvedValue({}),
  };
  const messages = { create: jest.fn().mockResolvedValue({ id: 'm1' }) };
  const webhook_events = {
    create: jest.fn().mockResolvedValue({ id: 'evt_1' }),
    update: jest.fn().mockResolvedValue({}),
  };

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
  let dlq: { capture: jest.Mock; registerReplayer: jest.Mock };

  async function build(): Promise<void> {
    db = makePrisma();
    emitter = { emit: jest.fn() };
    dlq = { capture: jest.fn().mockResolvedValue({ id: 'dl_1' }), registerReplayer: jest.fn() };

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
    // Replayers are registered on init; drive it so the registration is covered.
    service.onModuleInit();
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

      expect(db.clients.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            business_id: RESOLVED_BUSINESS_ID,
            name: 'Priya Sharma',
            phone: E164,
          }),
        }),
      );
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
      expect(data['phone']).toBeNull();
      // Email senders populate the email column instead.
      expect(data['email']).toBe('buyer@example.com');
    });

    it('leaves email unset for a phone channel', async () => {
      await inbound(makeNormalized());

      const data = db.clients.create.mock.calls[0]?.[0].data as Record<string, unknown>;
      expect(data['email']).toBeNull();
    });

    it('falls back to the sender id when the provider sends no display name', async () => {
      await inbound(makeNormalized({ sender: { externalId: WA_ID, displayName: '' } }));

      const data = db.clients.create.mock.calls[0]?.[0].data as Record<string, unknown>;
      expect(data['name']).toBe(WA_ID);
    });
  });

  // ── The same person, arriving on a second channel ───────

  describe('a sender we already know from another channel', () => {
    /** A client that already exists in this business holding `E164`. */
    const KNOWN_CLIENT_ID = '00000000-0000-4000-c000-000000000009';

    beforeEach(() => {
      // No contact on *this* channel account — the buyer is arriving here for
      // the first time — but their phone is already on a client row.
      db.channel_contacts.findFirst.mockResolvedValue(null);
      db.clients.findFirst.mockResolvedValue({ id: KNOWN_CLIENT_ID, deleted_at: null });
      db.channel_contacts.create.mockResolvedValue({
        id: CONTACT_ID,
        client_id: KNOWN_CLIENT_ID,
        client: { id: KNOWN_CLIENT_ID, phone: E164 },
      });
    });

    it('attaches to the client that already holds the number', async () => {
      await inbound(makeNormalized());

      expect(db.clients.create).not.toHaveBeenCalled();
      expect(db.channel_contacts.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ client_id: KNOWN_CLIENT_ID, external_id: WA_ID }),
        }),
      );
    });

    it('stores the message instead of losing it to the unique constraint', async () => {
      // The regression this exists for: `clients.create` raised P2002 on
      // uq_clients_business_phone, `handleInboundWebhook`'s catch swallowed it,
      // and nothing downstream ran. The delivery was already in
      // `webhook_events` by then, so the provider's retry was deduped away and
      // the customer's message was gone for good.
      await inbound(makeNormalized());

      expect(db.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ conversation_id: CONVERSATION_ID }),
        }),
      );
    });

    it('announces the resolved client, not an empty one', async () => {
      await inbound(makeNormalized());

      const event = emitter.emit.mock.calls[0]?.[1] as { clientId: string; conversationId: string };
      expect(event.clientId).toBe(KNOWN_CLIENT_ID);
      expect(event.conversationId).toBe(CONVERSATION_ID);
    });

    it('opens a conversation per channel account, not one shared across them', async () => {
      // Matching the contact does not merge the threads: the WhatsApp thread
      // and the SMS thread stay separate inboxes for the same person, which is
      // what the conversation lookup's channel_account_id scope encodes.
      await inbound(makeNormalized());

      expect(db.conversations.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            client_id: KNOWN_CLIENT_ID,
            channel_account_id: ACCOUNT_ID,
          }),
        }),
      );
      expect(db.conversations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            client_id: KNOWN_CLIENT_ID,
            channel_account_id: ACCOUNT_ID,
          }),
        }),
      );
    });

    it('matches an email sender on the address the client already carries', async () => {
      await inbound(
        makeNormalized({
          channel: ChannelType.EMAIL,
          sender: { externalId: 'buyer@example.invalid', displayName: 'Buyer' },
        }),
        ChannelType.EMAIL,
      );

      expect(db.clients.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([{ email: 'buyer@example.invalid' }]),
          }),
        }),
      );
      expect(db.clients.create).not.toHaveBeenCalled();
    });

    it('does not fold an Instagram handle into whoever happens to match', async () => {
      // An IGSID is neither a phone nor an email. There is no identity to
      // resolve, so this is a new person until an operator merges them.
      await inbound(
        makeNormalized({
          channel: ChannelType.INSTAGRAM,
          sender: { externalId: '17841400000000000', displayName: 'insta_user' },
        }),
        ChannelType.INSTAGRAM,
      );

      expect(db.clients.findFirst).not.toHaveBeenCalled();
      expect(db.clients.create).toHaveBeenCalled();
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

    /**
     * The adapter has always normalized the sender's number — but only into
     * `clients.phone`, never onto the event. So every consumer keyed on a
     * person's phone read `senderExternalId`, which is the raw `wa_id`, and
     * matched `919876543210` against rows written `+919876543210`. Nothing
     * errored; the lookups just returned nothing. That is one buyer becoming two
     * leads, a cadence that keeps sending after they replied, and a consent
     * lookup that misses.
     */
    it('carries the sender phone in E.164 alongside the raw channel address', async () => {
      await inbound(makeNormalized());

      const [, event] = emitter.emit.mock.calls.find(
        ([name]) => name === 'message.received',
      ) as [string, { senderExternalId: string; senderPhone?: string }];

      // Both, and different: the raw id is the reply address, the E.164 is the
      // identity. Collapsing them either way breaks the other consumer.
      expect(event.senderExternalId).toBe(WA_ID);
      expect(event.senderPhone).toBe(E164);
    });

    it('omits the phone on a channel that has no phone identity', async () => {
      // A Web Chat session id or an Instagram handle is not a phone number in
      // any format. Publishing one as `senderPhone` would put a UUID into
      // `realty_leads.whatsapp_phone` — a VARCHAR(20) column declared E.164.
      await inbound(
        makeNormalized({
          channel: ChannelType.WEB_CHAT,
          sender: { externalId: 'a3f1c0de-1111-4222-8333-444455556666' },
        } as Partial<NormalizedMessage>),
        ChannelType.WEB_CHAT,
      );

      const [, event] = emitter.emit.mock.calls.find(
        ([name]) => name === 'message.received',
      ) as [string, { senderPhone?: string }];

      expect(event.senderPhone).toBeUndefined();
    });

    it('falls back to the raw id for a phone channel whose number will not normalize', async () => {
      // A non-Indian mobile does not normalize, and dropping the identity
      // entirely would stop capturing that buyer. Keeping the raw value matches
      // what `clients.phone` already stores for them.
      await inbound(
        makeNormalized({ sender: { externalId: '14155552671' } } as Partial<NormalizedMessage>),
      );

      const [, event] = emitter.emit.mock.calls.find(
        ([name]) => name === 'message.received',
      ) as [string, { senderPhone?: string }];

      expect(event.senderPhone).toBe('14155552671');
    });

    /**
     * The whole point of `messageId` is that `ai-engine` looks the row up with
     * it (`ContextLoaderService.load` → `messages.findFirst({ id: messageId })`)
     * to read the customer's text. `normalized.id` is a UUID the adapter mints
     * for its in-memory envelope, while `messages.id` is `uuid_generate_v4()`
     * on the database side — so publishing the former meant the lookup never
     * matched, `messageText` fell back to `''`, and every inbound message was
     * classified and answered as if the customer had sent nothing.
     */
    it('carries the stored row id, not the adapter envelope id', async () => {
      const normalized = makeNormalized();

      await inbound(normalized);

      const [, event] = emitter.emit.mock.calls.find(
        ([name]) => name === 'message.received',
      ) as [string, { messageId: string }];

      expect(event.messageId).toBe('m1');
      expect(event.messageId).not.toBe(normalized.id);
    });

    it('falls back to the envelope id when no message row was written', async () => {
      // No channel_account ⇒ nothing persisted. The event is emitted anyway so
      // the delivery is not lost, and `ai-engine` skips it on the empty
      // conversationId rather than on the id.
      db.channel_accounts.findFirst.mockResolvedValue(null);
      const normalized = makeNormalized();

      await inbound(normalized);

      const [, event] = emitter.emit.mock.calls.find(
        ([name]) => name === 'message.received',
      ) as [string, { messageId: string; conversationId: string }];

      expect(event.messageId).toBe(normalized.id);
      expect(event.conversationId).toBe('');
    });

    it('dead-letters instead of announcing a message it never stored', async () => {
      // Previously this emitted a partial event and moved on. That event names
      // a conversation that does not exist, so every listener drops it — the
      // message was gone, and `webhook_events` had already deduped away the
      // provider's redelivery. Park it for replay instead.
      db.conversations.findFirst.mockRejectedValue(new Error('db down'));

      await expect(inbound(makeNormalized())).resolves.toBeDefined();

      expect(emitter.emit).not.toHaveBeenCalledWith(
        'message.received',
        expect.anything(),
      );
      expect(dlq.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          source: ChannelType.WHATSAPP,
          eventType: 'message.received',
          externalId: 'wamid.EXTERNAL_1',
        }),
        expect.any(Error),
      );
    });

    it('captures the raw body, so a replay re-parses rather than trusting a stale envelope', async () => {
      db.conversations.findFirst.mockRejectedValue(new Error('db down'));

      await inbound(makeNormalized());

      const [delivery] = dlq.capture.mock.calls[0] as [
        { payload: { body: unknown; channelType: string; webhookEventId: string | null } },
      ];
      expect(delivery.payload.body).toEqual({ any: 'payload' });
      expect(delivery.payload.channelType).toBe(ChannelType.WHATSAPP);
      // The row written before processing, so a successful replay can close it.
      expect(delivery.payload.webhookEventId).toBe('evt_1');
    });

    it('handles a non-Error rejection without masking it', async () => {
      db.conversations.findFirst.mockRejectedValue('a string, not an Error');

      await expect(inbound(makeNormalized())).resolves.toBeDefined();
      expect(dlq.capture).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ message: 'a string, not an Error' }),
      );
    });

    it('does not throw at the webhook boundary when the DLQ itself fails', async () => {
      // A 500 here would be retried by the provider straight into the dedupe
      // wall — one lost message turned into a lost message plus a 500.
      db.conversations.findFirst.mockRejectedValue(new Error('db down'));
      dlq.capture.mockRejectedValue(new Error('dlq down'));

      await expect(inbound(makeNormalized())).resolves.toBeDefined();
    });
  });

  // ── Idempotency ─────────────────────────────────────────

  describe('duplicate webhook deliveries', () => {
    it('claims a first delivery as unprocessed, then stamps it once it is', async () => {
      // The row is a dedupe claim, not a receipt. Writing `processed: true`
      // up front made a delivery that later failed indistinguishable from one
      // that succeeded, in the one table an operator would check.
      await inbound(makeNormalized());

      expect(db.webhook_events.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            source: ChannelType.WHATSAPP,
            external_id: 'wamid.EXTERNAL_1',
            signature_valid: true,
            processed: false,
          }),
        }),
      );
      expect(db.messages.create).toHaveBeenCalled();
      expect(db.webhook_events.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'evt_1' },
          data: expect.objectContaining({ processed: true }),
        }),
      );
    });

    it('leaves the delivery unprocessed when it failed', async () => {
      db.conversations.findFirst.mockRejectedValue(new Error('db down'));

      await inbound(makeNormalized());

      expect(db.webhook_events.update).not.toHaveBeenCalled();
    });

    it('still delivers the message when the processed stamp fails', async () => {
      // The message is already stored and announced; a failed audit update
      // must not turn a delivered message into a dead-lettered one.
      db.webhook_events.update.mockRejectedValue(new Error('update failed'));

      await expect(inbound(makeNormalized())).resolves.toBeDefined();

      expect(emitter.emit).toHaveBeenCalledWith('message.received', expect.anything());
      expect(dlq.capture).not.toHaveBeenCalled();
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

  // ── Batched payloads ────────────────────────────────────

  /**
   * Meta packs several messages into one POST — a customer sending three
   * messages in a row, or a backlog being redelivered, arrives as one webhook
   * with three `messages` entries. `parseInbound` returns only the first, so
   * routing a batch through it stored one row, emitted one event, and dropped
   * the rest without an error anywhere.
   */
  describe('batched webhooks', () => {
    /** Adapter whose batch parser returns all of `normalized`. */
    function makeBatchAdapter(all: NormalizedMessage[]) {
      return {
        ...makeAdapter(all[0]!),
        parseInboundAll: jest.fn().mockReturnValue(all),
      };
    }

    it('stores and announces every message in the batch', async () => {
      const batch = [
        makeNormalized({ id: 'msg_1', externalId: 'wamid.A' }),
        makeNormalized({ id: 'msg_2', externalId: 'wamid.B' }),
        makeNormalized({ id: 'msg_3', externalId: 'wamid.C' }),
      ];
      service.registerAdapter(makeBatchAdapter(batch) as never);

      const handled = await service.handleInboundWebhookBatch(
        ChannelType.WHATSAPP,
        REQ,
        BUSINESS_ID,
      );

      expect(handled).toHaveLength(3);
      expect(db.messages.create).toHaveBeenCalledTimes(3);
      expect(
        emitter.emit.mock.calls.filter(([name]) => name === 'message.received'),
      ).toHaveLength(3);
    });

    it('dedupes per message, not per request', async () => {
      // The middle message is a redelivery; the other two are new. Keying the
      // dedupe on the request would drop all three or none.
      const batch = [
        makeNormalized({ externalId: 'wamid.A' }),
        makeNormalized({ externalId: 'wamid.B' }),
        makeNormalized({ externalId: 'wamid.C' }),
      ];
      db.webhook_events.create
        .mockResolvedValueOnce({ id: 'evt_1' })
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: '5.0.0',
          }),
        )
        .mockResolvedValueOnce({ id: 'evt_3' });
      service.registerAdapter(makeBatchAdapter(batch) as never);

      await service.handleInboundWebhookBatch(ChannelType.WHATSAPP, REQ, BUSINESS_ID);

      expect(db.messages.create).toHaveBeenCalledTimes(2);
    });

    it('falls back to the single-message parser for adapters without a batch one', async () => {
      // SMS and WebChat never batch; they must keep working untouched.
      service.registerAdapter(makeAdapter(makeNormalized()) as never);

      const handled = await service.handleInboundWebhookBatch(
        ChannelType.WHATSAPP,
        REQ,
        BUSINESS_ID,
      );

      expect(handled).toHaveLength(1);
      expect(db.messages.create).toHaveBeenCalledTimes(1);
    });

    it('reports the underlying reason when a batch parses to nothing', async () => {
      // `parseInboundAll` swallows per-message failures and returns [], which
      // says nothing about why. The single parser's error is the diagnosis.
      const adapter = {
        ...makeAdapter(makeNormalized()),
        parseInboundAll: jest.fn().mockReturnValue([]),
        parseInbound: jest.fn().mockImplementation(() => {
          throw new Error('type=text but no text field');
        }),
      };
      service.registerAdapter(adapter as never);

      await expect(
        service.handleInboundWebhookBatch(ChannelType.WHATSAPP, REQ, BUSINESS_ID),
      ).rejects.toThrow(/type=text but no text field/);
    });

    it('handleInboundWebhook still processes the whole batch, returning the first', async () => {
      const batch = [
        makeNormalized({ externalId: 'wamid.A' }),
        makeNormalized({ externalId: 'wamid.B' }),
      ];
      service.registerAdapter(makeBatchAdapter(batch) as never);

      const first = await service.handleInboundWebhook(ChannelType.WHATSAPP, REQ, BUSINESS_ID);

      expect(first.externalId).toBe('wamid.A');
      expect(db.messages.create).toHaveBeenCalledTimes(2);
    });

    // ── Channel-account lookup is memoized per webhook ──────

    /**
     * The N+1 these pin: every message in a batch resolves the same
     * `channel_accounts` row, and each was issuing its own query. One WhatsApp
     * webhook carries the messages for one business phone number, so a
     * 30-message burst spent 30 round trips answering the same question — on
     * the busiest write path in the system, against a pool this box shares with
     * another service.
     */
    it('resolves the channel account once for a whole batch', async () => {
      const batch = [
        makeNormalized({ externalId: 'wamid.A' }),
        makeNormalized({ externalId: 'wamid.B' }),
        makeNormalized({ externalId: 'wamid.C' }),
      ];
      service.registerAdapter(makeBatchAdapter(batch) as never);

      await service.handleInboundWebhookBatch(ChannelType.WHATSAPP, REQ, BUSINESS_ID);

      // Three messages stored, one account lookup.
      expect(db.messages.create).toHaveBeenCalledTimes(3);
      expect(db.channel_accounts.findFirst).toHaveBeenCalledTimes(1);
    });

    it('still resolves each distinct account in a mixed batch', async () => {
      // Meta may put more than one `entry` in a payload, and they need not name
      // the same phone number id. Hoisting a single lookup out of the loop
      // would attribute the second account's messages to the first — i.e. write
      // one tenant's messages under another. The memo is keyed, not hoisted.
      const batch = [
        makeNormalized({ externalId: 'wamid.A', channelAccountId: 'PHONE_NUMBER_ID_1' }),
        makeNormalized({ externalId: 'wamid.B', channelAccountId: 'PHONE_NUMBER_ID_2' }),
        makeNormalized({ externalId: 'wamid.C', channelAccountId: 'PHONE_NUMBER_ID_1' }),
      ];
      service.registerAdapter(makeBatchAdapter(batch) as never);

      await service.handleInboundWebhookBatch(ChannelType.WHATSAPP, REQ, BUSINESS_ID);

      expect(db.messages.create).toHaveBeenCalledTimes(3);
      // Two distinct accounts, not one and not three.
      expect(db.channel_accounts.findFirst).toHaveBeenCalledTimes(2);
      const asked = db.channel_accounts.findFirst.mock.calls.map(
        ([arg]) => (arg as { where: { external_id: string } }).where.external_id,
      );
      expect(new Set(asked)).toEqual(new Set(['PHONE_NUMBER_ID_1', 'PHONE_NUMBER_ID_2']));
    });

    it('memoizes the miss as well as the hit', async () => {
      // A junk or deactivated account id returns null. Re-asking that once per
      // message is the same N+1 wearing a different hat — and a payload of
      // unknown ids is exactly what an abusive caller sends.
      db.channel_accounts.findFirst.mockResolvedValue(null);
      const batch = [
        makeNormalized({ externalId: 'wamid.A' }),
        makeNormalized({ externalId: 'wamid.B' }),
        makeNormalized({ externalId: 'wamid.C' }),
      ];
      service.registerAdapter(makeBatchAdapter(batch) as never);

      await service.handleInboundWebhookBatch(ChannelType.WHATSAPP, REQ, BUSINESS_ID);

      expect(db.channel_accounts.findFirst).toHaveBeenCalledTimes(1);
      expect(db.messages.create).not.toHaveBeenCalled();
    });

    it('does not carry a resolved account across separate webhooks', async () => {
      // The memo is request-scoped on purpose. This row decides which tenant a
      // message is written under, so a deactivation or a re-point must be seen
      // by the very next webhook rather than surviving in a process-lifetime
      // cache.
      service.registerAdapter(makeBatchAdapter([makeNormalized({ externalId: 'wamid.A' })]) as never);
      await service.handleInboundWebhookBatch(ChannelType.WHATSAPP, REQ, BUSINESS_ID);

      service.registerAdapter(makeBatchAdapter([makeNormalized({ externalId: 'wamid.B' })]) as never);
      await service.handleInboundWebhookBatch(ChannelType.WHATSAPP, REQ, BUSINESS_ID);

      expect(db.channel_accounts.findFirst).toHaveBeenCalledTimes(2);
    });

    it('does not memoize a failed lookup', async () => {
      // A rejected lookup is dead-lettered and replayed. Caching the rejection
      // would fail the replay for a reason that no longer exists.
      db.channel_accounts.findFirst
        .mockRejectedValueOnce(new Error('connection terminated'))
        .mockResolvedValue({
          id: ACCOUNT_ID,
          business_id: RESOLVED_BUSINESS_ID,
          channel: ChannelType.WHATSAPP,
          external_id: 'PHONE_NUMBER_ID_1',
          is_active: true,
        });
      const batch = [
        makeNormalized({ externalId: 'wamid.A' }),
        makeNormalized({ externalId: 'wamid.B' }),
      ];
      service.registerAdapter(makeBatchAdapter(batch) as never);

      await service.handleInboundWebhookBatch(ChannelType.WHATSAPP, REQ, BUSINESS_ID);

      // The second message asks again and succeeds, rather than inheriting the
      // first one's error.
      expect(db.channel_accounts.findFirst).toHaveBeenCalledTimes(2);
      expect(db.messages.create).toHaveBeenCalledTimes(1);
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
