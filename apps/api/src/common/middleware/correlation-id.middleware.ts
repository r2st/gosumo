/**
 * Opens the request context, as early in the request as anything can.
 *
 * Written as Express middleware rather than a Nest interceptor for the same
 * reason `securityHeaders` is: interceptors run *after* guards, so every 401
 * from the global `JwtAuthGuard` and every 413 from the body parser — two of
 * the most-served responses this API produces — would be logged with no
 * correlation id and answered without the header. Those are exactly the
 * responses somebody is trying to trace when they go looking.
 *
 * Installed before the body parser too, so a request rejected for size still
 * gets an id.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  resolveCorrelationId,
} from '../context/correlation-id.util';
import { runWithRequestContext } from '../context/request-context';

/**
 * Middleware that resolves the correlation id, publishes it three ways, and
 * runs the rest of the request inside a context carrying it.
 *
 * The three publications are not redundant:
 *   - `req.headers` — so code reading the request directly (the exception
 *     filter's fallback path, anything holding an `Request`) sees the resolved
 *     id rather than the raw inbound one. This also *overwrites* a rejected
 *     inbound value, so a hostile header cannot survive into a later reader.
 *   - the response header — so the caller can quote the id in a bug report,
 *     which is the only way a user-visible failure ever gets joined to a log.
 *   - the async context — so every line logged in between carries it.
 */
export function correlationId() {
  return function correlationIdMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const id = resolveCorrelationId(
      req.headers[CORRELATION_ID_HEADER],
      req.headers[REQUEST_ID_HEADER],
    );

    // Overwrite, never merge: after this line the request carries an id that
    // has been through `sanitizeCorrelationId`, whatever arrived.
    req.headers[CORRELATION_ID_HEADER] = id;
    res.setHeader(CORRELATION_ID_HEADER, id);

    runWithRequestContext({ correlationId: id }, next);
  };
}
