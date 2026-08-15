/**
 * QdrantClient unit tests.
 *
 * The client's contract is that it never throws: the AI pipeline proceeds
 * without RAG context when the vector store is down, and the confidence
 * calculator penalises `dataAvailability` instead. That makes the failure paths
 * the important ones — a leaked exception here takes down message processing
 * for every tenant because one vector store is unreachable.
 *
 * So each operation is checked for the degraded value it promises: reads fall
 * to `[]`, writes fall to `false`, and empty-input writes short-circuit to
 * `true` without touching the network.
 */

import { ConfigService } from '@nestjs/config';

import { QdrantClient, type QdrantPoint } from './qdrant.client';
import { EMBEDDING_DIMENSIONS } from '../ai-engine.constants';

const POINT: QdrantPoint = {
  id: 'pt-1',
  vector: [0.1, 0.2],
  payload: { businessId: 'biz-1' },
};

describe('QdrantClient', () => {
  let fetchMock: jest.Mock;
  let warnSpy: jest.SpyInstance;

  function build(url = 'http://qdrant.test:6333'): QdrantClient {
    const config = {
      get: jest.fn((_key: string, fallback: string) => url || fallback),
    };
    const client = new QdrantClient(config as unknown as ConfigService);
    warnSpy = jest
      .spyOn(client['logger'], 'warn')
      .mockImplementation(() => undefined);
    return client;
  }

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const ok = { ok: true };
  const notOk = { ok: false };

  // ─────────────────────────────────────────────
  // Base URL
  // ─────────────────────────────────────────────

  describe('base URL', () => {
    it('uses the configured Qdrant URL', async () => {
      fetchMock.mockResolvedValue(ok);

      await build('http://qdrant.test:6333').ensureCollection('kb');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://qdrant.test:6333/collections/kb',
      );
    });

    it('strips a trailing slash so paths do not double up', async () => {
      fetchMock.mockResolvedValue(ok);

      await build('http://qdrant.test:6333/').ensureCollection('kb');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://qdrant.test:6333/collections/kb',
      );
    });

    it('falls back to the local vector store', async () => {
      const config = { get: jest.fn((_k: string, fallback: string) => fallback) };
      const client = new QdrantClient(config as unknown as ConfigService);
      jest.spyOn(client['logger'], 'warn').mockImplementation(() => undefined);
      fetchMock.mockResolvedValue(ok);

      await client.ensureCollection('kb');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://localhost:6333/collections/kb',
      );
    });

    it('sends JSON content-type on every request', async () => {
      fetchMock.mockResolvedValue(ok);

      await build().ensureCollection('kb');

      expect(fetchMock.mock.calls[0][1].headers).toEqual({
        'content-type': 'application/json',
      });
    });

    it('omits a body on GET requests', async () => {
      fetchMock.mockResolvedValue(ok);

      await build().ensureCollection('kb');

      expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────
  // ensureCollection
  // ─────────────────────────────────────────────

  describe('ensureCollection', () => {
    it('is a no-op when the collection already exists', async () => {
      fetchMock.mockResolvedValue(ok);

      await expect(build().ensureCollection('kb')).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('creates the collection when it is missing', async () => {
      fetchMock.mockResolvedValueOnce(notOk).mockResolvedValueOnce(ok);

      await expect(build().ensureCollection('kb')).resolves.toBe(true);

      const [url, init] = fetchMock.mock.calls[1];
      expect(init.method).toBe('PUT');
      expect(url).toBe('http://qdrant.test:6333/collections/kb');
      expect(JSON.parse(init.body)).toEqual({
        vectors: { size: EMBEDDING_DIMENSIONS, distance: 'Cosine' },
      });
    });

    it('creates the collection with an explicit vector size', async () => {
      fetchMock.mockResolvedValueOnce(notOk).mockResolvedValueOnce(ok);

      await build().ensureCollection('kb', 384);

      expect(JSON.parse(fetchMock.mock.calls[1][1].body).vectors.size).toBe(384);
    });

    it('reports failure when creation is rejected', async () => {
      fetchMock.mockResolvedValueOnce(notOk).mockResolvedValueOnce(notOk);

      await expect(build().ensureCollection('kb')).resolves.toBe(false);
    });

    it('degrades to false when Qdrant is unreachable', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(build().ensureCollection('kb')).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ECONNREFUSED'),
      );
    });

    it('stringifies a non-Error failure', async () => {
      fetchMock.mockRejectedValue('socket hang up');

      await expect(build().ensureCollection('kb')).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('socket hang up'),
      );
    });
  });

  // ─────────────────────────────────────────────
  // upsert
  // ─────────────────────────────────────────────

  describe('upsert', () => {
    it('short-circuits an empty batch without a network call', async () => {
      await expect(build().upsert('kb', [])).resolves.toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('puts the points to the collection', async () => {
      fetchMock.mockResolvedValue(ok);

      await expect(build().upsert('kb', [POINT])).resolves.toBe(true);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://qdrant.test:6333/collections/kb/points');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toEqual({ points: [POINT] });
    });

    it('reports a rejected upsert', async () => {
      fetchMock.mockResolvedValue(notOk);

      await expect(build().upsert('kb', [POINT])).resolves.toBe(false);
    });

    it('degrades to false when Qdrant is unreachable', async () => {
      fetchMock.mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(build().upsert('kb', [POINT])).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ETIMEDOUT'));
    });
  });

  // ─────────────────────────────────────────────
  // search
  // ─────────────────────────────────────────────

  describe('search', () => {
    function hits(result: unknown): { ok: true; json: () => Promise<unknown> } {
      return { ok: true, json: () => Promise.resolve({ result }) };
    }

    it('posts the vector and requests payloads', async () => {
      fetchMock.mockResolvedValue(hits([]));

      await build().search('kb', [0.1, 0.2]);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://qdrant.test:6333/collections/kb/points/search');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        vector: [0.1, 0.2],
        limit: 10,
        with_payload: true,
      });
    });

    it('honours an explicit limit', async () => {
      fetchMock.mockResolvedValue(hits([]));

      await build().search('kb', [0.1], { limit: 5 });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).limit).toBe(5);
    });

    it('passes a score threshold when one is given', async () => {
      fetchMock.mockResolvedValue(hits([]));

      await build().search('kb', [0.1], { scoreThreshold: 0.75 });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).score_threshold).toBe(
        0.75,
      );
    });

    it('passes a zero score threshold rather than treating it as absent', async () => {
      fetchMock.mockResolvedValue(hits([]));

      await build().search('kb', [0.1], { scoreThreshold: 0 });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).score_threshold).toBe(0);
    });

    it('omits the score threshold when none is given', async () => {
      fetchMock.mockResolvedValue(hits([]));

      await build().search('kb', [0.1]);

      expect(
        JSON.parse(fetchMock.mock.calls[0][1].body).score_threshold,
      ).toBeUndefined();
    });

    it('passes a tenant filter through', async () => {
      fetchMock.mockResolvedValue(hits([]));
      const filter = { must: [{ key: 'businessId', match: { value: 'biz-1' } }] };

      await build().search('kb', [0.1], { filter });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).filter).toEqual(filter);
    });

    it('maps hits, stringifying numeric ids', async () => {
      fetchMock.mockResolvedValue(
        hits([{ id: 42, score: 0.9, payload: { title: 'Refunds' } }]),
      );

      await expect(build().search('kb', [0.1])).resolves.toEqual([
        { id: '42', score: 0.9, payload: { title: 'Refunds' } },
      ]);
    });

    it('normalises a hit with no payload', async () => {
      fetchMock.mockResolvedValue(hits([{ id: 'a', score: 0.5 }]));

      await expect(build().search('kb', [0.1])).resolves.toEqual([
        { id: 'a', score: 0.5, payload: {} },
      ]);
    });

    it('returns an empty list when the response omits a result array', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      await expect(build().search('kb', [0.1])).resolves.toEqual([]);
    });

    it('degrades to an empty list when the search is rejected', async () => {
      fetchMock.mockResolvedValue(notOk);

      await expect(build().search('kb', [0.1])).resolves.toEqual([]);
    });

    it('degrades to an empty list when Qdrant is unreachable', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(build().search('kb', [0.1])).resolves.toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ECONNREFUSED'),
      );
    });

    it('degrades to an empty list when the response body is not JSON', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error('invalid json')),
      });

      await expect(build().search('kb', [0.1])).resolves.toEqual([]);
    });
  });

  // ─────────────────────────────────────────────
  // deletePoints
  // ─────────────────────────────────────────────

  describe('deletePoints', () => {
    it('short-circuits an empty id list without a network call', async () => {
      await expect(build().deletePoints('kb', [])).resolves.toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts the ids to the delete endpoint', async () => {
      fetchMock.mockResolvedValue(ok);

      await expect(build().deletePoints('kb', ['a', 'b'])).resolves.toBe(true);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://qdrant.test:6333/collections/kb/points/delete');
      expect(JSON.parse(init.body)).toEqual({ points: ['a', 'b'] });
    });

    it('reports a rejected delete', async () => {
      fetchMock.mockResolvedValue(notOk);

      await expect(build().deletePoints('kb', ['a'])).resolves.toBe(false);
    });

    it('degrades to false when Qdrant is unreachable', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      await expect(build().deletePoints('kb', ['a'])).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ECONNRESET'),
      );
    });
  });

  // ─────────────────────────────────────────────
  // deleteByFilter
  // ─────────────────────────────────────────────

  describe('deleteByFilter', () => {
    const filter = {
      must: [
        { key: 'businessId', match: { value: 'biz-1' } },
        { key: 'entryId', match: { value: 'entry-1' } },
      ],
    };

    it('posts the filter to the delete endpoint', async () => {
      fetchMock.mockResolvedValue(ok);

      await expect(build().deleteByFilter('kb', filter)).resolves.toBe(true);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://qdrant.test:6333/collections/kb/points/delete');
      // Filter, not ids: a document is an unbounded number of points and only
      // the first id was ever recorded.
      expect(JSON.parse(init.body)).toEqual({ filter });
    });

    it('treats a missing collection as nothing to delete', async () => {
      // A tenant that never indexed a vector has no collection. Reporting
      // failure there would leave its metadata undeletable forever.
      fetchMock.mockResolvedValue({ ok: false, status: 404 });

      await expect(build().deleteByFilter('kb', filter)).resolves.toBe(true);
    });

    it('reports a rejected delete', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      await expect(build().deleteByFilter('kb', filter)).resolves.toBe(false);
    });

    it('degrades to false when Qdrant is unreachable', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(build().deleteByFilter('kb', filter)).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    });
  });
});
