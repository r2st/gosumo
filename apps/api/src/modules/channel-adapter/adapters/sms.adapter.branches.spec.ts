/**
 * SmsAdapter — signature reconstruction, payload casing, and outbound branches.
 *
 * Twilio is the odd one out among the channel adapters. Meta signs a body, and
 * verifying it needs only the body and a secret. Twilio signs the *request URL
 * plus the sorted body params*, which means verification depends on values this
 * process does not own — the forwarded protocol, the Host header, the original
 * path — and each of those has a "what if it's missing" branch that decides
 * between rejecting a real message and accepting a forged one.
 *
 * The rest of the file covers two other places where SMS differs from the
 * others:
 *
 *   - `parseInbound` accepts both Twilio's TitleCase form fields (`From`,
 *     `Body`, `MessageSid`) and the lowercase spellings a proxy or a test
 *     harness may send. Every field has both spellings and a default, so the
 *     lowercase arms are entirely untested branches until something asserts
 *     them.
 *   - `sendMessage` maps content types onto Twilio's form encoding and
 *     distinguishes a 5xx (throw, so `sendWithRetry` retries) from a 4xx
 *     (return a failure, because retrying a rejected number never succeeds).
 *     Getting that backwards either burns three attempts on a permanent error
 *     or gives up on a transient one.
 */

import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  ChannelType,
  MessageContentType,
  OutboundMessage,
  RawRequest,
} from '@gosumo/shared';

import { SmsAdapter } from './sms.adapter';

const ACCOUNT_SID = 'AC00000000000000000000000000000001';
const AUTH_TOKEN = 'twilio-auth-token';
const FROM_NUMBER = '+15005550006';
const TO_NUMBER = '+919876543210';

function makeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback ?? '',
  } as unknown as ConfigService;
}

/** An adapter with Twilio credentials configured, outside production. */
function configuredAdapter(overrides: Record<string, string> = {}): SmsAdapter {
  return new SmsAdapter(
    makeConfig({
      'twilio.accountSid': ACCOUNT_SID,
      'twilio.authToken': AUTH_TOKEN,
      'twilio.fromNumber': FROM_NUMBER,
      'app.env': 'development',
      ...overrides,
    }),
  );
}

/**
 * Build the signature Twilio would send for a given URL + body, using the
 * scheme the adapter reimplements: HMAC-SHA1 over the URL with the body params
 * appended in sorted key order.
 */
function twilioSignature(url: string, body: Record<string, string>): string {
  const data = Object.keys(body)
    .sort()
    .reduce((acc, key) => acc + key + (body[key] ?? ''), url);
  return crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
}

describe('SmsAdapter — validateWebhook', () => {
  const BODY = { From: TO_NUMBER, To: FROM_NUMBER, Body: 'Interested in 2BHK' };
  const URL = 'https://api.gosumo.test/webhooks/sms';

  function request(overrides: Partial<RawRequest> = {}): RawRequest {
    return {
      headers: {
        'x-twilio-signature': twilioSignature(URL, BODY),
        'x-forwarded-proto': 'https',
        host: 'api.gosumo.test',
        'x-original-url': '/webhooks/sms',
      },
      body: BODY,
      ...overrides,
    } as RawRequest;
  }

  it('accepts a correctly signed Twilio callback', () => {
    expect(configuredAdapter().validateWebhook(request())).toBe(true);
  });

  it('rejects a signature computed over different body params', () => {
    // The body is part of what Twilio signs, so tampering with the message text
    // invalidates the signature even though the URL is untouched.
    const tampered = request({ body: { ...BODY, Body: 'Send me your bank details' } });
    expect(configuredAdapter().validateWebhook(tampered)).toBe(false);
  });

  it('rejects a signature of the wrong length rather than throwing', () => {
    // `timingSafeEqual` throws on unequal buffer lengths; the guard has to run
    // first or a short signature becomes a 500 instead of a rejection.
    const req = request();
    req.headers['x-twilio-signature'] = 'short';
    expect(configuredAdapter().validateWebhook(req)).toBe(false);
  });

  it('rejects a request with no signature header at all', () => {
    const req = request();
    delete req.headers['x-twilio-signature'];
    expect(configuredAdapter().validateWebhook(req)).toBe(false);
  });

  it('defaults a missing x-forwarded-proto to https', () => {
    // Behind a TLS-terminating proxy the header is normally set; when it isn't,
    // assuming http would rebuild the wrong URL and reject every real callback.
    const req = request();
    delete req.headers['x-forwarded-proto'];
    expect(configuredAdapter().validateWebhook(req)).toBe(true);
  });

  it('signs an empty path when x-original-url is absent', () => {
    const url = 'https://api.gosumo.test';
    const req = request({
      headers: {
        'x-twilio-signature': twilioSignature(url, BODY),
        'x-forwarded-proto': 'https',
        host: 'api.gosumo.test',
      },
    });
    expect(configuredAdapter().validateWebhook(req)).toBe(true);
  });

  it('tolerates a callback with no body params', () => {
    const url = 'https://api.gosumo.test/webhooks/sms';
    const req = request({
      headers: {
        'x-twilio-signature': twilioSignature(url, {}),
        'x-forwarded-proto': 'https',
        host: 'api.gosumo.test',
        'x-original-url': '/webhooks/sms',
      },
      body: undefined,
    });
    expect(configuredAdapter().validateWebhook(req)).toBe(true);
  });

  describe('when the Host header is missing', () => {
    // Without Host the signed URL cannot be rebuilt, so the signature is
    // uncheckable — the same situation as an unset secret, and it takes the
    // same fail-closed path.
    function hostless(): RawRequest {
      const req = request();
      delete req.headers['host'];
      return req;
    }

    it('accepts outside production', () => {
      expect(configuredAdapter().validateWebhook(hostless())).toBe(true);
    });

    it('REFUSES in production', () => {
      const adapter = configuredAdapter({ 'app.env': 'production' });
      expect(adapter.validateWebhook(hostless())).toBe(false);
    });
  });

  describe('when the auth token is unset', () => {
    it('accepts outside production', () => {
      const adapter = new SmsAdapter(
        makeConfig({ 'twilio.accountSid': ACCOUNT_SID, 'app.env': 'development' }),
      );
      expect(adapter.validateWebhook(request())).toBe(true);
    });

    it('REFUSES in production rather than accepting everyone', () => {
      const adapter = new SmsAdapter(
        makeConfig({ 'twilio.accountSid': ACCOUNT_SID, 'app.env': 'production' }),
      );
      expect(adapter.validateWebhook(request())).toBe(false);
    });
  });
});

describe('SmsAdapter — parseInbound field casing', () => {
  const adapter = configuredAdapter();

  it('reads Twilio\'s TitleCase form fields', () => {
    const msg = adapter.parseInbound({
      headers: {},
      body: {
        From: TO_NUMBER,
        To: FROM_NUMBER,
        Body: 'Hello',
        MessageSid: 'SM123',
      },
    } as RawRequest);

    expect(msg.sender.externalId).toBe(TO_NUMBER);
    expect(msg.channelAccountId).toBe(FROM_NUMBER);
    expect(msg.externalId).toBe('SM123');
    expect(msg.content).toMatchObject({ type: MessageContentType.TEXT, text: 'Hello' });
  });

  it('falls back to lowercase spellings a proxy may send', () => {
    const msg = adapter.parseInbound({
      headers: {},
      body: {
        from: TO_NUMBER,
        to: FROM_NUMBER,
        body: 'Hello lowercase',
        messageSid: 'SM456',
      },
    } as RawRequest);

    expect(msg.sender.externalId).toBe(TO_NUMBER);
    expect(msg.channelAccountId).toBe(FROM_NUMBER);
    expect(msg.externalId).toBe('SM456');
    expect(msg.content).toMatchObject({ text: 'Hello lowercase' });
  });

  it('mints an external id when the provider sent none', () => {
    // Without an id the dedupe in ChannelAdapterService has nothing to key on;
    // a generated one makes it a no-op rather than a false positive.
    const msg = adapter.parseInbound({
      headers: {},
      body: { From: TO_NUMBER, To: FROM_NUMBER, Body: 'x' },
    } as RawRequest);

    expect(msg.externalId).toEqual(expect.any(String));
    expect(msg.externalId).not.toBe('');
  });

  it('defaults every absent field rather than emitting undefined', () => {
    const msg = adapter.parseInbound({ headers: {}, body: {} } as RawRequest);

    expect(msg.sender.externalId).toBe('');
    expect(msg.channelAccountId).toBe('');
    expect(msg.content).toMatchObject({ type: MessageContentType.TEXT, text: '' });
  });

  it('treats NumMedia > 0 with a media url as an MMS', () => {
    const msg = adapter.parseInbound({
      headers: {},
      body: {
        From: TO_NUMBER,
        To: FROM_NUMBER,
        Body: 'Floor plan',
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.com/media/ME1',
        MediaContentType0: 'image/png',
      },
    } as RawRequest);

    expect(msg.content).toMatchObject({
      type: MessageContentType.IMAGE,
      url: 'https://api.twilio.com/media/ME1',
      caption: 'Floor plan',
      mimeType: 'image/png',
    });
  });

  it('reads the lowercase numMedia spelling', () => {
    const msg = adapter.parseInbound({
      headers: {},
      body: {
        from: TO_NUMBER,
        numMedia: '1',
        MediaUrl0: 'https://api.twilio.com/media/ME2',
      },
    } as RawRequest);

    expect(msg.content).toMatchObject({ type: MessageContentType.IMAGE });
  });

  it('assumes jpeg when Twilio omits the media content type', () => {
    const msg = adapter.parseInbound({
      headers: {},
      body: { From: TO_NUMBER, NumMedia: '1', MediaUrl0: 'https://x.test/a' },
    } as RawRequest);

    expect(msg.content).toMatchObject({ mimeType: 'image/jpeg' });
  });

  it('leaves the caption unset when an MMS carries no text', () => {
    const msg = adapter.parseInbound({
      headers: {},
      body: { From: TO_NUMBER, NumMedia: '1', MediaUrl0: 'https://x.test/a', Body: '' },
    } as RawRequest);

    expect(msg.content).toMatchObject({ caption: undefined });
  });

  it('stays a text message when NumMedia is set but no url arrived', () => {
    const msg = adapter.parseInbound({
      headers: {},
      body: { From: TO_NUMBER, Body: 'still text', NumMedia: '2' },
    } as RawRequest);

    expect(msg.content).toMatchObject({ type: MessageContentType.TEXT });
  });
});

describe('SmsAdapter — sendMessage', () => {
  const TEXT_MESSAGE = {
    recipientExternalId: TO_NUMBER,
    channelAccountId: FROM_NUMBER,
    content: { type: MessageContentType.TEXT, text: 'Your site visit is confirmed' },
  } as OutboundMessage;

  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  /** Stub global fetch with a single response. */
  function stubFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(response as unknown as Response);
    return fetchSpy;
  }

  /** The form-encoded body the adapter posted to Twilio, parsed back out. */
  function postedParams(): URLSearchParams {
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    return new URLSearchParams(init.body as string);
  }

  it('posts a text message as Twilio form params', async () => {
    stubFetch({ ok: true, json: async () => ({ sid: 'SM_OUT_1' }) });

    const result = await configuredAdapter().sendMessage(TEXT_MESSAGE);

    expect(result).toMatchObject({ success: true, externalMessageId: 'SM_OUT_1' });
    expect(postedParams().get('Body')).toBe('Your site visit is confirmed');
    expect(postedParams().get('To')).toBe(TO_NUMBER);
    expect(postedParams().get('From')).toBe(FROM_NUMBER);
  });

  it('falls back to the message\'s own channel account when no from-number is configured', async () => {
    stubFetch({ ok: true, json: async () => ({ sid: 'SM_OUT_2' }) });

    const adapter = new SmsAdapter(
      makeConfig({
        'twilio.accountSid': ACCOUNT_SID,
        'twilio.authToken': AUTH_TOKEN,
        'app.env': 'development',
      }),
    );
    await adapter.sendMessage(TEXT_MESSAGE);

    expect(postedParams().get('From')).toBe(FROM_NUMBER);
  });

  it('sends an image as a MediaUrl with the caption as the body', async () => {
    stubFetch({ ok: true, json: async () => ({ sid: 'SM_OUT_3' }) });

    await configuredAdapter().sendMessage({
      ...TEXT_MESSAGE,
      content: {
        type: MessageContentType.IMAGE,
        url: 'https://cdn.gosumo.test/floorplan.png',
        caption: 'Floor plan',
      },
    } as OutboundMessage);

    expect(postedParams().get('MediaUrl')).toBe('https://cdn.gosumo.test/floorplan.png');
    expect(postedParams().get('Body')).toBe('Floor plan');
  });

  it('sends an empty body for an image with no caption', async () => {
    stubFetch({ ok: true, json: async () => ({ sid: 'SM_OUT_4' }) });

    await configuredAdapter().sendMessage({
      ...TEXT_MESSAGE,
      content: { type: MessageContentType.IMAGE, url: 'https://x.test/a.png' },
    } as OutboundMessage);

    expect(postedParams().get('Body')).toBe('');
  });

  it('substitutes a placeholder for a content type SMS cannot carry', async () => {
    // Better a legible placeholder than a crash or an empty SMS the customer
    // cannot interpret.
    stubFetch({ ok: true, json: async () => ({ sid: 'SM_OUT_5' }) });

    await configuredAdapter().sendMessage({
      ...TEXT_MESSAGE,
      content: { type: MessageContentType.LOCATION, latitude: 18.5, longitude: 73.8 },
    } as OutboundMessage);

    expect(postedParams().get('Body')).toBe('[content type not supported via SMS]');
  });

  it('reports missing credentials without calling Twilio', async () => {
    fetchSpy = jest.spyOn(global, 'fetch');

    const adapter = new SmsAdapter(makeConfig({ 'app.env': 'development' }));
    const result = await adapter.sendMessage(TEXT_MESSAGE);

    expect(result.success).toBe(false);
    expect(result.error).toContain('TWILIO_ACCOUNT_SID');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a 4xx as a failure without retrying', async () => {
    // An invalid recipient does not become valid on the second attempt.
    stubFetch({
      ok: false,
      status: 400,
      json: async () => ({ message: 'The To number is not a valid phone number' }),
    });

    const result = await configuredAdapter().sendMessage(TEXT_MESSAGE);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Twilio error: The To number is not a valid phone number');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the status code when the error body has no message', async () => {
    stubFetch({ ok: false, status: 422, json: async () => ({}) });

    const result = await configuredAdapter().sendMessage(TEXT_MESSAGE);

    expect(result.error).toBe('Twilio API returned 422');
  });

  it('falls back to the status code when the error body is not JSON', async () => {
    stubFetch({
      ok: false,
      status: 400,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    });

    const result = await configuredAdapter().sendMessage(TEXT_MESSAGE);

    expect(result.error).toBe('Twilio API returned 400');
  });

  it('retries a 5xx and gives up after the configured attempts', async () => {
    // The other direction from the 4xx case: a transient Twilio outage is worth
    // retrying, so the adapter throws and lets `sendWithRetry` back off.
    stubFetch({ ok: false, status: 503, json: async () => ({ message: 'busy' }) });

    const result = await configuredAdapter().sendMessage(TEXT_MESSAGE);

    expect(result.success).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }, 15000);

  it('retries a 429 rather than treating a rate limit as terminal', async () => {
    // Twilio answers 429 when the account's send rate is exceeded; backing off
    // is the whole remedy. The previous `>= 500` check dropped it instead.
    stubFetch({ ok: false, status: 429, json: async () => ({ message: 'Too many requests' }) });

    const result = await configuredAdapter().sendMessage(TEXT_MESSAGE);

    expect(result.success).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }, 15000);

  it('accepts a success response that carries no sid', async () => {
    stubFetch({ ok: true, json: async () => ({}) });

    const result = await configuredAdapter().sendMessage(TEXT_MESSAGE);

    expect(result.success).toBe(true);
    expect(result.externalMessageId).toBeUndefined();
  });
});

describe('SmsAdapter — unsupported message kinds', () => {
  it('declines templates with a reason rather than pretending to send', async () => {
    const result = await configuredAdapter().sendTemplate({} as never);
    expect(result).toEqual({
      success: false,
      error: 'SMS does not support template messages',
    });
  });

  it('declines interactive messages with a reason', async () => {
    const result = await configuredAdapter().sendInteractive({} as never);
    expect(result).toEqual({
      success: false,
      error: 'SMS does not support interactive messages',
    });
  });

  it('advertises the SMS capability set', () => {
    expect(configuredAdapter().getCapabilities()).toMatchObject({
      channelType: ChannelType.SMS,
      supportsTemplates: false,
      supportsInteractiveMessages: false,
      supportsMedia: true,
      maxMessageLength: 1600,
    });
  });
});
