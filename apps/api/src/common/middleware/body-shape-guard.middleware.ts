/**
 * Reject request bodies whose *shape* is hostile, as opposed to whose size is.
 *
 * `MAX_REQUEST_BODY_BYTES` already caps the bytes, and that is the bound most
 * people stop at. It does not bound the two things that actually hurt here,
 * because both are cheap to express:
 *
 *  - **Nesting.** `{"a":{"a":{"a": …` reaches ~50,000 levels inside 400 KB —
 *    a fifth of the byte ceiling. `JSON.parse` itself survives it (V8's parser
 *    is iterative), so the parser hands the controller a perfectly valid
 *    object, and the stack overflow happens later in whatever walks it
 *    recursively: `class-transformer`'s `plainToInstance`, `class-validator`'s
 *    nested validation, `JSON.stringify` in the logging interceptor, Prisma's
 *    input serializer. A `RangeError: Maximum call stack size exceeded` thrown
 *    from inside a global interceptor is not a 400 — it escapes the exception
 *    filter's usual path and takes the request down as a 500, and there is a
 *    window where it can take the worker with it.
 *  - **Breadth.** 400 KB of `{"a1":1,"a2":1, …}` is ~40,000 keys on one object.
 *    `ValidationPipe` runs with `forbidNonWhitelisted: true`, so every one of
 *    them is visited and reported — the *error* response is then larger than
 *    the request, which is amplification pointed at ourselves.
 *
 * Both are bounded here, before anything walks the body: after the parser (so
 * there is something to inspect) and before the router. The check itself is
 * iterative with an explicit stack — using recursion to detect a
 * recursion-depth attack would trigger the very overflow it is looking for.
 *
 * The limits are set well above what any DTO in the app describes. The deepest
 * legitimate body is a channel connect payload with a nested `widgetConfig`,
 * around five levels; the widest is a CSV import row set, bounded by
 * `@ArrayMaxSize(5000)`. Arrays are exempt from the breadth check for exactly
 * that reason — a 5,000-element array is one declared, validated shape, while
 * a 5,000-*key* object is not something any DTO here asks for.
 */

import { HttpStatus, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ErrorCode } from '@gosumo/shared';
import { getCorrelationId } from '../context/request-context';

/**
 * Deepest object/array nesting accepted.
 *
 * Ten times the deepest DTO in the app and far below where a recursive walk
 * gets into trouble (V8's default stack takes ~10,000 frames, and each level
 * of `plainToInstance` costs several).
 */
export const MAX_BODY_DEPTH = 32;

/**
 * Most keys accepted on a single object. Arrays are not subject to this.
 *
 * Bounded rather than left to the byte cap because of what happens downstream:
 * `ValidationPipe` runs with `forbidNonWhitelisted: true`, so every unexpected
 * key is visited *and reported*. 40,000 of them inside 400 KB produces an
 * error response larger than the request that caused it, which is
 * amplification pointed at ourselves.
 *
 * Deliberately no third check on *total* values. That was the obvious next
 * one to add and it does not survive contact with the numbers: at four bytes
 * minimum per JSON value the 1 MB ceiling already caps a body at roughly
 * 250,000 of them, and a `@ArrayMaxSize(5000)` inventory import at ~15 fields
 * a row is 75,000 — so any total-count limit low enough to bite an attacker is
 * also low enough to reject the largest import the API advertises. Depth and
 * key count are the two things the byte cap genuinely does not bound.
 */
export const MAX_OBJECT_KEYS = 1_000;

/** Why a body was rejected. `null` means it was accepted. */
export type BodyShapeViolation = 'depth' | 'keys' | null;

/** Client-facing text per violation. Names the limit; never echoes the body. */
const VIOLATION_MESSAGE: Record<NonNullable<BodyShapeViolation>, string> = {
  depth: `Request body is nested more than ${MAX_BODY_DEPTH} levels deep`,
  keys: `Request body contains an object with more than ${MAX_OBJECT_KEYS} keys`,
};

export interface BodyShapeLimits {
  maxDepth?: number;
  maxKeys?: number;
}

/**
 * Walk a parsed body and report the first limit it breaks.
 *
 * Iterative by construction — an explicit stack of `[value, depth]` pairs. A
 * recursive implementation would blow the call stack on precisely the input
 * this exists to reject, turning the guard into the vulnerability.
 *
 * Cycles cannot occur: this only ever sees the output of `JSON.parse` or `qs`,
 * neither of which can produce one. Prototype keys (`__proto__`) are not
 * special-cased here either — `JSON.parse` makes them ordinary own properties,
 * and `ValidationPipe`'s whitelist is what drops them.
 */
export function inspectBodyShape(
  body: unknown,
  limits: BodyShapeLimits = {},
): BodyShapeViolation {
  const maxDepth = limits.maxDepth ?? MAX_BODY_DEPTH;
  const maxKeys = limits.maxKeys ?? MAX_OBJECT_KEYS;

  if (body === null || typeof body !== 'object') return null;

  const stack: Array<{ value: object; depth: number }> = [{ value: body, depth: 1 }];

  while (stack.length > 0) {
    // Non-null assertion is safe: the loop condition just checked length.
    const { value, depth } = stack.pop()!;

    if (depth > maxDepth) return 'depth';

    if (Array.isArray(value)) {
      // Length is bounded by `@ArrayMaxSize` on the DTO and by the byte cap;
      // what matters here is that each element still gets depth-checked.
      for (const item of value) {
        if (item !== null && typeof item === 'object') {
          stack.push({ value: item as object, depth: depth + 1 });
        }
      }
      continue;
    }

    const keys = Object.keys(value);
    if (keys.length > maxKeys) return 'keys';

    for (const key of keys) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') {
        stack.push({ value: child as object, depth: depth + 1 });
      }
    }
  }

  return null;
}

/**
 * Express middleware rejecting hostile body shapes with a 400.
 *
 * Answers directly rather than throwing, because it runs before the router and
 * so before anything the global `HttpExceptionFilter` covers — a throw from
 * here would surface as Express's default HTML error page, which is both the
 * wrong content type for this API and a stack trace outside production. The
 * body it writes matches `ApiError` field for field so a client parsing error
 * responses does not need a second shape for this one case.
 *
 * Registered after {@link applyBodyLimits} (there has to be a parsed body to
 * inspect) and after `securityHeaders()`/`correlationId()`, so the 400 carries
 * both the headers and the id every other response does.
 */
export function bodyShapeGuard(limits: BodyShapeLimits = {}) {
  const logger = new Logger('BodyShapeGuard');

  return function bodyShapeGuardMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const violation = inspectBodyShape(req.body, limits);
    if (!violation) {
      next();
      return;
    }

    const traceId = getCorrelationId() ?? '';

    // WARN, not ERROR: nothing is broken here and the app is doing its job.
    // It is worth a line because a legitimate client that has outgrown a limit
    // and a probe look identical in the response, and only the log has the
    // route and the rate that tell them apart.
    logger.warn(
      `[${traceId}] ${req.method} ${req.url} → 400: body rejected (${violation})`,
    );

    res.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      error: ErrorCode.VALIDATION_FAILED,
      message: VIOLATION_MESSAGE[violation],
      traceId,
      timestamp: new Date().toISOString(),
      path: req.url,
    });
  };
}
