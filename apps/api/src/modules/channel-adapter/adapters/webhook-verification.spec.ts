/**
 * Webhook signature fail-closed tests.
 *
 * Root rule (CLAUDE.md #3): inbound webhook signatures are always verified.
 * Adapters may only skip verification when a secret is genuinely absent, and
 * that escape hatch must not exist in production — otherwise one missing env
 * var turns every webhook endpoint into an unauthenticated write path where
 * anyone who knows the URL can forge customer messages into a tenant's inbox.
 *
 * These tests pin the fail-closed behaviour per adapter and for the shared
 * helper both adapters delegate to.
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { RawRequest } from '@gosumo/shared';

import { WhatsAppAdapter } from './whatsapp.adapter';
import { InstagramAdapter } from './instagram.adapter';
import { SmsAdapter } from './sms.adapter';
import { allowUnverifiedWebhook, isProductionEnv } from './webhook-verification.util';

/**
 * ConfigService stub. `env` drives the fail-closed switch; every other key
 * resolves from `values`, defaulting to '' (i.e. "secret not configured").
 */
function makeConfig(env: string, values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: string) => {
      if (key === 'app.env') return env;
      return values[key] ?? fallback ?? '';
    },
  } as unknown as ConfigService;
}

const UNSIGNED_REQUEST: RawRequest = {
  headers: {},
  body: { hello: 'world' },
  rawBody: Buffer.from(JSON.stringify({ hello: 'world' })),
};

// ─────────────────────────────────────────────
// Shared helper
// ─────────────────────────────────────────────

describe('allowUnverifiedWebhook', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = { warn: jest.fn(), error: jest.fn() } as unknown as Logger;
  });

  it('permits the skip outside production and warns', () => {
    expect(allowUnverifiedWebhook(logger, false, 'secret missing')).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('refuses the skip in production and logs an error', () => {
    expect(allowUnverifiedWebhook(logger, true, 'secret missing')).toBe(false);
    expect(logger.error).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('isProductionEnv', () => {
  it('is true only for NODE_ENV=production', () => {
    expect(isProductionEnv(makeConfig('production'))).toBe(true);
    expect(isProductionEnv(makeConfig('development'))).toBe(false);
    expect(isProductionEnv(makeConfig('test'))).toBe(false);
    expect(isProductionEnv(makeConfig('staging'))).toBe(false);
  });

  it('does not treat a production-like string as production', () => {
    // Guards against a loose `includes`-style check creeping in.
    expect(isProductionEnv(makeConfig('preproduction'))).toBe(false);
    expect(isProductionEnv(makeConfig('PRODUCTION'))).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Per-adapter fail-closed behaviour
// ─────────────────────────────────────────────

describe('Adapter webhook verification — missing secret', () => {
  it('WhatsApp accepts unverified webhooks in development', () => {
    const adapter = new WhatsAppAdapter(makeConfig('development'));
    expect(adapter.validateWebhook(UNSIGNED_REQUEST)).toBe(true);
  });

  it('WhatsApp REJECTS unverified webhooks in production', () => {
    const adapter = new WhatsAppAdapter(makeConfig('production'));
    expect(adapter.validateWebhook(UNSIGNED_REQUEST)).toBe(false);
  });

  it('Instagram accepts unverified webhooks in development', () => {
    const adapter = new InstagramAdapter(makeConfig('development'));
    expect(adapter.validateWebhook(UNSIGNED_REQUEST)).toBe(true);
  });

  it('Instagram REJECTS unverified webhooks in production', () => {
    const adapter = new InstagramAdapter(makeConfig('production'));
    expect(adapter.validateWebhook(UNSIGNED_REQUEST)).toBe(false);
  });

  it('SMS accepts unverified webhooks in development', () => {
    const adapter = new SmsAdapter(makeConfig('development'));
    expect(adapter.validateWebhook(UNSIGNED_REQUEST)).toBe(true);
  });

  it('SMS REJECTS unverified webhooks in production', () => {
    const adapter = new SmsAdapter(makeConfig('production'));
    expect(adapter.validateWebhook(UNSIGNED_REQUEST)).toBe(false);
  });
});

describe('SmsAdapter — signature verification', () => {
  const AUTH_TOKEN = 'twilio-test-auth-token';

  function smsAdapter(env: string): SmsAdapter {
    return new SmsAdapter(makeConfig(env, { 'twilio.authToken': AUTH_TOKEN }));
  }

  /** Build a Twilio-style signed request for the given body. */
  function signedTwilioRequest(
    body: Record<string, string>,
    token = AUTH_TOKEN,
  ): RawRequest {
    const url = 'https://api.gosumo.test/webhooks/sms';
    let dataString = url;
    for (const key of Object.keys(body).sort()) {
      dataString += key + body[key];
    }
    const signature = crypto
      .createHmac('sha1', token)
      .update(dataString)
      .digest('base64');

    return {
      headers: {
        'x-twilio-signature': signature,
        'x-forwarded-proto': 'https',
        host: 'api.gosumo.test',
        'x-original-url': '/webhooks/sms',
      },
      body,
    };
  }

  it('accepts a correctly signed Twilio webhook', () => {
    const body = { From: '+919876543210', Body: 'Hi', MessageSid: 'SM1' };
    expect(smsAdapter('production').validateWebhook(signedTwilioRequest(body))).toBe(true);
  });

  it('rejects a webhook signed with the wrong token', () => {
    const body = { From: '+919876543210', Body: 'Hi', MessageSid: 'SM1' };
    const req = signedTwilioRequest(body, 'attacker-token');
    expect(smsAdapter('production').validateWebhook(req)).toBe(false);
  });

  it('rejects when the body has been tampered with after signing', () => {
    const req = signedTwilioRequest({ From: '+919876543210', Body: 'Hi', MessageSid: 'SM1' });
    (req.body as Record<string, string>)['Body'] = 'Send money now';
    expect(smsAdapter('production').validateWebhook(req)).toBe(false);
  });

  it('rejects a missing X-Twilio-Signature header even in development', () => {
    const req = signedTwilioRequest({ From: '+919876543210', Body: 'Hi' });
    delete req.headers['x-twilio-signature'];
    // A configured token means the signature is checkable, so its absence is
    // a real rejection — not the "cannot verify" escape hatch.
    expect(smsAdapter('development').validateWebhook(req)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on length mismatch; the adapter must guard it.
    const req = signedTwilioRequest({ From: '+919876543210', Body: 'Hi' });
    req.headers['x-twilio-signature'] = 'short';
    expect(() => smsAdapter('production').validateWebhook(req)).not.toThrow();
    expect(smsAdapter('production').validateWebhook(req)).toBe(false);
  });

  it('REJECTS in production when the Host header is missing', () => {
    // Without Host the signed URL cannot be rebuilt, so the signature is
    // uncheckable — previously this returned true and bypassed verification.
    const req = signedTwilioRequest({ From: '+919876543210', Body: 'Hi' });
    delete req.headers['host'];
    expect(smsAdapter('production').validateWebhook(req)).toBe(false);
  });

  it('does not throw when the body is absent', () => {
    const req: RawRequest = {
      headers: {
        'x-twilio-signature': 'sig',
        host: 'api.gosumo.test',
        'x-original-url': '/webhooks/sms',
      },
      body: undefined as unknown as Record<string, string>,
    };
    expect(() => smsAdapter('production').validateWebhook(req)).not.toThrow();
  });
});
