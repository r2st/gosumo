/**
 * Instagram Channel Adapter unit tests
 *
 * Coverage:
 *  1. Webhook signature validation (valid, tampered, missing header, no rawBody, no secret)
 *  2. GET verification challenge (success, wrong token, wrong mode, missing challenge)
 *  3. parseInbound — text, image attachment, quick reply, postback, reaction
 *  4. parseInbound error paths (echo-only payload, wrong object type)
 *  5. parseInboundAll — multi-event batches, echo/read-receipt filtering
 *  6. sendMessage — text success, image, 4xx failure, 5xx retry
 *  7. sendInteractive — quick replies success, empty action failure
 *  8. sendTemplate — unsupported
 *  9. getCapabilities
 * 10. isNonMessageEventOnly utility
 *
 * External HTTP calls (Meta Graph API) are mocked via jest.spyOn on global fetch.
 */

import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  ChannelType,
  MessageContentType,
  MessageDirection,
  RawRequest,
  OutboundMessage,
  InteractiveMessage,
} from '@gosumo/shared';

import { InstagramAdapter, isNonMessageEventOnly } from './adapters/instagram.adapter';

// ─────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────

const APP_SECRET = 'test-ig-app-secret-32chars-xxxxx';
const PAGE_ID = '17841400000000000';
const ACCESS_TOKEN = 'test-ig-access-token';
const VERIFY_TOKEN = 'gosumo-ig-verify-token';

const IG_BUSINESS_ID = '17841400000000000';
const SENDER_IGSID = '6789012345678901';

/**
 * Build an Instagram webhook payload with a single messaging event.
 * Pass `messaging` overrides to swap in a different event shape.
 */
function makeWebhookPayload(messaging: Record<string, unknown>): Record<string, unknown> {
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_BUSINESS_ID,
        time: 1700000000000,
        messaging: [messaging],
      },
    ],
  };
}

function makeTextEvent(text = 'Hi, is this available?'): Record<string, unknown> {
  return {
    sender: { id: SENDER_IGSID },
    recipient: { id: IG_BUSINESS_ID },
    timestamp: 1700000000000,
    message: { mid: 'mid.IG_TEXT_001', text },
  };
}

function buildSignedRequest(payload: unknown, secret: string): RawRequest {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return {
    headers: {
      'x-hub-signature-256': `sha256=${signature}`,
      'content-type': 'application/json',
    },
    body: payload,
    rawBody,
  };
}

function buildUnsignedRequest(payload: unknown): RawRequest {
  return {
    headers: { 'content-type': 'application/json' },
    body: payload,
    rawBody: Buffer.from(JSON.stringify(payload)),
  };
}

function makeConfigService(overrides: Record<string, string> = {}): ConfigService {
  const defaults: Record<string, string> = {
    'instagram.appSecret': APP_SECRET,
    'instagram.accessToken': ACCESS_TOKEN,
    'instagram.pageId': PAGE_ID,
    'instagram.verifyToken': VERIFY_TOKEN,
  };
  const values = { ...defaults, ...overrides };
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback ?? '',
  } as unknown as ConfigService;
}

async function buildAdapter(configOverrides: Record<string, string> = {}): Promise<InstagramAdapter> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      InstagramAdapter,
      { provide: ConfigService, useValue: makeConfigService(configOverrides) },
    ],
  }).compile();

  return module.get<InstagramAdapter>(InstagramAdapter);
}

// ─────────────────────────────────────────────
// 1. validateWebhook
// ─────────────────────────────────────────────

describe('InstagramAdapter — validateWebhook', () => {
  let adapter: InstagramAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  it('returns true for a valid HMAC-SHA256 signature', () => {
    const req = buildSignedRequest(makeWebhookPayload(makeTextEvent()), APP_SECRET);
    expect(adapter.validateWebhook(req)).toBe(true);
  });

  it('returns false for a tampered signature', () => {
    const payload = makeWebhookPayload(makeTextEvent());
    const req: RawRequest = {
      headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
      body: payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
    };
    expect(adapter.validateWebhook(req)).toBe(false);
  });

  it('returns false when X-Hub-Signature-256 header is missing', () => {
    const payload = makeWebhookPayload(makeTextEvent());
    const req: RawRequest = {
      headers: {},
      body: payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
    };
    expect(adapter.validateWebhook(req)).toBe(false);
  });

  it('returns false when rawBody is absent', () => {
    const payload = makeWebhookPayload(makeTextEvent());
    const req: RawRequest = {
      headers: { 'x-hub-signature-256': 'sha256=anything' },
      body: payload,
    };
    expect(adapter.validateWebhook(req)).toBe(false);
  });

  it('returns false for a wrong secret', () => {
    const req = buildSignedRequest(makeWebhookPayload(makeTextEvent()), 'wrong-secret-xxxxxxxxxxxxx');
    expect(adapter.validateWebhook(req)).toBe(false);
  });

  it('returns true and skips verification when appSecret is not configured', async () => {
    const adapterWithoutSecret = await buildAdapter({ 'instagram.appSecret': '' });
    const req = buildUnsignedRequest(makeWebhookPayload(makeTextEvent()));
    expect(adapterWithoutSecret.validateWebhook(req)).toBe(true);
  });
});

// ─────────────────────────────────────────────
// 2. verifyChallenge (GET handshake)
// ─────────────────────────────────────────────

describe('InstagramAdapter — verifyChallenge', () => {
  let adapter: InstagramAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  it('echoes the challenge when mode and token match', () => {
    expect(adapter.verifyChallenge('subscribe', VERIFY_TOKEN, '1234567890')).toBe('1234567890');
  });

  it('returns null when the verify token does not match', () => {
    expect(adapter.verifyChallenge('subscribe', 'wrong-token', '1234567890')).toBeNull();
  });

  it('returns null when the mode is not "subscribe"', () => {
    expect(adapter.verifyChallenge('unsubscribe', VERIFY_TOKEN, '1234567890')).toBeNull();
  });

  it('returns null when the challenge is missing', () => {
    expect(adapter.verifyChallenge('subscribe', VERIFY_TOKEN, undefined)).toBeNull();
  });
});

// ─────────────────────────────────────────────
// 3. parseInbound
// ─────────────────────────────────────────────

describe('InstagramAdapter — parseInbound', () => {
  let adapter: InstagramAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  it('parses a text message correctly', () => {
    const req = buildSignedRequest(makeWebhookPayload(makeTextEvent()), APP_SECRET);
    const msg = adapter.parseInbound(req);

    expect(msg.channel).toBe(ChannelType.INSTAGRAM);
    expect(msg.direction).toBe(MessageDirection.INBOUND);
    expect(msg.externalId).toBe('mid.IG_TEXT_001');
    expect(msg.sender.externalId).toBe(SENDER_IGSID);
    expect(msg.channelAccountId).toBe(IG_BUSINESS_ID);
    expect(msg.content.type).toBe(MessageContentType.TEXT);
    if (msg.content.type === MessageContentType.TEXT) {
      expect(msg.content.text).toBe('Hi, is this available?');
    }
    expect(msg.timestamp).toEqual(new Date(1700000000000));
    expect(msg.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('parses an image attachment', () => {
    const event = {
      sender: { id: SENDER_IGSID },
      recipient: { id: IG_BUSINESS_ID },
      timestamp: 1700000001000,
      message: {
        mid: 'mid.IG_IMG_001',
        attachments: [
          { type: 'image', payload: { url: 'https://cdn.ig.example/photo.jpg' } },
        ],
      },
    };
    const msg = adapter.parseInbound(buildUnsignedRequest(makeWebhookPayload(event)));

    expect(msg.content.type).toBe(MessageContentType.IMAGE);
    if (msg.content.type === MessageContentType.IMAGE) {
      expect(msg.content.url).toBe('https://cdn.ig.example/photo.jpg');
      expect(msg.content.mimeType).toBe('image/jpeg');
    }
  });

  it('parses a quick-reply tap as interactive', () => {
    const event = {
      sender: { id: SENDER_IGSID },
      recipient: { id: IG_BUSINESS_ID },
      timestamp: 1700000002000,
      message: {
        mid: 'mid.IG_QR_001',
        text: 'Red',
        quick_reply: { payload: 'COLOR_RED' },
      },
    };
    const msg = adapter.parseInbound(buildUnsignedRequest(makeWebhookPayload(event)));

    expect(msg.content.type).toBe(MessageContentType.INTERACTIVE);
    if (msg.content.type === MessageContentType.INTERACTIVE) {
      expect(msg.content.interactiveType).toBe('quick_reply');
      expect(msg.content.payload['id']).toBe('COLOR_RED');
      expect(msg.content.payload['title']).toBe('Red');
    }
  });

  it('parses a postback as interactive', () => {
    const event = {
      sender: { id: SENDER_IGSID },
      recipient: { id: IG_BUSINESS_ID },
      timestamp: 1700000003000,
      postback: { mid: 'mid.IG_PB_001', title: 'Get Started', payload: 'GET_STARTED' },
    };
    const msg = adapter.parseInbound(buildUnsignedRequest(makeWebhookPayload(event)));

    expect(msg.externalId).toBe('mid.IG_PB_001');
    expect(msg.content.type).toBe(MessageContentType.INTERACTIVE);
    if (msg.content.type === MessageContentType.INTERACTIVE) {
      expect(msg.content.interactiveType).toBe('postback');
      expect(msg.content.payload['id']).toBe('GET_STARTED');
      expect(msg.content.payload['title']).toBe('Get Started');
    }
  });

  it('parses a reaction as text', () => {
    const event = {
      sender: { id: SENDER_IGSID },
      recipient: { id: IG_BUSINESS_ID },
      timestamp: 1700000004000,
      reaction: { mid: 'mid.IG_REACTED', action: 'react', emoji: '❤️' },
    };
    const msg = adapter.parseInbound(buildUnsignedRequest(makeWebhookPayload(event)));

    expect(msg.content.type).toBe(MessageContentType.TEXT);
    if (msg.content.type === MessageContentType.TEXT) {
      expect(msg.content.text).toContain('❤️');
      expect(msg.content.text).toContain('mid.IG_REACTED');
    }
  });

  it('skips echo events and throws when nothing else is parseable', () => {
    const echoEvent = {
      sender: { id: IG_BUSINESS_ID },
      recipient: { id: SENDER_IGSID },
      timestamp: 1700000005000,
      message: { mid: 'mid.IG_ECHO', text: 'Our reply', is_echo: true },
    };
    expect(() =>
      adapter.parseInbound(buildUnsignedRequest(makeWebhookPayload(echoEvent))),
    ).toThrow('Webhook payload contained no parseable inbound message');
  });

  it('throws for an unexpected object type', () => {
    const badPayload = { object: 'whatsapp_business_account', entry: [] };
    expect(() => adapter.parseInbound(buildUnsignedRequest(badPayload))).toThrow(
      'Unexpected webhook object type',
    );
  });
});

// ─────────────────────────────────────────────
// 4. parseInboundAll
// ─────────────────────────────────────────────

describe('InstagramAdapter — parseInboundAll', () => {
  let adapter: InstagramAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  it('returns an empty array for an echo-only payload', () => {
    const echoEvent = {
      sender: { id: IG_BUSINESS_ID },
      recipient: { id: SENDER_IGSID },
      timestamp: 1700000006000,
      message: { mid: 'mid.IG_ECHO2', text: 'echo', is_echo: true },
    };
    const msgs = adapter.parseInboundAll(buildUnsignedRequest(makeWebhookPayload(echoEvent)));
    expect(msgs).toHaveLength(0);
  });

  it('returns multiple messages from a batched payload', () => {
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: IG_BUSINESS_ID,
          time: 1700000100000,
          messaging: [
            {
              sender: { id: SENDER_IGSID },
              recipient: { id: IG_BUSINESS_ID },
              timestamp: 1700000100000,
              message: { mid: 'mid.A1', text: 'First' },
            },
            {
              sender: { id: SENDER_IGSID },
              recipient: { id: IG_BUSINESS_ID },
              timestamp: 1700000101000,
              message: { mid: 'mid.A2', text: 'Second' },
            },
          ],
        },
      ],
    };
    const msgs = adapter.parseInboundAll(buildUnsignedRequest(payload));
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.externalId).toBe('mid.A1');
    expect(msgs[1]!.externalId).toBe('mid.A2');
  });
});

// ─────────────────────────────────────────────
// 5. isNonMessageEventOnly utility
// ─────────────────────────────────────────────

describe('isNonMessageEventOnly()', () => {
  it('returns true for a read-receipt-only payload', () => {
    const payload = makeWebhookPayload({
      sender: { id: SENDER_IGSID },
      recipient: { id: IG_BUSINESS_ID },
      timestamp: 1700000007000,
      read: { mid: 'mid.READ_001' },
    });
    expect(isNonMessageEventOnly(payload)).toBe(true);
  });

  it('returns true for an echo-only payload', () => {
    const payload = makeWebhookPayload({
      sender: { id: IG_BUSINESS_ID },
      recipient: { id: SENDER_IGSID },
      timestamp: 1700000008000,
      message: { mid: 'mid.ECHO', text: 'x', is_echo: true },
    });
    expect(isNonMessageEventOnly(payload)).toBe(true);
  });

  it('returns false when there is a real inbound message', () => {
    expect(isNonMessageEventOnly(makeWebhookPayload(makeTextEvent()))).toBe(false);
  });

  it('returns false for null/undefined input', () => {
    expect(isNonMessageEventOnly(null)).toBe(false);
    expect(isNonMessageEventOnly(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────
// 6. sendMessage
// ─────────────────────────────────────────────

describe('InstagramAdapter — sendMessage', () => {
  let adapter: InstagramAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends a text message and returns success', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ recipient_id: SENDER_IGSID, message_id: 'mid.SENT_001' }),
    } as unknown as Response);

    const message: OutboundMessage = {
      channelAccountId: PAGE_ID,
      recipientExternalId: SENDER_IGSID,
      content: { type: MessageContentType.TEXT, text: 'Yes, it is in stock!' },
    };

    const result = await adapter.sendMessage(message);

    expect(result.success).toBe(true);
    expect(result.externalMessageId).toBe('mid.SENT_001');
    expect(result.sentAt).toBeInstanceOf(Date);

    // Verify endpoint + body shape
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toContain(`/${PAGE_ID}/messages`);
    const sentBody = JSON.parse((calledInit as RequestInit).body as string);
    expect(sentBody).toEqual({
      recipient: { id: SENDER_IGSID },
      message: { text: 'Yes, it is in stock!' },
    });
  });

  it('sends an image message as an attachment', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ recipient_id: SENDER_IGSID, message_id: 'mid.SENT_IMG' }),
    } as unknown as Response);

    const message: OutboundMessage = {
      channelAccountId: PAGE_ID,
      recipientExternalId: SENDER_IGSID,
      content: {
        type: MessageContentType.IMAGE,
        url: 'https://cdn.gosumo.app/catalog/item.jpg',
        mimeType: 'image/jpeg',
      },
    };

    const result = await adapter.sendMessage(message);
    expect(result.success).toBe(true);

    const sentBody = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(sentBody.message.attachment).toEqual({
      type: 'image',
      payload: { url: 'https://cdn.gosumo.app/catalog/item.jpg', is_reusable: false },
    });
  });

  it('returns a failure result for a 4xx error (non-retryable)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: { message: 'User cannot receive messages outside the 24h window', code: 10 },
      }),
    } as unknown as Response);

    const message: OutboundMessage = {
      channelAccountId: PAGE_ID,
      recipientExternalId: SENDER_IGSID,
      content: { type: MessageContentType.TEXT, text: 'Late reply' },
    };

    const result = await adapter.sendMessage(message);
    expect(result.success).toBe(false);
    expect(result.error).toContain('24h window');
  });

  it('retries on 5xx errors and fails after maxAttempts', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'Service unavailable',
    } as unknown as Response);

    const message: OutboundMessage = {
      channelAccountId: PAGE_ID,
      recipientExternalId: SENDER_IGSID,
      content: { type: MessageContentType.TEXT, text: 'Test' },
    };

    const result = await adapter.sendMessage(message);
    expect(result.success).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }, 10_000);
});

// ─────────────────────────────────────────────
// 7. sendInteractive (quick replies)
// ─────────────────────────────────────────────

describe('InstagramAdapter — sendInteractive', () => {
  let adapter: InstagramAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends quick replies built from action.quickReplies', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ recipient_id: SENDER_IGSID, message_id: 'mid.QR_SENT' }),
    } as unknown as Response);

    const interactive: InteractiveMessage = {
      channelAccountId: PAGE_ID,
      recipientExternalId: SENDER_IGSID,
      interactiveType: 'quick_reply',
      body: 'Which size?',
      action: {
        quickReplies: [
          { title: 'Small', payload: 'SIZE_S' },
          { title: 'Large', payload: 'SIZE_L' },
        ],
      },
    };

    const result = await adapter.sendInteractive(interactive);
    expect(result.success).toBe(true);
    expect(result.externalMessageId).toBe('mid.QR_SENT');

    const sentBody = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(sentBody.message.text).toBe('Which size?');
    expect(sentBody.message.quick_replies).toEqual([
      { content_type: 'text', title: 'Small', payload: 'SIZE_S' },
      { content_type: 'text', title: 'Large', payload: 'SIZE_L' },
    ]);
  });

  it('returns a failure result when no quick replies are provided', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const interactive: InteractiveMessage = {
      channelAccountId: PAGE_ID,
      recipientExternalId: SENDER_IGSID,
      interactiveType: 'quick_reply',
      body: 'Pick one',
      action: {},
    };

    const result = await adapter.sendInteractive(interactive);
    expect(result.success).toBe(false);
    expect(result.error).toContain('quickReplies');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 8. sendTemplate (unsupported)
// ─────────────────────────────────────────────

describe('InstagramAdapter — sendTemplate', () => {
  it('returns an unsupported failure result without calling the API', async () => {
    const adapter = await buildAdapter();
    const fetchSpy = jest.spyOn(global, 'fetch');

    const result = await adapter.sendTemplate({
      channelAccountId: PAGE_ID,
      recipientExternalId: SENDER_IGSID,
      templateName: 'order_update',
      language: 'en',
      parameters: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not support template');
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────
// 9. getCapabilities
// ─────────────────────────────────────────────

describe('InstagramAdapter — getCapabilities', () => {
  it('returns the correct Instagram capability set', async () => {
    const adapter = await buildAdapter();
    const caps = adapter.getCapabilities();

    expect(caps.channelType).toBe(ChannelType.INSTAGRAM);
    expect(caps.supportsTemplates).toBe(false);
    expect(caps.supportsInteractiveMessages).toBe(true);
    expect(caps.supportsMedia).toBe(true);
    expect(caps.supportsVoice).toBe(false);
    expect(caps.supportsPaymentLinks).toBe(false);
    expect(caps.maxMessageLength).toBe(1000);
  });
});
