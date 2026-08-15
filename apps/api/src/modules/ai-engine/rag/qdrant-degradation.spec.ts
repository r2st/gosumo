/**
 * What the AI pipeline does when the vector store is gone.
 *
 * The rule (ai-engine CLAUDE.md): *Qdrant unavailable → proceed without RAG
 * context; penalize `data_availability` — do not block the pipeline.* An
 * inbound WhatsApp message must still get an answer when Qdrant is down; what
 * it must not get is a 500, and what the business must not get is a confident
 * answer grounded in nothing.
 *
 * These exercise the real `QdrantClient` against a failing `fetch` rather than
 * a stubbed client, because the tolerance being asserted lives in that client's
 * own catch blocks — a mocked client would assert nothing but the mock.
 */
import { ConfigService } from '@nestjs/config';
import { IntentType } from '@gosumo/shared';
import { QdrantClient } from './qdrant.client';
import { RagRetrieverService } from './rag-retriever.service';
import type { EmbeddingService } from './embedding.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const VECTOR = new Array(8).fill(0.1);

const config = {
  get: <T>(_key: string, fallback: T): T => fallback,
} as unknown as ConfigService;

/** An embedding service that works, so only Qdrant is the variable. */
const embeddings = {
  embed: jest.fn().mockResolvedValue(VECTOR),
} as unknown as EmbeddingService;

/** The ways an unreachable host actually presents to `fetch`. */
const OUTAGES: Array<[string, () => Promise<never>]> = [
  ['connection refused', () => Promise.reject(new TypeError('fetch failed'))],
  [
    'DNS failure',
    () => Promise.reject(new Error('getaddrinfo ENOTFOUND qdrant.gosumo.internal')),
  ],
  ['socket reset mid-request', () => Promise.reject(new Error('ECONNRESET'))],
];

describe('RAG degrades to no context when Qdrant is down', () => {
  let originalFetch: typeof globalThis.fetch;
  let retriever: RagRetrieverService;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    retriever = new RagRetrieverService(new QdrantClient(config), embeddings);
    (embeddings.embed as jest.Mock).mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it.each(OUTAGES)('returns no chunks when the search %s', async (_label, reject) => {
    globalThis.fetch = jest.fn(reject) as unknown as typeof globalThis.fetch;

    await expect(
      retriever.retrieve('do you deliver to Wakad?', BUSINESS_ID, IntentType.GENERAL_INQUIRY),
    ).resolves.toEqual([]);
  });

  it('returns no chunks when Qdrant answers but with an error status', async () => {
    // A 500 from a half-alive Qdrant is not an exception — it has to be handled
    // as its own case or it becomes a JSON parse failure instead.
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
    }) as unknown as typeof globalThis.fetch;

    await expect(
      retriever.retrieve('do you deliver to Wakad?', BUSINESS_ID, IntentType.GENERAL_INQUIRY),
    ).resolves.toEqual([]);
  });

  it('returns no chunks when the collection does not exist yet', async () => {
    // A tenant that has never ingested anything. Not an outage, same answer.
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    }) as unknown as typeof globalThis.fetch;

    await expect(
      retriever.retrieve('anything', BUSINESS_ID, IntentType.GENERAL_INQUIRY),
    ).resolves.toEqual([]);
  });

  it('tells the prompt that nothing was found, rather than emitting an empty block', async () => {
    // The degraded prompt has to *say* it is degraded. An empty `<rag_context>`
    // reads to the model as "the business has no policy on this", which is the
    // shape of an invented answer.
    const formatted = retriever.formatForPrompt([]);

    expect(formatted).toMatch(/No specific policy or knowledge was found/);
    expect(formatted).toMatch(/flag for human review/i);
  });

  it('degrades the same way when embeddings are unavailable', async () => {
    // The other half of the RAG path. `embed` returns null when no endpoint is
    // configured or the provider call fails; Qdrant is never reached.
    (embeddings.embed as jest.Mock).mockResolvedValueOnce(null);
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(
      retriever.retrieve('anything', BUSINESS_ID, IntentType.GENERAL_INQUIRY),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('QdrantClient writes fail soft rather than throwing', () => {
  let originalFetch: typeof globalThis.fetch;
  let client: QdrantClient;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof globalThis.fetch;
    client = new QdrantClient(config);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reports a failed upsert instead of throwing into the caller', async () => {
    // Ingestion has to learn the write did not land — it rolls back the
    // metadata row on false — but it must learn it as a value, not a throw.
    await expect(
      client.upsert('kb_x', [{ id: 'p1', vector: VECTOR, payload: {} }]),
    ).resolves.toBe(false);
  });

  it('reports a failed collection bootstrap instead of throwing', async () => {
    await expect(client.ensureCollection('kb_x')).resolves.toBe(false);
  });

  it('reports a failed delete instead of throwing', async () => {
    // Deletion is the one place the degrade-quietly rule is inverted: the
    // caller must see `false` so it can abort before dropping the metadata row
    // that is the only handle a retry has.
    await expect(
      client.deleteByFilter('kb_x', { must: [{ key: 'entryId', match: { value: 'e1' } }] }),
    ).resolves.toBe(false);
  });
});
