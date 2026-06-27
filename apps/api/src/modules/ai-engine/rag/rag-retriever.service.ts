import { Injectable, Logger } from '@nestjs/common';
import { IntentType } from '@gosumo/shared';
import { QdrantClient } from './qdrant.client';
import { EmbeddingService } from './embedding.service';
import { knowledgeCollection, MAX_RAG_CHUNKS, RAG_SCORE_THRESHOLD } from '../ai-engine.constants';

export interface RetrievedChunk {
  id: string;
  content: string;
  score: number;
  sourceType: string;
}

/**
 * RagRetrieverService — retrieves relevant business knowledge to ground the
 * AI's response. Embeds the query, searches the business's Qdrant collection
 * (tenant-isolated by collection name + a `businessId` payload filter), and
 * returns the top-K chunks above the similarity floor.
 *
 * Always returns an array. When embeddings or Qdrant are unavailable it
 * returns `[]`, and the confidence calculator penalizes data availability.
 */
@Injectable()
export class RagRetrieverService {
  private readonly logger = new Logger(RagRetrieverService.name);

  constructor(
    private readonly qdrant: QdrantClient,
    private readonly embeddings: EmbeddingService,
  ) {}

  async retrieve(
    query: string,
    businessId: string,
    intent: IntentType,
    topK = MAX_RAG_CHUNKS,
  ): Promise<RetrievedChunk[]> {
    const vector = await this.embeddings.embed(query);
    if (!vector) {
      this.logger.debug('No query embedding available — skipping RAG retrieval');
      return [];
    }

    const hits = await this.qdrant.search(knowledgeCollection(businessId), vector, {
      limit: Math.max(topK, MAX_RAG_CHUNKS),
      scoreThreshold: RAG_SCORE_THRESHOLD,
      filter: { must: [{ key: 'businessId', match: { value: businessId } }] },
    });

    const chunks = hits
      .map((h) => ({
        id: h.id,
        content: typeof h.payload['content'] === 'string' ? (h.payload['content'] as string) : '',
        score: h.score,
        sourceType: typeof h.payload['sourceType'] === 'string' ? (h.payload['sourceType'] as string) : 'UNKNOWN',
      }))
      .filter((c) => c.content.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    this.logger.debug(`RAG retrieved ${chunks.length} chunk(s) for intent ${intent}`);
    return chunks;
  }

  /**
   * Format retrieved chunks into the `<rag_context>` block for the prompt.
   */
  formatForPrompt(chunks: RetrievedChunk[]): string {
    if (chunks.length === 0) {
      return 'No specific policy or knowledge was found for this query. Use general best practices and flag for human review if uncertain.';
    }
    return chunks
      .map((c) => `SOURCE: ${c.sourceType} | Relevance: ${c.score.toFixed(2)}\n${c.content}`)
      .join('\n\n');
  }
}
