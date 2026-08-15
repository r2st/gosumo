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
  // The DLQ-backed wrappers the controller actually calls. They own the
  // try/catch now, so the controller must *not* have one of its own — a
  // handler that swallows on its way past these would defeat the capture.
  const handleMetaLeadgenDelivery = jest
    .fn()
    .mockResolvedValue({ total: 0, created: 0, merged: 0, skipped: 0, failed: 0, errors: [] });
  const handlePortalEmailDelivery = jest.fn().mockResolvedValue(null);
  const importCsv = jest.fn().mockResolvedValue({ imported: 0 });
  const ingestCtwa = jest.fn().mockResolvedValue({ leadId: 'l1' });
  const verifyMetaSignature = jest.fn().mockReturnValue(true);
  const resolveMetaChallenge = jest.fn().mockReturnValue('challenge-echo');

  const ingestionService = {
    ingestMetaLeadgen,
    ingestPortalEmail,
    handleMetaLeadgenDelivery,
    handlePortalEmailDelivery,
    importCsv,
    ingestCtwa,
    verifyMetaSignature,
    resolveMetaChallenge,
  } as unknown as RealtyIngestionService;

  const processIvrCallback = jest.fn().mockResolvedValue(undefined);
  const handleIvrDelivery = jest.fn().mockResolvedValue(null);
  const verifyIvrSignature = jest.fn().mockReturnValue(true);
  const ivrService = {
    processIvrCallback,
    handleIvrDelivery,
    verifyIvrSignature,
  } as unknown as RealtyIvrService;

  const config = {
    get: (key: string, fallback?: unknown) => configValues[key] ?? fallback,
  } as unknown as ConfigService;

  const controller = new RealtyIngestionController(ingestionService, ivrService, config);

  return {
    controller,
    ingestMetaLeadgen,
    ingestPortalEmail,
    handleMetaLeadgenDelivery,
    handlePortalEmailDelivery,
    importCsv,
    ingestCtwa,
    verifyMetaSignature,
    resolveMetaChallenge,
    processIvrCallback,
    handleIvrDelivery,
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

      expect(h.handleIvrDelivery).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ phone: '+919876543210', provider: 'exotel' }),
        expect.anything(),
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

      expect(h.handleIvrDelivery).not.toHaveBeenCalled();
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

      expect(h.handleIvrDelivery).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no caller phone'));
    });

    /** The gateway sets x-business-id; a webhook that arrives without it is still 200. */
    it('falls back to "unknown" when the business header is absent', async () => {
      const h = makeHarness();

      await h.controller.handleIvrCallback(req(), 'sig', undefined as unknown as string, call);

      expect(h.handleIvrDelivery).toHaveBeenCalledWith(
        'unknown',
        expect.anything(),
        expect.anything(),
      );
    });

    /**
     * The controller no longer owns a catch: it routes through the DLQ-backed
     * wrapper, whose whole job is to park the failure before returning. A
     * `try { … } catch { log }` here would re-swallow the delivery *after*
     * capture and quietly re-open the hole this route used to have.
     */
    it('routes a processing failure through the DLQ wrapper, not a local catch', async () => {
      const h = makeHarness();

      await expect(
        h.controller.handleIvrCallback(req(), 'sig', BUSINESS_ID, call),
      ).resolves.toEqual({ status: 'ok' });

      expect(h.handleIvrDelivery).toHaveBeenCalledTimes(1);
      // `processIvrCallback` is the un-parked path — reaching it directly would
      // mean the capture wrapper was bypassed.
      expect(h.processIvrCallback).not.toHaveBeenCalled();
    });

    it('still acknowledges 200 when the delivery could not be handled', async () => {
      const h = makeHarness();
      // What the wrapper returns after dead-lettering: it absorbs the error and
      // reports nothing processed.
      h.handleIvrDelivery.mockResolvedValue(null);

      await expect(
        h.controller.handleIvrCallback(req(), 'sig', BUSINESS_ID, call),
      ).resolves.toEqual({ status: 'ok' });
    });

    /**
     * If the wrapper itself ever threw, the provider would get a 500 and retry
     * into an endpoint that keeps failing. The wrapper is written not to; this
     * pins the controller's side of that contract.
     */
    it('carries the tenant header through to the capture metadata', async () => {
      const h = makeHarness();

      await h.controller.handleIvrCallback(req(), 'sig', BUSINESS_ID, call);

      expect(h.handleIvrDelivery).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.anything(),
        expect.objectContaining({ 'x-business-id': BUSINESS_ID }),
      );
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

      expect(h.handleMetaLeadgenDelivery).toHaveBeenCalledWith(
        BUSINESS_ID,
        { entry: [] },
        expect.anything(),
      );
    });

    it('discards an unsigned payload but still answers 200', async () => {
      const h = makeHarness();
      h.verifyMetaSignature.mockReturnValue(false);

      await expect(
        h.controller.handleLeadgenWebhook(req(), 'sha256=forged', BUSINESS_ID, { entry: [] }),
      ).resolves.toEqual({ status: 'ok' });

      expect(h.handleMetaLeadgenDelivery).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid signature'));
    });

    it('falls back to "unknown" without the business header', async () => {
      const h = makeHarness();

      await h.controller.handleLeadgenWebhook(req(), 'sig', undefined as unknown as string, {});

      expect(h.handleMetaLeadgenDelivery).toHaveBeenCalledWith(
        'unknown',
        {},
        expect.anything(),
      );
    });

    /**
     * The DLQ-backed wrapper is the only path to ingestion. Calling the bare
     * `ingestMetaLeadgen` from here would skip the capture — and because that
     * method reports per-candidate failures in a summary rather than throwing,
     * skipping the capture is exactly how a paid Lead Ad used to vanish behind
     * a 200 with nothing but a log line left of it.
     */
    it('ingests only through the capturing wrapper', async () => {
      const h = makeHarness();

      await h.controller.handleLeadgenWebhook(req(), 'sig', BUSINESS_ID, { entry: [] });

      expect(h.handleMetaLeadgenDelivery).toHaveBeenCalledTimes(1);
      expect(h.ingestMetaLeadgen).not.toHaveBeenCalled();
    });

    it('acknowledges 200 even when every candidate in the batch failed', async () => {
      const h = makeHarness();
      h.handleMetaLeadgenDelivery.mockResolvedValue({
        total: 2,
        created: 0,
        merged: 0,
        skipped: 0,
        failed: 2,
        errors: [{ row: 1, reason: 'qdrant down' }],
      });

      await expect(
        h.controller.handleLeadgenWebhook(req(), 'sig', BUSINESS_ID, {}),
      ).resolves.toEqual({ status: 'ok' });
    });

    it('carries the tenant header through to the capture metadata', async () => {
      const h = makeHarness();

      await h.controller.handleLeadgenWebhook(req(), 'sig', BUSINESS_ID, {});

      expect(h.handleMetaLeadgenDelivery).toHaveBeenCalledWith(
        BUSINESS_ID,
        {},
        expect.objectContaining({ 'x-business-id': BUSINESS_ID }),
      );
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
      expect(h.handlePortalEmailDelivery).toHaveBeenCalledWith(
        BUSINESS_ID,
        dto,
        expect.anything(),
      );
    });

    /** Unlike the HMAC webhooks this one 401s — it is not provider-retried. */
    it('rejects a wrong token', async () => {
      const h = makeHarness({ [TOKEN_KEY]: 'secret' });

      await expect(
        h.controller.handlePortalEmail('guessed', BUSINESS_ID, dto),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.handlePortalEmailDelivery).not.toHaveBeenCalled();
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
      expect(h.handlePortalEmailDelivery).not.toHaveBeenCalled();
    });

    it('allows an unauthenticated call outside production when no token is configured', async () => {
      const h = makeHarness({ [TOKEN_KEY]: '', 'app.env': 'development' });

      await expect(h.controller.handlePortalEmail('', BUSINESS_ID, dto)).resolves.toEqual({
        status: 'ok',
      });
      expect(h.handlePortalEmailDelivery).toHaveBeenCalled();
    });

    it('falls back to "unknown" without the business header', async () => {
      const h = makeHarness({ [TOKEN_KEY]: 'secret' });

      await h.controller.handlePortalEmail('secret', undefined as unknown as string, dto);

      expect(h.handlePortalEmailDelivery).toHaveBeenCalledWith(
        'unknown',
        dto,
        expect.anything(),
      );
    });

    /**
     * Same contract as the other two: the capturing wrapper is the only path
     * in, so an enquiry whose write failed is parked rather than logged away.
     */
    it('ingests only through the capturing wrapper', async () => {
      const h = makeHarness({ [TOKEN_KEY]: 'secret' });

      await h.controller.handlePortalEmail('secret', BUSINESS_ID, dto);

      expect(h.handlePortalEmailDelivery).toHaveBeenCalledTimes(1);
      expect(h.ingestPortalEmail).not.toHaveBeenCalled();
    });

    it('acknowledges 200 when the wrapper reports nothing ingested', async () => {
      const h = makeHarness({ [TOKEN_KEY]: 'secret' });
      // What the wrapper returns after dead-lettering a failed enquiry.
      h.handlePortalEmailDelivery.mockResolvedValue(null);

      await expect(h.controller.handlePortalEmail('secret', BUSINESS_ID, dto)).resolves.toEqual({
        status: 'ok',
      });
    });

    it('carries the tenant header through to the capture metadata', async () => {
      const h = makeHarness({ [TOKEN_KEY]: 'secret' });

      await h.controller.handlePortalEmail('secret', BUSINESS_ID, dto);

      expect(h.handlePortalEmailDelivery).toHaveBeenCalledWith(
        BUSINESS_ID,
        dto,
        expect.objectContaining({ 'x-business-id': BUSINESS_ID }),
      );
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
