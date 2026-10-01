/**
 * BaseChannelAdapter unit tests.
 *
 * Every concrete adapter routes its outbound calls through `sendWithRetry`, so
 * the retry policy is exercised five times over by the per-channel suites — but
 * always through a real adapter's HTTP mocking, which makes it awkward to pin
 * down *how many* attempts happened and how long they waited. This suite drives
 * the base class directly with a stub operation instead, so the attempt count
 * and the backoff schedule are observable.
 *
 * Timers are faked: the backoff sleeps are real `setTimeout` calls and a test
 * that actually waited 500ms + 1000ms would make this suite the slowest in the
 * repo for no benefit.
 */

import { Logger } from '@nestjs/common';
import {
  ChannelType,
  ChannelCapabilities,
  ExternalServiceError,
  InteractiveMessage,
  NormalizedMessage,
  OutboundMessage,
  PayloadParseError,
  RawRequest,
  SendResult,
  TemplateMessage,
  UnsupportedOperationError,
  ValidationError,
} from '@gosumo/shared';
import { BaseChannelAdapter } from './base.adapter';

/**
 * A minimal concrete adapter. The abstract send methods are never called here —
 * the tests drive the protected `sendWithRetry` directly through `run`.
 */
class TestAdapter extends BaseChannelAdapter {
  readonly channelType = ChannelType.WHATSAPP;

  constructor(options: { maxAttempts?: number; retryDelayMs?: number } = {}) {
    super('TestAdapter', options);
  }

  validateWebhook(_req: RawRequest): boolean {
    return true;
  }

  parseInbound(_req: RawRequest): NormalizedMessage {
    throw new Error('not used');
  }

  getCapabilities(): ChannelCapabilities {
    throw new Error('not used');
  }

  sendMessage(_message: OutboundMessage): Promise<SendResult> {
    throw new Error('not used');
  }

  sendTemplate(_template: TemplateMessage): Promise<SendResult> {
    throw new Error('not used');
  }

  sendInteractive(_interactive: InteractiveMessage): Promise<SendResult> {
    throw new Error('not used');
  }

  /** Exposes the protected helper under test. */
  run(operation: () => Promise<SendResult>, label = 'sendMessage'): Promise<SendResult> {
    return this.sendWithRetry(operation, label);
  }

  /** Exposes the protected failure wrapper. */
  fail(err: unknown, context?: string): SendResult {
    return this.buildFailedResult(err, context);
  }
}

describe('BaseChannelAdapter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // The base class logs on every retry and every terminal failure; silence
    // the Nest logger so the suite's own output stays readable.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /**
   * Runs a `sendWithRetry` to completion under fake timers.
   *
   * The helper cannot simply `await` the call: the backoff sleeps never fire on
   * their own with timers faked, so the promise would hang. Draining pending
   * timers between microtask flushes advances each sleep as it is scheduled.
   */
  async function settle(promise: Promise<SendResult>): Promise<SendResult> {
    let done = false;
    const wrapped = promise.then((r) => {
      done = true;
      return r;
    });
    while (!done) {
      await Promise.resolve();
      if (jest.getTimerCount() > 0) {
        jest.runOnlyPendingTimers();
      } else {
        break;
      }
      await Promise.resolve();
    }
    return wrapped;
  }

  // ── success paths ────────────────────────────

  describe('a succeeding operation', () => {
    it('returns on the first attempt without sleeping', async () => {
      const adapter = new TestAdapter();
      const operation = jest.fn().mockResolvedValue({ success: true, externalId: 'x' });

      const result = await settle(adapter.run(operation));

      expect(result).toEqual({ success: true, externalId: 'x', attempts: 1 });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('reports the attempt on which a flaky operation finally succeeded', async () => {
      const adapter = new TestAdapter({ retryDelayMs: 10 });
      const operation = jest
        .fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValue({ success: true, externalId: 'x' });

      const result = await settle(adapter.run(operation));

      // `attempts` is what the caller records against the message, so an
      // off-by-one here would misreport a first-try send as a retry.
      expect(result.attempts).toBe(2);
      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  // ── non-retryable throws ─────────────────────

  describe('a non-retryable throw', () => {
    it('surfaces immediately instead of burning the attempt budget', async () => {
      const adapter = new TestAdapter();
      const operation = jest
        .fn()
        .mockRejectedValue(
          new UnsupportedOperationError('Instagram does not support sending location messages'),
        );

      const result = await settle(adapter.run(operation));

      // The whole point of the taxonomy's `retryable` flag: a channel that
      // cannot send locations will not learn to on the third try.
      expect(operation).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        success: false,
        attempts: 1,
        error: 'Instagram does not support sending location messages',
      });
      expect(jest.getTimerCount()).toBe(0);
    });

    it.each([
      ['a validation failure', new ValidationError('recipient is not an E.164 number')],
      ['a parse failure', new PayloadParseError('WhatsApp', 'unreadable payload')],
      [
        'a provider 400',
        new ExternalServiceError('WhatsApp', 'rejected the request', { status: 400 }),
      ],
    ])('does not retry %s', async (_label, error) => {
      const adapter = new TestAdapter();
      const operation = jest.fn().mockRejectedValue(error);

      const result = await settle(adapter.run(operation));

      expect(operation).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
    });
  });

  // ── retryable throws ─────────────────────────

  describe('a retryable throw', () => {
    it('retries a provider 5xx up to the attempt limit', async () => {
      const adapter = new TestAdapter({ maxAttempts: 3, retryDelayMs: 100 });
      const operation = jest
        .fn()
        .mockRejectedValue(
          new ExternalServiceError('WhatsApp', 'service unavailable', { status: 503 }),
        );

      const result = await settle(adapter.run(operation));

      expect(operation).toHaveBeenCalledTimes(3);
      expect(result).toEqual({
        success: false,
        attempts: 3,
        error: 'service unavailable',
      });
    });

    it.each([
      ['a 429', 429],
      ['a 408', 408],
    ])('retries %s, which the provider may answer differently', async (_label, status) => {
      const adapter = new TestAdapter({ maxAttempts: 2, retryDelayMs: 10 });
      const operation = jest
        .fn()
        .mockRejectedValue(new ExternalServiceError('WhatsApp', 'slow down', { status }));

      await settle(adapter.run(operation));

      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('treats an unclassified throwable as retryable', async () => {
      const adapter = new TestAdapter({ maxAttempts: 2, retryDelayMs: 10 });
      // A caller that asked for retries should not lose them to an error the
      // taxonomy could not classify — a bare Error keeps the old behaviour.
      const operation = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

      const result = await settle(adapter.run(operation));

      expect(operation).toHaveBeenCalledTimes(2);
      expect(result.error).toBe('ECONNRESET');
    });

    it('stringifies a non-Error rejection rather than reporting "undefined"', async () => {
      const adapter = new TestAdapter({ maxAttempts: 1 });
      const operation = jest.fn().mockRejectedValue('just a string');

      const result = await settle(adapter.run(operation));

      expect(result.error).toBe('just a string');
    });

    it('backs off exponentially from the configured delay', async () => {
      const adapter = new TestAdapter({ maxAttempts: 3, retryDelayMs: 500 });
      const operation = jest.fn().mockRejectedValue(new Error('transient'));
      const delays: number[] = [];
      jest.spyOn(global, 'setTimeout').mockImplementation(((
        fn: () => void,
        ms?: number,
      ): NodeJS.Timeout => {
        delays.push(ms ?? 0);
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout);

      await adapter.run(operation);

      // 500 → 1000: doubling, and no sleep after the final attempt.
      expect(delays).toEqual([500, 1000]);
    });
  });

  // ── failed results (not throws) ──────────────

  describe('an operation that returns success: false', () => {
    it('is surfaced without a retry', async () => {
      const adapter = new TestAdapter();
      const operation = jest
        .fn()
        .mockResolvedValue({ success: false, error: 'recipient blocked the business' });

      const result = await settle(adapter.run(operation));

      // A returned failure is the adapter's own verdict — it has already
      // decided this is terminal, so the base class must not second-guess it.
      expect(operation).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        success: false,
        error: 'recipient blocked the business',
        attempts: 1,
      });
    });

    it('tolerates a failure result that carries no error text', async () => {
      const adapter = new TestAdapter();
      const operation = jest.fn().mockResolvedValue({ success: false });

      const result = await settle(adapter.run(operation));

      expect(result).toEqual({ success: false, attempts: 1 });
    });
  });

  // ── media stubs ──────────────────────────────

  describe('the default media stubs', () => {
    it('rejects downloadMedia as unsupported for the channel', async () => {
      const adapter = new TestAdapter();

      const error = await adapter.downloadMedia('media_1').then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect((error as UnsupportedOperationError).context).toEqual({
        channelType: ChannelType.WHATSAPP,
        operation: 'downloadMedia',
      });
    });

    it('rejects uploadMedia as unsupported for the channel', async () => {
      const adapter = new TestAdapter();

      const error = await adapter.uploadMedia(Buffer.from('x'), 'image/png').then(
        () => null,
        (err: unknown) => err,
      );

      // 422, not 500: the request was fine, this channel just can't do it.
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect((error as UnsupportedOperationError).httpStatus).toBe(422);
      expect((error as UnsupportedOperationError).retryable).toBe(false);
    });
  });

  // ── buildFailedResult ────────────────────────

  describe('buildFailedResult', () => {
    it('prefixes the context onto the message when one is given', () => {
      const adapter = new TestAdapter();

      expect(adapter.fail(new Error('boom'), 'sendTemplate')).toEqual({
        success: false,
        error: 'sendTemplate: boom',
      });
    });

    it('uses the bare message when no context is given', () => {
      const adapter = new TestAdapter();

      expect(adapter.fail(new Error('boom'))).toEqual({ success: false, error: 'boom' });
    });

    it('stringifies a non-Error throwable', () => {
      const adapter = new TestAdapter();

      expect(adapter.fail({ code: 42 })).toEqual({
        success: false,
        error: '[object Object]',
      });
    });
  });
});
