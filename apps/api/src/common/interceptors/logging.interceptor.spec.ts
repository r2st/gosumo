/**
 * LoggingInterceptor unit tests.
 *
 * The interceptor's visible output is log lines, which are not worth asserting
 * on. What *is* worth asserting is the correlation ID contract, because two
 * other things depend on it:
 *
 *  - `HttpExceptionFilter` reads `x-correlation-id` off the request and echoes
 *    it in every error body. If this interceptor stopped writing the header
 *    back onto the request, every error response would lose its trace handle.
 *  - Callers (and the dashboard) may supply their own ID to stitch a
 *    client-side action to a server-side request. An interceptor that always
 *    minted a fresh one would silently break that join.
 *
 * The error path matters for a subtler reason: `tap({ error })` observes the
 * failure without consuming it. A `tap` that swallowed the error would turn
 * every 500 into a hung request.
 */

import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { of, throwError, lastValueFrom } from 'rxjs';

import { LoggingInterceptor } from './logging.interceptor';

interface Harness {
  context: ExecutionContext;
  request: { method: string; url: string; headers: Record<string, string | undefined> };
  headersSet: Record<string, unknown>;
}

function makeHarness(headers: Record<string, string | undefined> = {}): Harness {
  const request = { method: 'GET', url: '/api/v1/contacts', headers };
  const headersSet: Record<string, unknown> = {};
  const response = {
    statusCode: 200,
    setHeader: (key: string, value: unknown) => {
      headersSet[key] = value;
    },
  };

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, request, headersSet };
}

const handlerOf = (value: unknown): CallHandler => ({ handle: () => of(value) });

describe('LoggingInterceptor correlation IDs', () => {
  it('mints a correlation ID when the caller did not supply one', async () => {
    const { context, request, headersSet } = makeHarness();

    await lastValueFrom(new LoggingInterceptor().intercept(context, handlerOf('ok')));

    const minted = request.headers['x-correlation-id'];
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    // The filter reads it off the request; the client reads it off the
    // response. Both must see the same value.
    expect(headersSet['x-correlation-id']).toBe(minted);
  });

  it('propagates a caller-supplied correlation ID unchanged', async () => {
    const { context, request, headersSet } = makeHarness({
      'x-correlation-id': 'client-trace-42',
    });

    await lastValueFrom(new LoggingInterceptor().intercept(context, handlerOf('ok')));

    expect(request.headers['x-correlation-id']).toBe('client-trace-42');
    expect(headersSet['x-correlation-id']).toBe('client-trace-42');
  });

  it('gives distinct requests distinct IDs', async () => {
    const first = makeHarness();
    const second = makeHarness();

    await lastValueFrom(new LoggingInterceptor().intercept(first.context, handlerOf('ok')));
    await lastValueFrom(new LoggingInterceptor().intercept(second.context, handlerOf('ok')));

    expect(first.request.headers['x-correlation-id']).not.toBe(
      second.request.headers['x-correlation-id'],
    );
  });
});

describe('LoggingInterceptor pass-through', () => {
  it('returns the handler value untouched', async () => {
    const { context } = makeHarness();
    const payload = { id: 'contact-1' };

    await expect(
      lastValueFrom(new LoggingInterceptor().intercept(context, handlerOf(payload))),
    ).resolves.toBe(payload);
  });

  it('re-raises handler errors rather than swallowing them', async () => {
    // `tap` observes; it must not consume. If this ever regressed, the global
    // exception filter would never run and the request would hang.
    const { context } = makeHarness();
    const boom = Object.assign(new Error('not found'), { status: 404 });

    await expect(
      lastValueFrom(
        new LoggingInterceptor().intercept(context, { handle: () => throwError(() => boom) }),
      ),
    ).rejects.toBe(boom);
  });

  it('logs a status for an error that carries none', async () => {
    // A raw driver error has no `.status`; the interceptor defaults to 500
    // rather than logging `undefined`.
    const { context } = makeHarness();
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();

    await expect(
      lastValueFrom(
        new LoggingInterceptor().intercept(context, {
          handle: () => throwError(() => new Error('connection reset')),
        }),
      ),
    ).rejects.toThrow('connection reset');

    expect(debug).toHaveBeenCalledWith(expect.stringContaining('| 500 |'));
    debug.mockRestore();
  });

  it('logs the status an HTTP error carries', async () => {
    const { context } = makeHarness();
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();

    await expect(
      lastValueFrom(
        new LoggingInterceptor().intercept(context, {
          handle: () => throwError(() => Object.assign(new Error('nope'), { status: 403 })),
        }),
      ),
    ).rejects.toThrow('nope');

    expect(debug).toHaveBeenCalledWith(expect.stringContaining('| 403 |'));
    debug.mockRestore();
  });

  it('does not log a failed request at warn — the filter already does', async () => {
    /**
     * The point of the level change, pinned so it cannot drift back.
     *
     * `HttpExceptionFilter` emits a complete line for every failing request,
     * with the same correlation id and status. This interceptor's error line is
     * a duplicate of it, and at `warn` it meant the two most routine responses
     * an API serves — a 404 on a bad URL, a 401 on an expired token — each
     * raised a warning. Warnings that fire on routine traffic are warnings
     * nobody reads.
     */
    const { context } = makeHarness();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await expect(
      lastValueFrom(
        new LoggingInterceptor().intercept(context, {
          handle: () => throwError(() => Object.assign(new Error('gone'), { status: 404 })),
        }),
      ),
    ).rejects.toThrow('gone');

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('tolerates a request with no user-agent', async () => {
    const { context } = makeHarness({ 'user-agent': undefined });
    await expect(
      lastValueFrom(new LoggingInterceptor().intercept(context, handlerOf('ok'))),
    ).resolves.toBe('ok');
  });
});
