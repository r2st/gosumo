/**
 * Contract: no outbound HTTP call is made without a deadline.
 *
 * Node's global `fetch` will wait forever. Every provider GoSumo talks to —
 * Meta, Twilio, SendGrid, Stripe, Razorpay, Google, Qdrant, and whatever host a
 * tenant put in their CRM webhook field — can accept a connection and then stop
 * answering, and until this round nothing in the platform except the LLM client
 * put a bound on that. The failure is quiet in the worst way: the request never
 * errors, so nothing retries, nothing alerts, and no error rate moves. An API
 * request parks; a BullMQ worker parks a concurrency slot, and the queue loses
 * throughput one stuck job at a time until the pod is restarted.
 *
 * Nothing about a bare `await fetch(url, { ... })` looks wrong in review — it is
 * the obvious way to write the call, and it behaves perfectly against a healthy
 * provider — so a static sweep is the only thing that catches the next one.
 * The behavioural tests below pin that the sweep is checking something real.
 *
 * @see common/utils/http-timeout.util.ts
 */

import * as fs from 'fs';
import * as path from 'path';

import { ConfigService } from '@nestjs/config';
import { MessageContentType } from '@gosumo/shared';
import type { OutboundMessage } from '@gosumo/shared';

import { HttpTimeoutError } from '../common/utils/http-timeout.util';
import { postJson } from './realty-integrations/crm/crm-http';
import { WhatsAppAdapter } from './channel-adapter/adapters/whatsapp.adapter';

// ─────────────────────────────────────────────
// Static sweep
// ─────────────────────────────────────────────

/**
 * Files allowed to call the global `fetch` directly, and why.
 *
 * Paths are relative to `src/`. Keep this list short: a new entry is a new
 * place that can hang, so it needs a reason that `fetchWithTimeout` genuinely
 * cannot serve.
 */
const ALLOWED_BARE_FETCH: ReadonlyMap<string, string> = new Map([
  ['common/utils/http-timeout.util.ts', 'defines the wrapper'],
  [
    'modules/ai-engine/pipeline/llm-client.service.ts',
    'has its own deadline, tied to a circuit breaker and retry budget nothing else shares',
  ],
]);

describe('every outbound HTTP call has a deadline', () => {
  const SRC_ROOT = path.join(__dirname, '..');

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (entry.name.endsWith('.ts') && !entry.name.includes('.spec.')) out.push(full);
    }
    return out;
  }

  /**
   * A call to the global `fetch`, as opposed to `fetchWithTimeout(` (the name
   * continues past `fetch`) or a method named `…fetch(` on some object (the
   * lookbehind rejects a preceding `.` or word character).
   */
  const BARE_FETCH = /(?<![\w.])fetch\s*\(/;

  it('no source file calls the global fetch outside the documented exceptions', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC_ROOT)) {
      const relative = path.relative(SRC_ROOT, file);
      if (ALLOWED_BARE_FETCH.has(relative)) continue;

      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (BARE_FETCH.test(line)) offenders.push(`${relative}:${i + 1} — ${line.trim()}`);
        });
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the exception list honest — every allowed file still calls fetch', () => {
    // A stale exception is how the next bare `fetch` slips in: the entry stops
    // describing anything, and the path it names may later be reused.
    for (const [relative] of ALLOWED_BARE_FETCH) {
      const contents = fs.readFileSync(path.join(SRC_ROOT, relative), 'utf8');
      expect(BARE_FETCH.test(contents)).toBe(true);
    }
  });

  it('the LLM client bounds its own call rather than relying on the wrapper', () => {
    const contents = fs.readFileSync(
      path.join(SRC_ROOT, 'modules/ai-engine/pipeline/llm-client.service.ts'),
      'utf8',
    );
    expect(contents).toContain('AbortController');
    expect(contents).toMatch(/signal:\s*controller\.signal/);
  });
});

// ─────────────────────────────────────────────
// Behavioural
// ─────────────────────────────────────────────

const realFetch = global.fetch;

/** A provider that accepts the connection and then never answers. */
function stalls(): jest.Mock {
  return jest.fn(
    (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason ?? new Error('aborted')),
        );
      }),
  );
}

afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

describe('a stalled provider fails instead of hanging', () => {
  it('gives up on a tenant CRM webhook host that stops answering', async () => {
    jest.useFakeTimers();
    global.fetch = stalls() as unknown as typeof fetch;

    // The worst case in the platform: the URL is tenant-supplied, the host is
    // one GoSumo does not run, and the call happens on a worker.
    const call = postJson('https://tenant-crm.example.test/hook', { lead: 'x' });
    const asserted = expect(call).rejects.toBeInstanceOf(HttpTimeoutError);

    await jest.advanceTimersByTimeAsync(60_000);
    await asserted;
  });

  it('gives up on a Meta send that stops answering', async () => {
    jest.useFakeTimers();
    global.fetch = stalls() as unknown as typeof fetch;

    const adapter = new WhatsAppAdapter({
      get: (key: string, fallback?: string) =>
        ({
          'whatsapp.accessToken': 'token',
          'whatsapp.phoneNumberId': '123',
        })[key] ??
        fallback ??
        '',
    } as unknown as ConfigService);

    const send = adapter.sendMessage({
      recipientExternalId: '919812345678',
      content: { type: MessageContentType.TEXT, text: 'Hi' },
    } as OutboundMessage);

    // The adapter retries with backoff, so drain well past a single deadline.
    const settled = send.then(
      (result) => result,
      (err: unknown) => ({ success: false, error: String(err) }),
    );
    await jest.advanceTimersByTimeAsync(120_000);

    await expect(settled).resolves.toMatchObject({ success: false });
  });

  it('passes an abort signal on every send, not just the ones under test', async () => {
    const spy = jest.fn((_url: string, _init: RequestInit = {}) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ messages: [{ id: 'wamid.out' }] }),
      } as unknown as Response),
    );
    global.fetch = spy as unknown as typeof fetch;

    const adapter = new WhatsAppAdapter({
      get: (key: string, fallback?: string) =>
        ({
          'whatsapp.accessToken': 'token',
          'whatsapp.phoneNumberId': '123',
        })[key] ??
        fallback ??
        '',
    } as unknown as ConfigService);

    await adapter.sendMessage({
      recipientExternalId: '919812345678',
      content: { type: MessageContentType.TEXT, text: 'Hi' },
    } as OutboundMessage);

    const [, init] = spy.mock.calls[0] ?? [];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
