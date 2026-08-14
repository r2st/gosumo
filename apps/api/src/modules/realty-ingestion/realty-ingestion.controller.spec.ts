/**
 * RealtyIngestionController unit tests.
 *
 * This controller is the product's unauthenticated ingress: three `@Public()`
 * webhooks that carry lead data from IVR providers, Meta Lead Ads and the
 * property portals. Everything they receive is attacker-reachable, so the tests
 * here are about the gate rather than the happy path — who gets turned away,
 * what a rejection returns, and what a failure downstream is allowed to leak.
 *
 * Two conventions are load-bearing and easy to regress:
 *  1. A rejected or failed webhook still answers 200. A 4xx/5xx puts Meta and
 *     the IVR providers into a retry storm against an endpoint that will keep
 *     failing.
 *  2. Rejection must be silent to the caller — the body never says whether it
 *     was the signature, the payload or the processing that failed, so the
 *     endpoint cannot be used as an oracle.
 *
 * Services are mocked; no HTTP server is booted.
 */

import { Logger, UnauthorizedException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { RealtyIngestionController } from './realty-ingestion.controller';
import { RealtyIngestionService } from './realty-ingestion.service';
import { RealtyIvrService } from './realty-ivr.service';
import type { CsvImportDto, PortalEmailDto, CtwaContextDto } from './dto';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

function makeHarness(configValues: Record<string, unknown> = {}) {
  const ingestMetaLeadgen = jest.fn().mockResolvedValue(undefined);
  const ingestPortalEmail = jest.fn().mockResolvedValue(undefined);
  const importCsv = jest.fn().mockResolvedValue({ imported: 0 });
  const ingestCtwa = jest.fn().mockResolvedValue({ leadId: 'l1' });
  const verifyMetaSignature = jest.fn().mockReturnValue(true);
  const resolveMetaChallenge = jest.fn().mockReturnValue('challenge-echo');

  const ingestionService = {
    ingestMetaLeadgen,
    ingestPortalEmail,
    importCsv,
    ingestCtwa,
    verifyMetaSignature,
    resolveMetaChallenge,
  } as unknown as RealtyIngestionService;

  const processIvrCallback = jest.fn().mockResolvedValue(undefined);
  const verifyIvrSignature = jest.fn().mockReturnValue(true);
  const ivrService = { processIvrCallback, verifyIvrSignature } as unknown as RealtyIvrService;

  const config = {
    get: (key: string, fallback?: unknown) => configValues[key] ?? fallback,
  } as unknown as ConfigService;

  const controller = new RealtyIngestionController(ingestionService, ivrService, config);

  return {
    controller,
    ingestMetaLeadgen,
    ingestPortalEmail,
    importCsv,
    ingestCtwa,
    verifyMetaSignature,
    resolveMetaChallenge,
    processIvrCallback,
    verifyIvrSignature,
  };
}

/** An express Request carrying the raw body the HMAC checks read. */
function req(rawBody = '{}'): Request {
  return { rawBody: Buffer.from(rawBody) } as unknown as Request;
}

/** An express Request where the rawBody middleware never populated anything. */
function reqWithoutRawBody(): Request {
  return {} as unknown as Request;
}

describe('RealtyIngestionController', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // ── IVR missed-call webhook ──

  describe('handleIvrCallback', () => {
    // Exotel's shape — the parser detects the provider from these field names.
    const call = { CallFrom: '+919876543210', CallTo: '+918000000000' };

    it('processes a signed callback with a caller phone', async () => {
      const h = makeHarness();

      await expect(
        h.controller.handleIvrCallback(req(), 'sig', BUSINESS_ID, call),
      ).resolves.toEqual({ status: 'ok' });

      expect(h.processIvrCallback).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ phone: '+919876543210', provider: 'exotel' }),
      );
    });

    /**
     * A bad signature must not reach the service, and must still return 200 —
     * a 401 here teaches a prober exactly when it has guessed right, and puts
     * the provider into a retry loop.
     */
    it('discards a callback whose signature does not verify', async () => {
      const h = makeHarness();
      h.verifyIvrSignature.mockReturnValue(false);

      await expect(
        h.controller.handleIvrCallback(req(), 'forged', BUSINESS_ID, call),
      ).resolves.toEqual({ status: 'ok' });

      expect(h.processIvrCallback).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid signature'));
    });

    it('passes the raw body, not the parsed one, to the signature check', async () => {
      const h = makeHarness();
      const request = req('{"raw":true}');

      await h.controller.handleIvrCallback(request, 'sig', BUSINESS_ID, { parsed: true });

      // Verifying the re-serialised body would fail on any key-order change.
      expect(h.verifyIvrSignature).toHaveBeenCalledWith(Buffer.from('{"raw":true}'), 'sig');
    });

    it('tolerates a request that carries no raw body at all', async () => {
      const h = makeHarness();
      h.verifyIvrSignature.mockReturnValue(false);

      await expect(
        h.controller.handleIvrCallback(reqWithoutRawBody(), 'sig', BUSINESS_ID, call),
      ).resolves.toEqual({ status: 'ok' });
      expect(h.verifyIvrSignature).toHaveBeenCalledWith(undefined, 'sig');
    });

    it('ignores a payload with no caller phone', async () => {
      const h = makeHarness();

      await expect(
        h.controller.handleIvrCallback(req(), 'sig', BUSINESS_ID, { nothing: 'useful' }),
      ).resolves.toEqual({ status: 'ok' });

      expect(h.processIvrCallback).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no caller phone'));
    });

    /** The gateway sets x-business-id; a webhook that arrives without it is still 200. */
    it('falls back to "unknown" when the business header is absent', async () => {
      const h = makeHarness();

      await h.controller.handleIvrCallback(req(), 'sig', undefined as unknown as string, call);

      expect(h.processIvrCallback).toHaveBeenCalledWith('unknown', expect.anything());
    });

    it('swallows a processing failure and still acknowledges', async () => {
      const h = makeHarness();
      h.processIvrCallback.mockRejectedValue(new Error('lead table is gone'));

      await expect(
        h.controller.handleIvrCallback(req(), 'sig', BUSINESS_ID, call),
      ).resolves.toEqual({ status: 'ok' });

      expect(error).toHaveBeenCalledWith(expect.stringContaining('lead table is gone'));
    });

    it('reports a non-Error rejection rather than "[object Object]"', async () => {
      const h = makeHarness();
      h.processIvrCallback.mockRejectedValue('connection reset');

      await h.controller.handleIvrCallback(req(), 'sig', BUSINESS_ID, call);

      expect(error).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
    });
  });

  // ── Meta Leadgen ──

  describe('handleLeadgenVerification', () => {
    function res() {
      const r = { status: jest.fn().mockReturnThis(), send: jest.fn(), json: jest.fn() };
      return r as unknown as Response & typeof r;
    }

    it('echoes the challenge when the token matches', () => {
      const h = makeHarness();
      const r = res();

      h.controller.handleLeadgenVerification('subscribe', 'tok', 'challenge-echo', r);

      expect(r.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(r.send).toHaveBeenCalledWith('challenge-echo');
    });

    it('403s when the challenge cannot be resolved', () => {
      const h = makeHarness();
      h.resolveMetaChallenge.mockReturnValue(null);
      const r = res();

      h.controller.handleLeadgenVerification('subscribe', 'wrong', 'c', r);

      expect(r.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
      expect(r.json).toHaveBeenCalledWith({ message: 'Verification failed' });
      expect(r.send).not.toHaveBeenCalled();
    });
  });

  describe('handleLeadgenWebhook', () => {
    it('ingests a correctly signed payload', async () => {
      const h = makeHarness();

      await expect(
        h.controller.handleLeadgenWebhook(req(), 'sha256=good', BUSINESS_ID, { entry: [] }),
      ).resolves.toEqual({ status: 'ok' });

      expect(h.ingestMetaLeadgen).toHaveBeenCalledWith(BUSINESS_ID, { entry: [] });
    });

    it('discards an unsigned payload but still answers 200', async () => {
      const h = makeHarness();
      h.verifyMetaSignature.mockReturnValue(false);

      await expect(
        h.controller.handleLeadgenWebhook(req(), 'sha256=forged', BUSINESS_ID, { entry: [] }),
      ).resolves.toEqual({ status: 'ok' });

      expect(h.ingestMetaLeadgen).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid signature'));
    });

    it('falls back to "unknown" without the business header', async () => {
      const h = makeHarness();

      await h.controller.handleLeadgenWebhook(req(), 'sig', undefined as unknown as string, {});

      expect(h.ingestMetaLeadgen).toHaveBeenCalledWith('unknown', {});
    });

    it('swallows an ingestion failure and acknowledges', async () => {
      const h = makeHarness();
      h.ingestMetaLeadgen.mockRejectedValue(new Error('qdrant down'));

      await expect(
        h.controller.handleLeadgenWebhook(req(), 'sig', BUSINESS_ID, {}),
      ).resolves.toEqual({ status: 'ok' });

      expect(error).toHaveBeenCalledWith(expect.stringContaining('qdrant down'));
    });

    it('reports a non-Error ingestion rejection', async () => {
      const h = makeHarness();
      h.ingestMetaLeadgen.mockRejectedValue('socket hang up');

      await h.controller.handleLeadgenWebhook(req(), 'sig', BUSINESS_ID, {});

      expect(error).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
    });
  });

  // ── Portal enquiry email ──

  describe('handlePortalEmail', () => {
    const dto = { from: 'leads@99acres.com', subject: 'New enquiry', body: '...' } as PortalEmailDto;
    const TOKEN_KEY = 'realty.portalIngestToken';

    it('accepts a request carrying the configured token', async () => {
      const h = makeHarness({ [TOKEN_KEY]: 'secret' });

      await expect(h.controller.handlePortalEmail('secret', BUSINESS_ID, dto)).resolves.toEqual({
        status: 'ok',
      });
      expect(h.ingestPortalEmail).toHaveBeenCalledWith(BUSINESS_ID, dto);
    });

    /** Unlike the HMAC webhooks this one 401s — it is not provider-retried. */
    it('rejects a wrong token', async () => {
      const h = makeHarness({ [TOKEN_KEY]: 'secret' });

      await expect(
        h.controller.handlePortalEmail('guessed', BUSINESS_ID, dto),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.ingestPortalEmail).not.toHaveBeenCalled();
    });

    it('rejects a missing token', async () => {
      const h = makeHarness({ [TOKEN_KEY]: 'secret' });

      await expect(
        h.controller.handlePortalEmail(undefined as unknown as string, BUSINESS_ID, dto),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    /**
     * With no token configured the endpoint cannot tell anyone apart. Outside
     * production that is a developer convenience; in production it would mean
     * an open lead-injection endpoint, so it authenticates no one instead.
     */
    it('refuses every caller in production when no token is configured', async () => {
      const h = makeHarness({ [TOKEN_KEY]: '', 'app.env': 'production' });

      await expect(h.controller.handlePortalEmail('anything', BUSINESS_ID, dto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(h.ingestPortalEmail).not.toHaveBeenCalled();
    });

    it('allows an unauthenticated call outside production when no token is configured', async () => {
      const h = makeHarness({ [TOKEN_KEY]: '', 'app.env': 'development' });

      await expect(h.controller.handlePortalEmail('', BUSINESS_ID, dto)).resolves.toEqual({
        status: 'ok',
      });
      expect(h.ingestPortalEmail).toHaveBeenCalled();
    });

    it('falls back to "unknown" without the business header', async () => {
      const h = makeHarness({ [TOKEN_KEY]: 'secret' });

      await h.controller.handlePortalEmail('secret', undefined as unknown as string, dto);

      expect(h.ingestPortalEmail).toHaveBeenCalledWith('unknown', dto);
    });

    it('swallows a processing failure and acknowledges', async () => {
      const h = makeHarness({ [TOKEN_KEY]: 'secret' });
      h.ingestPortalEmail.mockRejectedValue(new Error('parser blew up'));

      await expect(h.controller.handlePortalEmail('secret', BUSINESS_ID, dto)).resolves.toEqual({
        status: 'ok',
      });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('parser blew up'));
    });

    it('reports a non-Error processing rejection', async () => {
      const h = makeHarness({ [TOKEN_KEY]: 'secret' });
      h.ingestPortalEmail.mockRejectedValue('timeout');

      await h.controller.handlePortalEmail('secret', BUSINESS_ID, dto);

      expect(error).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    });
  });

  // ── Authenticated routes ──

  /**
   * These two take their tenant from `@TenantId()`, never from the body — a
   * businessId in the payload would be client-forgeable.
   */
  describe('authenticated routes', () => {
    it('imports CSV rows under the caller tenant', async () => {
      const h = makeHarness();
      const dto = { rows: [{ phone: '+919876543210' }] } as unknown as CsvImportDto;

      await h.controller.importCsv(BUSINESS_ID, dto);

      expect(h.importCsv).toHaveBeenCalledWith(BUSINESS_ID, dto);
    });

    it('attaches CTWA context under the caller tenant', async () => {
      const h = makeHarness();
      const dto = { adId: 'ad-1', phone: '+919876543210' } as unknown as CtwaContextDto;

      await h.controller.ingestCtwa(BUSINESS_ID, dto);

      expect(h.ingestCtwa).toHaveBeenCalledWith(BUSINESS_ID, dto);
    });
  });
});
