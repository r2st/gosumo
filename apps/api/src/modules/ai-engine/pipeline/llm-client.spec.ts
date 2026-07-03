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

  describe('extractJson', () => {
    it('parses a bare JSON object', () => {
      const client = makeClient();
      expect(client.extractJson('{"a":1}')).toEqual({ a: 1 });
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
