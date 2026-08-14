/**
 * Instagram channel — end-to-end tests.
 *
 * Drives a real NestJS app over HTTP (supertest) through the full
 * controller → ChannelAdapterService → InstagramAdapter pipeline.
 *
 * Coverage:
 *  - GET  /v1/.../webhooks/instagram  verification handshake (hub.verify_token + hub.challenge)
 *  - POST inbound parsing: text, image, postback, reaction, story_mention
 *  - Outbound: text, image, quick replies (via the service public API)
 *  - HMAC-SHA256 signature validation: valid accepted, invalid rejected
 *  - Error handling: bad object type, empty payload, missing fields
 */
import request from 'supertest';
import {
  ChannelType,
  MessageContentType,
  OutboundMessage,
  InteractiveMessage,
  NormalizedMessage,
} from '@gosumo/shared';

import { InstagramAdapter } from '../../src/modules/channel-adapter/adapters/instagram.adapter';
import { ChannelAdapterService } from '../../src/modules/channel-adapter/channel-adapter.service';
import {
  createHarness,
  E2EHarness,
  TEST_CONFIG,
  signMetaBody,
  mockFetchJsonOnce,
} from './utils/e2e-harness';

const APP_SECRET = TEST_CONFIG['instagram.appSecret'];
const PAGE_ID = TEST_CONFIG['instagram.pageId'];
const VERIFY_TOKEN = TEST_CONFIG['instagram.verifyToken'];
const IG_BUSINESS_ID = PAGE_ID;
const SENDER_IGSID = '6789012345678901';

const WEBHOOK_PATH = '/webhooks/instagram';

function igPayload(messaging: Record<string, unknown>): Record<string, unknown> {
  return {
    object: 'instagram',
    entry: [{ id: IG_BUSINESS_ID, time: 1700000000000, messaging: [messaging] }],
  };
}

function textEvent(text = 'Is this still available?'): Record<string, unknown> {
  return {
    sender: { id: SENDER_IGSID },
    recipient: { id: IG_BUSINESS_ID },
    timestamp: 1700000000000,
    message: { mid: 'mid.IG_TEXT_001', text },
  };
}

describe('Instagram channel (e2e)', () => {
  let h: E2EHarness;
  let adapter: InstagramAdapter;
  let parseSpy: jest.SpyInstance;

  beforeAll(async () => {
    h = await createHarness();
    adapter = h.module.get(InstagramAdapter);
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(() => {
    h.events.length = 0;
    // The webhook route goes through the batch parser — one Meta POST can
    // carry several messaging events, and `parseInbound` returns only the first.
    parseSpy = jest.spyOn(adapter, 'parseInboundAll');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** POST a signed Instagram webhook and return the supertest response. */
  function postSigned(payload: unknown, signature?: string) {
    const raw = JSON.stringify(payload);
    return request(h.app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature ?? signMetaBody(raw, APP_SECRET))
      .send(raw);
  }

  /** The NormalizedMessage the adapter produced for the most recent request. */
  async function lastParsed(): Promise<NormalizedMessage> {
    expect(parseSpy).toHaveBeenCalled();
    const batch = parseSpy.mock.results[parseSpy.mock.results.length - 1]!
      .value as NormalizedMessage[];
    expect(batch.length).toBeGreaterThan(0);
    return batch[batch.length - 1]!;
  }

  const receivedEvents = () => h.events.filter((e) => e.name === 'message.received');

  // ───────────────────────────── GET verification ─────────────────────────────

  describe('GET verification handshake', () => {
    it('echoes hub.challenge when the verify token matches', async () => {
      const res = await request(h.app.getHttpServer())
        .get(WEBHOOK_PATH)
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'challenge-12345',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('challenge-12345');
    });

    it('returns 403 when the verify token is wrong', async () => {
      const res = await request(h.app.getHttpServer())
        .get(WEBHOOK_PATH)
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong-token',
          'hub.challenge': 'challenge-12345',
        });

      expect(res.status).toBe(403);
    });

    it('returns 403 when the mode is not "subscribe"', async () => {
      const res = await request(h.app.getHttpServer())
        .get(WEBHOOK_PATH)
        .query({
          'hub.mode': 'unsubscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'challenge-12345',
        });

      expect(res.status).toBe(403);
    });
  });

  // ───────────────────────────── Inbound parsing ─────────────────────────────

  describe('inbound message parsing', () => {
    it('parses a text message and emits message.received', async () => {
      const res = await postSigned(igPayload(textEvent('Hello there')));
      expect(res.status).toBe(200);

      const msg = await lastParsed();
      expect(msg.channel).toBe(ChannelType.INSTAGRAM);
      expect(msg.sender.externalId).toBe(SENDER_IGSID);
      expect(msg.content.type).toBe(MessageContentType.TEXT);
      if (msg.content.type === MessageContentType.TEXT) {
        expect(msg.content.text).toBe('Hello there');
      }

      expect(receivedEvents()).toHaveLength(1);
      expect((receivedEvents()[0]!.payload as { channel: ChannelType }).channel).toBe(
        ChannelType.INSTAGRAM,
      );
    });

    it('parses an image attachment', async () => {
      const event = {
        sender: { id: SENDER_IGSID },
        recipient: { id: IG_BUSINESS_ID },
        timestamp: 1700000001000,
        message: {
          mid: 'mid.IG_IMG',
          attachments: [{ type: 'image', payload: { url: 'https://cdn.ig/photo.jpg' } }],
        },
      };
      const res = await postSigned(igPayload(event));
      expect(res.status).toBe(200);

      const msg = await lastParsed();
      expect(msg.content.type).toBe(MessageContentType.IMAGE);
      if (msg.content.type === MessageContentType.IMAGE) {
        expect(msg.content.url).toBe('https://cdn.ig/photo.jpg');
      }
    });

    it('parses a postback as interactive content', async () => {
      const event = {
        sender: { id: SENDER_IGSID },
        recipient: { id: IG_BUSINESS_ID },
        timestamp: 1700000002000,
        postback: { mid: 'mid.IG_PB', title: 'Get Started', payload: 'GET_STARTED' },
      };
      const res = await postSigned(igPayload(event));
      expect(res.status).toBe(200);

      const msg = await lastParsed();
      expect(msg.externalId).toBe('mid.IG_PB');
      expect(msg.content.type).toBe(MessageContentType.INTERACTIVE);
      if (msg.content.type === MessageContentType.INTERACTIVE) {
        expect(msg.content.interactiveType).toBe('postback');
        expect(msg.content.payload['id']).toBe('GET_STARTED');
      }
    });

    it('parses a reaction as text content', async () => {
      const event = {
        sender: { id: SENDER_IGSID },
        recipient: { id: IG_BUSINESS_ID },
        timestamp: 1700000003000,
        reaction: { mid: 'mid.IG_REACT', action: 'react', emoji: '❤️' },
      };
      const res = await postSigned(igPayload(event));
      expect(res.status).toBe(200);

      const msg = await lastParsed();
      expect(msg.content.type).toBe(MessageContentType.TEXT);
      if (msg.content.type === MessageContentType.TEXT) {
        expect(msg.content.text).toContain('❤️');
      }
    });

    it('parses a story_mention attachment as image content', async () => {
      const event = {
        sender: { id: SENDER_IGSID },
        recipient: { id: IG_BUSINESS_ID },
        timestamp: 1700000004000,
        message: {
          mid: 'mid.IG_STORY',
          attachments: [
            { type: 'story_mention', payload: { url: 'https://cdn.ig/story-frame.jpg' } },
          ],
          reply_to: { story: { id: 'story-99', url: 'https://cdn.ig/story-99' } },
        },
      };
      const res = await postSigned(igPayload(event));
      expect(res.status).toBe(200);

      const msg = await lastParsed();
      expect(msg.content.type).toBe(MessageContentType.IMAGE);
      if (msg.content.type === MessageContentType.IMAGE) {
        expect(msg.content.url).toBe('https://cdn.ig/story-frame.jpg');
      }
      expect(msg.metadata['storyReplyId']).toBe('story-99');
    });
  });

  // ───────────────────────────── Signature validation ─────────────────────────────

  describe('HMAC signature validation', () => {
    it('accepts a request with a valid signature (event is emitted)', async () => {
      const res = await postSigned(igPayload(textEvent()));
      expect(res.status).toBe(200);
      expect(receivedEvents()).toHaveLength(1);
    });

    it('rejects a tampered signature: 200 ack but no event emitted', async () => {
      const res = await postSigned(igPayload(textEvent()), 'sha256=deadbeefdeadbeef');
      // Webhook always acks 200 to avoid Meta retry storms…
      expect(res.status).toBe(200);
      // …but the invalid signature means nothing is processed/emitted.
      expect(receivedEvents()).toHaveLength(0);
    });

    it('rejects a request with no signature header', async () => {
      const raw = JSON.stringify(igPayload(textEvent()));
      const res = await request(h.app.getHttpServer())
        .post(WEBHOOK_PATH)
        .set('Content-Type', 'application/json')
        .send(raw);

      expect(res.status).toBe(200);
      expect(receivedEvents()).toHaveLength(0);
    });
  });

  // ───────────────────────────── Error handling ─────────────────────────────

  describe('error handling', () => {
    it('acks but emits nothing for a wrong object type', async () => {
      const res = await postSigned({ object: 'whatsapp_business_account', entry: [] });
      expect(res.status).toBe(200);
      expect(receivedEvents()).toHaveLength(0);
    });

    it('acks an echo-only payload without parsing (short-circuited by the controller)', async () => {
      const echo = {
        sender: { id: IG_BUSINESS_ID },
        recipient: { id: SENDER_IGSID },
        timestamp: 1700000005000,
        message: { mid: 'mid.ECHO', text: 'our reply', is_echo: true },
      };
      const res = await postSigned(igPayload(echo));
      expect(res.status).toBe(200);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(receivedEvents()).toHaveLength(0);
    });

    it('acks but emits nothing for an empty/malformed payload', async () => {
      const res = await postSigned({ object: 'instagram', entry: [{ id: IG_BUSINESS_ID, time: 1, messaging: [] }] });
      expect(res.status).toBe(200);
      expect(receivedEvents()).toHaveLength(0);
    });
  });

  // ───────────────────────────── Outbound sending ─────────────────────────────

  describe('outbound message sending', () => {
    let service: ChannelAdapterService;

    beforeAll(() => {
      service = h.module.get(ChannelAdapterService);
    });

    it('sends a text message and emits message.sent', async () => {
      const fetchSpy = mockFetchJsonOnce(200, {
        recipient_id: SENDER_IGSID,
        message_id: 'mid.SENT_TEXT',
      });

      const message: OutboundMessage = {
        channelAccountId: PAGE_ID,
        recipientExternalId: SENDER_IGSID,
        content: { type: MessageContentType.TEXT, text: 'Yes — in stock!' },
      };

      const result = await service.sendMessage(ChannelType.INSTAGRAM, message, 'biz-1');
      expect(result.success).toBe(true);
      expect(result.externalMessageId).toBe('mid.SENT_TEXT');

      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain(`/${PAGE_ID}/messages`);
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toEqual({ recipient: { id: SENDER_IGSID }, message: { text: 'Yes — in stock!' } });

      expect(h.events.some((e) => e.name === 'message.sent')).toBe(true);
    });

    it('sends an image message as an attachment', async () => {
      const fetchSpy = mockFetchJsonOnce(200, {
        recipient_id: SENDER_IGSID,
        message_id: 'mid.SENT_IMG',
      });

      const message: OutboundMessage = {
        channelAccountId: PAGE_ID,
        recipientExternalId: SENDER_IGSID,
        content: {
          type: MessageContentType.IMAGE,
          url: 'https://cdn.gosumo.app/item.jpg',
          mimeType: 'image/jpeg',
        },
      };

      const result = await service.sendMessage(ChannelType.INSTAGRAM, message, 'biz-1');
      expect(result.success).toBe(true);

      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.message.attachment).toEqual({
        type: 'image',
        payload: { url: 'https://cdn.gosumo.app/item.jpg', is_reusable: false },
      });
    });

    it('sends quick replies via sendInteractive', async () => {
      const fetchSpy = mockFetchJsonOnce(200, {
        recipient_id: SENDER_IGSID,
        message_id: 'mid.SENT_QR',
      });

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

      const result = await service.sendInteractive(ChannelType.INSTAGRAM, interactive, 'biz-1');
      expect(result.success).toBe(true);
      expect(result.externalMessageId).toBe('mid.SENT_QR');

      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.message.quick_replies).toEqual([
        { content_type: 'text', title: 'Small', payload: 'SIZE_S' },
        { content_type: 'text', title: 'Large', payload: 'SIZE_L' },
      ]);
    });

    it('returns a failure result on a 4xx from the Graph API', async () => {
      mockFetchJsonOnce(400, {
        error: { message: 'Outside 24h window', code: 10 },
      });

      const message: OutboundMessage = {
        channelAccountId: PAGE_ID,
        recipientExternalId: SENDER_IGSID,
        content: { type: MessageContentType.TEXT, text: 'late reply' },
      };

      const result = await service.sendMessage(ChannelType.INSTAGRAM, message, 'biz-1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('24h window');
      expect(h.events.some((e) => e.name === 'message.failed')).toBe(true);
    });
  });
});
