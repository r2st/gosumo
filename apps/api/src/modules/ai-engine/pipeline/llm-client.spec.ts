import { ConfigService } from '@nestjs/config';
import { LlmClientService, LlmUnavailableError } from './llm-client.service';
import {
  LLM_BREAKER_COOLDOWN_MS,
  LLM_BREAKER_FAILURE_THRESHOLD,
} from '../ai-engine.constants';

function makeClient(apiKey = 'test-key'): LlmClientService {
  const config = {
    get: (key: string, fallback?: string) => (key === 'openrouter.apiKey' ? apiKey : fallback ?? ''),
  } as unknown as ConfigService;
  return new LlmClientService(config);
}

const req = { system: 'sys', user: 'hello' };

describe('LlmClientService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('throws LlmUnavailableError when the API key is missing', async () => {
    const client = makeClient('');
    await expect(client.complete(req)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('returns text and token usage on a 200 response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"response_text":"hi"}' }, finish_reason: 'stop' }],
        model: 'openai/gpt-oss-20b:free',
        usage: { prompt_tokens: 42, completion_tokens: 8 },
      }),
    } as unknown as Response);

    const client = makeClient();
    const result = await client.complete(req);

    expect(result.text).toBe('{"response_text":"hi"}');
    expect(result.modelId).toBe('openai/gpt-oss-20b:free');
    expect(result.promptTokens).toBe(42);
    expect(result.completionTokens).toBe(8);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('does not retry on a 4xx error', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    } as unknown as Response);

    const client = makeClient();
    await expect(client.complete(req)).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries on a 5xx error then fails', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'unavailable',
    } as unknown as Response);

    const client = makeClient();
    await expect(client.complete(req)).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // maxAttempts = 2
  }, 10_000);

  /**
   * OpenRouter's free tier is served by a rotating set of providers, and a 200
   * from one of them is not a guarantee of shape — `choices`, `message`,
   * `usage` and `model` have all been seen missing. Every one of them must
   * degrade to a default rather than throw, because a TypeError here surfaces
   * to the customer as a dead conversation instead of an escalation.
   */
  describe('tolerating a well-formed 200 with missing fields', () => {
    const respond = (body: unknown) =>
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => body,
      } as unknown as Response);

    it('returns empty text and zeroed usage for an entirely bare body', async () => {
      respond({});

      const result = await makeClient().complete(req);

      expect(result.text).toBe('');
      expect(result.promptTokens).toBe(0);
      expect(result.completionTokens).toBe(0);
    });

    it('falls back to the requested model when the response names none', async () => {
      respond({ choices: [{ message: { content: 'hi' } }] });

      const result = await makeClient().complete({ ...req, model: 'openai/gpt-oss-120b:free' });

      expect(result.modelId).toBe('openai/gpt-oss-120b:free');
    });

    it('treats a choice with no message, and one with no content, as empty', async () => {
      respond({ choices: [{ finish_reason: 'stop' }, { message: {} }] });

      expect((await makeClient().complete(req)).text).toBe('');
    });

    it('joins the content of several choices', async () => {
      respond({ choices: [{ message: { content: 'a' } }, { message: { content: 'b' } }] });

      expect((await makeClient().complete(req)).text).toBe('ab');
    });

    it('zeroes each usage counter independently', async () => {
      respond({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 7 } });

      const result = await makeClient().complete(req);

      expect(result.promptTokens).toBe(7);
      expect(result.completionTokens).toBe(0);
    });
  });

  /** A rejection that is not an Error must still reach the caller as a message. */
  it('wraps a non-Error rejection rather than reporting "[object Object]"', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue('socket hang up');

    await expect(makeClient().complete(req)).rejects.toThrow('socket hang up');
  }, 10_000);

  describe('extractJson', () => {
    it('parses a bare JSON object', () => {
      const client = makeClient();
      expect(client.extractJson('{"a":1}')).toEqual({ a: 1 });
    });

    it('returns null for empty text without attempting a parse', () => {
      expect(makeClient().extractJson('')).toBeNull();
    });

    it('extracts JSON from a fenced code block', () => {
      const client = makeClient();
      expect(client.extractJson('text ```json\n{"a":2}\n``` more')).toEqual({ a: 2 });
    });

    it('extracts the outermost object embedded in prose', () => {
      const client = makeClient();
      expect(client.extractJson('Here: {"a":3, "b":{"c":4}} done')).toEqual({ a: 3, b: { c: 4 } });
    });

    it('returns null when there is no JSON', () => {
      const client = makeClient();
      expect(client.extractJson('nothing here')).toBeNull();
    });
  });
});

/**
 * Circuit breaker.
 *
 * Retry-with-backoff is the right shape for a blip and the wrong shape for an
 * outage: with OpenRouter down, every turn still paid two full 8s timeouts plus
 * the backoff before the pipeline could escalate — and paid it holding a BullMQ
 * worker slot, so the queue backed up behind a dependency already known to be
 * unreachable. The breaker does not change what happens on failure, only how
 * long the caller waits to find out.
 *
 * The failure path is driven with rejected fetches rather than 5xx responses so
 * the retry sleep is the only timer involved, and that is faked.
 */
describe('LlmClientService — circuit breaker', () => {
  const OK_RESPONSE = {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'hi' } }],
      model: 'openai/gpt-oss-20b:free',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  } as unknown as Response;

  /** Drive `count` failed completions, swallowing each rejection. */
  async function failTimes(client: LlmClientService, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await client.complete(req).catch(() => undefined);
    }
  }

  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    // Real timers, but the retry backoff is stubbed to nothing so a run of
    // failures does not cost a second each.
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((fn: () => void) => {
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout);
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
  });

  afterEach(() => jest.restoreAllMocks());

  it('stays closed while failures are below the threshold', async () => {
    const client = makeClient();

    await failTimes(client, LLM_BREAKER_FAILURE_THRESHOLD - 1);

    expect(client.circuitOpen).toBe(false);
  });

  it('opens once the provider has failed consistently', async () => {
    const client = makeClient();

    await failTimes(client, LLM_BREAKER_FAILURE_THRESHOLD);

    expect(client.circuitOpen).toBe(true);
  });

  it('stops calling the provider entirely once open', async () => {
    const client = makeClient();
    await failTimes(client, LLM_BREAKER_FAILURE_THRESHOLD);
    const callsWhileFailing = fetchSpy.mock.calls.length;

    await failTimes(client, 3);

    // This is the whole point: no socket, no timeout, no worker slot held.
    expect(fetchSpy).toHaveBeenCalledTimes(callsWhileFailing);
  });

  it('still rejects with LlmUnavailableError, so callers escalate as before', async () => {
    const client = makeClient();
    await failTimes(client, LLM_BREAKER_FAILURE_THRESHOLD);

    await expect(client.complete(req)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('resets the run on any success, so scattered blips never trip it', async () => {
    const client = makeClient();

    for (let i = 0; i < 10; i++) {
      await failTimes(client, LLM_BREAKER_FAILURE_THRESHOLD - 1);
      fetchSpy.mockResolvedValueOnce(OK_RESPONSE);
      await client.complete(req);
    }

    expect(client.circuitOpen).toBe(false);
  });

  describe('recovery', () => {
    it('lets exactly one probe through after the cooldown', async () => {
      const client = makeClient();
      await failTimes(client, LLM_BREAKER_FAILURE_THRESHOLD);
      const before = fetchSpy.mock.calls.length;

      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + LLM_BREAKER_COOLDOWN_MS + 1);
      // Three callers arrive at once; only the probe may reach the provider.
      // Sending all of them would put the full stalled load back on a provider
      // that has only just come up.
      await Promise.all([
        client.complete(req).catch(() => undefined),
        client.complete(req).catch(() => undefined),
        client.complete(req).catch(() => undefined),
      ]);

      expect(fetchSpy.mock.calls.length).toBeGreaterThan(before);
      expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(before + 2);
    });

    it('closes when the probe succeeds', async () => {
      const client = makeClient();
      await failTimes(client, LLM_BREAKER_FAILURE_THRESHOLD);

      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + LLM_BREAKER_COOLDOWN_MS + 1);
      fetchSpy.mockResolvedValueOnce(OK_RESPONSE);
      await expect(client.complete(req)).resolves.toMatchObject({ text: 'hi' });

      expect(client.circuitOpen).toBe(false);
    });

    it('re-opens and restarts the cooldown when the probe fails', async () => {
      const client = makeClient();
      await failTimes(client, LLM_BREAKER_FAILURE_THRESHOLD);

      const openedAt = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(openedAt + LLM_BREAKER_COOLDOWN_MS + 1);
      await client.complete(req).catch(() => undefined); // probe fails
      const afterProbe = fetchSpy.mock.calls.length;

      // Without restarting the clock the breaker would be open-but-elapsed and
      // wave the very next call straight through.
      await failTimes(client, 3);

      expect(client.circuitOpen).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(afterProbe);
    });
  });

  describe('what counts as an outage', () => {
    it('does not open on a rejected prompt', async () => {
      // A 400 is this caller's request being wrong. Opening on it would take
      // the AI pipeline down for every tenant because one prompt was malformed.
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'bad request',
      } as unknown as Response);
      const client = makeClient();

      await failTimes(client, LLM_BREAKER_FAILURE_THRESHOLD * 2);

      expect(client.circuitOpen).toBe(false);
    });

    it('opens on sustained rate limiting', async () => {
      // A 429 is the provider refusing everyone, which is what the breaker is
      // for — and hammering it is what keeps it refusing.
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      } as unknown as Response);
      const client = makeClient();

      await failTimes(client, LLM_BREAKER_FAILURE_THRESHOLD);

      expect(client.circuitOpen).toBe(true);
    });

    it('opens on sustained 5xx', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'unavailable',
      } as unknown as Response);
      const client = makeClient();

      await failTimes(client, LLM_BREAKER_FAILURE_THRESHOLD);

      expect(client.circuitOpen).toBe(true);
    });

    it('is per-client, so one instance cannot silence another', async () => {
      const tripped = makeClient();
      await failTimes(tripped, LLM_BREAKER_FAILURE_THRESHOLD);

      expect(makeClient().circuitOpen).toBe(false);
    });
  });
});
