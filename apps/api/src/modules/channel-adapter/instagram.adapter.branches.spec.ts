/**
 * Branch coverage for the Instagram adapter.
 *
 * `instagram.adapter.spec.ts` covers the protocol's main line: signed webhook,
 * text/image/quick-reply/postback inbound, text and image outbound. This file
 * takes the rest of the surface — every attachment variant and its missing-field
 * rejection, the outbound content types Instagram refuses, quick-reply coercion
 * from untyped input, and the Graph API's error-body shapes.
 *
 * The production fail-closed case is here too: an unset app secret must reject
 * in production and only skip verification outside it (root rule #3).
 */

import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  MessageContentType,
  RawRequest,
  OutboundMessage,
  InteractiveMessage,
  ExternalServiceError,
  PayloadParseError,
} from '@gosumo/shared';

import {
  InstagramAdapter,
  isNonMessageEventOnly,
} from './adapters/instagram.adapter';

const APP_SECRET = 'test-ig-app-secret-32chars-xxxxx';
const PAGE_ID = '17841400000000000';
const ACCESS_TOKEN = 'test-ig-access-token';
const VERIFY_TOKEN = 'gosumo-ig-verify-token';

const IG_BUSINESS_ID = '17841400000000000';
const SENDER_IGSID = '6789012345678901';

function makeWebhookPayload(
  messaging: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    object: 'instagram',
    entry: [{ id: IG_BUSINESS_ID, time: 1700000000000, messaging }],
  };
}

function makeAttachmentEvent(
  attachment: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sender: { id: SENDER_IGSID },
    recipient: { id: IG_BUSINESS_ID },
    timestamp: 1700000000000,
    message: { mid: 'mid.IG_ATTACH', attachments: [attachment] },
  };
}

function request(payload: unknown): RawRequest {
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

async function buildAdapter(
  configOverrides: Record<string, string> = {},
): Promise<InstagramAdapter> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      InstagramAdapter,
      { provide: ConfigService, useValue: makeConfigService(configOverrides) },
    ],
  }).compile();
  return module.get(InstagramAdapter);
}

/** Stub the Graph API with a single response. */
function stubFetch(response: Partial<Response> & { json?: () => unknown }) {
  return jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(response as unknown as Response);
}

// ─────────────────────────────────────────────
// Webhook verification
// ─────────────────────────────────────────────

describe('InstagramAdapter — webhook verification branches', () => {
  it('rejects an unsigned webhook in production when no secret is set', async () => {
    const adapter = await buildAdapter({
      'instagram.appSecret': '',
      'app.env': 'production',
    });

    expect(adapter.validateWebhook(request(makeWebhookPayload([])))).toBe(false);
  });

  it('skips verification outside production when no secret is set', async () => {
    const adapter = await buildAdapter({
      'instagram.appSecret': '',
      'app.env': 'development',
    });

    expect(adapter.validateWebhook(request(makeWebhookPayload([])))).toBe(true);
  });

  it('rejects a signature of the wrong length before comparing it', async () => {
    // timingSafeEqual throws on unequal buffer lengths, so the length check has
    // to come first — a truncated signature must be a clean false, not a crash.
    const adapter = await buildAdapter();
    const req = request(makeWebhookPayload([]));
    req.headers['x-hub-signature-256'] = 'sha256=deadbeef';

    expect(adapter.validateWebhook(req)).toBe(false);
  });

  it('rejects a correctly-shaped signature computed over different bytes', async () => {
    const adapter = await buildAdapter();
    const req = request(makeWebhookPayload([]));
    const otherHash = crypto
      .createHmac('sha256', APP_SECRET)
      .update(Buffer.from('different bytes'))
      .digest('hex');
    req.headers['x-hub-signature-256'] = `sha256=${otherHash}`;

    expect(adapter.validateWebhook(req)).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Inbound attachments
// ─────────────────────────────────────────────

describe('InstagramAdapter — attachment parsing', () => {
  let adapter: InstagramAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  it.each([
    ['story_mention', 'image/jpeg'],
    ['share', 'image/jpeg'],
    ['video', 'video/mp4'],
    ['audio', 'application/octet-stream'],
    ['file', 'application/octet-stream'],
  ])('maps a %s attachment to media with mime %s', (type, mimeType) => {
    const msg = adapter.parseInbound(
      request(
        makeWebhookPayload([
          makeAttachmentEvent({
            type,
            payload: { url: 'https://cdn.example/asset' },
          }),
        ]),
      ),
    );

    expect(msg.content).toEqual({
      type: MessageContentType.IMAGE,
      url: 'https://cdn.example/asset',
      mimeType,
    });
  });

  it('parses a location attachment', () => {
    const msg = adapter.parseInbound(
      request(
        makeWebhookPayload([
          makeAttachmentEvent({
            type: 'location',
            payload: { title: 'Baner, Pune', coordinates: { lat: 18.56, long: 73.78 } },
          }),
        ]),
      ),
    );

    expect(msg.content).toEqual({
      type: MessageContentType.LOCATION,
      latitude: 18.56,
      longitude: 73.78,
      name: 'Baner, Pune',
    });
  });

  it.each(['image', 'video', 'audio', 'file', 'share', 'story_mention'])(
    'rejects a %s attachment with no url',
    (type) => {
      expect(() =>
        adapter.parseInbound(
          request(makeWebhookPayload([makeAttachmentEvent({ type, payload: {} })])),
        ),
      ).toThrow(/missing payload.url/);
    },
  );

  it('rejects a location attachment with no coordinates', () => {
    expect(() =>
      adapter.parseInbound(
        request(
          makeWebhookPayload([
            makeAttachmentEvent({ type: 'location', payload: { title: 'Nowhere' } }),
          ]),
        ),
      ),
    ).toThrow(/missing coordinates/);
  });

  it('rejects an attachment type Instagram has not documented to us', () => {
    const parse = (): unknown =>
      adapter.parseInbound(
        request(
          makeWebhookPayload([
            makeAttachmentEvent({ type: 'hologram', payload: { url: 'x' } }),
          ]),
        ),
      );

    // A parse error is never retryable — the same bytes fail forever, so the
    // consumer must DLQ rather than burn its attempt budget.
    expect(parse).toThrow(PayloadParseError);
    expect(parse).toThrow('Unsupported attachment type "hologram"');

    let caught: unknown;
    try {
      parse();
    } catch (err) {
      caught = err;
    }
    expect((caught as PayloadParseError).retryable).toBe(false);
    expect((caught as PayloadParseError).context).toEqual({
      source: 'Instagram',
      attachmentType: 'hologram',
    });
  });

  it('rejects a message carrying neither text nor an attachment', () => {
    expect(() =>
      adapter.parseInbound(
        request(
          makeWebhookPayload([
            {
              sender: { id: SENDER_IGSID },
              recipient: { id: IG_BUSINESS_ID },
              timestamp: 1700000000000,
              message: { mid: 'mid.EMPTY' },
            },
          ]),
        ),
      ),
    ).toThrow(PayloadParseError);
  });

  it('reports the offending mid when a message has no renderable content', () => {
    let caught: unknown;
    try {
      adapter.parseInbound(
        request(
          makeWebhookPayload([
            {
              sender: { id: SENDER_IGSID },
              recipient: { id: IG_BUSINESS_ID },
              timestamp: 1700000000000,
              message: { mid: 'mid.EMPTY' },
            },
          ]),
        ),
      );
    } catch (err) {
      caught = err;
    }

    // The mid is what makes the DLQ entry actionable against Instagram's logs.
    expect(caught).toBeInstanceOf(PayloadParseError);
    expect((caught as PayloadParseError).message).toBe(
      'Message carries neither text nor an attachment',
    );
    expect((caught as PayloadParseError).context).toEqual({
      source: 'Instagram',
      mid: 'mid.EMPTY',
    });
  });

  it('carries story-reply context into the message metadata', () => {
    const msg = adapter.parseInbound(
      request(
        makeWebhookPayload([
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: IG_BUSINESS_ID },
            timestamp: 1700000000000,
            message: {
              mid: 'mid.STORY_REPLY',
              text: 'love this',
              reply_to: { story: { url: 'https://cdn/story.jpg', id: 'story-1' } },
            },
          },
        ]),
      ),
    );

    expect(msg.metadata).toMatchObject({
      storyReplyUrl: 'https://cdn/story.jpg',
      storyReplyId: 'story-1',
    });
  });

  it('leaves story metadata undefined on an ordinary message', () => {
    const msg = adapter.parseInbound(
      request(
        makeWebhookPayload([
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: IG_BUSINESS_ID },
            timestamp: 1700000000000,
            message: { mid: 'mid.PLAIN', text: 'hello' },
          },
        ]),
      ),
    );

    expect(msg.metadata?.['storyReplyUrl']).toBeUndefined();
  });

  it('defaults a postback with no title to an empty title', () => {
    const msg = adapter.parseInbound(
      request(
        makeWebhookPayload([
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: IG_BUSINESS_ID },
            timestamp: 1700000000000,
            postback: { mid: 'mid.PB', payload: 'SHOW_CATALOG' },
          },
        ]),
      ),
    );

    expect(msg.content).toMatchObject({
      interactiveType: 'postback',
      payload: { id: 'SHOW_CATALOG', title: '' },
    });
  });

  it.each([
    ['the emoji field', { emoji: '❤️' }, '❤️'],
    ['the reaction name', { reaction: 'love' }, 'love'],
    ['a placeholder when neither is present', {}, '?'],
  ])('renders a reaction from %s', (_label, extra, expected) => {
    const msg = adapter.parseInbound(
      request(
        makeWebhookPayload([
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: IG_BUSINESS_ID },
            timestamp: 1700000000000,
            reaction: { mid: 'mid.REACT', action: 'react', ...extra },
          },
        ]),
      ),
    );

    expect(msg.content).toEqual({
      type: MessageContentType.TEXT,
      text: `[reaction: ${expected} on mid.REACT]`,
    });
  });

  it('falls back to a generated id when the event carries no mid', () => {
    const msg = adapter.parseInbound(
      request(
        makeWebhookPayload([
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: IG_BUSINESS_ID },
            timestamp: 1700000000000,
            message: { text: 'no mid here' },
          },
        ]),
      ),
    );

    expect(msg.externalId).toEqual(expect.any(String));
    expect(msg.externalId).not.toBe('');
  });
});

// ─────────────────────────────────────────────
// parseInboundAll
// ─────────────────────────────────────────────

describe('InstagramAdapter — parseInboundAll branches', () => {
  let adapter: InstagramAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  it('returns nothing for a payload from another Meta product', () => {
    expect(
      adapter.parseInboundAll(request({ object: 'page', entry: [] })),
    ).toEqual([]);
  });

  it('tolerates an entry with no messaging array', () => {
    expect(
      adapter.parseInboundAll(
        request({ object: 'instagram', entry: [{ id: IG_BUSINESS_ID, time: 1 }] }),
      ),
    ).toEqual([]);
  });

  it('skips an unparseable event but keeps the parseable ones', () => {
    const result = adapter.parseInboundAll(
      request(
        makeWebhookPayload([
          // Unparseable — an attachment with no url.
          makeAttachmentEvent({ type: 'image', payload: {} }),
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: IG_BUSINESS_ID },
            timestamp: 1700000000000,
            message: { mid: 'mid.GOOD', text: 'still here' },
          },
        ]),
      ),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.externalId).toBe('mid.GOOD');
  });

  /**
   * The skip-and-continue above only holds while the catch handler itself can
   * run. It logged `event.sender.id` un-chained, and "no sender" is one of the
   * shapes that reaches it — so the handler threw, the throw escaped the loop,
   * and the service reported the whole POST as unparseable. Every good message
   * delivered alongside it was discarded: no row, no event, and a 200 back to
   * Meta so it never redelivered.
   */
  it('keeps the good messages when a sibling event has no sender', () => {
    const result = adapter.parseInboundAll(
      request(
        makeWebhookPayload([
          { recipient: { id: IG_BUSINESS_ID }, timestamp: 1, message: { mid: 'mid.NOSENDER' } },
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: IG_BUSINESS_ID },
            timestamp: 1700000000000,
            message: { mid: 'mid.GOOD', text: 'still here' },
          },
        ]),
      ),
    );

    expect(result.map((m) => m.externalId)).toEqual(['mid.GOOD']);
  });

  it('keeps the good messages when a sibling event has no recipient', () => {
    const result = adapter.parseInboundAll(
      request(
        makeWebhookPayload([
          { sender: { id: SENDER_IGSID }, timestamp: 1, message: { mid: 'mid.NORECIPIENT' } },
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: IG_BUSINESS_ID },
            timestamp: 1700000000000,
            message: { mid: 'mid.GOOD', text: 'still here' },
          },
        ]),
      ),
    );

    expect(result.map((m) => m.externalId)).toEqual(['mid.GOOD']);
  });

  it('returns nothing rather than throwing on an unwalkable envelope', () => {
    for (const payload of [
      { object: 'instagram', entry: null },
      { object: 'instagram', entry: 'nope' },
      { object: 'instagram', entry: [null] },
      { object: 'instagram', entry: [{ id: IG_BUSINESS_ID, messaging: 'nope' }] },
      { object: 'instagram', entry: [{ id: IG_BUSINESS_ID, messaging: [null] }] },
    ]) {
      expect(adapter.parseInboundAll(request(payload))).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────
// isNonMessageEventOnly
// ─────────────────────────────────────────────

describe('isNonMessageEventOnly — branches', () => {
  it('treats an entry with no messaging array as non-message', () => {
    expect(isNonMessageEventOnly({ entry: [{ id: 'x', time: 1 }] })).toBe(true);
  });

  it('treats a payload with an entry array but no events as non-message', () => {
    expect(isNonMessageEventOnly({ entry: [] })).toBe(true);
  });

  it('returns false for a payload with no entry key', () => {
    expect(isNonMessageEventOnly({ object: 'instagram' })).toBe(false);
  });

  /**
   * Called ahead of the controller's try/catch, so a throw here is a 500 out of
   * a `@Public()` route — the response that makes Meta redeliver on a loop.
   */
  it.each([
    ['null entry', { entry: null }],
    ['entry that is a number', { entry: 7 }],
    ['null entry item', { entry: [null] }],
    ['messaging that is not an array', { entry: [{ id: 'x', messaging: {} }] }],
    ['null messaging item', { entry: [{ id: 'x', messaging: [null] }] }],
  ])('does not throw on a malformed payload: %s', (_label, body) => {
    expect(() => isNonMessageEventOnly(body)).not.toThrow();
  });

  it('returns false when a postback is present', () => {
    expect(
      isNonMessageEventOnly(
        makeWebhookPayload([
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: IG_BUSINESS_ID },
            timestamp: 1,
            postback: { mid: 'm', payload: 'P' },
          },
        ]),
      ),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Outbound content types
// ─────────────────────────────────────────────

describe('InstagramAdapter — outbound body construction', () => {
  let adapter: InstagramAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function outbound(content: OutboundMessage['content']): OutboundMessage {
    return {
      channelAccountId: PAGE_ID,
      recipientExternalId: SENDER_IGSID,
      content,
    };
  }

  it('sends a document as a file attachment', async () => {
    const fetchSpy = stubFetch({
      ok: true,
      status: 200,
      json: async () => ({ recipient_id: SENDER_IGSID, message_id: 'mid.DOC' }),
    });

    const result = await adapter.sendMessage(
      outbound({
        type: MessageContentType.DOCUMENT,
        url: 'https://cdn/brochure.pdf',
        filename: 'brochure.pdf',
        mimeType: 'application/pdf',
      }),
    );

    expect(result.success).toBe(true);
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.message.attachment).toEqual({
      type: 'file',
      payload: { url: 'https://cdn/brochure.pdf', is_reusable: false },
    });
  });

  it.each([
    [MessageContentType.INTERACTIVE, { interactiveType: 'button', payload: {} }],
    [MessageContentType.TEMPLATE, { templateName: 'welcome', language: 'en' }],
    [MessageContentType.PAYMENT_LINK, { url: 'https://pay', amountPaise: 100 }],
  ])('refuses to send %s content through sendMessage', async (type, extra) => {
    stubFetch({ ok: true, status: 200, json: async () => ({}) });

    const result = await adapter.sendMessage(
      outbound({ type, ...extra } as OutboundMessage['content']),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not support content type/);
    // Instagram will not start supporting this content type between attempts,
    // so the send must not consume its retry budget or the backoff sleeps.
    expect(result.attempts).toBe(1);
  });

  it('refuses to send a location', async () => {
    const result = await adapter.sendMessage(
      outbound({
        type: MessageContentType.LOCATION,
        latitude: 18.5,
        longitude: 73.8,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not support sending location/);
    expect(result.attempts).toBe(1);
  });
});

// ─────────────────────────────────────────────
// Quick replies
// ─────────────────────────────────────────────

describe('InstagramAdapter — quick-reply coercion', () => {
  let adapter: InstagramAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function interactive(action: Record<string, unknown>): InteractiveMessage {
    return {
      channelAccountId: PAGE_ID,
      recipientExternalId: SENDER_IGSID,
      body: 'Pick one',
      action,
    } as InteractiveMessage;
  }

  it('fails when quickReplies is not an array', async () => {
    const result = await adapter.sendInteractive(
      interactive({ quickReplies: 'two-bhk' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/non-empty action.quickReplies/);
  });

  it('drops malformed buttons and keeps the well-formed ones', async () => {
    const fetchSpy = stubFetch({
      ok: true,
      status: 200,
      json: async () => ({ recipient_id: SENDER_IGSID, message_id: 'mid.QR' }),
    });

    const result = await adapter.sendInteractive(
      interactive({
        quickReplies: [
          null,
          { title: 'no payload' },
          { payload: 'NO_TITLE' },
          { title: 42, payload: 'BAD_TITLE' },
          { title: '2 BHK', payload: 'CONFIG_2BHK' },
        ],
      }),
    );

    expect(result.success).toBe(true);
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.message.quick_replies).toEqual([
      { content_type: 'text', title: '2 BHK', payload: 'CONFIG_2BHK' },
    ]);
  });

  it('includes an image url only when the button carries one', async () => {
    const fetchSpy = stubFetch({
      ok: true,
      status: 200,
      json: async () => ({ recipient_id: SENDER_IGSID, message_id: 'mid.QR2' }),
    });

    await adapter.sendInteractive(
      interactive({
        quickReplies: [
          { title: 'With image', payload: 'A', imageUrl: 'https://cdn/a.png' },
          { title: 'Without', payload: 'B' },
        ],
      }),
    );

    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.message.quick_replies[0]).toHaveProperty(
      'image_url',
      'https://cdn/a.png',
    );
    expect(body.message.quick_replies[1]).not.toHaveProperty('image_url');
  });

  it('fails when every supplied button is malformed', async () => {
    const result = await adapter.sendInteractive(
      interactive({ quickReplies: [{ nope: true }] }),
    );

    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Graph API error handling
// ─────────────────────────────────────────────

describe('InstagramAdapter — Graph API responses', () => {
  let adapter: InstagramAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const textMessage: OutboundMessage = {
    channelAccountId: PAGE_ID,
    recipientExternalId: SENDER_IGSID,
    content: { type: MessageContentType.TEXT, text: 'hi' },
  };

  it('surfaces the Meta error code and message from a 4xx body', async () => {
    stubFetch({
      ok: false,
      status: 400,
      json: async () => ({
        error: { message: 'Outside the 24-hour window', code: 10 },
      }),
    });

    const result = await adapter.sendMessage(textMessage);

    expect(result).toMatchObject({
      success: false,
      error: 'Meta API error 10: Outside the 24-hour window',
      // A 4xx is not retried — the caller sees a single attempt.
      attempts: 1,
    });
  });

  it('falls back to the HTTP status when the error body has no code', async () => {
    stubFetch({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'Forbidden' } }),
    });

    const result = await adapter.sendMessage(textMessage);

    expect(result.error).toBe('Meta API error 403: Forbidden');
  });

  it('falls back to a status-only message when the body is not JSON', async () => {
    stubFetch({
      ok: false,
      status: 404,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    });

    const result = await adapter.sendMessage(textMessage);

    expect(result.error).toBe('Meta API returned 404');
  });

  it('falls back to a status-only message when the body has no error object', async () => {
    stubFetch({ ok: false, status: 422, json: async () => ({ nothing: true }) });

    const result = await adapter.sendMessage(textMessage);

    expect(result.error).toBe('Meta API returned 422');
  });

  it('retries a 5xx and reports failure after exhausting attempts', async () => {
    const fetchSpy = stubFetch({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: 'Service unavailable', code: 2 } }),
    });

    const result = await adapter.sendMessage(textMessage);

    expect(result.success).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('retries a 429 instead of dropping the send', async () => {
    const fetchSpy = stubFetch({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Rate limit', code: 4 } }),
    });

    const result = await adapter.sendMessage(textMessage);

    expect(result.success).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('gives up on a 403 after a single attempt', async () => {
    const fetchSpy = stubFetch({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'Forbidden', code: 403 } }),
    });

    const result = await adapter.sendMessage(textMessage);

    // A revoked token is not a transient condition.
    expect(result).toMatchObject({ success: false, attempts: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// Media download
// ─────────────────────────────────────────────

describe('InstagramAdapter — downloadMedia', () => {
  let adapter: InstagramAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the fetched bytes as a Buffer', async () => {
    // The body is streamed against a running size total rather than read with
    // `arrayBuffer()`, so the stub supplies a reader — see `readBodyWithLimit`.
    const bytes = Buffer.from('jpeg-bytes');
    let sent = false;
    stubFetch({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      body: {
        getReader: () => ({
          read: async () =>
            sent
              ? { done: true, value: undefined }
              : ((sent = true), { done: false, value: new Uint8Array(bytes) }),
          cancel: async () => undefined,
        }),
      },
    } as unknown as Response);

    const result = await adapter.downloadMedia('https://cdn/asset.jpg');

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString()).toBe('jpeg-bytes');
  });

  it('throws when the CDN url has expired', async () => {
    stubFetch({ ok: false, status: 410, statusText: 'Gone' });

    const error = await adapter.downloadMedia('https://cdn/expired.jpg').then(
      () => null,
      (err: unknown) => err,
    );

    // 410 is terminal — the CDN link is dead, not briefly unavailable.
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).message).toBe('Instagram Media: download failed');
    expect((error as ExternalServiceError).retryable).toBe(false);
    expect((error as ExternalServiceError).context).toEqual({
      service: 'Instagram Media',
      status: 410,
      statusText: 'Gone',
    });
  });
});
