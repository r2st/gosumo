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

import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { HttpExceptionFilter, ApiError } from './http-exception.filter';

function makeHost(): { host: ArgumentsHost; sent: () => ApiError; status: () => number } {
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
    headers: { 'x-correlation-id': 'trace-123' },
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
});
