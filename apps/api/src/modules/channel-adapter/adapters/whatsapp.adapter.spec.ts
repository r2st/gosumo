/**
 * WhatsAppAdapter unit tests.
 *
 * The adapter is the whole of GoSumo's WhatsApp protocol knowledge: it decides
 * what an inbound Meta payload means, what an outbound send looks like on the
 * wire, and which Meta failures are worth retrying. All three are branch-dense
 * and none of them are exercised by the module-level tests, which stub the
 * adapter out.
 *
 * `fetch` is stubbed per test; no network, no Meta credentials. Signature
 * verification has its own home in `common/utils/webhook-verification.spec.ts`
 * — here it is covered only for the paths that are not about a missing secret.
 */

import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  ChannelType,
  MessageContentType,
  MessageDirection,
  RawRequest,
  ExternalServiceError,
  PayloadParseError,
} from '@gosumo/shared';
import type { OutboundMessage } from '@gosumo/shared';

import { WhatsAppAdapter, isStatusUpdateOnly } from './whatsapp.adapter';

const APP_SECRET = 'whatsapp-app-secret';
const ACCESS_TOKEN = 'whatsapp-access-token';
const PHONE_NUMBER_ID = '123456789';

function makeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback ?? '',
  } as unknown as ConfigService;
}

function configured(overrides: Record<string, string> = {}): WhatsAppAdapter {
  return new WhatsAppAdapter(
    makeConfig({
      'whatsapp.appSecret': APP_SECRET,
      'whatsapp.accessToken': ACCESS_TOKEN,
      'whatsapp.phoneNumberId': PHONE_NUMBER_ID,
      ...overrides,
    }),
  );
}

/** One Meta webhook envelope around a single message object. */
function webhook(
  message: Record<string, unknown>,
  opts: { contacts?: unknown[]; object?: string } = {},
): RawRequest {
  return {
    headers: {},
    body: {
      object: opts.object ?? 'whatsapp_business_account',
      entry: [
        {
          id: 'waba_1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '919876543210',
                  phone_number_id: PHONE_NUMBER_ID,
                },
                contacts: opts.contacts ?? [
                  { profile: { name: 'Asha' }, wa_id: '919812345678' },
                ],
                messages: [
                  {
                    from: '919812345678',
                    id: 'wamid.1',
                    timestamp: '1754870400',
                    ...message,
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  };
}

/** A `fetch` double returning one scripted response. */
function stubFetch(
  response: Partial<{ ok: boolean; status: number; statusText: string; json: unknown; text: string }>,
): jest.Mock {
  const mock = jest.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    statusText: response.statusText ?? 'OK',
    json: async () => {
      if (response.json instanceof Error) throw response.json;
      return response.json ?? {};
    },
    text: async () => response.text ?? '',
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('WhatsAppAdapter', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('declares the WhatsApp capability set', () => {
    const caps = configured().getCapabilities();

    expect(caps).toMatchObject({
      channelType: ChannelType.WHATSAPP,
      supportsTemplates: true,
      supportsInteractiveMessages: true,
      supportsVoice: false,
      maxMessageLength: 4096,
    });
  });

  // ── validateWebhook ──────────────────────────

  describe('validateWebhook', () => {
    /** Signs `body` the way Meta does. */
    function signed(body: string, secret = APP_SECRET): RawRequest {
      const hash = crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
      return {
        headers: { 'x-hub-signature-256': `sha256=${hash}` },
        body: JSON.parse(body) as Record<string, unknown>,
        rawBody: Buffer.from(body),
      };
    }

    it('accepts a correctly signed payload', () => {
      expect(configured().validateWebhook(signed('{"a":1}'))).toBe(true);
    });

    it('rejects a payload signed with the wrong secret', () => {
      expect(configured().validateWebhook(signed('{"a":1}', 'not-the-secret'))).toBe(false);
    });

    it('rejects a payload whose body changed after signing', () => {
      const req = signed('{"a":1}');
      req.rawBody = Buffer.from('{"a":2}');

      expect(configured().validateWebhook(req)).toBe(false);
    });

    it('rejects a header without the sha256= prefix', () => {
      const req = signed('{"a":1}');
      req.headers['x-hub-signature-256'] = 'deadbeef';

      expect(configured().validateWebhook(req)).toBe(false);
    });

    it('rejects a missing signature header', () => {
      const req = signed('{"a":1}');
      delete req.headers['x-hub-signature-256'];

      expect(configured().validateWebhook(req)).toBe(false);
    });

    it('rejects when rawBody was not captured — the signature is over bytes', () => {
      const req = signed('{"a":1}');
      delete req.rawBody;

      expect(configured().validateWebhook(req)).toBe(false);
    });

    it('rejects a truncated signature without throwing', () => {
      // timingSafeEqual throws on a length mismatch; the guard must run first.
      const req = signed('{"a":1}');
      req.headers['x-hub-signature-256'] = 'sha256=abc';

      expect(() => configured().validateWebhook(req)).not.toThrow();
      expect(configured().validateWebhook(req)).toBe(false);
    });
  });

  // ── parseInbound ─────────────────────────────

  describe('parseInbound', () => {
    it('normalizes a text message with the sender profile name', () => {
      const result = configured().parseInbound(
        webhook({ type: 'text', text: { body: 'Hello' } }),
      );

      expect(result).toMatchObject({
        externalId: 'wamid.1',
        channel: ChannelType.WHATSAPP,
        channelAccountId: PHONE_NUMBER_ID,
        direction: MessageDirection.INBOUND,
        sender: { externalId: '919812345678', displayName: 'Asha' },
        content: { type: MessageContentType.TEXT, text: 'Hello' },
      });
      expect(result.timestamp).toEqual(new Date(1754870400 * 1000));
    });

    it('leaves the display name undefined when no contact matches the sender', () => {
      const result = configured().parseInbound(
        webhook({ type: 'text', text: { body: 'Hi' } }, { contacts: [] }),
      );

      expect(result.sender.displayName).toBeUndefined();
    });

    it('carries the reply context into metadata', () => {
      const result = configured().parseInbound(
        webhook({
          type: 'text',
          text: { body: 'Yes' },
          context: { from: '919876543210', id: 'wamid.0' },
        }),
      );

      expect(result.metadata).toMatchObject({
        wabaId: 'waba_1',
        contextMessageId: 'wamid.0',
        contextFrom: '919876543210',
      });
    });

    it('rejects a payload for a different Meta product', () => {
      expect(() =>
        configured().parseInbound(webhook({ type: 'text' }, { object: 'instagram' })),
      ).toThrow(/Unexpected webhook object type/);
    });

    it('throws on a status-only payload', () => {
      const req: RawRequest = {
        headers: {},
        body: {
          object: 'whatsapp_business_account',
          entry: [
            {
              id: 'waba_1',
              changes: [
                {
                  field: 'messages',
                  value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, statuses: [] },
                },
              ],
            },
          ],
        },
      };

      expect(() => configured().parseInbound(req)).toThrow(/no parseable inbound message/);
    });

    it('skips changes for fields other than messages', () => {
      const req: RawRequest = {
        headers: {},
        body: {
          object: 'whatsapp_business_account',
          entry: [
            {
              id: 'waba_1',
              changes: [
                { field: 'message_template_status_update', value: { messages: [] } },
              ],
            },
          ],
        },
      };

      expect(() => configured().parseInbound(req)).toThrow(/no parseable inbound message/);
    });
  });

  // ── Content type mapping ─────────────────────

  describe('inbound content mapping', () => {
    const parse = (message: Record<string, unknown>) =>
      configured().parseInbound(webhook(message)).content;

    it('maps an image to a whatsapp-media URL, keeping caption and mime type', () => {
      expect(
        parse({
          type: 'image',
          image: { id: 'media_1', mime_type: 'image/jpeg', caption: 'front elevation' },
        }),
      ).toEqual({
        type: MessageContentType.IMAGE,
        url: 'whatsapp-media://media_1',
        caption: 'front elevation',
        mimeType: 'image/jpeg',
      });
    });

    it('maps a document, defaulting a missing filename', () => {
      expect(
        parse({ type: 'document', document: { id: 'doc_1', mime_type: 'application/pdf' } }),
      ).toMatchObject({
        type: MessageContentType.DOCUMENT,
        url: 'whatsapp-media://doc_1',
        filename: 'document',
      });
    });

    it('maps a location with its optional name and address', () => {
      expect(
        parse({
          type: 'location',
          location: { latitude: 18.52, longitude: 73.85, name: 'Site', address: 'Baner, Pune' },
        }),
      ).toEqual({
        type: MessageContentType.LOCATION,
        latitude: 18.52,
        longitude: 73.85,
        name: 'Site',
        address: 'Baner, Pune',
      });
    });

    it('maps a template quick-reply button tap', () => {
      expect(
        parse({ type: 'button', button: { payload: 'BOOK_VISIT', text: 'Book a visit' } }),
      ).toEqual({
        type: MessageContentType.INTERACTIVE,
        interactiveType: 'button_reply',
        payload: { id: 'BOOK_VISIT', title: 'Book a visit' },
      });
    });

    it('maps an interactive button reply', () => {
      expect(
        parse({
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: 'YES', title: 'Yes' } },
        }),
      ).toEqual({
        type: MessageContentType.INTERACTIVE,
        interactiveType: 'button_reply',
        payload: { id: 'YES', title: 'Yes' },
      });
    });

    it('maps an interactive list reply with its description', () => {
      expect(
        parse({
          type: 'interactive',
          interactive: {
            type: 'list_reply',
            list_reply: { id: '2bhk', title: '2 BHK', description: '₹85L onwards' },
          },
        }),
      ).toEqual({
        type: MessageContentType.INTERACTIVE,
        interactiveType: 'list_reply',
        payload: { id: '2bhk', title: '2 BHK', description: '₹85L onwards' },
      });
    });

    it('falls back to empty strings when an interactive reply is missing its body', () => {
      expect(
        parse({ type: 'interactive', interactive: { type: 'button_reply' } }),
      ).toMatchObject({ payload: { id: '', title: '' } });
      expect(
        parse({ type: 'interactive', interactive: { type: 'list_reply' } }),
      ).toMatchObject({ payload: { id: '', title: '' } });
    });

    it('passes an unrecognised interactive type through verbatim', () => {
      expect(
        parse({ type: 'interactive', interactive: { type: 'nfm_reply', foo: 'bar' } }),
      ).toMatchObject({ interactiveType: 'nfm_reply', payload: { type: 'nfm_reply', foo: 'bar' } });
    });

    it.each(['audio', 'video', 'sticker'])('stores %s as a downloadable media reference', (kind) => {
      expect(parse({ type: kind, [kind]: { id: 'm_9', mime_type: `${kind}/x` } })).toEqual({
        type: MessageContentType.IMAGE,
        url: 'whatsapp-media://m_9',
        mimeType: `${kind}/x`,
      });
    });

    it('renders a reaction as readable text', () => {
      expect(
        parse({ type: 'reaction', reaction: { message_id: 'wamid.0', emoji: '👍' } }),
      ).toEqual({ type: MessageContentType.TEXT, text: '[reaction: 👍 on wamid.0]' });
    });

    it('renders a reaction with missing fields without throwing', () => {
      expect(parse({ type: 'reaction' })).toEqual({
        type: MessageContentType.TEXT,
        text: '[reaction: ? on ?]',
      });
    });

    it.each([
      ['text', 'type=text but no text field'],
      ['image', 'type=image but no image field'],
      ['document', 'type=document but no document field'],
      ['location', 'type=location but no location field'],
      ['interactive', 'type=interactive but no interactive field'],
      ['button', 'type=button but no button field'],
    ])('throws when a %s message carries no %s payload', (type, message) => {
      expect(() => parse({ type })).toThrow(PayloadParseError);
      expect(() => parse({ type })).toThrow(message);
    });

    it.each(['unknown', 'order', 'system'])('throws for the unsupported type %s', (type) => {
      expect(() => parse({ type })).toThrow(`Unsupported message type "${type}"`);
    });

    it('carries the provider message id on a parse failure', () => {
      let caught: unknown;
      try {
        parse({ type: 'text' });
      } catch (err) {
        caught = err;
      }

      // The id is the only handle on the offending payload once it is in the
      // DLQ, and it belongs in context rather than in the message.
      expect(caught).toBeInstanceOf(PayloadParseError);
      expect((caught as PayloadParseError).retryable).toBe(false);
      expect((caught as PayloadParseError).context).toMatchObject({
        source: 'WhatsApp',
        messageType: 'text',
      });
      expect((caught as PayloadParseError).context['messageId']).toBeDefined();
    });
  });

  // ── parseInboundAll ──────────────────────────

  describe('parseInboundAll', () => {
    it('returns every message in the batch', () => {
      const req = webhook({ type: 'text', text: { body: 'one' } });
      const value = (req.body as { entry: { changes: { value: { messages: unknown[] } }[] }[] })
        .entry[0]!.changes[0]!.value;
      value.messages.push({
        from: '919812345678',
        id: 'wamid.2',
        timestamp: '1754870401',
        type: 'text',
        text: { body: 'two' },
      });

      const results = configured().parseInboundAll(req);

      expect(results.map((r) => r.externalId)).toEqual(['wamid.1', 'wamid.2']);
    });

    it('skips the messages it cannot parse and keeps the rest', () => {
      const req = webhook({ type: 'text', text: { body: 'ok' } });
      const value = (req.body as { entry: { changes: { value: { messages: unknown[] } }[] }[] })
        .entry[0]!.changes[0]!.value;
      value.messages.push({
        from: '919812345678',
        id: 'wamid.bad',
        timestamp: '1754870401',
        type: 'unknown',
      });

      const results = configured().parseInboundAll(req);

      expect(results).toHaveLength(1);
      expect(results[0]!.externalId).toBe('wamid.1');
    });

    it('returns nothing for another product, a non-message field, or a status payload', () => {
      const adapter = configured();

      expect(
        adapter.parseInboundAll(webhook({ type: 'text' }, { object: 'instagram' })),
      ).toEqual([]);
      expect(
        adapter.parseInboundAll({
          headers: {},
          body: {
            object: 'whatsapp_business_account',
            entry: [{ id: 'w', changes: [{ field: 'statuses', value: {} }] }],
          },
        }),
      ).toEqual([]);
      expect(
        adapter.parseInboundAll({
          headers: {},
          body: {
            object: 'whatsapp_business_account',
            entry: [{ id: 'w', changes: [{ field: 'messages', value: { statuses: [] } }] }],
          },
        }),
      ).toEqual([]);
    });
  });

  // ── Outbound body building ───────────────────

  describe('outbound message bodies', () => {
    /** Sends `content` and returns the JSON body posted to Meta. */
    async function bodyFor(
      content: OutboundMessage['content'],
      extra: Partial<OutboundMessage> = {},
    ): Promise<Record<string, unknown>> {
      const fetchMock = stubFetch({ json: { messages: [{ id: 'wamid.out' }] } });
      await configured().sendMessage({
        recipientExternalId: '919812345678',
        content,
        ...extra,
      } as OutboundMessage);
      return JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>;
    }

    it('sends text with link previews off', async () => {
      const body = await bodyFor({ type: MessageContentType.TEXT, text: 'Hello' });

      expect(body).toMatchObject({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '919812345678',
        type: 'text',
        text: { body: 'Hello', preview_url: false },
      });
      expect(body).not.toHaveProperty('context');
    });

    it('threads a reply through the context field', async () => {
      const body = await bodyFor(
        { type: MessageContentType.TEXT, text: 'Yes' },
        { replyToExternalId: 'wamid.0' },
      );

      expect(body.context).toEqual({ message_id: 'wamid.0' });
    });

    it('sends an already-uploaded image by media id, not by link', async () => {
      const body = await bodyFor({
        type: MessageContentType.IMAGE,
        url: 'whatsapp-media://media_1',
        caption: 'plan',
        mimeType: 'image/png',
      });

      expect(body.image).toEqual({ id: 'media_1', caption: 'plan' });
    });

    it('sends an external image by link', async () => {
      const body = await bodyFor({
        type: MessageContentType.IMAGE,
        url: 'https://cdn.example.invalid/a.jpg',
        mimeType: 'image/jpeg',
      });

      expect(body.image).toEqual({ link: 'https://cdn.example.invalid/a.jpg', caption: undefined });
    });

    it('sends a document by media id or by link on the same rule', async () => {
      expect(
        (
          await bodyFor({
            type: MessageContentType.DOCUMENT,
            url: 'whatsapp-media://doc_1',
            filename: 'brochure.pdf',
            mimeType: 'application/pdf',
          })
        ).document,
      ).toEqual({ id: 'doc_1', filename: 'brochure.pdf' });

      expect(
        (
          await bodyFor({
            type: MessageContentType.DOCUMENT,
            url: 'https://cdn.example.invalid/b.pdf',
            filename: 'b.pdf',
            mimeType: 'application/pdf',
          })
        ).document,
      ).toEqual({ link: 'https://cdn.example.invalid/b.pdf', filename: 'b.pdf' });
    });

    it('sends a location', async () => {
      const body = await bodyFor({
        type: MessageContentType.LOCATION,
        latitude: 18.52,
        longitude: 73.85,
        name: 'Site office',
      });

      expect(body).toMatchObject({
        type: 'location',
        location: { latitude: 18.52, longitude: 73.85, name: 'Site office' },
      });
    });

    it('turns a template parameter map into one body component', async () => {
      const body = await bodyFor({
        type: MessageContentType.TEMPLATE,
        templateName: 'visit_reminder',
        language: 'en',
        parameters: { '1': 'Asha', '2': 'Sunday 11am' },
      });

      expect(body.template).toEqual({
        name: 'visit_reminder',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Asha' },
              { type: 'text', text: 'Sunday 11am' },
            ],
          },
        ],
      });
    });

    it.each([MessageContentType.INTERACTIVE, MessageContentType.PAYMENT_LINK])(
      'refuses %s, which belongs on sendInteractive/sendTemplate',
      async (type) => {
        const result = await configured().sendMessage({
          recipientExternalId: '919812345678',
          content: { type } as OutboundMessage['content'],
        } as OutboundMessage);

        expect(result.success).toBe(false);
      },
    );
  });

  describe('sendTemplate', () => {
    it('omits the components key entirely when there are no parameters', async () => {
      const fetchMock = stubFetch({ json: { messages: [{ id: 'wamid.out' }] } });

      await configured().sendTemplate({
        channelAccountId: PHONE_NUMBER_ID,
        recipientExternalId: '919812345678',
        templateName: 'hello',
        language: 'en',
        parameters: {},
      });

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
        template: Record<string, unknown>;
      };
      expect(body.template).toEqual({ name: 'hello', language: { code: 'en' } });
    });

    it('includes components when parameters are supplied', async () => {
      const fetchMock = stubFetch({ json: { messages: [{ id: 'wamid.out' }] } });

      await configured().sendTemplate({
        channelAccountId: PHONE_NUMBER_ID,
        recipientExternalId: '919812345678',
        templateName: 'hello',
        language: 'en',
        parameters: { '1': 'Asha' },
      });

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
        template: { components: unknown[] };
      };
      expect(body.template.components).toHaveLength(1);
    });
  });

  describe('sendInteractive', () => {
    it('sends body and action, omitting an absent header and footer', async () => {
      const fetchMock = stubFetch({ json: { messages: [{ id: 'wamid.out' }] } });

      await configured().sendInteractive({
        channelAccountId: PHONE_NUMBER_ID,
        recipientExternalId: '919812345678',
        interactiveType: 'button',
        body: 'Pick a slot',
        action: { buttons: [] },
      });

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
        interactive: Record<string, unknown>;
      };
      expect(body.interactive).toEqual({
        type: 'button',
        body: { text: 'Pick a slot' },
        action: { buttons: [] },
      });
    });

    it('wraps a footer string and passes a header object straight through', async () => {
      const fetchMock = stubFetch({ json: { messages: [{ id: 'wamid.out' }] } });

      await configured().sendInteractive({
        channelAccountId: PHONE_NUMBER_ID,
        recipientExternalId: '919812345678',
        interactiveType: 'list',
        body: 'Pick a unit',
        action: { sections: [] },
        header: { type: 'text', text: 'Available' },
        footer: 'Prices exclude GST',
      });

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
        interactive: Record<string, unknown>;
      };
      expect(body.interactive).toMatchObject({
        header: { type: 'text', text: 'Available' },
        footer: { text: 'Prices exclude GST' },
      });
    });
  });

  // ── Meta API error handling ──────────────────

  describe('callMetaApi failure handling', () => {
    it('returns the external message id on success', async () => {
      stubFetch({ json: { messages: [{ id: 'wamid.out' }] } });

      const result = await configured().sendMessage({
        recipientExternalId: '919812345678',
        content: { type: MessageContentType.TEXT, text: 'Hi' },
      } as OutboundMessage);

      expect(result).toMatchObject({ success: true, externalMessageId: 'wamid.out' });
    });

    it('succeeds without an id when Meta returns no messages array', async () => {
      stubFetch({ json: {} });

      const result = await configured().sendMessage({
        recipientExternalId: '919812345678',
        content: { type: MessageContentType.TEXT, text: 'Hi' },
      } as OutboundMessage);

      expect(result.success).toBe(true);
      expect(result.externalMessageId).toBeUndefined();
    });

    it('reports a 4xx as a failed result without retrying', async () => {
      const fetchMock = stubFetch({
        ok: false,
        status: 400,
        json: { error: { message: 'Invalid recipient', code: 131026 } },
      });

      const result = await configured().sendMessage({
        recipientExternalId: 'bad',
        content: { type: MessageContentType.TEXT, text: 'Hi' },
      } as OutboundMessage);

      expect(result).toMatchObject({
        success: false,
        error: 'Meta API error 131026: Invalid recipient',
        attempts: 1,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to the status code when the error body is not JSON', async () => {
      stubFetch({ ok: false, status: 403, json: new Error('not json') });

      const result = await configured().sendMessage({
        recipientExternalId: '919812345678',
        content: { type: MessageContentType.TEXT, text: 'Hi' },
      } as OutboundMessage);

      expect(result).toMatchObject({ success: false, error: 'Meta API returned 403' });
    });

    it('falls back to the status code when the JSON body has no error message', async () => {
      stubFetch({ ok: false, status: 422, json: { error: {} } });

      const result = await configured().sendMessage({
        recipientExternalId: '919812345678',
        content: { type: MessageContentType.TEXT, text: 'Hi' },
      } as OutboundMessage);

      expect(result).toMatchObject({ success: false, error: 'Meta API returned 422' });
    });

    it('retries a 5xx and gives up as a failure', async () => {
      const fetchMock = stubFetch({ ok: false, status: 503, json: { error: { message: 'busy' } } });

      const result = await configured().sendMessage({
        recipientExternalId: '919812345678',
        content: { type: MessageContentType.TEXT, text: 'Hi' },
      } as OutboundMessage);

      expect(result.success).toBe(false);
      // maxAttempts is 3 for this adapter.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }, 15000);

    it('retries a 429, the rate limit this adapter is most likely to hit', async () => {
      // WhatsApp caps a number at 80 msg/sec. The old `status >= 500` test
      // classified that as terminal, so a burst was dropped rather than
      // backed off — the one transient failure the retry loop exists for.
      const fetchMock = stubFetch({
        ok: false,
        status: 429,
        json: { error: { message: 'Too many requests', code: 130429 } },
      });

      const result = await configured().sendMessage({
        recipientExternalId: '919812345678',
        content: { type: MessageContentType.TEXT, text: 'Hi' },
      } as OutboundMessage);

      expect(result.success).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }, 15000);

    it('does not retry a 4xx that is the request’s own fault', async () => {
      const fetchMock = stubFetch({
        ok: false,
        status: 400,
        json: { error: { message: 'Invalid recipient', code: 131026 } },
      });

      const result = await configured().sendMessage({
        recipientExternalId: '919812345678',
        content: { type: MessageContentType.TEXT, text: 'Hi' },
      } as OutboundMessage);

      expect(result).toMatchObject({
        success: false,
        error: 'Meta API error 131026: Invalid recipient',
        attempts: 1,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ── Media ────────────────────────────────────

  describe('downloadMedia', () => {
    it('resolves the CDN url then streams the bytes', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://cdn.meta/x' }) })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        });
      global.fetch = fetchMock as unknown as typeof fetch;

      const buffer = await configured().downloadMedia('media_1');

      expect(buffer).toEqual(Buffer.from([1, 2, 3]));
      expect(fetchMock.mock.calls[0]![0]).toContain('/media_1');
      expect(fetchMock.mock.calls[1]![0]).toBe('https://cdn.meta/x');
    });

    it('throws when the media metadata lookup fails', async () => {
      stubFetch({ ok: false, status: 404, statusText: 'Not Found' });

      const error = await configured().downloadMedia('gone').then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ExternalServiceError);
      expect((error as ExternalServiceError).message).toBe('WhatsApp Media: URL fetch failed');
      expect((error as ExternalServiceError).retryable).toBe(false);
      expect((error as ExternalServiceError).context).toEqual({
        service: 'WhatsApp Media',
        status: 404,
        statusText: 'Not Found',
      });
    });

    it('throws when the CDN download fails', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://cdn.meta/x' }) })
        .mockResolvedValueOnce({ ok: false, status: 410, statusText: 'Gone' });
      global.fetch = fetchMock as unknown as typeof fetch;

      const error = await configured().downloadMedia('media_1').then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ExternalServiceError);
      expect((error as ExternalServiceError).message).toBe('WhatsApp Media: download failed');
      expect((error as ExternalServiceError).retryable).toBe(false);
      expect((error as ExternalServiceError).context).toEqual({
        service: 'WhatsApp Media',
        status: 410,
        statusText: 'Gone',
      });
    });
  });

  describe('uploadMedia', () => {
    it('posts the buffer and returns the new media id', async () => {
      const fetchMock = stubFetch({ json: { id: 'media_new' } });

      await expect(
        configured().uploadMedia(Buffer.from('hello'), 'image/png'),
      ).resolves.toBe('media_new');
      expect(fetchMock.mock.calls[0]![0]).toContain(`/${PHONE_NUMBER_ID}/media`);
      expect(fetchMock.mock.calls[0]![1].method).toBe('POST');
    });

    it('surfaces the response body when the upload is rejected', async () => {
      stubFetch({ ok: false, status: 413, text: 'file too large' });

      const error = await configured().uploadMedia(Buffer.from('hello'), 'image/png').then(
        () => null,
        (err: unknown) => err,
      );

      // The provider's body is log-only context now — it can echo customer
      // content, so it must not reach an HTTP response.
      expect(error).toBeInstanceOf(ExternalServiceError);
      expect((error as ExternalServiceError).message).toBe('WhatsApp Media: upload failed');
      expect((error as ExternalServiceError).context).toEqual({
        service: 'WhatsApp Media',
        status: 413,
        body: 'file too large',
      });
    });
  });
});

// ─────────────────────────────────────────────
// isStatusUpdateOnly
// ─────────────────────────────────────────────

describe('isStatusUpdateOnly', () => {
  const payload = (changes: unknown[]) => ({ entry: [{ id: 'w', changes }] });

  it('is true for a delivery-status webhook', () => {
    expect(isStatusUpdateOnly(payload([{ field: 'messages', value: { statuses: [{}] } }]))).toBe(
      true,
    );
  });

  it('is false once the payload carries a message', () => {
    expect(
      isStatusUpdateOnly(payload([{ field: 'messages', value: { messages: [{}] } }])),
    ).toBe(false);
  });

  it('is true when the messages array is present but empty', () => {
    expect(isStatusUpdateOnly(payload([{ field: 'messages', value: { messages: [] } }]))).toBe(
      true,
    );
  });

  it('is true for a change on some other field', () => {
    expect(isStatusUpdateOnly(payload([{ field: 'account_update', value: {} }]))).toBe(true);
  });

  it('is false for a body that is not a Meta envelope at all', () => {
    expect(isStatusUpdateOnly(undefined)).toBe(false);
    expect(isStatusUpdateOnly({})).toBe(false);
  });

  /**
   * The controller calls this before its try/catch and before the signature is
   * checked, so anything this function throws leaves a `@Public()` route
   * answering 500 — the one response that makes Meta redeliver, and keep
   * redelivering. Each shape below threw before; a body we cannot classify has
   * to fall through to the parser instead.
   */
  it.each([
    ['entry item with no changes', { entry: [{ id: 'w' }] }],
    ['null changes', { entry: [{ id: 'w', changes: null }] }],
    ['changes that is not an array', { entry: [{ id: 'w', changes: {} }] }],
    ['entry that is a string', { entry: 'nope' }],
    ['entry that is a number', { entry: 7 }],
  ])('treats an unwalkable envelope as not-status-only: %s', (_label, body) => {
    expect(() => isStatusUpdateOnly(body)).not.toThrow();
    // Not-status-only, so the route hands it to the parser, which reports a
    // reason. Claiming "status update, nothing to do" about a shape we could
    // not read would discard a message we never looked for.
    expect(isStatusUpdateOnly(body)).toBe(false);
  });

  it.each([
    ['null change item', { entry: [{ id: 'w', changes: [null] }] }],
    ['change with no value', { entry: [{ id: 'w', changes: [{ field: 'messages' }] }] }],
    ['null value.messages', { entry: [{ id: 'w', changes: [{ field: 'messages', value: null }] }] }],
  ])('reads a walkable change carrying no messages as status-only: %s', (_label, body) => {
    expect(() => isStatusUpdateOnly(body)).not.toThrow();
    expect(isStatusUpdateOnly(body)).toBe(true);
  });
});

// ─────────────────────────────────────────────
// parseInboundAll — per-message failure isolation
// ─────────────────────────────────────────────

describe('WhatsAppAdapter.parseInboundAll isolation', () => {
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    adapter = configured();
    jest
      .spyOn((adapter as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const envelope = (value: unknown): RawRequest => ({
    headers: {},
    body: {
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba-1', changes: [{ field: 'messages', value }] }],
    },
    query: {},
  });

  const goodMessage = (id: string) => ({
    id,
    from: '919876543210',
    timestamp: '1700000000',
    type: 'text',
    text: { body: 'hello' },
  });

  it('keeps the good messages when a sibling entry is null', () => {
    // The per-message loop existed to isolate exactly this, but the contact
    // lookup sat *outside* its try — so one null entry threw past the catch,
    // the service turned it into a payload-wide parse failure, and both real
    // messages were lost with no row and no event.
    const parsed = adapter.parseInboundAll(
      envelope({
        metadata: { phone_number_id: 'pn-1', display_phone_number: '+911111111111' },
        contacts: [{ wa_id: '919876543210', profile: { name: 'Asha' } }],
        messages: [goodMessage('wamid.1'), null, goodMessage('wamid.2')],
      }),
    );

    expect(parsed.map((m) => m.externalId)).toEqual(['wamid.1', 'wamid.2']);
    expect(parsed[0]!.sender.displayName).toBe('Asha');
  });

  it('keeps the good messages when the contacts array carries a null', () => {
    const parsed = adapter.parseInboundAll(
      envelope({
        metadata: { phone_number_id: 'pn-1', display_phone_number: '+911111111111' },
        contacts: [null, { wa_id: '919876543210', profile: { name: 'Asha' } }],
        messages: [goodMessage('wamid.1')],
      }),
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.sender.displayName).toBe('Asha');
  });

  it('skips a message whose contact entry has no profile', () => {
    // `contact?.profile.name` is only half-chained; the contact matches, the
    // profile is absent, and the throw has to stay inside the loop.
    const parsed = adapter.parseInboundAll(
      envelope({
        metadata: { phone_number_id: 'pn-1', display_phone_number: '+911111111111' },
        contacts: [{ wa_id: '919876543210' }],
        messages: [goodMessage('wamid.1'), { ...goodMessage('wamid.2'), from: '910000000000' }],
      }),
    );

    expect(parsed.map((m) => m.externalId)).toEqual(['wamid.2']);
  });

  it('returns nothing rather than throwing on an unwalkable envelope', () => {
    // A throw here would be reported as "could not parse" for the whole POST;
    // returning empty lets the service ask `parseInbound` for the real reason.
    for (const body of [
      { object: 'whatsapp_business_account', entry: null },
      { object: 'whatsapp_business_account', entry: [{ changes: 'nope' }] },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages' }] }] },
      {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: { messages: 'nope' } }] }],
      },
    ]) {
      expect(adapter.parseInboundAll({ headers: {}, body, query: {} })).toEqual([]);
    }
  });
});
