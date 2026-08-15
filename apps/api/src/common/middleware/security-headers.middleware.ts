/**
 * Baseline security response headers.
 *
 * The API sent none of these. For a service that returns JSON that is easy to
 * wave off — until you notice what it actually returns: validation errors
 * echo the offending value, search endpoints echo the query, and the exception
 * filter puts messages carrying customer-supplied text into the body. A
 * browser navigated straight at such a response with no `nosniff` will happily
 * decide the body is HTML and run what is in it, on this origin.
 *
 * Written as Express middleware rather than a Nest interceptor deliberately:
 * interceptors run *after* guards, so a 401 from `JwtAuthGuard` — one of the
 * most-served responses here — would have gone out bare.
 *
 * What is *not* set is as deliberate as what is. No `Cross-Origin-Resource-Policy`
 * (the dashboard and the chat widget are cross-origin by design and it would
 * break them) and no CORS decisions (those belong to `enableCors`, which has
 * the allow-list).
 */

import type { NextFunction, Request, Response } from 'express';

/**
 * Locked down as far as an endpoint that serves data rather than pages can be.
 * `default-src 'none'` means a response rendered as a document — the sniffing
 * case above, or a browser pointed at an API URL directly — can load nothing
 * and run nothing. `frame-ancestors` is the header-level version of
 * `X-Frame-Options: DENY`, kept alongside it because the two are honoured by
 * different browser generations.
 */
export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Swagger UI is a real page: it loads its own scripts, styles, and fonts, and
 * the strict policy above would leave a blank screen. It is dev-only by
 * default (see `swaggerEnabled`), so this is the narrower exception rather
 * than the rule — it keeps `frame-ancestors` and drops only what the UI needs.
 */
export const DOCS_CONTENT_SECURITY_POLICY =
  "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
  "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; font-src 'self' data:";

/** One year, the value HSTS preload requires. */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/** Path prefix Swagger UI is mounted under, if it is mounted at all. */
const DOCS_PREFIX = '/v1/docs';

export interface SecurityHeadersOptions {
  /**
   * Whether to advertise HSTS. Only true behind TLS: sent over plain http in
   * development it would pin a browser to https for a host that does not serve
   * it, and the fix is clearing browser state, not redeploying.
   */
  hsts?: boolean;
}

/**
 * Express middleware setting the headers above on every response, including
 * ones that never reach a controller.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}) {
  return function securityHeadersMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // The whole point: never let a browser guess the type of a body that may
    // contain text somebody else wrote.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      isDocsPath(req.path) ? DOCS_CONTENT_SECURITY_POLICY : API_CONTENT_SECURITY_POLICY,
    );
    // Resource ids live in these paths; they should not travel to whatever a
    // response links onward to.
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (options.hsts) {
      res.setHeader(
        'Strict-Transport-Security',
        `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
      );
    }

    next();
  };
}

/** Whether a request path is Swagger UI or one of its assets. */
export function isDocsPath(path: string): boolean {
  return path === DOCS_PREFIX || path.startsWith(`${DOCS_PREFIX}/`);
}
