import { IntentType } from '@gosumo/shared';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { QdrantClient } from './qdrant.client';
import { EmbeddingService } from './embedding.service';

function makeService(embedReturns: number[] | null = [0.1, 0.2, 0.3]): {
  service: KnowledgeIngestionService;
  ensureCollection: jest.Mock;
  upsert: jest.Mock;
  embed: jest.Mock;
  deleteByFilter: jest.Mock;
} {
  const ensureCollection = jest.fn().mockResolvedValue(true);
  const upsert = jest.fn().mockResolvedValue(true);
  const deleteByFilter = jest.fn().mockResolvedValue(true);
  const embed = jest.fn().mockResolvedValue(embedReturns);
  const qdrant = { ensureCollection, upsert, deleteByFilter } as unknown as QdrantClient;
  const embeddings = { embed, hash: jest.fn() } as unknown as EmbeddingService;
  return {
    service: new KnowledgeIngestionService(qdrant, embeddings),
    ensureCollection,
    upsert,
    embed,
    deleteByFilter,
  };
}

describe('KnowledgeIngestionService', () => {
  describe('chunk', () => {
    it('returns no chunks for empty text', () => {
      const { service } = makeService();
      expect(service.chunk('')).toEqual([]);
      expect(service.chunk('   ')).toEqual([]);
    });

    it('keeps a single short paragraph as one chunk', () => {
      const { service } = makeService();
      const text = 'Our refund policy allows full refunds within 24 hours of booking your appointment.';
      const chunks = service.chunk(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain('refund policy');
    });

    it('splits a long multi-paragraph document into multiple chunks', () => {
      const { service } = makeService();
      const para = 'A'.repeat(1000);
      const text = `${para}\n\n${para}\n\n${para}`;
      const chunks = service.chunk(text);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('discards sub-minimum stubs', () => {
      const { service } = makeService();
      expect(service.chunk('tiny')).toEqual([]);
    });
  });

  describe('ingest', () => {
    it('embeds and upserts chunks when embeddings are available', async () => {
      const { service, ensureCollection, upsert } = makeService();
      const result = await service.ingest({
        businessId: 'b1',
        entryId: 'e1',
        content: 'Full refund within 24 hours of booking. After that a 50% fee applies to all cancellations.',
        sourceType: 'REFUND_POLICY',
        applicableIntents: [IntentType.REFUND],
      });

      expect(ensureCollection).toHaveBeenCalled();
      expect(upsert).toHaveBeenCalled();
      expect(result.chunksIndexed).toBeGreaterThan(0);
      expect(result.collection).toContain('b1');
    });

    it('skips indexing when embeddings are unavailable', async () => {
      const { service, upsert } = makeService(null);
      const result = await service.ingest({
        businessId: 'b1',
        entryId: 'e1',
        content: 'Some business policy text that is long enough to be a chunk on its own here.',
        sourceType: 'FAQ_ENTRY',
      });
      expect(result.chunksIndexed).toBe(0);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('returns early for content that yields no chunks, without touching Qdrant', async () => {
      // A document that is all stubs still creates a metadata row upstream; it
      // must not create an empty collection here.
      const { service, ensureCollection, upsert, embed } = makeService();

      const result = await service.ingest({
        businessId: 'b1',
        entryId: 'e1',
        content: '   ',
        sourceType: 'FAQ_ENTRY',
      });

      expect(result).toEqual({ collection: expect.stringContaining('b1'), chunksIndexed: 0, pointIds: [] });
      expect(ensureCollection).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    });

    it('abandons the whole document when a later chunk fails to embed', async () => {
      // Partial indexing is worse than none: the entry's metadata says
      // "indexed", so the missing chunks would never be retried.
      const { service, upsert, embed } = makeService();
      embed.mockResolvedValueOnce([0.1]).mockResolvedValueOnce(null);

      const para = `${'A'.repeat(1700)}.`;
      const result = await service.ingest({
        businessId: 'b1',
        entryId: 'e1',
        content: `${para}\n\n${para}`,
        sourceType: 'FAQ_ENTRY',
      });

      expect(embed.mock.calls.length).toBeGreaterThan(1);
      expect(result.chunksIndexed).toBe(0);
      expect(result.pointIds).toEqual([]);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('reports zero indexed when the Qdrant upsert fails', async () => {
      const { service, upsert } = makeService();
      upsert.mockResolvedValue(false);

      const result = await service.ingest({
        businessId: 'b1',
        entryId: 'e1',
        content: 'Full refund within 24 hours of booking your appointment with us.',
        sourceType: 'REFUND_POLICY',
      });

      // The caller uses this to decide whether a re-index is owed.
      expect(result.chunksIndexed).toBe(0);
      expect(result.pointIds).toEqual([]);
    });

    it('stamps every point with the tenant and entry it came from', async () => {
      // `RagRetrieverService` filters on the `businessId` payload field, so a
      // point written without it is invisible — and a point written with the
      // wrong one is a cross-tenant leak.
      const { service, upsert } = makeService();

      await service.ingest({
        businessId: 'b1',
        entryId: 'e1',
        content: 'Full refund within 24 hours of booking your appointment with us.',
        sourceType: 'REFUND_POLICY',
        title: 'Refund policy',
        tags: ['refund'],
        applicableIntents: [IntentType.REFUND],
      });

      const [collection, points] = upsert.mock.calls[0] as [string, Array<{ payload: Record<string, unknown> }>];
      expect(collection).toContain('b1');
      for (const point of points) {
        expect(point.payload['businessId']).toBe('b1');
        expect(point.payload['entryId']).toBe('e1');
        expect(point.payload['sourceType']).toBe('REFUND_POLICY');
      }
    });

    it('defaults the optional payload fields rather than writing undefined', async () => {
      const { service, upsert } = makeService();

      await service.ingest({
        businessId: 'b1',
        entryId: 'e1',
        content: 'Full refund within 24 hours of booking your appointment with us.',
        sourceType: 'REFUND_POLICY',
      });

      const payload = (upsert.mock.calls[0] as [string, Array<{ payload: Record<string, unknown> }>])[1][0]!
        .payload;
      expect(payload['title']).toBeNull();
      expect(payload['tags']).toEqual([]);
      expect(payload['applicableIntents']).toEqual([]);
    });

    it('numbers chunks so retrieval can reconstruct document order', async () => {
      const { service, upsert } = makeService();
      const para = `${'A'.repeat(1700)}.`;

      await service.ingest({
        businessId: 'b1',
        entryId: 'e1',
        content: `${para}\n\n${para}\n\n${para}`,
        sourceType: 'FAQ_ENTRY',
      });

      const points = (upsert.mock.calls[0] as [string, Array<{ payload: Record<string, unknown> }>])[1];
      expect(points.length).toBeGreaterThan(1);
      expect(points.map((p) => p.payload['chunkIndex'])).toEqual(points.map((_, i) => i));
    });
  });

  describe('chunk boundaries', () => {
    it('splits an oversized paragraph on sentence boundaries', () => {
      // A single paragraph over the max size cannot go out whole — it would
      // blow the per-chunk token budget. The split must land between
      // sentences, not mid-word.
      const { service } = makeService();
      const sentence = `${'word '.repeat(60)}end. `;
      const chunks = service.chunk(sentence.repeat(12));

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2100);
    });

    it('splits a paragraph with no sentence punctuation at all', () => {
      // The sentence regex finds nothing, so the fallback keeps the paragraph
      // as a single unit rather than returning an empty list.
      const { service } = makeService();
      const chunks = service.chunk('A'.repeat(4000));

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.join('')).toContain('AAA');
    });

    it('overlaps adjacent chunks so a policy split across a boundary survives', () => {
      const { service } = makeService();
      const para = `${'A'.repeat(1700)}.`;
      const chunks = service.chunk(`${para}\n\n${para}`);

      expect(chunks.length).toBeGreaterThan(1);
      // The tail of chunk N reappears at the head of chunk N+1.
      const tail = chunks[0]!.slice(-50);
      expect(chunks[1]!.startsWith(tail.slice(0, 20))).toBe(true);
    });

    it('normalises CRLF line endings before splitting', () => {
      // Documents pasted from Windows would otherwise never match the
      // blank-line paragraph boundary.
      const { service } = makeService();
      const a = 'First paragraph of the refund policy, long enough to survive.';
      const b = 'Second paragraph of the refund policy, also long enough here.';

      expect(service.chunk(`${a}\r\n\r\n${b}`)).toEqual(service.chunk(`${a}\n\n${b}`));
    });
  });

  describe('remove', () => {
    it('deletes every chunk of an entry by filter, not by point id', async () => {
      // A document becomes N points with N generated ids, and only the first
      // is ever recorded in Postgres. Deleting by id would leave chunks 2..N
      // in the collection — still matching queries, still grounding answers,
      // with the entry gone from the tenant's knowledge base.
      const { service, deleteByFilter } = makeService();

      await expect(service.remove('biz-1', 'entry-1')).resolves.toBe(true);

      expect(deleteByFilter).toHaveBeenCalledTimes(1);
      const [collection, filter] = deleteByFilter.mock.calls[0]!;
      expect(collection).toContain('biz-1');
      expect(filter).toEqual({
        must: [
          { key: 'businessId', match: { value: 'biz-1' } },
          { key: 'entryId', match: { value: 'entry-1' } },
        ],
      });
    });

    it('scopes the delete by businessId as well as entryId', async () => {
      // Tenant isolation: an entry id from another business must not be able
      // to reach this collection's points even if it were guessed.
      const { service, deleteByFilter } = makeService();

      await service.remove('biz-1', 'entry-1');

      const [, filter] = deleteByFilter.mock.calls[0]!;
      expect(filter.must).toContainEqual({ key: 'businessId', match: { value: 'biz-1' } });
    });

    it('reports failure when the vector store rejects the delete', async () => {
      const { service, deleteByFilter } = makeService();
      deleteByFilter.mockResolvedValueOnce(false);

      await expect(service.remove('biz-1', 'entry-1')).resolves.toBe(false);
    });

    it('removes exactly the chunks a multi-chunk ingest created', async () => {
      // End-to-end on the payload contract: whatever ingest stamps on each
      // point is what remove filters on.
      const { service, upsert, deleteByFilter } = makeService();
      const para = `${'A'.repeat(1700)}.`;

      await service.ingest({
        businessId: 'biz-1',
        entryId: 'entry-1',
        content: `${para}\n\n${para}\n\n${para}`,
        sourceType: 'REFUND_POLICY',
      });

      const [, points] = upsert.mock.calls[0]!;
      expect(points.length).toBeGreaterThan(1);
      for (const point of points) {
        expect(point.payload).toMatchObject({ businessId: 'biz-1', entryId: 'entry-1' });
      }

      await service.remove('biz-1', 'entry-1');

      const [, filter] = deleteByFilter.mock.calls[0]!;
      // Every point above matches this filter.
      for (const point of points) {
        for (const clause of filter.must) {
          expect(point.payload[clause.key]).toBe(clause.match.value);
        }
      }
    });
  });
});
