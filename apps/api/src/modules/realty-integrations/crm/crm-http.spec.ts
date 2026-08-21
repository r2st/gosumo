/**
 * CRM webhook retry policy.
 *
 * These are outbound pushes to a tenant-configured URL on a host GoSumo does
 * not run — the least reliable destination in the platform, and previously the
 * only outbound HTTP path with no retry at all: one transient 502 from the
 * customer's CRM lost the lead push permanently.
 *
 * The policy is narrow, and the *omissions* are the load-bearing part. A CRM
 * lead push is not idempotent: the destination creates a lead record, so a
 * blind retry of a request that actually succeeded puts the same lead in
 * someone's call list twice. A duplicate is silent; a missed push surfaces as
 * `realty.crm.push_failed` and can be re-driven. So a request is only repeated
 * where it provably never reached the application.
 *
 * Most of this file exists to pin what is *not* retried.
 */
import { Logger } from '@nestjs/common';

import {
  CRM_MAX_ATTEMPTS,
  CRM_RETRYABLE_STATUSES,
  postJson,
} from './crm-http';
import * as httpTimeout from '../../../common/utils/http-timeout.util';

function response(status: number, body = '', headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

describe('postJson', () => {
  let fetchWithTimeout: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    fetchWithTimeout = jest.spyOn(httpTimeout, 'fetchWithTimeout');
  });

  afterEach(() => jest.restoreAllMocks());

  // ─────────────────────────────────────────────
  // The happy path is unchanged
  // ─────────────────────────────────────────────

  it('returns the parsed body on a first-attempt success', async () => {
    fetchWithTimeout.mockResolvedValue(response(200, '{"id":"lead-1"}'));

    const result = await postJson('https://crm.example/hook', { a: 1 });

    expect(result).toEqual({
      ok: true,
      status: 200,
      body: { id: 'lead-1' },
      attempts: 1,
    });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('falls back to raw text when the response is not JSON', async () => {
    fetchWithTimeout.mockResolvedValue(response(200, 'OK'));

    await expect(postJson('https://crm.example/hook', {})).resolves.toMatchObject({ body: 'OK' });
  });

  it('reports a null body for an empty response', async () => {
    fetchWithTimeout.mockResolvedValue(response(204, ''));

    await expect(postJson('https://crm.example/hook', {})).resolves.toMatchObject({ body: null });
  });

  it('goes through fetchWithTimeout, so a stalled host cannot hold the worker', async () => {
    fetchWithTimeout.mockResolvedValue(response(200));

    await postJson('https://crm.example/hook', {});

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      'https://crm.example/hook',
      expect.objectContaining({ method: 'POST' }),
      expect.objectContaining({ service: 'CRM webhook' }),
    );
  });

  // ─────────────────────────────────────────────
  // What is retried
  // ─────────────────────────────────────────────

  describe('retries', () => {
    it.each([...CRM_RETRYABLE_STATUSES])('retries a %i', async (status) => {
      fetchWithTimeout
        .mockResolvedValueOnce(response(status))
        .mockResolvedValueOnce(response(200, '{"ok":true}'));

      const result = await postJson('https://crm.example/hook', {});

      expect(result).toMatchObject({ ok: true, attempts: 2 });
      expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it('gives up after the attempt budget and reports the last response', async () => {
      fetchWithTimeout.mockResolvedValue(response(503));

      const result = await postJson('https://crm.example/hook', {});

      expect(fetchWithTimeout).toHaveBeenCalledTimes(CRM_MAX_ATTEMPTS);
      expect(result).toMatchObject({ ok: false, status: 503, attempts: CRM_MAX_ATTEMPTS });
    });

    it('sends the identical payload on every attempt', async () => {
      fetchWithTimeout
        .mockResolvedValueOnce(response(502))
        .mockResolvedValueOnce(response(200));

      await postJson('https://crm.example/hook', { lead: 'l-1' });

      const bodies = fetchWithTimeout.mock.calls.map(
        (c) => (c[1] as { body: string }).body,
      );
      expect(bodies[0]).toBe(bodies[1]);
      expect(bodies[0]).toBe('{"lead":"l-1"}');
    });

    it('preserves caller-supplied headers across retries', async () => {
      fetchWithTimeout
        .mockResolvedValueOnce(response(429))
        .mockResolvedValueOnce(response(200));

      await postJson('https://crm.example/hook', {}, { 'x-api-key': 'k' });

      for (const call of fetchWithTimeout.mock.calls) {
        expect((call[1] as { headers: Record<string, string> }).headers).toMatchObject({
          'x-api-key': 'k',
          'Content-Type': 'application/json',
        });
      }
    });
  });

  // ─────────────────────────────────────────────
  // What is NOT retried — the duplicate-lead guard
  // ─────────────────────────────────────────────

  describe('does not retry an ambiguous send', () => {
    it('does not retry a 500: the origin may have created the lead before failing', async () => {
      fetchWithTimeout.mockResolvedValue(response(500));

      const result = await postJson('https://crm.example/hook', {});

      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: false, status: 500, attempts: 1 });
    });

    it('does not retry a timeout or transport error', async () => {
      // The bytes were sent; whether they were processed is unknowable here.
      fetchWithTimeout.mockRejectedValue(new Error('timeout of 10000ms exceeded'));

      await expect(postJson('https://crm.example/hook', {})).rejects.toThrow('timeout');
      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it.each([400, 401, 403, 404, 422])('does not retry a %i', async (status) => {
      // A bad payload or bad credentials reproduces exactly on a re-run.
      fetchWithTimeout.mockResolvedValue(response(status));

      const result = await postJson('https://crm.example/hook', {});

      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
      expect(result.attempts).toBe(1);
    });

    it('excludes 500 from the retryable set explicitly', () => {
      expect(CRM_RETRYABLE_STATUSES.has(500)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────
  // Retry-After
  // ─────────────────────────────────────────────

  describe('Retry-After', () => {
    /**
     * Fake timers rather than real sleeps: the cap under test is five seconds,
     * and a suite that actually waits it out is five seconds slower for every
     * run forever. Advancing explicitly also lets the delay be asserted
     * exactly, instead of inferred from a wall-clock lower bound that has to be
     * loose enough not to flake on a loaded machine.
     */
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    /** Run `postJson`, advancing `ms` of backoff, and return the result. */
    async function runWithBackoff(ms: number): Promise<{ attempts: number }> {
      const pending = postJson('https://crm.example/hook', {});
      // Let the first fetch settle before the timer exists to advance.
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(ms);
      return pending;
    }

    it('waits the header value when it is short', async () => {
      fetchWithTimeout
        .mockResolvedValueOnce(response(429, '', { 'retry-after': '1' }))
        .mockResolvedValueOnce(response(200));

      // One second, not the 500ms default backoff for a first retry.
      await expect(runWithBackoff(1_000)).resolves.toMatchObject({ attempts: 2 });
    });

    it('does not retry before the header value has elapsed', async () => {
      fetchWithTimeout
        .mockResolvedValueOnce(response(429, '', { 'retry-after': '1' }))
        .mockResolvedValueOnce(response(200));

      const pending = postJson('https://crm.example/hook', {});
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(600);

      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(500);
      await pending;
    });

    it('caps a long Retry-After rather than holding the worker', async () => {
      // "Wait an hour" means the quota is gone; sleeping that long inside a
      // worker is never right. The cap turns it into a hint.
      fetchWithTimeout
        .mockResolvedValueOnce(response(429, '', { 'retry-after': '3600' }))
        .mockResolvedValueOnce(response(200));

      await expect(runWithBackoff(5_000)).resolves.toMatchObject({ attempts: 2 });
    });

    it.each([['a date', 'Wed, 21 Oct 2026 07:28:00 GMT'], ['a negative', '-5']])(
      'ignores %s Retry-After and uses the exponential backoff',
      async (_label, header) => {
        fetchWithTimeout
          .mockResolvedValueOnce(response(503, '', { 'retry-after': header }))
          .mockResolvedValueOnce(response(200));

        await expect(runWithBackoff(500)).resolves.toMatchObject({ attempts: 2 });
      },
    );

    it('doubles the backoff between the first and second retry', async () => {
      fetchWithTimeout.mockResolvedValue(response(503));

      const pending = postJson('https://crm.example/hook', {});
      await jest.advanceTimersByTimeAsync(0);

      await jest.advanceTimersByTimeAsync(500);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(2);

      // The second gap is 1000ms, not another 500ms.
      await jest.advanceTimersByTimeAsync(600);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(400);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(3);

      await pending;
    });
  });
});
