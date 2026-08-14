import { ConfigService } from '@nestjs/config';
import { LlmClientService, LlmUnavailableError } from './llm-client.service';

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
