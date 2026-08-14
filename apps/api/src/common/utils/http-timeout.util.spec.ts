/**
 * The behaviour the outbound-call deadline has to have.
 *
 * The interesting cases are the two ways a provider hangs — never answering,
 * and answering then stalling mid-body — because only the first is what people
 * picture when they say "add a timeout", and only the second is what a
 * headers-only deadline misses.
 */

import { ExternalServiceError } from '@gosumo/shared';

import {
  DEFAULT_HTTP_TIMEOUT_MS,
  HttpTimeoutError,
  MEDIA_HTTP_TIMEOUT_MS,
  fetchWithTimeout,
} from './http-timeout.util';

const realFetch = global.fetch;

/** A `fetch` that respects the signal it is given and otherwise never settles. */
function hangingFetch(): jest.Mock {
  return jest.fn(
    (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return; // no signal: hangs forever, which is the bug
        // Undici rejects synchronously on an already-aborted signal rather than
        // waiting for an event that has been and gone.
        if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
      }),
  );
}

afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

describe('fetchWithTimeout', () => {
  it('aborts a provider that never answers, as a typed retryable failure', async () => {
    jest.useFakeTimers();
    global.fetch = hangingFetch() as unknown as typeof fetch;

    const call = fetchWithTimeout('https://api.stripe.com/v1/charges', { method: 'POST' }, {
      service: 'Stripe',
      timeoutMs: 5_000,
    });
    const asserted = expect(call).rejects.toBeInstanceOf(HttpTimeoutError);

    await jest.advanceTimersByTimeAsync(5_000);
    await asserted;

    await expect(call.catch((err: unknown) => err)).resolves.toMatchObject({
      service: 'Stripe',
      timeoutMs: 5_000,
      retryable: true,
      httpStatus: 502,
    });
  });

  it('is an ExternalServiceError, so the filter and the queue already know what to do with it', async () => {
    jest.useFakeTimers();
    global.fetch = hangingFetch() as unknown as typeof fetch;

    const call = fetchWithTimeout('https://graph.facebook.com/v19.0/1/messages', {}, {
      service: 'WhatsApp',
      timeoutMs: 1_000,
    });
    const asserted = expect(call).rejects.toBeInstanceOf(ExternalServiceError);
    await jest.advanceTimersByTimeAsync(1_000);
    await asserted;
  });

  it('keeps the deadline armed across the body read', async () => {
    jest.useFakeTimers();

    // Headers arrive immediately; the body never does. A deadline cleared when
    // `fetch` resolves would leave this hanging forever.
    let abortBody: ((reason: unknown) => void) | undefined;
    global.fetch = jest.fn((_url: string, init: RequestInit = {}) => {
      init.signal?.addEventListener('abort', () => abortBody?.(init.signal?.reason));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            abortBody = reject;
          }),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const response = await fetchWithTimeout('https://api.twilio.com/x.json', {}, {
      service: 'Twilio',
      timeoutMs: 2_000,
    });

    const body = response.json();
    const asserted = expect(body).rejects.toBeInstanceOf(HttpTimeoutError);
    await jest.advanceTimersByTimeAsync(2_000);
    await asserted;
  });

  it('does not abort a call that answers inside its deadline', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'ok' }) } as unknown as Response),
    ) as unknown as typeof fetch;

    const response = await fetchWithTimeout('https://api.razorpay.com/v1/orders', {}, {
      service: 'Razorpay',
    });
    await expect(response.json()).resolves.toEqual({ id: 'ok' });

    // The armed deadline must not resurface as a late rejection.
    await jest.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS * 2);
    expect(response.status).toBe(200);
  });

  it('passes the composed signal to fetch rather than the caller-supplied one', async () => {
    const spy = jest.fn((_url: string, _init: RequestInit = {}) =>
      Promise.resolve({ ok: true, status: 204 } as unknown as Response),
    );
    global.fetch = spy as unknown as typeof fetch;

    await fetchWithTimeout('https://example.test/hook', { method: 'POST' }, { service: 'CRM' });

    const [, init] = spy.mock.calls[0] ?? [];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.method).toBe('POST');
  });

  it('lets a caller-driven abort surface as itself, not as a timeout', async () => {
    global.fetch = hangingFetch() as unknown as typeof fetch;

    const caller = new AbortController();
    const call = fetchWithTimeout('https://example.test/slow', { signal: caller.signal }, {
      service: 'CRM',
      timeoutMs: 60_000,
    });

    const reason = new Error('caller gave up');
    caller.abort(reason);

    await expect(call).rejects.toBe(reason);
  });

  it('honours a signal that was already aborted before the call', async () => {
    global.fetch = hangingFetch() as unknown as typeof fetch;

    const reason = new Error('already gone');
    const call = fetchWithTimeout('https://example.test/slow', { signal: AbortSignal.abort(reason) }, {
      service: 'CRM',
    });

    await expect(call).rejects.toBe(reason);
  });

  it('propagates a genuine network error unchanged', async () => {
    const boom = new TypeError('fetch failed');
    global.fetch = jest.fn(() => Promise.reject(boom)) as unknown as typeof fetch;

    await expect(
      fetchWithTimeout('https://example.test/down', {}, { service: 'CRM' }),
    ).rejects.toBe(boom);
  });

  it('keeps credentials out of the logged context', async () => {
    jest.useFakeTimers();
    global.fetch = hangingFetch() as unknown as typeof fetch;

    const call = fetchWithTimeout(
      'https://api.example.test/send?api_key=sk_live_secret&sig=abc',
      {},
      { service: 'CRM', timeoutMs: 100 },
    );
    const asserted = expect(call).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(100);
    await asserted;

    const err = (await call.catch((e: unknown) => e)) as HttpTimeoutError;
    expect(err.context['url']).toBe('https://api.example.test/send');
    expect(JSON.stringify(err.context)).not.toContain('sk_live_secret');
  });

  it('gives media transfers a longer budget than JSON calls', () => {
    // The deadline spans the body read, so a binary transfer cannot share the
    // JSON budget without aborting healthy downloads.
    expect(MEDIA_HTTP_TIMEOUT_MS).toBeGreaterThan(DEFAULT_HTTP_TIMEOUT_MS);
  });
});
