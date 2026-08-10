/**
 * Webhook signature fail-closed tests.
 *
 * Root rule (CLAUDE.md #3): inbound webhook signatures are always verified.
 * Adapters may only skip verification when a secret is genuinely absent, and
 * that escape hatch must not exist in production — otherwise one missing env
 * var turns every webhook endpoint into an unauthenticated write path where
 * anyone who knows the URL can forge customer messages into a tenant's inbox.
 *
 * These tests pin the fail-closed behaviour for every inbound webhook surface —
 * the three channel adapters and the three realty-ingestion endpoints (IVR,
 * Meta Leadgen, portal email) — plus the shared helper they all delegate to.
 */

import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { RawRequest } from '@gosumo/shared';

import { WhatsAppAdapter } from '../../modules/channel-adapter/adapters/whatsapp.adapter';
import { InstagramAdapter } from '../../modules/channel-adapter/adapters/instagram.adapter';
import { SmsAdapter } from '../../modules/channel-adapter/adapters/sms.adapter';
import { RealtyIngestionService } from '../../modules/realty-ingestion/realty-ingestion.service';
import { RealtyIvrService } from '../../modules/realty-ingestion/realty-ivr.service';
import { RealtyIngestionController } from '../../modules/realty-ingestion/realty-ingestion.controller';
import type { PortalEmailDto } from '../../modules/realty-ingestion/dto';
import type { RealtyLeadsService } from '../../modules/realty-leads/realty-leads.service';
import type { ChannelAdapterService } from '../../modules/channel-adapter/channel-adapter.service';
import type { PrismaService } from '../services/prisma.service';
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

// ─────────────────────────────────────────────
// realty-ingestion webhooks
// ─────────────────────────────────────────────

/**
 * The realty lead webhooks are a second, separately-written family of public
 * endpoints. They each had their own "no secret configured → return true"
 * branch, so a missing env var accepted forged leads into a broker's pipeline
 * in production exactly the way the adapters used to accept forged messages.
 * They now share the helper; these tests hold that line.
 */
describe('realty-ingestion webhook verification — missing secret', () => {
  const BODY = Buffer.from(JSON.stringify({ entry: [] }));

  function ivrService(env: string, secret = ''): RealtyIvrService {
    return new RealtyIvrService(
      {} as RealtyLeadsService,
      {} as ChannelAdapterService,
      {} as PrismaService,
      makeConfig(env, secret ? { 'realty.ivrWebhookSecret': secret } : {}),
    );
  }

  function ingestionService(env: string, secret = ''): RealtyIngestionService {
    return new RealtyIngestionService(
      {} as RealtyLeadsService,
      makeConfig(env, secret ? { 'whatsapp.appSecret': secret } : {}),
    );
  }

  it('IVR accepts an unverifiable webhook in development', () => {
    expect(ivrService('development').verifyIvrSignature(BODY, 'anything')).toBe(true);
  });

  it('IVR REJECTS an unverifiable webhook in production', () => {
    expect(ivrService('production').verifyIvrSignature(BODY, 'anything')).toBe(false);
  });

  it('IVR still verifies normally once the secret is configured', () => {
    const secret = 'ivr-secret';
    const hex = crypto.createHmac('sha256', secret).update(BODY).digest('hex');
    const service = ivrService('production', secret);
    expect(service.verifyIvrSignature(BODY, hex)).toBe(true);
    expect(service.verifyIvrSignature(BODY, `sha256=${hex}`)).toBe(true);
    expect(service.verifyIvrSignature(BODY, hex.replace(/^./, 'f'))).toBe(false);
  });

  it('Meta Leadgen accepts an unverifiable webhook in development', () => {
    expect(ingestionService('development').verifyMetaSignature(BODY, 'sha256=x')).toBe(true);
  });

  it('Meta Leadgen REJECTS an unverifiable webhook in production', () => {
    expect(ingestionService('production').verifyMetaSignature(BODY, 'sha256=x')).toBe(false);
  });

  it('Meta Leadgen still verifies normally once the app secret is configured', () => {
    const secret = 'meta-secret';
    const expected =
      'sha256=' + crypto.createHmac('sha256', secret).update(BODY).digest('hex');
    const service = ingestionService('production', secret);
    expect(service.verifyMetaSignature(BODY, expected)).toBe(true);
    expect(service.verifyMetaSignature(BODY, expected.replace(/.$/, '0'))).toBe(false);
    // A configured secret makes the signature checkable, so an absent header or
    // body is a rejection rather than the "cannot verify" escape hatch.
    expect(service.verifyMetaSignature(BODY, undefined)).toBe(false);
    expect(service.verifyMetaSignature(undefined, expected)).toBe(false);
  });
});

describe('portal-email webhook — missing ingest token', () => {
  const DTO = { from: 'noreply@99acres.com', subject: 'New enquiry', body: '' } as PortalEmailDto;

  function controller(env: string, token = '') {
    const ingestion = {
      ingestPortalEmail: jest.fn().mockResolvedValue({ ingested: 1 }),
    } as unknown as RealtyIngestionService;
    const config = makeConfig(env, token ? { 'realty.portalIngestToken': token } : {});
    return {
      ingestion,
      controller: new RealtyIngestionController(
        ingestion,
        {} as RealtyIvrService,
        config,
      ),
    };
  }

  it('accepts an untokened post in development', async () => {
    const { controller: c, ingestion } = controller('development');
    await expect(c.handlePortalEmail('', 'biz_1', DTO)).resolves.toEqual({ status: 'ok' });
    expect(ingestion.ingestPortalEmail).toHaveBeenCalled();
  });

  it('REJECTS an untokened post in production rather than accepting everyone', async () => {
    const { controller: c, ingestion } = controller('production');
    await expect(c.handlePortalEmail('', 'biz_1', DTO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(ingestion.ingestPortalEmail).not.toHaveBeenCalled();
  });

  it('rejects a wrong token and accepts the configured one', async () => {
    const { controller: c, ingestion } = controller('production', 'right-token');
    await expect(c.handlePortalEmail('wrong-token', 'biz_1', DTO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(c.handlePortalEmail('right-token', 'biz_1', DTO)).resolves.toEqual({
      status: 'ok',
    });
    expect(ingestion.ingestPortalEmail).toHaveBeenCalledTimes(1);
  });

  it('swallows a downstream failure and still acks', async () => {
    const { controller: c, ingestion } = controller('development');
    (ingestion.ingestPortalEmail as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    await expect(c.handlePortalEmail('', 'biz_1', DTO)).resolves.toEqual({ status: 'ok' });
  });

  it('falls back to an "unknown" tenant when the gateway header is absent', async () => {
    const { controller: c, ingestion } = controller('development');
    await c.handlePortalEmail('', undefined as unknown as string, DTO);
    expect(ingestion.ingestPortalEmail).toHaveBeenCalledWith('unknown', DTO);
  });
});
