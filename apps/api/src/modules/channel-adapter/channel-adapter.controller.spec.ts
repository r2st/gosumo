/**
 * ChannelAdapterController — webhook entry-point unit tests.
 *
 * These endpoints are `@Public()` and answer to whatever a provider (or anyone
 * else) posts at them, so the branches that matter are the defensive ones: the
 * error paths that must still return 200 rather than invite a retry storm, and
 * the header normalisation that HMAC verification reads its signature out of.
 *
 * The happy paths are covered by the adapter and service suites; this file is
 * about what happens when the input is not what the code hoped for.
 */

import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { ChannelType } from '@gosumo/shared';
import { ChannelAdapterController } from './channel-adapter.controller';
import { ChannelAdapterService } from './channel-adapter.service';
import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
import { InstagramAdapter } from './adapters/instagram.adapter';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

function makeRequest(over: Partial<Request> = {}): Request {
  return { query: {}, ...over } as Request;
}

describe('ChannelAdapterController', () => {
  let controller: ChannelAdapterController;
  let service: { handleInboundWebhook: jest.Mock };
  let error: jest.SpyInstance;

  beforeEach(() => {
    service = { handleInboundWebhook: jest.fn() };
    controller = new ChannelAdapterController(
      service as unknown as ChannelAdapterService,
      {} as WhatsAppAdapter,
      {} as InstagramAdapter,
      { get: jest.fn() } as unknown as ConfigService,
    );
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('handleGenericWebhook', () => {
    it('rejects an unknown channel before doing any work', async () => {
      await expect(
        controller.handleGenericWebhook('carrier-pigeon', makeRequest(), {}, {}),
      ).rejects.toThrow(BadRequestException);

      expect(service.handleInboundWebhook).not.toHaveBeenCalled();
    });

    it('names the valid channels in the rejection', async () => {
      // The caller is a provider integration someone is configuring; "unknown
      // channel" without the list means a trip to the source.
      await expect(
        controller.handleGenericWebhook('carrier-pigeon', makeRequest(), {}, {}),
      ).rejects.toThrow(new RegExp(ChannelType.SMS));
    });

    it('accepts a lowercase channel in the path', async () => {
      service.handleInboundWebhook.mockResolvedValue({
        externalId: 'ext-1',
        sender: { externalId: '+919876543210' },
      });

      await expect(
        controller.handleGenericWebhook('sms', makeRequest(), {}, {}),
      ).resolves.toEqual({ status: 'ok' });

      expect(service.handleInboundWebhook).toHaveBeenCalledWith(
        ChannelType.SMS,
        expect.anything(),
        'unknown',
      );
    });

    it('passes through the business id header when present', async () => {
      service.handleInboundWebhook.mockResolvedValue({
        externalId: 'ext-1',
        sender: { externalId: '+919876543210' },
      });

      await controller.handleGenericWebhook(
        'sms',
        makeRequest(),
        { 'x-business-id': BUSINESS_ID },
        {},
      );

      expect(service.handleInboundWebhook).toHaveBeenCalledWith(
        ChannelType.SMS,
        expect.anything(),
        BUSINESS_ID,
      );
    });

    /**
     * Every provider here retries a non-200, and a retry storm against a
     * handler that is already failing is how one bad payload becomes an
     * outage. The error is swallowed deliberately — but it has to be *logged*
     * legibly, which is what the two cases below are really about.
     */
    it('still answers 200 when processing throws', async () => {
      service.handleInboundWebhook.mockRejectedValue(new Error('adapter exploded'));

      await expect(
        controller.handleGenericWebhook('sms', makeRequest(), {}, {}),
      ).resolves.toEqual({ status: 'ok' });

      expect(error).toHaveBeenCalledWith(expect.stringContaining('adapter exploded'));
    });

    it('logs a readable line when something throws a non-Error', async () => {
      // A rejected promise carrying a string or a plain object is common from
      // third-party clients. Without the String() fallback the log line reads
      // "undefined" and the payload that caused it is unrecoverable.
      service.handleInboundWebhook.mockRejectedValue('socket hang up');

      await expect(
        controller.handleGenericWebhook('sms', makeRequest(), {}, {}),
      ).resolves.toEqual({ status: 'ok' });

      expect(error).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining('undefined'));
    });

    it('names the channel in the error line', async () => {
      service.handleInboundWebhook.mockRejectedValue(new Error('boom'));

      await controller.handleGenericWebhook('sms', makeRequest(), {}, {});

      expect(error).toHaveBeenCalledWith(expect.stringContaining(ChannelType.SMS));
    });
  });

  /**
   * Header normalisation feeds signature verification: the HMAC comparison
   * reads its header out of this map, so anything lost here fails a webhook
   * closed (or, worse, compares against the wrong string).
   */
  describe('raw request construction', () => {
    const build = (headers: Record<string, unknown>, req = makeRequest()) => {
      service.handleInboundWebhook.mockResolvedValue({
        externalId: 'ext-1',
        sender: { externalId: 'x' },
      });
      return controller
        .handleGenericWebhook('sms', req, headers as Record<string, string>, { a: 1 })
        .then(() => service.handleInboundWebhook.mock.calls[0]![1] as {
          headers: Record<string, string>;
          body: unknown;
          rawBody?: Buffer;
          query: Record<string, string>;
        });
    };

    it('lowercases header names', async () => {
      const raw = await build({ 'X-Hub-Signature-256': 'sha256=abc' });
      expect(raw.headers['x-hub-signature-256']).toBe('sha256=abc');
    });

    it('joins a repeated header rather than dropping it', async () => {
      // Express hands back an array when a header appears more than once.
      // Taking `[0]` — or letting the array through as-is — would change the
      // bytes the signature is compared against.
      const raw = await build({ 'x-forwarded-for': ['203.0.113.7', '10.0.0.1'] });
      expect(raw.headers['x-forwarded-for']).toBe('203.0.113.7, 10.0.0.1');
    });

    it('normalises a missing header value to an empty string', async () => {
      // The consumers index this map and expect a string; undefined here turns
      // a missing signature into a TypeError instead of a clean rejection.
      const raw = await build({ 'x-signature': undefined });
      expect(raw.headers['x-signature']).toBe('');
    });

    it('carries the raw body through for HMAC verification', async () => {
      // Root rule #3: the signature is over the exact bytes received, so the
      // parsed body is not a substitute. This is the plumbing that provides it.
      const rawBody = Buffer.from('{"a":1}');
      const raw = await build({}, makeRequest({ rawBody } as Partial<Request>));
      expect(raw.rawBody).toBe(rawBody);
    });

    it('leaves rawBody undefined when Nest did not populate it', async () => {
      const raw = await build({});
      expect(raw.rawBody).toBeUndefined();
    });

    it('passes the parsed body and query through unchanged', async () => {
      const raw = await build({}, makeRequest({ query: { token: 't' } } as Partial<Request>));
      expect(raw.body).toEqual({ a: 1 });
      expect(raw.query).toEqual({ token: 't' });
    });
  });
});
