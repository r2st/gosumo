/**
 * The dashboard's response headers.
 *
 * These are asserted here rather than trusted to the Caddyfile because the
 * Caddyfile is not in this repository — a header that only exists there is one
 * nothing in CI can see and nobody reading the app can find.
 */

import { describe, expect, it } from 'vitest';
import {
  buildContentSecurityPolicy,
  PERMISSIONS_POLICY,
  securityHeaders,
  toOrigin,
} from './security-headers.mjs';

/** Pull one header's value out of the list by name. */
function header(
  list: { key: string; value: string }[],
  name: string,
): string | undefined {
  return list.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;
}

/** Split a CSP string into its directives, keyed by directive name. */
function directives(csp: string): Record<string, string> {
  return Object.fromEntries(
    csp.split('; ').map((d) => {
      const [name, ...rest] = d.split(' ');
      return [name, rest.join(' ')];
    }),
  );
}

const PROD = {
  apiUrl: 'https://api.gosumo.aiknol.com',
  wsUrl: 'https://api.gosumo.aiknol.com',
  nodeEnv: 'production',
};

describe('securityHeaders', () => {
  it('sets every header the app is responsible for', () => {
    const list = securityHeaders(PROD);

    for (const name of [
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Content-Security-Policy',
      'Strict-Transport-Security',
    ]) {
      expect(header(list, name), name).toBeTruthy();
    }
  });

  it('stops referrers leaving the origin — dashboard paths carry record ids', () => {
    expect(header(securityHeaders(PROD), 'Referrer-Policy')).toBe('same-origin');
  });

  it('refuses framing through both the old header and the modern directive', () => {
    const list = securityHeaders(PROD);

    expect(header(list, 'X-Frame-Options')).toBe('DENY');
    expect(header(list, 'Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  describe('HSTS', () => {
    it('is sent in production with a preload-eligible max-age', () => {
      expect(header(securityHeaders(PROD), 'Strict-Transport-Security')).toBe(
        'max-age=31536000; includeSubDomains; preload',
      );
    });

    it.each(['development', 'test', undefined])(
      'is withheld when NODE_ENV is %s — over http it pins a port that is not there',
      (nodeEnv) => {
        const list = securityHeaders({ ...PROD, nodeEnv });

        expect(header(list, 'Strict-Transport-Security')).toBeUndefined();
      },
    );
  });

  it('keeps the other headers in development, where only HSTS is unsafe', () => {
    const list = securityHeaders({ ...PROD, nodeEnv: 'development' });

    expect(header(list, 'X-Content-Type-Options')).toBe('nosniff');
    expect(header(list, 'Content-Security-Policy')).toBeTruthy();
  });

  it('survives an unset API url rather than failing the build', () => {
    const list = securityHeaders({ nodeEnv: 'production' });

    expect(header(list, 'Content-Security-Policy')).toContain("connect-src 'self'");
    expect(header(list, 'Content-Security-Policy')).toContain('https://analytics.doaide.com');
  });
});

describe('PERMISSIONS_POLICY', () => {
  it.each(['camera', 'microphone', 'geolocation', 'payment', 'usb'])(
    'denies %s',
    (feature) => {
      expect(PERMISSIONS_POLICY).toContain(`${feature}=()`);
    },
  );

  it('uses the empty allow-list form throughout — a wildcard here grants', () => {
    for (const directive of PERMISSIONS_POLICY.split(', ')) {
      expect(directive).toMatch(/^[a-z-]+=\(\)$/);
    }
  });
});

describe('buildContentSecurityPolicy', () => {
  const prodCsp = () =>
    directives(
      buildContentSecurityPolicy({
        apiOrigin: 'https://api.gosumo.aiknol.com',
        wsOrigin: 'https://api.gosumo.aiknol.com',
        dev: false,
      }),
    );

  it('closes the injection primitives that unsafe-inline does not cover', () => {
    // `script-src 'unsafe-inline'` is a known limit here (see the module note).
    // These three are what the policy is actually buying in the meantime — a
    // `<base>` tag rewrites where every relative script on the page loads from.
    const csp = prodCsp();

    expect(csp['object-src']).toBe("'none'");
    expect(csp['base-uri']).toBe("'self'");
    expect(csp['form-action']).toBe("'self'");
  });

  it('lets the API through connect-src, or the dashboard cannot load anything', () => {
    expect(prodCsp()['connect-src']).toContain('https://api.gosumo.aiknol.com');
  });

  it('lets the socket through under its own scheme', () => {
    // `connect-src` matches on scheme, so an https entry does not cover wss.
    expect(prodCsp()['connect-src']).toContain('wss://api.gosumo.aiknol.com');
  });

  it('narrows connect-src to self and analytics when no API origin is configured', () => {
    expect(directives(buildContentSecurityPolicy({}))['connect-src']).toBe(
      "'self' https://analytics.doaide.com",
    );
  });

  it('does not repeat an origin when the API and socket share a host', () => {
    const connect = prodCsp()['connect-src']?.split(' ') ?? [];

    expect(new Set(connect).size).toBe(connect.length);
  });

  it('withholds unsafe-eval in production, where only Fast Refresh needs it', () => {
    expect(prodCsp()['script-src']).not.toContain('unsafe-eval');
  });

  it('allows unsafe-eval in development, where React Fast Refresh needs it', () => {
    const csp = directives(buildContentSecurityPolicy({ dev: true }));

    expect(csp['script-src']).toContain("'unsafe-eval'");
  });

  it('allows the Umami analytics script and beacon', () => {
    const csp = prodCsp();

    expect(csp['script-src']).toContain('https://analytics.doaide.com');
    expect(csp['connect-src']).toContain('https://analytics.doaide.com');
  });

  it('permits the inline theme and language init scripts', () => {
    // `layout.tsx` inlines both in <head> to apply the saved theme before
    // first paint. Dropping 'unsafe-inline' without adding a nonce would leave
    // the dashboard rendering in the wrong theme on every load.
    expect(prodCsp()['script-src']).toContain("'unsafe-inline'");
  });

  it('permits the inline styles next/font emits', () => {
    expect(prodCsp()['style-src']).toContain("'unsafe-inline'");
  });

  it('allows remote https images, matching next.config remotePatterns', () => {
    // The two have to agree: an image host allowed by Next and blocked by the
    // CSP is a broken avatar with an error only in the browser console.
    const img = prodCsp()['img-src'] ?? '';

    expect(img).toContain('https:');
    expect(img).toContain('data:');
    expect(img).toContain('blob:');
  });

  it('allows fonts from origin, data URIs, and Google Fonts', () => {
    const fontSrc = prodCsp()['font-src'] ?? '';
    expect(fontSrc).toContain("'self'");
    expect(fontSrc).toContain('data:');
    expect(fontSrc).toContain('https://fonts.gstatic.com');
  });

  it('starts from a default-src that is not a wildcard', () => {
    expect(prodCsp()['default-src']).toBe("'self'");
  });
});

describe('toOrigin', () => {
  it.each([
    ['https://api.gosumo.aiknol.com', 'https://api.gosumo.aiknol.com'],
    ['https://api.gosumo.aiknol.com/', 'https://api.gosumo.aiknol.com'],
    ['http://localhost:3000', 'http://localhost:3000'],
  ])('reduces %s to its origin', (input, expected) => {
    expect(toOrigin(input)).toBe(expected);
  });

  it('strips a path — a CSP source with a path matches by prefix, not exactly', () => {
    expect(toOrigin('https://api.gosumo.aiknol.com/v1')).toBe(
      'https://api.gosumo.aiknol.com',
    );
  });

  it.each([undefined, '', 'not a url'])(
    'yields undefined for %s rather than throwing the build',
    (input) => {
      expect(toOrigin(input)).toBeUndefined();
    },
  );
});
