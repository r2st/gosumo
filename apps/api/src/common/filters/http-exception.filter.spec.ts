/**
 * HttpExceptionFilter unit tests.
 *
 * Two behaviours matter beyond plain status mapping:
 *
 *  1. Prisma P2025 ("record not found") must surface as a 404. Repository
 *     writes are tenant-scoped via `where: { id, business_id }`, so a
 *     cross-tenant id raises P2025 — the caller must see a plain "not found"
 *     and never a 500 or any hint the row exists under another tenant.
 *
 *  2. Unhandled errors must not echo their message to the client. Driver and
 *     runtime errors routinely embed SQL, table names, and file paths.
 */

import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ErrorCode,
  ResourceNotFoundError,
  ExternalServiceError,
  RateLimitExceededError,
  ValidationError,
} from '@gosumo/shared';

import { HttpExceptionFilter, ApiError } from './http-exception.filter';

function makeHost(
  headers: Record<string, string> = { 'x-correlation-id': 'trace-123' },
): { host: ArgumentsHost; sent: () => ApiError; status: () => number } {
  let payload: ApiError | undefined;
  let statusCode = 0;

  const response = {
    status: (code: number) => {
      statusCode = code;
      return response;
    },
    json: (body: ApiError) => {
      payload = body;
      return response;
    },
  };

  const request = {
    url: '/api/v1/contacts/abc',
    method: 'PATCH',
    headers,
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return {
    host,
    sent: () => payload as ApiError,
    status: () => statusCode,
  };
}

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    // Realistic driver text — the filter must not pass this through.
    `An operation failed because it depends on one or more records that were required but not found. table: "canned_responses"`,
    { code, clientVersion: Prisma.prismaVersion.client },
  );
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
  });

  it('passes an HttpException through with its own status and message', () => {
    const ctx = makeHost();
    filter.catch(new HttpException('Contact not found', HttpStatus.NOT_FOUND), ctx.host);

    expect(ctx.status()).toBe(HttpStatus.NOT_FOUND);
    expect(ctx.sent().message).toBe('Contact not found');
  });

  it('maps Prisma P2025 to 404', () => {
    const ctx = makeHost();
    filter.catch(prismaError('P2025'), ctx.host);

    expect(ctx.status()).toBe(HttpStatus.NOT_FOUND);
    expect(ctx.sent().message).toBe('Resource not found');
  });

  it('does not leak table names from a P2025 to the client', () => {
    // A cross-tenant write reaches here; the response must not confirm that
    // the row exists under a different business.
    const ctx = makeHost();
    filter.catch(prismaError('P2025'), ctx.host);

    expect(JSON.stringify(ctx.sent())).not.toContain('canned_responses');
  });

  it('maps Prisma P2002 (unique violation) to 409', () => {
    const ctx = makeHost();
    filter.catch(prismaError('P2002'), ctx.host);
    expect(ctx.status()).toBe(HttpStatus.CONFLICT);
  });

  it('maps Prisma P2003 (FK violation) to 400', () => {
    const ctx = makeHost();
    filter.catch(prismaError('P2003'), ctx.host);
    expect(ctx.status()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('leaves an unmapped Prisma code as a 500 with no driver detail', () => {
    const ctx = makeHost();
    filter.catch(prismaError('P1001'), ctx.host);

    expect(ctx.status()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(JSON.stringify(ctx.sent())).not.toContain('canned_responses');
  });

  it('does not echo an unhandled error message to the client', () => {
    const ctx = makeHost();
    filter.catch(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 user=gosumo password=hunter2'),
      ctx.host,
    );

    expect(ctx.status()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = JSON.stringify(ctx.sent());
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('10.0.0.5');
    expect(ctx.sent().message).toBe('An unexpected error occurred');
  });

  it('still logs the full detail server-side for triage', () => {
    const ctx = makeHost();
    const errorSpy = jest.spyOn(filter['logger'], 'error');
    filter.catch(new Error('boom with secret detail'), ctx.host);

    expect(errorSpy).toHaveBeenCalled();
  });

  it('echoes the inbound correlation id as the traceId', () => {
    const ctx = makeHost();
    filter.catch(new HttpException('nope', HttpStatus.BAD_REQUEST), ctx.host);
    expect(ctx.sent().traceId).toBe('trace-123');
  });

  it('includes the request path and a timestamp', () => {
    const ctx = makeHost();
    filter.catch(new HttpException('nope', HttpStatus.BAD_REQUEST), ctx.host);

    expect(ctx.sent().path).toBe('/api/v1/contacts/abc');
    expect(Date.parse(ctx.sent().timestamp)).not.toBeNaN();
  });

  it('preserves a validation pipe message array', () => {
    const ctx = makeHost();
    filter.catch(
      new HttpException(
        { message: ['name must be a string', 'phone must be valid'], error: 'Bad Request' },
        HttpStatus.BAD_REQUEST,
      ),
      ctx.host,
    );

    expect(ctx.sent().message).toEqual(['name must be a string', 'phone must be valid']);
  });

  // ───────────────────────────────────────────────
  // Every response carries a taxonomy code
  // ───────────────────────────────────────────────
  //
  // The platform throws framework exceptions far more often than typed ones,
  // and the dashboard's ApiError reads `error` as a machine code. So `error`
  // must be an ErrorCode on every path into this filter, not Nest's prose.

  describe('error code normalisation', () => {
    it('uses a typed error’s own code', () => {
      const ctx = makeHost();
      filter.catch(new ResourceNotFoundError('Lead', 'lead-1'), ctx.host);

      expect(ctx.status()).toBe(HttpStatus.NOT_FOUND);
      expect(ctx.sent().error).toBe(ErrorCode.RESOURCE_NOT_FOUND);
      expect(ctx.sent().message).toBe('Lead not found');
    });

    it('prefers the typed code over the one the status would imply', () => {
      // PayloadParseError is a 400, but 400 alone maps to VALIDATION_FAILED.
      const ctx = makeHost();
      filter.catch(new ExternalServiceError('razorpay', 'timeout', { status: 504 }), ctx.host);

      expect(ctx.status()).toBe(502);
      expect(ctx.sent().error).toBe(ErrorCode.EXTERNAL_SERVICE_ERROR);
    });

    it.each([
      ['BadRequestException', new BadRequestException('bad'), 400, ErrorCode.VALIDATION_FAILED],
      ['UnauthorizedException', new UnauthorizedException('nope'), 401, ErrorCode.UNAUTHENTICATED],
      ['ForbiddenException', new ForbiddenException('nope'), 403, ErrorCode.FORBIDDEN],
      ['NotFoundException', new NotFoundException('gone'), 404, ErrorCode.RESOURCE_NOT_FOUND],
      ['ConflictException', new ConflictException('dup'), 409, ErrorCode.CONFLICT],
      [
        'UnprocessableEntityException',
        new UnprocessableEntityException('range too large'),
        422,
        ErrorCode.UNSUPPORTED_OPERATION,
      ],
    ])('classifies a %s as %s', (_label, exception, status, code) => {
      const ctx = makeHost();
      filter.catch(exception, ctx.host);

      expect(ctx.status()).toBe(status);
      expect(ctx.sent().error).toBe(code);
    });

    it('never echoes Nest’s prose error string', () => {
      // `new NotFoundException()` serialises as { error: 'Not Found' }, which
      // is not a code and must not reach the client as one.
      const ctx = makeHost();
      filter.catch(new NotFoundException('gone'), ctx.host);

      expect(ctx.sent().error).not.toBe('Not Found');
      expect(Object.values(ErrorCode)).toContain(ctx.sent().error);
    });

    it('honours a handler-supplied taxonomy code', () => {
      // A handler that wants a more precise code than the status implies can
      // name one: throw new BadRequestException({ message, error: CODE }).
      const ctx = makeHost();
      filter.catch(
        new BadRequestException({
          message: 'entry[0] absent',
          error: ErrorCode.PAYLOAD_PARSE_ERROR,
        }),
        ctx.host,
      );

      expect(ctx.status()).toBe(400);
      expect(ctx.sent().error).toBe(ErrorCode.PAYLOAD_PARSE_ERROR);
      expect(ctx.sent().message).toBe('entry[0] absent');
    });

    it.each([
      ['a non-code string', { message: 'x', error: 'Bad Request' }],
      ['a number', { message: 'x', error: 42 }],
      ['an object', { message: 'x', error: { code: 'NOPE' } }],
      ['null', { message: 'x', error: null }],
      ['an absent error field', { message: 'x' }],
    ])('falls back to the status-derived code when error is %s', (_label, body) => {
      const ctx = makeHost();
      filter.catch(new HttpException(body, HttpStatus.BAD_REQUEST), ctx.host);

      expect(ctx.sent().error).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('falls back to the exception message when the body has none', () => {
      const ctx = makeHost();
      filter.catch(new HttpException({ error: 'Bad Request' }, HttpStatus.BAD_REQUEST), ctx.host);

      expect(ctx.sent().message).toBe('Http Exception');
      expect(ctx.sent().error).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('classifies a string-bodied HttpException from its status', () => {
      const ctx = makeHost();
      filter.catch(new HttpException('Contact not found', HttpStatus.NOT_FOUND), ctx.host);

      expect(ctx.sent().error).toBe(ErrorCode.RESOURCE_NOT_FOUND);
      expect(ctx.sent().message).toBe('Contact not found');
    });

    it.each([
      ['P2025', HttpStatus.NOT_FOUND, ErrorCode.RESOURCE_NOT_FOUND],
      ['P2002', HttpStatus.CONFLICT, ErrorCode.CONFLICT],
      ['P2003', HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED],
      ['P2000', HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED],
    ])('classifies the mapped Prisma code %s as %s', (prismaCode, status, code) => {
      const ctx = makeHost();
      filter.catch(prismaError(prismaCode), ctx.host);

      expect(ctx.status()).toBe(status);
      expect(ctx.sent().error).toBe(code);
    });

    it('classifies an unmapped Prisma code as INTERNAL_ERROR', () => {
      const ctx = makeHost();
      filter.catch(prismaError('P1001'), ctx.host);

      expect(ctx.sent().error).toBe(ErrorCode.INTERNAL_ERROR);
    });

    it('classifies an unhandled Error as INTERNAL_ERROR', () => {
      const ctx = makeHost();
      filter.catch(new Error('boom'), ctx.host);

      expect(ctx.sent().error).toBe(ErrorCode.INTERNAL_ERROR);
    });

    it.each([
      ['a string', 'just a string'],
      ['null', null],
      ['undefined', undefined],
      ['a number', 42],
      ['a bare object', { nope: true }],
    ])('classifies the non-Error throwable %s as a 500 INTERNAL_ERROR', (_label, thrown) => {
      const ctx = makeHost();
      filter.catch(thrown, ctx.host);

      expect(ctx.status()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(ctx.sent().error).toBe(ErrorCode.INTERNAL_ERROR);
      expect(ctx.sent().message).toBe('An unexpected error occurred');
    });
  });

  // ───────────────────────────────────────────────
  // Trace id
  // ───────────────────────────────────────────────

  describe('traceId', () => {
    it('generates a uuid when no correlation id was sent', () => {
      const ctx = makeHost({});
      filter.catch(new NotFoundException('gone'), ctx.host);

      expect(ctx.sent().traceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('generates a distinct trace id per unattributed failure', () => {
      const first = makeHost({});
      const second = makeHost({});
      filter.catch(new Error('a'), first.host);
      filter.catch(new Error('b'), second.host);

      expect(first.sent().traceId).not.toBe(second.sent().traceId);
    });
  });

  // ───────────────────────────────────────────────
  // Logging
  // ───────────────────────────────────────────────

  describe('logging', () => {
    it('logs 5xx at error level with the stack', () => {
      const ctx = makeHost();
      const errorSpy = jest.spyOn(filter['logger'], 'error');
      const warnSpy = jest.spyOn(filter['logger'], 'warn');
      const err = new Error('boom');
      filter.catch(err, ctx.host);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('trace-123'), err.stack);
    });

    it('logs a non-Error throwable at error level with its string form', () => {
      const ctx = makeHost();
      const errorSpy = jest.spyOn(filter['logger'], 'error');
      filter.catch('raw failure', ctx.host);

      expect(errorSpy).toHaveBeenCalledWith(expect.any(String), 'raw failure');
    });

    it('logs 4xx at warn level, not error', () => {
      const ctx = makeHost();
      const errorSpy = jest.spyOn(filter['logger'], 'error');
      const warnSpy = jest.spyOn(filter['logger'], 'warn');
      filter.catch(new NotFoundException('gone'), ctx.host);

      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('→ 404'));
    });

    it('appends a typed error’s context to the log line', () => {
      const ctx = makeHost();
      const warnSpy = jest.spyOn(filter['logger'], 'warn');
      filter.catch(new ResourceNotFoundError('Lead', 'lead-9'), ctx.host);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('lead-9'));
    });

    it('omits the context fragment when the typed error carries none', () => {
      const ctx = makeHost();
      const warnSpy = jest.spyOn(filter['logger'], 'warn');
      filter.catch(new ValidationError('budget must be positive'), ctx.host);

      const line = warnSpy.mock.calls[0]![0] as string;
      expect(line).not.toContain('{}');
      expect(line).toContain('budget must be positive');
    });

    it('keeps a typed error’s context out of the response body', () => {
      const ctx = makeHost();
      filter.catch(
        new ResourceNotFoundError('Lead', 'lead-9', { context: { businessId: 'biz-secret' } }),
        ctx.host,
      );

      const body = JSON.stringify(ctx.sent());
      expect(body).not.toContain('biz-secret');
      expect(body).not.toContain('lead-9');
    });

    it('logs a 5xx typed error at error level with its context', () => {
      const ctx = makeHost();
      const errorSpy = jest.spyOn(filter['logger'], 'error');
      filter.catch(new ExternalServiceError('razorpay', 'down', { status: 503 }), ctx.host);

      // ExternalServiceError is a 502 — a server-side fault, so error level.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('razorpay'),
        expect.anything(),
      );
    });
  });

  it('renders a rate limit as a 429 with the retry hint kept out of the body', () => {
    const ctx = makeHost();
    filter.catch(new RateLimitExceededError('too many sends', 30), ctx.host);

    expect(ctx.status()).toBe(429);
    expect(ctx.sent().error).toBe(ErrorCode.RATE_LIMIT_EXCEEDED);
    expect(JSON.stringify(ctx.sent())).not.toContain('retryAfterSeconds');
  });

  it('always emits the full envelope', () => {
    const ctx = makeHost();
    filter.catch(new NotFoundException('gone'), ctx.host);

    expect(Object.keys(ctx.sent()).sort()).toEqual([
      'error',
      'message',
      'path',
      'statusCode',
      'timestamp',
      'traceId',
    ]);
  });
});
