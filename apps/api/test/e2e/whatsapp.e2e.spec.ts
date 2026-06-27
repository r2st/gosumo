/**
 * WhatsApp channel — end-to-end tests.
 *
 * Exercises the dedicated /webhooks/whatsapp routes and the WhatsApp Cloud API
 * adapter through the full controller → service → adapter pipeline.
 *
 * Coverage:
 *  - GET verification handshake (hub.verify_token + hub.challenge)
 *  - POST inbound parsing: text, image, interactive button reply
 *  - Status-only payloads are acknowledged without processing
 *  - HMAC-SHA256 signature validation: valid accepted, invalid rejected
 *  - Outbound: text message, approved template
 */
import request from 'supertest';
import {
  ChannelType,
  MessageContentType,
  OutboundMessage,
  TemplateMessage,
  NormalizedMessage,
} from '@gosumo/shared';

import { WhatsAppAdapter } from '../../src/modules/channel-adapter/adapters/whatsapp.adapter';
import { ChannelAdapterService } from '../../src/modules/channel-adapter/channel-adapter.service';
import {
  createHarness,
  E2EHarness,
  TEST_CONFIG,
  signMetaBody,
  mockFetchJsonOnce,
} from './utils/e2e-harness';

const APP_SECRET = TEST_CONFIG['whatsapp.appSecret'];
const PHONE_NUMBER_ID = TEST_CONFIG['whatsapp.phoneNumberId'];
const VERIFY_TOKEN = TEST_CONFIG['whatsapp.verifyToken'];
const WA_ID = '919999900001';

const WEBHOOK_PATH = '/webhooks/whatsapp';

function waPayload(message: Record<string, unknown>): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID_001',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+91 99999 00001', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: 'Priya Sharma' }, wa_id: WA_ID }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

describe('WhatsApp channel (e2e)', () => {
  let h: E2EHarness;
  let adapter: WhatsAppAdapter;
  let service: ChannelAdapterService;
  let parseSpy: jest.SpyInstance;

  beforeAll(async () => {
    h = await createHarness();
    adapter = h.module.get(WhatsAppAdapter);
    service = h.module.get(ChannelAdapterService);
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(() => {
    h.events.length = 0;
    parseSpy = jest.spyOn(adapter, 'parseInbound');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function postSigned(payload: unknown, signature?: string) {
    const raw = JSON.stringify(payload);
    return request(h.app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature ?? signMetaBody(raw, APP_SECRET))
      .send(raw);
  }

  async function lastParsed(): Promise<NormalizedMessage> {
    expect(parseSpy).toHaveBeenCalled();
    return parseSpy.mock.results[parseSpy.mock.results.length - 1]!.value as NormalizedMessage;
  }

  const receivedEvents = () => h.events.filter((e) => e.name === 'message.received');

  // ───────────────────────────── GET verification ─────────────────────────────

  describe('GET verification handshake', () => {
    it('echoes hub.challenge when the verify token matches', async () => {
      const res = await request(h.app.getHttpServer())
        .get(WEBHOOK_PATH)
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'wa-challenge-1' });

      expect(res.status).toBe(200);
      expect(res.text).toBe('wa-challenge-1');
    });

    it('returns 403 on a verify-token mismatch', async () => {
      const res = await request(h.app.getHttpServer())
        .get(WEBHOOK_PATH)
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': 'wa-challenge-1' });

      expect(res.status).toBe(403);
    });
  });

  // ───────────────────────────── Inbound parsing ─────────────────────────────

  describe('inbound message parsing', () => {
    it('parses a text message and emits message.received', async () => {
      const message = {
        from: WA_ID,
        id: 'wamid.TEXT_1',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'Do you deliver to Pune?' },
      };
      const res = await postSigned(waPayload(message));
      expect(res.status).toBe(200);

      const msg = await lastParsed();
      expect(msg.channel).toBe(ChannelType.WHATSAPP);
      expect(msg.sender.externalId).toBe(WA_ID);
      expect(msg.sender.displayName).toBe('Priya Sharma');
      expect(msg.content.type).toBe(MessageContentType.TEXT);
      if (msg.content.type === MessageContentType.TEXT) {
        expect(msg.content.text).toBe('Do you deliver to Pune?');
      }
      expect(receivedEvents()).toHaveLength(1);
    });

    it('parses an image message', async () => {
      const message = {
        from: WA_ID,
        id: 'wamid.IMG_1',
        timestamp: '1700000001',
        type: 'image',
        image: { id: 'media-abc', mime_type: 'image/jpeg', caption: 'this one' },
      };
      const res = await postSigned(waPayload(message));
      expect(res.status).toBe(200);

      const msg = await lastParsed();
      expect(msg.content.type).toBe(MessageContentType.IMAGE);
      if (msg.content.type === MessageContentType.IMAGE) {
        expect(msg.content.url).toBe('whatsapp-media://media-abc');
        expect(msg.content.caption).toBe('this one');
      }
    });

    it('parses an interactive button reply', async () => {
      const message = {
        from: WA_ID,
        id: 'wamid.BTN_1',
        timestamp: '1700000002',
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'CONFIRM', title: 'Confirm order' } },
      };
      const res = await postSigned(waPayload(message));
      expect(res.status).toBe(200);

      const msg = await lastParsed();
      expect(msg.content.type).toBe(MessageContentType.INTERACTIVE);
      if (msg.content.type === MessageContentType.INTERACTIVE) {
        expect(msg.content.interactiveType).toBe('button_reply');
        expect(msg.content.payload['id']).toBe('CONFIRM');
      }
    });

    it('acknowledges a status-only payload without parsing', async () => {
      const statusPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_ID_001',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '+91 99999 00001', phone_number_id: PHONE_NUMBER_ID },
                  statuses: [
                    { id: 'wamid.X', status: 'delivered', timestamp: '1700000003', recipient_id: WA_ID },
                  ],
                },
              },
            ],
          },
        ],
      };
      const res = await postSigned(statusPayload);
      expect(res.status).toBe(200);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(receivedEvents()).toHaveLength(0);
    });
  });

  // ───────────────────────────── Signature validation ─────────────────────────────

  describe('HMAC signature validation', () => {
    it('accepts a request with a valid signature', async () => {
      const res = await postSigned(
        waPayload({ from: WA_ID, id: 'wamid.OK', timestamp: '1700000004', type: 'text', text: { body: 'hi' } }),
      );
      expect(res.status).toBe(200);
      expect(receivedEvents()).toHaveLength(1);
    });

    it('rejects a tampered signature: 200 ack but no event', async () => {
      const res = await postSigned(
        waPayload({ from: WA_ID, id: 'wamid.BAD', timestamp: '1700000005', type: 'text', text: { body: 'hi' } }),
        'sha256=00000000',
      );
      expect(res.status).toBe(200);
      expect(receivedEvents()).toHaveLength(0);
    });
  });

  // ───────────────────────────── Outbound sending ─────────────────────────────

  describe('outbound message sending', () => {
    it('sends a text message and emits message.sent', async () => {
      const fetchSpy = mockFetchJsonOnce(200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: WA_ID, wa_id: WA_ID }],
        messages: [{ id: 'wamid.SENT_1' }],
      });

      const message: OutboundMessage = {
        channelAccountId: PHONE_NUMBER_ID,
        recipientExternalId: WA_ID,
        content: { type: MessageContentType.TEXT, text: 'Yes, we deliver to Pune.' },
      };

      const result = await service.sendMessage(ChannelType.WHATSAPP, message, 'biz-1');
      expect(result.success).toBe(true);
      expect(result.externalMessageId).toBe('wamid.SENT_1');

      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.type).toBe('text');
      expect(body.text.body).toBe('Yes, we deliver to Pune.');
      expect(h.events.some((e) => e.name === 'message.sent')).toBe(true);
    });

    it('sends an approved template message', async () => {
      const fetchSpy = mockFetchJsonOnce(200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: WA_ID, wa_id: WA_ID }],
        messages: [{ id: 'wamid.TPL_1' }],
      });

      const template: TemplateMessage = {
        channelAccountId: PHONE_NUMBER_ID,
        recipientExternalId: WA_ID,
        templateName: 'order_shipped',
        language: 'en',
        parameters: { '1': 'ORD-42' },
      };

      const result = await service.sendTemplate(ChannelType.WHATSAPP, template, 'biz-1');
      expect(result.success).toBe(true);
      expect(result.externalMessageId).toBe('wamid.TPL_1');

      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.type).toBe('template');
      expect(body.template.name).toBe('order_shipped');
    });
  });
});
