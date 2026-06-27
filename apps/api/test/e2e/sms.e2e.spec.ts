/**
 * SMS channel — end-to-end tests.
 *
 * SMS arrives (Twilio) via the generic /webhooks/:channel route (channel = SMS)
 * as an application/x-www-form-urlencoded body, and is sent via the Twilio
 * Messages API.
 *
 * Twilio signature validation reconstructs the public webhook URL from proxy
 * headers, which supertest's loopback server cannot reproduce; the inbound
 * harness is therefore configured without an auth token (validateWebhook then
 * skips verification, mirroring local/dev). A separate outbound harness keeps
 * credentials configured so the Twilio API call is exercised.
 *
 * Coverage:
 *  - POST inbound parsing: SMS text body and MMS media
 *  - Outbound: success via Twilio, 4xx failure surfaced as message.failed
 */
import request from 'supertest';
import {
  ChannelType,
  MessageContentType,
  OutboundMessage,
  NormalizedMessage,
} from '@gosumo/shared';

import { SmsAdapter } from '../../src/modules/channel-adapter/adapters/sms.adapter';
import { ChannelAdapterService } from '../../src/modules/channel-adapter/channel-adapter.service';
import { createHarness, E2EHarness, mockFetchJsonOnce } from './utils/e2e-harness';

const WEBHOOK_PATH = '/webhooks/sms';
const FROM = '+919812345678';
const TO = '+15550001111';

describe('SMS channel (e2e)', () => {
  // Inbound harness: no auth token → signature verification is skipped.
  let inbound: E2EHarness;
  // Outbound harness: credentials configured → Twilio API call is exercised.
  let outbound: E2EHarness;
  let adapter: SmsAdapter;
  let service: ChannelAdapterService;
  let parseSpy: jest.SpyInstance;

  beforeAll(async () => {
    inbound = await createHarness({ config: { 'twilio.authToken': '' } });
    outbound = await createHarness();
    adapter = inbound.module.get(SmsAdapter);
    service = outbound.module.get(ChannelAdapterService);
  });

  afterAll(async () => {
    await inbound.close();
    await outbound.close();
  });

  beforeEach(() => {
    inbound.events.length = 0;
    outbound.events.length = 0;
    parseSpy = jest.spyOn(adapter, 'parseInbound');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function lastParsed(): Promise<NormalizedMessage> {
    expect(parseSpy).toHaveBeenCalled();
    return parseSpy.mock.results[parseSpy.mock.results.length - 1]!.value as NormalizedMessage;
  }

  // ───────────────────────────── Inbound parsing ─────────────────────────────

  describe('inbound parsing', () => {
    it('parses an inbound SMS text body', async () => {
      const res = await request(inbound.app.getHttpServer())
        .post(WEBHOOK_PATH)
        .type('form')
        .send({ From: FROM, To: TO, Body: 'Is the salon open on Sunday?', MessageSid: 'SM123', NumMedia: '0' });

      expect(res.status).toBe(200);

      const msg = await lastParsed();
      expect(msg.channel).toBe(ChannelType.SMS);
      expect(msg.sender.externalId).toBe(FROM);
      expect(msg.externalId).toBe('SM123');
      expect(msg.content.type).toBe(MessageContentType.TEXT);
      if (msg.content.type === MessageContentType.TEXT) {
        expect(msg.content.text).toBe('Is the salon open on Sunday?');
      }
      expect(inbound.events.filter((e) => e.name === 'message.received')).toHaveLength(1);
    });

    it('parses an inbound MMS as image content', async () => {
      const res = await request(inbound.app.getHttpServer())
        .post(WEBHOOK_PATH)
        .type('form')
        .send({
          From: FROM,
          To: TO,
          Body: 'see attached',
          MessageSid: 'SM124',
          NumMedia: '1',
          MediaUrl0: 'https://api.twilio.com/media/img.jpg',
          MediaContentType0: 'image/jpeg',
        });

      expect(res.status).toBe(200);

      const msg = await lastParsed();
      expect(msg.content.type).toBe(MessageContentType.IMAGE);
      if (msg.content.type === MessageContentType.IMAGE) {
        expect(msg.content.url).toBe('https://api.twilio.com/media/img.jpg');
        expect(msg.content.caption).toBe('see attached');
      }
    });
  });

  // ───────────────────────────── Outbound sending ─────────────────────────────

  describe('outbound sending', () => {
    it('sends an SMS via Twilio and emits message.sent', async () => {
      const fetchSpy = mockFetchJsonOnce(201, { sid: 'SMsent123', status: 'queued' });

      const message: OutboundMessage = {
        channelAccountId: TO,
        recipientExternalId: FROM,
        content: { type: MessageContentType.TEXT, text: 'Yes, open 10am–6pm Sunday.' },
      };

      const result = await service.sendMessage(ChannelType.SMS, message, 'biz-1');
      expect(result.success).toBe(true);
      expect(result.externalMessageId).toBe('SMsent123');

      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain('api.twilio.com');
      expect((init as RequestInit).method).toBe('POST');
      expect(outbound.events.some((e) => e.name === 'message.sent')).toBe(true);
    });

    it('surfaces a Twilio 4xx as message.failed', async () => {
      mockFetchJsonOnce(400, { message: 'The To number is not a valid phone number' });

      const message: OutboundMessage = {
        channelAccountId: TO,
        recipientExternalId: 'not-a-number',
        content: { type: MessageContentType.TEXT, text: 'hi' },
      };

      const result = await service.sendMessage(ChannelType.SMS, message, 'biz-1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a valid phone number');
      expect(outbound.events.some((e) => e.name === 'message.failed')).toBe(true);
    });
  });
});
