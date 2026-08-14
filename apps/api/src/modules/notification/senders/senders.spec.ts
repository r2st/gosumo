import { ConfigService } from '@nestjs/config';
import { NotificationTemplateChannel } from '@prisma/client';
import { EmailSender } from './email.sender';
import { SmsSender } from './sms.sender';
import { WhatsAppSender } from './whatsapp.sender';
import { PushSender } from './push.sender';
import { SenderRegistry } from './sender-registry';
import { OutboundNotification } from './channel-sender.interface';

/** ConfigService that returns undefined (no provider credentials → no-op mode). */
const emptyConfig = { get: () => undefined } as unknown as ConfigService;

function outbound(overrides: Partial<OutboundNotification> = {}): OutboundNotification {
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

describe('Channel senders', () => {
  describe('EmailSender', () => {
    const sender = new EmailSender(emptyConfig);

    it('validates email addresses', () => {
      expect(sender.validateRecipient('a@b.com')).toBeNull();
      expect(sender.validateRecipient('not-an-email')).toMatch(/Invalid email/);
    });

    it('sends (no-op) for a valid address and returns a provider id', async () => {
      const r = await sender.send(outbound({ recipient: 'a@b.com' }));
      expect(r.success).toBe(true);
      expect(r.providerMessageId).toContain('email');
    });

    it('fails permanently (non-retryable) for an invalid address', async () => {
      const r = await sender.send(outbound({ recipient: 'bad' }));
      expect(r.success).toBe(false);
      expect(r.retryable).toBe(false);
    });
  });

  describe('SmsSender', () => {
    const sender = new SmsSender(emptyConfig);

    it('requires E.164 numbers', () => {
      expect(sender.validateRecipient('+919876543210')).toBeNull();
      expect(sender.validateRecipient('9876543210')).toMatch(/E.164/);
    });

    it('rejects an empty body', async () => {
      const r = await sender.send(outbound({ recipient: '+919876543210', text: '   ' }));
      expect(r.success).toBe(false);
      expect(r.retryable).toBe(false);
    });

    it('rejects an over-long message', async () => {
      const r = await sender.send(
        outbound({ recipient: '+919876543210', text: 'x'.repeat(1000) }),
      );
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/too long/);
    });

    it('sends a valid SMS', async () => {
      const r = await sender.send(outbound({ recipient: '+919876543210', text: 'Hi' }));
      expect(r.success).toBe(true);
    });
  });

  describe('WhatsAppSender', () => {
    const sender = new WhatsAppSender(emptyConfig);

    it('requires E.164 numbers', () => {
      expect(sender.validateRecipient('+919876543210')).toBeNull();
      expect(sender.validateRecipient('abc')).toMatch(/E.164/);
    });

    it('sends a template message', async () => {
      const r = await sender.send(
        outbound({ recipient: '+919876543210', externalTemplateName: 'order_shipped' }),
      );
      expect(r.success).toBe(true);
      expect(r.providerMessageId).toContain('wa');
    });

    /**
     * A bad number is the sender's own fault, not the provider's, so it must
     * come back non-retryable — a retryable failure would have the queue redial
     * the same invalid number until it exhausts its attempts.
     */
    it('rejects a non-E.164 recipient without retrying', async () => {
      const r = await sender.send(outbound({ recipient: '9876543210' }));

      expect(r).toMatchObject({ success: false, retryable: false });
      expect(r.error).toMatch(/E\.164/);
    });

    it('sends a free-form message when no template is named', async () => {
      const r = await sender.send(
        outbound({ recipient: '+919876543210', externalTemplateName: null }),
      );
      expect(r.success).toBe(true);
      expect(r.providerMessageId).toContain('wa');
    });

    /**
     * With no credentials the sender must no-op *successfully*: a dev or test
     * environment should not fill the queue with retrying failures. Each half
     * of the credential check has to trip it on its own.
     */
    describe('credential gate', () => {
      const configWith = (values: Record<string, string>) =>
        ({ get: (k: string) => values[k] }) as unknown as ConfigService;

      it('no-ops when neither credential is set', async () => {
        const r = await sender.send(outbound({ recipient: '+919876543210' }));
        expect(r).toMatchObject({ success: true });
        expect(r.providerMessageId).toContain('wa_noop_');
      });

      it('no-ops when only the phone number id is set', async () => {
        const s = new WhatsAppSender(configWith({ 'whatsapp.phoneNumberId': '123' }));
        const r = await s.send(outbound({ recipient: '+919876543210' }));
        expect(r.providerMessageId).toContain('wa_noop_');
      });

      it('no-ops when only the access token is set', async () => {
        const s = new WhatsAppSender(configWith({ 'whatsapp.accessToken': 'tok' }));
        const r = await s.send(outbound({ recipient: '+919876543210' }));
        expect(r.providerMessageId).toContain('wa_noop_');
      });

      it('leaves no-op mode once both credentials are present', async () => {
        const s = new WhatsAppSender(
          configWith({ 'whatsapp.accessToken': 'tok', 'whatsapp.phoneNumberId': '123' }),
        );
        const r = await s.send(outbound({ recipient: '+919876543210' }));
        expect(r.success).toBe(true);
        expect(r.providerMessageId).toMatch(/^wamid\./);
      });
    });
  });

  describe('PushSender', () => {
    const sender = new PushSender(emptyConfig);

    it('requires a plausible device token', () => {
      expect(sender.validateRecipient('a'.repeat(20))).toBeNull();
      expect(sender.validateRecipient('short')).toMatch(/Invalid device token/);
    });

    it('sends to a valid token', async () => {
      const r = await sender.send(outbound({ recipient: 'd'.repeat(40), subject: 'Ping' }));
      expect(r.success).toBe(true);
    });

    it('fails permanently (non-retryable) for a too-short device token', async () => {
      const r = await sender.send(outbound({ recipient: 'short' }));
      expect(r).toEqual({
        success: false,
        error: expect.stringMatching(/Invalid device token/),
        retryable: false,
      });
    });

    it('no-ops without an FCM server key, logging a blank title for a subjectless push', async () => {
      const debug = jest
        .spyOn((sender as unknown as { logger: { debug: (m: string) => void } }).logger, 'debug')
        .mockImplementation(() => undefined);

      const r = await sender.send(outbound({ recipient: 'd'.repeat(40), subject: null }));

      expect(r.success).toBe(true);
      expect(r.providerMessageId).toContain('push_noop_');
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('""'));
      debug.mockRestore();
    });

    it('reports a retryable failure when the provider call throws', async () => {
      const configured = new PushSender({
        get: () => 'fcm-server-key',
      } as unknown as ConfigService);
      jest
        .spyOn((configured as unknown as { logger: { log: () => void } }).logger, 'log')
        .mockImplementation(() => {
          throw new Error('FCM unreachable');
        });

      const r = await configured.send(outbound({ recipient: 'd'.repeat(40) }));

      expect(r).toEqual({ success: false, error: 'FCM unreachable', retryable: true });
    });

    it('stringifies a non-Error thrown by the provider call', async () => {
      const configured = new PushSender({
        get: () => 'fcm-server-key',
      } as unknown as ConfigService);
      jest
        .spyOn((configured as unknown as { logger: { log: () => void } }).logger, 'log')
        .mockImplementation(() => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'socket hang up';
        });
      const errorSpy = jest
        .spyOn((configured as unknown as { logger: { error: () => void } }).logger, 'error')
        .mockImplementation(() => undefined);

      const r = await configured.send(outbound({ recipient: 'd'.repeat(40) }));

      expect(r).toEqual({ success: false, error: 'socket hang up', retryable: true });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
    });
  });

  describe('SenderRegistry', () => {
    const registry = new SenderRegistry(
      new EmailSender(emptyConfig),
      new SmsSender(emptyConfig),
      new WhatsAppSender(emptyConfig),
      new PushSender(emptyConfig),
    );

    it('resolves a sender for every channel', () => {
      for (const ch of Object.values(NotificationTemplateChannel)) {
        expect(registry.get(ch).channel).toBe(ch);
        expect(registry.has(ch)).toBe(true);
      }
    });

    it('throws for an unregistered channel', () => {
      expect(() => registry.get('TELEGRAM' as never)).toThrow(/No sender registered/);
    });
  });
});
