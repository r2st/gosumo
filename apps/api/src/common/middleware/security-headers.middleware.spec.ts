import type { NextFunction, Request, Response } from 'express';
import {
  API_CONTENT_SECURITY_POLICY,
  DOCS_CONTENT_SECURITY_POLICY,
  isDocsPath,
  PERMISSIONS_POLICY,
  securityHeaders,
} from './security-headers.middleware';

function run(
  path: string,
  options: { hsts?: boolean } = {},
): { headers: Record<string, string>; nextCalled: boolean } {
  const headers: Record<string, string> = {};
  let nextCalled = false;

  const req = { path } as Request;
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  securityHeaders(options)(req, res, next);
  return { headers, nextCalled };
}

describe('securityHeaders', () => {
  it('always sets nosniff — the one that stops a JSON body being run as HTML', () => {
    expect(run('/v1/conversations').headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('refuses framing two ways, for two browser generations', () => {
    const { headers } = run('/v1/conversations');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });

  it('sends the locked-down policy on API routes', () => {
    expect(run('/v1/conversations').headers['Content-Security-Policy']).toBe(
      API_CONTENT_SECURITY_POLICY,
    );
  });

  it('withholds referrers, since resource ids are in the path', () => {
    expect(run('/v1/conversations/abc').headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('calls next so the request still gets served', () => {
    expect(run('/v1/conversations').nextCalled).toBe(true);
  });

  describe('Permissions-Policy', () => {
    it('is sent on every response', () => {
      expect(run('/v1/conversations').headers['Permissions-Policy']).toBe(
        PERMISSIONS_POLICY,
      );
    });

    it.each(['camera', 'microphone', 'geolocation', 'payment', 'usb'])(
      'denies %s outright',
      (feature) => {
        expect(PERMISSIONS_POLICY).toContain(`${feature}=()`);
      },
    );

    it('uses the empty allow-list form throughout — a wildcard here grants', () => {
      for (const directive of PERMISSIONS_POLICY.split(', ')) {
        expect(directive).toMatch(/^[a-z-]+=\(\)$/);
      }
    });

    it('covers the docs path too, where the CSP is deliberately relaxed', () => {
      // `/v1/docs` runs inline script by necessity. This is what is left
      // standing between script that gets in there and a device API.
      expect(run('/v1/docs').headers['Permissions-Policy']).toBe(PERMISSIONS_POLICY);
    });
  });

  describe('Swagger UI', () => {
    it.each(['/v1/docs', '/v1/docs/', '/v1/docs/swagger-ui.css'])(
      'relaxes the policy for %s so the page actually renders',
      (path) => {
        expect(run(path).headers['Content-Security-Policy']).toBe(DOCS_CONTENT_SECURITY_POLICY);
      },
    );

    it('still refuses to be framed', () => {
      expect(run('/v1/docs').headers['Content-Security-Policy']).toContain(
        "frame-ancestors 'none'",
      );
    });

    it('does not relax a route that merely starts with the same letters', () => {
      expect(run('/v1/documents').headers['Content-Security-Policy']).toBe(
        API_CONTENT_SECURITY_POLICY,
      );
    });
  });

  describe('HSTS', () => {
    it('is sent when asked for', () => {
      expect(run('/v1/health', { hsts: true }).headers['Strict-Transport-Security']).toBe(
        'max-age=31536000; includeSubDomains',
      );
    });

    it('is absent by default — over plain http it pins a browser to a port that is not there', () => {
      expect(run('/v1/health').headers['Strict-Transport-Security']).toBeUndefined();
    });
  });
});

describe('isDocsPath', () => {
  it.each([
    ['/v1/docs', true],
    ['/v1/docs/', true],
    ['/v1/docs/swagger-ui-bundle.js', true],
    ['/v1/documents', false],
    ['/v1/docsomething', false],
    ['/v1/conversations', false],
    ['/', false],
  ])('%s → %s', (path, expected) => {
    expect(isDocsPath(path)).toBe(expected);
  });
});
