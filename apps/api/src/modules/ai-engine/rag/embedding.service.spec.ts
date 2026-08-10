/**
 * EmbeddingService unit tests.
 *
 * The service's contract is stated in the module CLAUDE.md as a hard rule:
 * *"Qdrant unavailable: proceed without RAG context ... do not block the
 * pipeline."* `embed()` is the first place that rule is enforced — it returns
 * `null` for every failure mode rather than throwing, and the whole RAG layer
 * is built on that promise. So each failure path is tested individually, since
 * a single one that threw instead would take down message processing for every
 * tenant.
 *
 * The cache is the other thing worth pinning. It is keyed on a content hash,
 * which means two callers embedding the same text must share one provider call
 * — that is the difference between one embed per message and one per retrieval
 * attempt.
 */

import { ConfigService } from '@nestjs/config';

import { EmbeddingService } from './embedding.service';
import { EMBEDDING_MODEL } from '../ai-engine.constants';

const URL = 'https://embeddings.example/v1/embeddings';

function makeService(): EmbeddingService {
  return new EmbeddingService({ get: () => undefined } as unknown as ConfigService);
}

/** Installs a fetch double and returns the recorded calls. */
function stubFetch(impl: () => unknown): jest.Mock {
  const mock = jest.fn(impl as never);
  (globalThis as { fetch: unknown }).fetch = mock;
  return mock;
}

const okResponse = (embedding: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ embedding }] }),
});

describe('EmbeddingService.embed', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env['EMBEDDINGS_URL'] = URL;
    process.env['EMBEDDINGS_API_KEY'] = 'sk-test';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns the provider vector', async () => {
    stubFetch(() => okResponse([0.1, 0.2, 0.3]));

    await expect(makeService().embed('refund policy')).resolves.toEqual([0.1, 0.2, 0.3]);
  });

  it('posts the configured model and the trimmed text', async () => {
    const fetchMock = stubFetch(() => okResponse([0.1]));

    await makeService().embed('  refund policy  ');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      model: EMBEDDING_MODEL,
      input: 'refund policy',
    });
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test');
  });

  it.each<[string, string | undefined]>([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['undefined', undefined],
  ])('returns null for %s text without calling the provider', async (_label, text) => {
    const fetchMock = stubFetch(() => okResponse([0.1]));

    await expect(makeService().embed(text as unknown as string)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['url', 'EMBEDDINGS_URL'],
    ['api key', 'EMBEDDINGS_API_KEY'],
  ])('returns null when the %s is unset, and does not call out', async (_label, key) => {
    // The documented default posture: a dev box or test run with no embeddings
    // provider must degrade, not fail.
    delete process.env[key];
    const fetchMock = stubFetch(() => okResponse([0.1]));

    await expect(makeService().embed('refund policy')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on a non-2xx provider response', async () => {
    stubFetch(() => ({ ok: false, status: 429, json: async () => ({}) }));

    await expect(makeService().embed('refund policy')).resolves.toBeNull();
  });

  it('returns null when fetch rejects', async () => {
    // Connection reset, DNS failure, provider timeout — all must degrade.
    stubFetch(() => Promise.reject(new Error('ECONNRESET')));

    await expect(makeService().embed('refund policy')).resolves.toBeNull();
  });

  it('returns null when the thrown value is not an Error', async () => {
    // The catch formats `err instanceof Error ? err.message : String(err)`;
    // a non-Error rejection must not itself throw inside the handler.
    stubFetch(() => Promise.reject('provider exploded'));

    await expect(makeService().embed('refund policy')).resolves.toBeNull();
  });

  it.each([
    ['a body with no data array', { }],
    ['an empty data array', { data: [] }],
    ['a datum with no embedding', { data: [{}] }],
    ['an empty embedding', { data: [{ embedding: [] }] }],
  ])('returns null for %s', async (_label, body) => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => body }));

    await expect(makeService().embed('refund policy')).resolves.toBeNull();
  });

  it('does not cache a failed call', async () => {
    // A transient 500 must not poison the cache for the process lifetime.
    const fetchMock = stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    const service = makeService();

    await service.embed('refund policy');
    await service.embed('refund policy');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('EmbeddingService caching', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env['EMBEDDINGS_URL'] = URL;
    process.env['EMBEDDINGS_API_KEY'] = 'sk-test';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  it('embeds identical text once', async () => {
    const fetchMock = stubFetch(() => okResponse([0.4, 0.5]));
    const service = makeService();

    const first = await service.embed('what is the refund policy');
    const second = await service.embed('what is the refund policy');

    expect(first).toEqual([0.4, 0.5]);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats text differing only by surrounding whitespace as a cache hit', async () => {
    // The key is hashed *after* trimming, so the two calls collapse.
    const fetchMock = stubFetch(() => okResponse([0.4]));
    const service = makeService();

    await service.embed('refund policy');
    await service.embed('  refund policy\n');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not conflate distinct text', async () => {
    const fetchMock = stubFetch(() => okResponse([0.4]));
    const service = makeService();

    await service.embed('refund policy');
    await service.embed('cancellation policy');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps caches separate per instance', async () => {
    // The cache is instance state, so two injected copies never leak vectors
    // to each other — relevant because the map is unbounded and per-process.
    const fetchMock = stubFetch(() => okResponse([0.4]));

    await makeService().embed('refund policy');
    await makeService().embed('refund policy');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('EmbeddingService.hash', () => {
  it('is a stable SHA-256 hex digest', () => {
    const service = makeService();
    expect(service.hash('refund policy')).toMatch(/^[0-9a-f]{64}$/);
    expect(service.hash('refund policy')).toBe(service.hash('refund policy'));
  });

  it('differs for different content', () => {
    // It doubles as the re-index discriminator: an edited knowledge entry must
    // produce a different hash or it will never be re-embedded.
    const service = makeService();
    expect(service.hash('refund policy v1')).not.toBe(service.hash('refund policy v2'));
  });
});
