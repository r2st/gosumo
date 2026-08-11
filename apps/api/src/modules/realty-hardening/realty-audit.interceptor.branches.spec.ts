/**
 * RealtyAuditInterceptor — the defensive branches.
 *
 * The interceptor is registered globally, so it runs against every request
 * shape the platform can produce, not just the well-formed Express one the
 * main spec exercises. These are the degradations: a non-HTTP execution
 * context (a queue processor or a WebSocket frame), a request missing
 * `method`/`path`, a header arriving as an array, and paths whose shape the
 * resource-type map does not know about.
 *
 * The contract being protected is that none of these can throw — an audit
 * failure must never take down the request it is auditing.
 */

import { firstValueFrom, of } from 'rxjs';
import { RealtyAuditInterceptor } from './realty-audit.interceptor';

const BIZ = '00000000-0000-4000-a000-000000000001';
const LEAD = '00000000-0000-4000-a000-000000000010';
const USER = '00000000-0000-4000-a000-000000000070';

function makeContext(req: Record<string, unknown>, type = 'http') {
  return {
    getType: () => type,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ setHeader: jest.fn() }),
    }),
  } as never;
}

function makeHandler(body: unknown = { id: LEAD }) {
  return { handle: () => of(body) } as never;
}

describe('RealtyAuditInterceptor — branches', () => {
  let audit: { record: jest.Mock };
  let interceptor: RealtyAuditInterceptor;

  beforeEach(() => {
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    interceptor = new RealtyAuditInterceptor(audit as never);
  });

  describe('self-gating', () => {
    it('passes through a non-HTTP execution context untouched', async () => {
      const context = {
        getType: () => 'rpc',
        switchToHttp: () => {
          throw new Error('switchToHttp must not be called for an rpc context');
        },
      } as never;

      await expect(
        firstValueFrom(interceptor.intercept(context, makeHandler())),
      ).resolves.toEqual({ id: LEAD });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('treats a request with no method as a GET and skips it', async () => {
      const req = {
        path: '/v1/realty/leads',
        tenantId: BIZ,
        user: { sub: USER },
        headers: {},
      };

      await firstValueFrom(interceptor.intercept(makeContext(req), makeHandler()));

      expect(audit.record).not.toHaveBeenCalled();
    });

    it('falls back to req.url when the request has no path', async () => {
      const req = {
        method: 'POST',
        url: `/v1/realty/leads/${LEAD}`,
        tenantId: BIZ,
        user: { sub: USER },
        headers: {},
      };

      await firstValueFrom(interceptor.intercept(makeContext(req), makeHandler()));

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0]?.[0]).toMatchObject({
        resourceType: 'realty_lead',
        resourceId: LEAD,
      });
    });

    it('skips a request with neither path nor url', async () => {
      const req = {
        method: 'POST',
        tenantId: BIZ,
        user: { sub: USER },
        headers: {},
      };

      await firstValueFrom(interceptor.intercept(makeContext(req), makeHandler()));

      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('resource type derivation', () => {
    async function resourceTypeFor(path: string): Promise<string> {
      const req = {
        method: 'POST',
        path,
        tenantId: BIZ,
        user: { sub: USER },
        headers: {},
      };
      await firstValueFrom(
        interceptor.intercept(makeContext(req), makeHandler(null)),
      );
      return audit.record.mock.calls[0]?.[0].resourceType as string;
    }

    it('prefixes an unmapped segment rather than dropping it', async () => {
      await expect(resourceTypeFor('/v1/realty/widgets')).resolves.toBe(
        'realty_widgets',
      );
    });

    it('falls back to a bare "realty" when nothing follows the segment', async () => {
      await expect(resourceTypeFor('/v1/realty/')).resolves.toBe('realty');
    });
  });

  describe('resource id resolution', () => {
    async function resourceIdFor(
      path: string,
      body: unknown,
    ): Promise<string | null> {
      const req = {
        method: 'POST',
        path,
        tenantId: BIZ,
        user: { sub: USER },
        headers: {},
      };
      await firstValueFrom(
        interceptor.intercept(makeContext(req), makeHandler(body)),
      );
      return audit.record.mock.calls[0]?.[0].resourceId as string | null;
    }

    it('ignores a non-string body id', async () => {
      await expect(
        resourceIdFor('/v1/realty/leads', { id: 42 }),
      ).resolves.toBeNull();
    });

    it('records no id when the body has none and the path carries no uuid', async () => {
      await expect(
        resourceIdFor('/v1/realty/leads', { created: true }),
      ).resolves.toBeNull();
    });

    it('records no id for a null response body', async () => {
      await expect(resourceIdFor('/v1/realty/leads', null)).resolves.toBeNull();
    });
  });

  describe('header handling', () => {
    async function auditFor(
      headers: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
      const req = {
        method: 'POST',
        path: '/v1/realty/leads',
        tenantId: BIZ,
        user: { sub: USER },
        headers,
        ...extra,
      };
      await firstValueFrom(
        interceptor.intercept(makeContext(req), makeHandler(null)),
      );
      return audit.record.mock.calls[0]?.[0] as Record<string, unknown>;
    }

    it('takes the first value when the correlation header repeats', async () => {
      const recorded = await auditFor({
        'x-correlation-id': ['corr-1', 'corr-2'],
      });

      expect(recorded.requestId).toBe('corr-1');
    });

    it('records no request id for an empty repeated correlation header', async () => {
      const recorded = await auditFor({ 'x-correlation-id': [] });

      expect(recorded.requestId).toBeNull();
    });

    it('falls back to x-request-id when there is no correlation id', async () => {
      const recorded = await auditFor({ 'x-request-id': 'req-7' });

      expect(recorded.requestId).toBe('req-7');
    });

    it('records no request id when neither header is present', async () => {
      const recorded = await auditFor({});

      expect(recorded.requestId).toBeNull();
    });

    it('takes the client IP from the head of x-forwarded-for', async () => {
      const recorded = await auditFor(
        { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
        { ip: '10.0.0.1' },
      );

      expect(recorded.ipAddress).toBe('203.0.113.7');
    });

    it('ignores an empty x-forwarded-for and uses the socket IP', async () => {
      const recorded = await auditFor(
        { 'x-forwarded-for': '' },
        { ip: '10.0.0.1' },
      );

      expect(recorded.ipAddress).toBe('10.0.0.1');
    });

    it('records no IP when there is neither a header nor a socket address', async () => {
      const recorded = await auditFor({});

      expect(recorded.ipAddress).toBeNull();
    });

    it('records no user agent when the header is absent', async () => {
      const recorded = await auditFor({});

      expect(recorded.userAgent).toBeNull();
    });
  });
});
