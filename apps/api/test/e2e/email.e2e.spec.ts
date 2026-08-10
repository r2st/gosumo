/**
 * Email channel — end-to-end tests.
 *
 * Email arrives via the generic /webhooks/:channel route (channel = EMAIL) and
 * is sent via the SendGrid v3 API. Email relays define no signature scheme of
 * their own, so the inbound route is authenticated by a shared-secret HMAC
 * (EMAIL_INBOUND_WEBHOOK_SECRET) that is unset here and therefore skipped
 * outside production — the fail-closed half is covered in
 * `src/common/utils/webhook-verification.spec.ts`. These tests focus on inbound
 * parsing and outbound delivery.
 *
 * Coverage:
 *  - POST inbound parsing: subject + body combined into a normalized text message
 *  - Outbound: success via SendGrid, 4xx failure surfaced as message.failed
 */
import request from 'supertest';
import {
  ChannelType,
  MessageContentType,
  OutboundMessage,
  NormalizedMessage,
} from '@gosumo/shared';

import { EmailAdapter } from '../../src/modules/channel-adapter/adapters/email.adapter';
import { ChannelAdapterService } from '../../src/modules/channel-adapter/channel-adapter.service';
import { createHarness, E2EHarness } from './utils/e2e-harness';

const WEBHOOK_PATH = '/webhooks/email';

describe('Email channel (e2e)', () => {
  let h: E2EHarness;
  let adapter: EmailAdapter;
  let service: ChannelAdapterService;
  let parseSpy: jest.SpyInstance;

  beforeAll(async () => {
    h = await createHarness();
    adapter = h.module.get(EmailAdapter);
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

  async function lastParsed(): Promise<NormalizedMessage> {
    expect(parseSpy).toHaveBeenCalled();
    return parseSpy.mock.results[parseSpy.mock.results.length - 1]!.value as NormalizedMessage;
  }

  // ───────────────────────────── Inbound parsing ─────────────────────────────

  describe('inbound parsing', () => {
    it('parses an inbound email into a normalized text message', async () => {
      const res = await request(h.app.getHttpServer())
        .post(WEBHOOK_PATH)
        .send({
          from: 'customer@example.com',
          to: 'support@gosumo.app',
          subject: 'Order Inquiry',
          body: 'Where is my order?',
          messageId: 'email-msg-1',
        });

      expect(res.status).toBe(200);

      const msg = await lastParsed();
      expect(msg.channel).toBe(ChannelType.EMAIL);
      expect(msg.sender.externalId).toBe('customer@example.com');
      expect(msg.externalId).toBe('email-msg-1');
      expect(msg.content.type).toBe(MessageContentType.TEXT);
      if (msg.content.type === MessageContentType.TEXT) {
        expect(msg.content.text).toContain('Order Inquiry');
        expect(msg.content.text).toContain('Where is my order?');
      }

      expect(h.events.filter((e) => e.name === 'message.received')).toHaveLength(1);
    });
  });

  // ───────────────────────────── Outbound sending ─────────────────────────────

  describe('outbound sending', () => {
    it('sends an email via SendGrid and emits message.sent', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 202,
        headers: { get: (name: string) => (name === 'x-message-id' ? 'sg-id-1' : null) },
        text: async () => '',
      } as unknown as Response);

      const message: OutboundMessage = {
        channelAccountId: 'support@gosumo.app',
        recipientExternalId: 'customer@example.com',
        content: { type: MessageContentType.TEXT, text: 'Your order ships today.' },
      };

      const result = await service.sendMessage(ChannelType.EMAIL, message, 'biz-1');
      expect(result.success).toBe(true);
      expect(result.externalMessageId).toBe('sg-id-1');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.sendgrid.com/v3/mail/send',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(h.events.some((e) => e.name === 'message.sent')).toBe(true);
    });

    it('surfaces a 4xx from SendGrid as message.failed', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => 'Unauthorized',
      } as unknown as Response);

      const message: OutboundMessage = {
        channelAccountId: 'support@gosumo.app',
        recipientExternalId: 'customer@example.com',
        content: { type: MessageContentType.TEXT, text: 'hello' },
      };

      const result = await service.sendMessage(ChannelType.EMAIL, message, 'biz-1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('401');
      expect(h.events.some((e) => e.name === 'message.failed')).toBe(true);
    });
  });
});
