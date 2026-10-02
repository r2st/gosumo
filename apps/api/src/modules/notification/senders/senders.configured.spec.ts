import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { EmailSender } from './email.sender';
import { SmsSender } from './sms.sender';
import { WhatsAppSender } from './whatsapp.sender';
import { PushSender } from './push.sender';
import { OutboundNotification } from './channel-sender.interface';
import { maskEmail, maskPhone } from '../../../common/utils/log-redact.util';

/**
 * `senders.spec.ts` exercises the credential-free no-op mode every sender falls
 * back to in dev/test. This file covers the other branch — the one that runs in
 * production, once provider credentials are present — plus the validation edges
 * that decide whether a failure is retryable.
 *
 * The `catch` arms are not reachable yet: each `try` body is a placeholder that
 * cannot throw until a real provider call is wired in. They are deliberately
 * left uncovered rather than covered by stubbing something that does not exist.
 */
const configWith = (values: Record<string, string>): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

function outbound(
  overrides: Partial<OutboundNotification> = {},
): OutboundNotification {
  return {
    notificationId: 'n1',
    businessId: 'b1',
    recipient: 'test@example.com',
    subject: 'Hi',
    text: 'Hello there',
    html: null,
    externalTemplateName: null,
    data: {},
    ...overrides,
  };
}

describe('Channel senders with a provider configured', () => {
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('EmailSender', () => {
    const sender = (): EmailSender =>
      new EmailSender(configWith({ 'notification.email.apiKey': 'key_live' }));

    it('sends through the provider and returns a non-no-op message id', async () => {
      const result = await sender().send(outbound({ recipient: 'a@b.com' }));
      expect(result.success).toBe(true);
      expect(result.providerMessageId).toMatch(/^email_/);
      expect(result.providerMessageId).not.toContain('noop');
    });

    it('logs the delivery at info level with the email masked', async () => {
      await sender().send(outbound({ recipient: 'a@b.com' }));
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`EMAIL sent to ${maskEmail('a@b.com')}`),
      );
    });

    it('issues a distinct message id per send', async () => {
      const s = sender();
      const first = await s.send(outbound({ recipient: 'a@b.com' }));
      const second = await s.send(outbound({ recipient: 'a@b.com' }));
      expect(first.providerMessageId).not.toBe(second.providerMessageId);
    });

    it('still rejects a bad address before reaching the provider', async () => {
      const result = await sender().send(outbound({ recipient: 'a@b' }));
      expect(result).toEqual({
        success: false,
        error: 'Invalid email address: a@b',
        retryable: false,
      });
      expect(log).not.toHaveBeenCalled();
    });

    it('rejects an address with whitespace', () => {
      expect(sender().validateRecipient('a b@c.com')).toMatch(/Invalid email/);
    });
  });

  describe('SmsSender', () => {
    const sender = (): SmsSender =>
      new SmsSender(configWith({ 'notification.sms.apiKey': 'msg91_key' }));

    it('sends through the gateway and returns a non-no-op message id', async () => {
      const result = await sender().send(outbound({ recipient: '+919876543210' }));
      expect(result.success).toBe(true);
      expect(result.providerMessageId).toMatch(/^sms_/);
      expect(result.providerMessageId).not.toContain('noop');
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`SMS sent to ${maskPhone('+919876543210')}`),
      );
    });

    it('rejects a non-E.164 number as permanently failed, before billing anything', async () => {
      const result = await sender().send(outbound({ recipient: '9876543210' }));
      expect(result).toEqual({
        success: false,
        error: 'Invalid phone number (expected E.164): 9876543210',
        retryable: false,
      });
    });

    it('rejects a number with a leading zero after the plus', () => {
      expect(sender().validateRecipient('+0919876543210')).toMatch(/E.164/);
    });

    it('accepts a body that fills exactly the six-segment cap', async () => {
      const result = await sender().send(
        outbound({ recipient: '+919876543210', text: 'x'.repeat(960) }),
      );
      expect(result.success).toBe(true);
    });

    it('rejects one character past the cap, and says how many segments it saw', async () => {
      const result = await sender().send(
        outbound({ recipient: '+919876543210', text: 'x'.repeat(961) }),
      );
      expect(result).toEqual({
        success: false,
        error: 'SMS too long: 7 segments (max 6)',
        retryable: false,
      });
    });

    it('rejects a whitespace-only body even with credentials present', async () => {
      const result = await sender().send(
        outbound({ recipient: '+919876543210', text: '\n\t ' }),
      );
      expect(result).toEqual({
        success: false,
        error: 'SMS body is empty',
        retryable: false,
      });
    });
  });

  describe('WhatsAppSender', () => {
    const sender = (): WhatsAppSender =>
      new WhatsAppSender(
        configWith({
          'whatsapp.accessToken': 'EAAG...',
          'whatsapp.phoneNumberId': '1234567890',
        }),
      );

    it('returns a wamid-shaped id when both credentials are present', async () => {
      const result = await sender().send(outbound({ recipient: '+919876543210' }));
      expect(result.success).toBe(true);
      expect(result.providerMessageId).toMatch(/^wamid\./);
    });

    it('names the approved template in the delivery log', async () => {
      await sender().send(
        outbound({
          recipient: '+919876543210',
          externalTemplateName: 'order_confirmed_v2',
        }),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('order_confirmed_v2'),
      );
    });

    it('falls back to free-form text when no template is named', async () => {
      await sender().send(outbound({ recipient: '+919876543210' }));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('text'));
    });

    it('stays in no-op mode when only the token is configured', async () => {
      const partial = new WhatsAppSender(
        configWith({ 'whatsapp.accessToken': 'EAAG...' }),
      );
      const result = await partial.send(outbound({ recipient: '+919876543210' }));
      expect(result.providerMessageId).toContain('wa_noop_');
    });

    it('stays in no-op mode when only the phone number id is configured', async () => {
      const partial = new WhatsAppSender(
        configWith({ 'whatsapp.phoneNumberId': '1234567890' }),
      );
      const result = await partial.send(outbound({ recipient: '+919876543210' }));
      expect(result.providerMessageId).toContain('wa_noop_');
    });
  });

  describe('PushSender', () => {
    const sender = (): PushSender =>
      new PushSender(configWith({ 'notification.push.serverKey': 'AAAA...' }));

    it('sends to FCM and returns a non-no-op message id', async () => {
      const result = await sender().send(
        outbound({ recipient: 'd'.repeat(64) }),
      );
      expect(result.success).toBe(true);
      expect(result.providerMessageId).toMatch(/^push_/);
      expect(result.providerMessageId).not.toContain('noop');
    });

    it('logs only the last 4 chars of the device token', async () => {
      const token = 'abcdefgh' + 'z'.repeat(56);
      await sender().send(outbound({ recipient: token }));
      const logged = log.mock.calls[0][0] as string;
      expect(logged).toContain('token…zzzz');
      expect(logged).not.toContain(token);
    });

    it('accepts a token at exactly the minimum length', () => {
      expect(sender().validateRecipient('a'.repeat(10))).toBeNull();
    });

    it('rejects a token one character short, permanently', async () => {
      const result = await sender().send(outbound({ recipient: 'a'.repeat(9) }));
      expect(result).toEqual({
        success: false,
        error: `Invalid device token: "${'a'.repeat(9)}"`,
        retryable: false,
      });
    });
  });
});
