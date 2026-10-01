/**
 * Data flow integrity tests for channel adapters.
 *
 * Every adapter's `parseInbound` must produce a NormalizedMessage that
 * satisfies the contract: every required field is populated, the timestamp is a
 * valid Date, and content.type matches the actual content shape. A gap here
 * travels silently until it hits a NOT NULL column or a broken AI prompt.
 */

import { ChannelType, MessageDirection, MessageContentType, RawRequest, NormalizedMessage } from '@gosumo/shared';
import { ConfigService } from '@nestjs/config';
import { validateNormalizedMessage } from './channel-adapter.service';

// ─── Adapters under test ────────────────────────────

import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
import { InstagramAdapter } from './adapters/instagram.adapter';
import { SmsAdapter } from './adapters/sms.adapter';
import { EmailAdapter } from './adapters/email.adapter';
import { WebChatAdapter } from './adapters/webchat.adapter';

// ─── Fixtures ───────────────────────────────────────

function rawReq(body: unknown): RawRequest {
  return {
    body,
    headers: {},
    rawBody: Buffer.from(JSON.stringify(body)),
  };
}

function whatsappPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_001',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '+91 99999 00001', phone_number_id: 'pn_123' },
          contacts: [{ profile: { name: 'Priya' }, wa_id: '919999900001' }],
          messages: [{
            from: '919999900001',
            id: 'wamid.test001',
            timestamp: '1700000000',
            type: 'text',
            text: { body: 'Hello' },
          }],
          ...overrides,
        },
        field: 'messages',
      }],
    }],
  };
}

function instagramPayload(): unknown {
  return {
    object: 'instagram',
    entry: [{
      id: 'IG_001',
      messaging: [{
        sender: { id: 'ig_user_123' },
        recipient: { id: 'ig_page_456' },
        timestamp: 1700000000000,
        message: {
          mid: 'm_test001',
          text: 'Hi from Instagram',
        },
      }],
    }],
  };
}

function smsPayload(extra: Record<string, string> = {}): Record<string, string> {
  return {
    From: '+919999900001',
    To: '+919999900002',
    Body: 'Hello via SMS',
    MessageSid: 'SM_test001',
    NumMedia: '0',
    ...extra,
  };
}

function emailPayload(extra: Record<string, unknown> = {}): unknown {
  return {
    from: 'priya@example.com',
    to: 'support@business.com',
    subject: 'Order inquiry',
    body: 'Where is my order?',
    messageId: 'msg_email_001',
    ...extra,
  };
}

function webchatPayload(): unknown {
  return {
    widgetId: 'widget_001',
    sessionId: 'session_001',
    text: 'Hello from web',
    timestamp: '2024-01-15T10:00:00Z',
    sender: 'Test Visitor',
  };
}

// ─── Helpers ────────────────────────────────────────

function mockConfig(): ConfigService {
  return { get: () => undefined, getOrThrow: () => '' } as unknown as ConfigService;
}

function assertValidNormalized(msg: NormalizedMessage, channel: ChannelType): void {
  const issues = validateNormalizedMessage(msg);
  expect(issues).toEqual([]);
  expect(msg.channel).toBe(channel);
  expect(msg.direction).toBe(MessageDirection.INBOUND);
  expect(msg.id).toBeTruthy();
  expect(msg.externalId).toBeTruthy();
  expect(msg.sender.externalId).toBeTruthy();
  expect(msg.timestamp).toBeInstanceOf(Date);
  expect(Number.isNaN(msg.timestamp.getTime())).toBe(false);
}

// ─── Tests ──────────────────────────────────────────

describe('NormalizedMessage field coverage', () => {
  describe('WhatsApp', () => {
    let adapter: WhatsAppAdapter;
    beforeEach(() => {
      adapter = new WhatsAppAdapter(mockConfig(), null as never);
    });

    it('populates every required field from a text message webhook', () => {
      const msg = adapter.parseInbound(rawReq(whatsappPayload()));
      assertValidNormalized(msg, ChannelType.WHATSAPP);
      expect(msg.content.type).toBe(MessageContentType.TEXT);
      expect((msg.content as { text: string }).text).toBe('Hello');
      expect(msg.sender.displayName).toBe('Priya');
    });

    it('preserves the provider timestamp rather than using Date.now()', () => {
      const msg = adapter.parseInbound(rawReq(whatsappPayload()));
      expect(msg.timestamp.getTime()).toBe(1700000000 * 1000);
    });
  });

  describe('Instagram', () => {
    let adapter: InstagramAdapter;
    beforeEach(() => {
      adapter = new InstagramAdapter(mockConfig(), null as never);
    });

    it('populates every required field from a DM webhook', () => {
      const msg = adapter.parseInbound(rawReq(instagramPayload()));
      assertValidNormalized(msg, ChannelType.INSTAGRAM);
      expect(msg.content.type).toBe(MessageContentType.TEXT);
      expect((msg.content as { text: string }).text).toBe('Hi from Instagram');
    });
  });

  describe('SMS', () => {
    let adapter: SmsAdapter;
    beforeEach(() => {
      adapter = new SmsAdapter(mockConfig(), null as never);
    });

    it('populates every required field from a Twilio webhook', () => {
      const msg = adapter.parseInbound(rawReq(smsPayload()));
      assertValidNormalized(msg, ChannelType.SMS);
      expect(msg.content.type).toBe(MessageContentType.TEXT);
      expect((msg.content as { text: string }).text).toBe('Hello via SMS');
    });

    it('uses Twilio DateCreated when present instead of Date.now()', () => {
      const msg = adapter.parseInbound(rawReq(smsPayload({
        DateCreated: 'Wed, 15 Nov 2023 12:00:00 +0000',
      })));
      expect(msg.timestamp.getTime()).toBe(new Date('2023-11-15T12:00:00Z').getTime());
    });

    it('falls back to Date.now() when no Twilio timestamp is present', () => {
      const before = Date.now();
      const msg = adapter.parseInbound(rawReq(smsPayload()));
      const after = Date.now();
      expect(msg.timestamp.getTime()).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('Email', () => {
    let adapter: EmailAdapter;
    beforeEach(() => {
      adapter = new EmailAdapter(mockConfig(), null as never);
    });

    it('populates every required field from an inbound email webhook', () => {
      const msg = adapter.parseInbound(rawReq(emailPayload()));
      assertValidNormalized(msg, ChannelType.EMAIL);
      expect(msg.content.type).toBe(MessageContentType.TEXT);
      expect((msg.content as { text: string }).text).toContain('Order inquiry');
      expect((msg.content as { text: string }).text).toContain('Where is my order?');
    });

    it('uses the email Date header when present instead of Date.now()', () => {
      const msg = adapter.parseInbound(rawReq(emailPayload({
        date: '2023-11-15T12:00:00Z',
      })));
      expect(msg.timestamp.getTime()).toBe(new Date('2023-11-15T12:00:00Z').getTime());
    });

    it('falls back to Date.now() when no date header is present', () => {
      const before = Date.now();
      const msg = adapter.parseInbound(rawReq(emailPayload()));
      const after = Date.now();
      expect(msg.timestamp.getTime()).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp.getTime()).toBeLessThanOrEqual(after);
    });

    it('preserves attachment metadata in the normalized metadata', () => {
      const msg = adapter.parseInbound(rawReq(emailPayload({
        attachments: [{ filename: 'invoice.pdf', url: 'https://cdn.example.com/f.pdf', mimeType: 'application/pdf' }],
      })));
      expect((msg.metadata as Record<string, unknown>).hasAttachments).toBe(true);
    });
  });

  describe('WebChat', () => {
    let adapter: WebChatAdapter;
    beforeEach(() => {
      adapter = new WebChatAdapter(mockConfig());
    });

    it('populates every required field from a webchat message', () => {
      const msg = adapter.parseInbound(rawReq(webchatPayload()));
      assertValidNormalized(msg, ChannelType.WEB_CHAT);
      expect(msg.content.type).toBe(MessageContentType.TEXT);
      expect((msg.content as { text: string }).text).toBe('Hello from web');
    });

    it('uses the client-provided timestamp when present', () => {
      const msg = adapter.parseInbound(rawReq(webchatPayload()));
      expect(msg.timestamp.getTime()).toBe(new Date('2024-01-15T10:00:00Z').getTime());
    });
  });
});

describe('validateNormalizedMessage', () => {
  it('returns no issues for a complete message', () => {
    const msg: NormalizedMessage = {
      id: 'msg_1',
      externalId: 'ext_1',
      channel: ChannelType.WHATSAPP,
      channelAccountId: 'acct_1',
      direction: MessageDirection.INBOUND,
      sender: { externalId: 'sender_1', displayName: 'Test' },
      content: { type: MessageContentType.TEXT, text: 'Hello' },
      timestamp: new Date(),
      metadata: {},
    };
    expect(validateNormalizedMessage(msg)).toEqual([]);
  });

  it('catches a missing sender.externalId', () => {
    const msg: NormalizedMessage = {
      id: 'msg_1',
      externalId: 'ext_1',
      channel: ChannelType.SMS,
      channelAccountId: 'acct_1',
      direction: MessageDirection.INBOUND,
      sender: { externalId: '' },
      content: { type: MessageContentType.TEXT, text: 'Hello' },
      timestamp: new Date(),
      metadata: {},
    };
    expect(validateNormalizedMessage(msg)).toContain('sender.externalId is empty');
  });

  it('catches an invalid timestamp', () => {
    const msg: NormalizedMessage = {
      id: 'msg_1',
      externalId: 'ext_1',
      channel: ChannelType.EMAIL,
      channelAccountId: 'acct_1',
      direction: MessageDirection.INBOUND,
      sender: { externalId: 'sender_1' },
      content: { type: MessageContentType.TEXT, text: 'Hello' },
      timestamp: new Date('not-a-date'),
      metadata: {},
    };
    expect(validateNormalizedMessage(msg)).toContain('timestamp is not a valid Date');
  });
});
