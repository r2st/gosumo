import { ConfigService } from '@nestjs/config';
import { MessageContentType, RawRequest, OutboundMessage } from '@gosumo/shared';
import { EmailAdapter } from './email.adapter';

/**
 * Branch-focused companion to `email.adapter.spec.ts`.
 *
 * The happy paths live there; this file pins the fallbacks — every `||`
 * default in `parseInbound`, the non-TEXT content branch, and the 4xx/5xx
 * split in `sendMessage` (including a SendGrid response that carries no
 * `x-message-id`).
 */

function makeAdapter(): EmailAdapter {
  const configService = {
    get: jest.fn((key: string, fallback: string) => {
      if (key === 'sendgrid.fromEmail') return 'no-reply@gosumo.test';
      if (key === 'sendgrid.fromName') return 'GoSumo';
      if (key === 'sendgrid.apiKey') return 'SG.test-key';
      return fallback;
    }),
  } as unknown as ConfigService;
  return new EmailAdapter(configService);
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channelAccountId: 'acct-1',
    recipientExternalId: 'buyer@example.com',
    content: { type: MessageContentType.TEXT, text: 'Hello there' },
    ...overrides,
  } as OutboundMessage;
}

describe('EmailAdapter — branch coverage', () => {
  let adapter: EmailAdapter;
  const originalFetch = global.fetch;

  beforeEach(() => {
    adapter = makeAdapter();
    jest.spyOn(adapter['logger'], 'log').mockImplementation();
    jest.spyOn(adapter['logger'], 'warn').mockImplementation();
    jest.spyOn(adapter['logger'], 'error').mockImplementation();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────
  // parseInbound fallbacks
  // ─────────────────────────────────────────────

  describe('parseInbound', () => {
    it('defaults every absent field rather than emitting undefined', () => {
      const req: RawRequest = { headers: {}, body: {} };

      const msg = adapter.parseInbound(req);

      expect(msg.sender.externalId).toBe('');
      expect(msg.sender.displayName).toBe('');
      expect(msg.channelAccountId).toBe('');
      expect(msg.content).toEqual({ type: MessageContentType.TEXT, text: '' });
      expect(msg.metadata).toEqual(
        expect.objectContaining({ from: '', to: '', subject: '', hasAttachments: false }),
      );
      // A relay that omits messageId still gets a stable external id.
      expect(msg.externalId).toEqual(expect.any(String));
      expect(msg.externalId).not.toBe('');
    });

    it('falls back to the HTML part when the plain-text body is missing', () => {
      const req: RawRequest = {
        headers: {},
        body: { from: 'a@b.com', html: '<p>See attached</p>' },
      };

      const msg = adapter.parseInbound(req);

      // No subject ⇒ no "Subject:" prefix.
      expect(msg.content).toEqual({
        type: MessageContentType.TEXT,
        text: '<p>See attached</p>',
      });
    });

    it('flags attachments only when the array is non-empty', () => {
      const withAttachments = adapter.parseInbound({
        headers: {},
        body: {
          from: 'a@b.com',
          body: 'plans attached',
          attachments: [
            { filename: 'floor-plan.pdf', url: 'https://cdn/x.pdf', mimeType: 'application/pdf' },
          ],
        },
      } as RawRequest);
      const emptyAttachments = adapter.parseInbound({
        headers: {},
        body: { from: 'a@b.com', body: 'nothing attached', attachments: [] },
      } as RawRequest);

      expect(withAttachments.metadata?.hasAttachments).toBe(true);
      expect(emptyAttachments.metadata?.hasAttachments).toBe(false);
    });
  });

  // ─────────────────────────────────────────────
  // sendMessage
  // ─────────────────────────────────────────────

  describe('sendMessage', () => {
    it('renders a placeholder for a non-TEXT content type', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        status: 202,
        headers: { get: () => 'sg-1' },
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await adapter.sendMessage(
        outbound({
          content: {
            type: MessageContentType.IMAGE,
            url: 'https://cdn/photo.jpg',
            mimeType: 'image/jpeg',
          },
        }),
      );

      expect(result.success).toBe(true);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.content[0].value).toBe('[Content type IMAGE — see attachment]');
    });

    it('generates an external id when SendGrid returns no x-message-id header', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 202,
        headers: { get: () => null },
      }) as unknown as typeof fetch;

      const result = await adapter.sendMessage(outbound());

      expect(result.success).toBe(true);
      expect(result.externalMessageId).toEqual(expect.any(String));
      expect(result.externalMessageId).not.toBe('');
    });

    it('returns a non-retryable failure on 4xx and does not retry', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        status: 401,
        text: async () => 'Unauthorized',
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await adapter.sendMessage(outbound());

      expect(result.success).toBe(false);
      expect(result.error).toContain('SendGrid 401');
      expect(result.error).toContain('Unauthorized');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still reports a 4xx whose body cannot be read', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 422,
        text: async () => {
          throw new Error('stream already consumed');
        },
      }) as unknown as typeof fetch;

      const result = await adapter.sendMessage(outbound());

      expect(result.success).toBe(false);
      expect(result.error).toBe('SendGrid 422: Unknown client error');
    });

    it('retries a 5xx and gives up after maxAttempts', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        status: 503,
        text: async () => 'upstream unavailable',
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await adapter.sendMessage(outbound());

      expect(result.success).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(adapter['maxAttempts']);
    }, 15000);

    it('recovers when a 5xx is followed by a success', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({ status: 500, text: async () => 'boom' })
        .mockResolvedValueOnce({ status: 202, headers: { get: () => 'sg-retry' } });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await adapter.sendMessage(outbound());

      expect(result.success).toBe(true);
      expect(result.externalMessageId).toBe('sg-retry');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, 15000);

    it('retries a 5xx whose body cannot be read', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          status: 502,
          text: async () => {
            throw new Error('socket hang up');
          },
        })
        .mockResolvedValueOnce({ status: 202, headers: { get: () => 'sg-ok' } });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await adapter.sendMessage(outbound());

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, 15000);
  });

  // ─────────────────────────────────────────────
  // Template / interactive
  // ─────────────────────────────────────────────

  describe('sendTemplate', () => {
    it('flattens the template parameters into the email body', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        status: 202,
        headers: { get: () => 'sg-tpl' },
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await adapter.sendTemplate({
        channelAccountId: 'acct-1',
        recipientExternalId: 'buyer@example.com',
        templateName: 'site_visit_reminder',
        parameters: { project: 'Prestige Falcon City', slot: 'Saturday 11am' },
        correlationId: 'corr-1',
      } as never);

      expect(result.success).toBe(true);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.content[0].value).toBe(
        'Template: site_visit_reminder\n\n' +
          'project: Prestige Falcon City\n' +
          'slot: Saturday 11am',
      );
      expect(body.personalizations[0].to[0].email).toBe('buyer@example.com');
    });

    it('handles a template with no parameters', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        status: 202,
        headers: { get: () => 'sg-tpl-empty' },
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await adapter.sendTemplate({
        channelAccountId: 'acct-1',
        recipientExternalId: 'buyer@example.com',
        templateName: 'ping',
        parameters: {},
      } as never);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.content[0].value).toBe('Template: ping\n\n');
    });
  });

  describe('sendInteractive', () => {
    it('refuses — email has no interactive surface', async () => {
      const result = await adapter.sendInteractive({
        channelAccountId: 'acct-1',
        recipientExternalId: 'buyer@example.com',
      } as never);

      expect(result).toEqual({
        success: false,
        error: 'Email does not support interactive messages',
      });
    });
  });
});
