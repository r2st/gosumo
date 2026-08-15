/**
 * The breaker's contract, driven with an injected clock rather than timers.
 *
 * Every test here describes a way the breaker can be subtly wrong while still
 * looking like a breaker: opening on a caller's own bad request, staying open
 * after the provider recovers, admitting every waiting caller at once the
 * moment the cooldown elapses, or wedging itself half-open forever.
 */

import { ExternalServiceError, ValidationError } from '@gosumo/shared';
import {
  CircuitBreaker,
  CircuitOpenError,
  defaultIsOutage,
} from './circuit-breaker';

const THRESHOLD = 3;
const COOLDOWN_MS = 30_000;

/** A retryable provider failure — the shape the breaker counts. */
function outage(): ExternalServiceError {
  return new ExternalServiceError('Acme', 'unavailable', {
    status: 503,
    retryable: true,
  });
}

/** A provider answering "your request is wrong" — never an outage. */
function badRequest(): ExternalServiceError {
  return new ExternalServiceError('Acme', 'amount must be positive', {
    status: 400,
    retryable: false,
  });
}

/** Builds a breaker over a clock the test moves by hand. */
function makeBreaker(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  let nowMs = 1_000_000;
  const breaker = new CircuitBreaker({
    name: 'Acme',
    failureThreshold: THRESHOLD,
    cooldownMs: COOLDOWN_MS,
    now: () => nowMs,
    ...overrides,
  });
  return {
    breaker,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

/** Drive `count` failing calls, swallowing each rejection. */
async function failTimes(
  breaker: CircuitBreaker,
  count: number,
  error: () => Error = outage,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await breaker.run(() => Promise.reject(error())).catch(() => undefined);
  }
}

describe('CircuitBreaker', () => {
  describe('closed', () => {
    it('passes a result straight through', async () => {
      const { breaker } = makeBreaker();

      await expect(breaker.run(async () => 'ok')).resolves.toBe('ok');
      expect(breaker.state).toBe('closed');
    });

    it('rethrows the original error untouched', async () => {
      const { breaker } = makeBreaker();
      const thrown = outage();

      await expect(breaker.run(() => Promise.reject(thrown))).rejects.toBe(thrown);
    });

    it('stays closed one failure short of the threshold', async () => {
      const { breaker } = makeBreaker();

      await failTimes(breaker, THRESHOLD - 1);

      expect(breaker.state).toBe('closed');
    });
  });

  describe('opening', () => {
    it('opens at the threshold', async () => {
      const { breaker } = makeBreaker();

      await failTimes(breaker, THRESHOLD);

      expect(breaker.state).toBe('open');
      expect(breaker.isOpen).toBe(true);
    });

    it('stops calling the dependency at all once open', async () => {
      const { breaker } = makeBreaker();
      const call = jest.fn().mockRejectedValue(outage());

      for (let i = 0; i < THRESHOLD + 5; i++) {
        await breaker.run(call).catch(() => undefined);
      }

      // This is the entire point: no socket, no deadline, no worker slot held.
      expect(call).toHaveBeenCalledTimes(THRESHOLD);
    });

    it('rejects with a retryable CircuitOpenError naming the dependency', async () => {
      const { breaker } = makeBreaker();
      await failTimes(breaker, THRESHOLD);

      const error = await breaker.run(async () => 'never').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CircuitOpenError);
      expect((error as CircuitOpenError).message).toContain('Acme');
      // A queue consumer must treat this as "later", not "never" — the
      // dependency is expected back.
      expect((error as CircuitOpenError).retryable).toBe(true);
    });

    it('resets the run on any success, so scattered blips never trip it', async () => {
      const { breaker } = makeBreaker();

      for (let i = 0; i < 10; i++) {
        await failTimes(breaker, THRESHOLD - 1);
        await breaker.run(async () => 'ok');
      }

      expect(breaker.state).toBe('closed');
    });
  });

  describe('what counts as an outage', () => {
    it('never opens on the caller\'s own bad request', async () => {
      // Opening here would take a healthy dependency offline for every tenant
      // because one request was malformed.
      const { breaker } = makeBreaker();

      await failTimes(breaker, THRESHOLD * 3, badRequest);

      expect(breaker.state).toBe('closed');
    });

    it('never opens on a bug in our own code', async () => {
      // A TypeError from a mapping bug is not evidence about the provider, and
      // fast-failing on it would hide the stack that shows the bug.
      const { breaker } = makeBreaker();

      await failTimes(breaker, THRESHOLD * 3, () => new TypeError('x is not a function'));

      expect(breaker.state).toBe('closed');
    });

    it('opens on a transport failure that never reached the provider', async () => {
      const { breaker } = makeBreaker();
      const refused = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });

      await failTimes(breaker, THRESHOLD, () => refused);

      expect(breaker.state).toBe('open');
    });

    it('reads a transport code through the cause chain', async () => {
      // `fetch` reports a connection failure as a bare TypeError whose `cause`
      // carries the real code — the shape undici actually throws.
      const { breaker } = makeBreaker();
      const wrapped = () =>
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.acme.com'), {
            code: 'ENOTFOUND',
          }),
        });

      await failTimes(breaker, THRESHOLD, wrapped);

      expect(breaker.state).toBe('open');
    });

    it('honours a caller-supplied classifier', async () => {
      const { breaker } = makeBreaker({ isOutage: () => true });

      await failTimes(breaker, THRESHOLD, badRequest);

      expect(breaker.state).toBe('open');
    });
  });

  describe('recovery', () => {
    it('keeps rejecting until the cooldown elapses', async () => {
      const { breaker, advance } = makeBreaker();
      await failTimes(breaker, THRESHOLD);

      advance(COOLDOWN_MS - 1);

      await expect(breaker.run(async () => 'ok')).rejects.toBeInstanceOf(CircuitOpenError);
    });

    it('lets exactly one probe through after the cooldown', async () => {
      const { breaker, advance } = makeBreaker();
      await failTimes(breaker, THRESHOLD);
      advance(COOLDOWN_MS);

      // Three callers arrive at once. Admitting all three would put the full
      // stalled load back on a dependency that has only just come up.
      let admitted = 0;
      const stalled = () =>
        new Promise<string>((resolve) => {
          admitted++;
          setTimeout(() => resolve('ok'), 0);
        });
      await Promise.all([
        breaker.run(stalled).catch(() => undefined),
        breaker.run(stalled).catch(() => undefined),
        breaker.run(stalled).catch(() => undefined),
      ]);

      expect(admitted).toBe(1);
    });

    it('closes when the probe succeeds', async () => {
      const { breaker, advance } = makeBreaker();
      await failTimes(breaker, THRESHOLD);
      advance(COOLDOWN_MS);

      await expect(breaker.run(async () => 'ok')).resolves.toBe('ok');

      expect(breaker.state).toBe('closed');
    });

    it('re-opens on a fresh clock when the probe fails', async () => {
      const { breaker, advance } = makeBreaker();
      await failTimes(breaker, THRESHOLD);
      advance(COOLDOWN_MS);

      await failTimes(breaker, 1); // the probe

      // Without restarting the clock the breaker would be open-but-elapsed and
      // wave the very next caller straight through.
      const call = jest.fn().mockResolvedValue('ok');
      await breaker.run(call).catch(() => undefined);

      expect(breaker.state).toBe('open');
      expect(call).not.toHaveBeenCalled();
    });

    it('closes when the probe reaches the provider and gets a real rejection', async () => {
      // A 400 from the probe means the provider is answering — the outage is
      // over. Leaving the breaker half-open here would wedge it permanently:
      // no further call is admitted, and the only thing that could clear it is
      // a success that can never be attempted.
      const { breaker, advance } = makeBreaker();
      await failTimes(breaker, THRESHOLD);
      advance(COOLDOWN_MS);

      await failTimes(breaker, 1, badRequest); // the probe

      expect(breaker.state).toBe('closed');
      await expect(breaker.run(async () => 'ok')).resolves.toBe('ok');
    });

    it('reports half_open only while the probe is in flight', async () => {
      const { breaker, advance } = makeBreaker();
      await failTimes(breaker, THRESHOLD);
      expect(breaker.state).toBe('open');

      advance(COOLDOWN_MS);
      let release: (v: string) => void = () => undefined;
      const inFlight = breaker.run(() => new Promise<string>((r) => (release = r)));

      expect(breaker.state).toBe('half_open');
      release('ok');
      await inFlight;
      expect(breaker.state).toBe('closed');
    });
  });

  describe('snapshot', () => {
    it('reports a closed breaker with no open duration', () => {
      const { breaker } = makeBreaker();

      expect(breaker.snapshot()).toEqual({
        name: 'Acme',
        state: 'closed',
        consecutiveFailures: 0,
      });
    });

    it('reports how long an open breaker has been open', async () => {
      const { breaker, advance } = makeBreaker();
      await failTimes(breaker, THRESHOLD);
      advance(5_000);

      expect(breaker.snapshot()).toEqual({
        name: 'Acme',
        state: 'open',
        consecutiveFailures: THRESHOLD,
        openForMs: 5_000,
      });
    });
  });

  it('can be closed by hand, for an operator who knows better', async () => {
    const { breaker } = makeBreaker();
    await failTimes(breaker, THRESHOLD);

    breaker.reset();

    expect(breaker.state).toBe('closed');
    await expect(breaker.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('uses a custom open-circuit error when one is supplied', async () => {
    class Terminal extends Error {}
    const { breaker } = makeBreaker({ openError: () => new Terminal('gone') });
    await failTimes(breaker, THRESHOLD);

    await expect(breaker.run(async () => 'ok')).rejects.toBeInstanceOf(Terminal);
  });
});

describe('defaultIsOutage', () => {
  it('trusts the taxonomy', () => {
    expect(defaultIsOutage(outage())).toBe(true);
    expect(defaultIsOutage(badRequest())).toBe(false);
    expect(defaultIsOutage(new ValidationError('bad field'))).toBe(false);
  });

  it('does not recurse past a bounded cause chain', () => {
    // A self-referential cause is not hypothetical: wrapping an error in
    // itself is a one-character mistake, and an unbounded walk would hang the
    // failure path rather than the success path.
    const loop: { cause?: unknown } = {};
    loop.cause = loop;

    expect(defaultIsOutage(loop)).toBe(false);
  });

  it('ignores a non-string code', () => {
    expect(defaultIsOutage(Object.assign(new Error('x'), { code: 500 }))).toBe(false);
  });
});
