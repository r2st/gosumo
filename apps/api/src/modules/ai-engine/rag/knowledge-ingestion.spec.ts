import { IntentType } from '@gosumo/shared';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { QdrantClient } from './qdrant.client';
import { EmbeddingService } from './embedding.service';

function makeService(embedReturns: number[] | null = [0.1, 0.2, 0.3]): {
  service: KnowledgeIngestionService;
  ensureCollection: jest.Mock;
  upsert: jest.Mock;
  embed: jest.Mock;
} {
  const ensureCollection = jest.fn().mockResolvedValue(true);
  const upsert = jest.fn().mockResolvedValue(true);
  const embed = jest.fn().mockResolvedValue(embedReturns);
  const qdrant = { ensureCollection, upsert } as unknown as QdrantClient;
  const embeddings = { embed, hash: jest.fn() } as unknown as EmbeddingService;
  return { service: new KnowledgeIngestionService(qdrant, embeddings), ensureCollection, upsert, embed };
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
  });
});
