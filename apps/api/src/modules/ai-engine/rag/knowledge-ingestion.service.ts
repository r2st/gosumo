import { Injectable, Logger } from '@nestjs/common';
import { IntentType, generateId } from '@gosumo/shared';
import { QdrantClient, QdrantPoint } from './qdrant.client';
import { EmbeddingService } from './embedding.service';
import { knowledgeCollection } from '../ai-engine.constants';

export interface IngestionInput {
  businessId: string;
  entryId: string;
  content: string;
  sourceType: string;
  title?: string;
  tags?: string[];
  applicableIntents?: IntentType[];
}

export interface IngestionOutput {
  collection: string;
  chunksIndexed: number;
  pointIds: string[];
}

/**
 * KnowledgeIngestionService — turns a business document into vector points.
 *
 * Pipeline: semantic chunk → embed each chunk → upsert into the business's
 * Qdrant collection. The chunker prefers paragraph boundaries, falls back to
 * sentence boundaries for oversized paragraphs, keeps a small overlap between
 * adjacent chunks, and discards stubs.
 *
 * If embeddings are unavailable the document is left un-vectorized
 * (`chunksIndexed: 0`); the caller still records the entry's metadata so it
 * can be re-indexed once embeddings come online.
 */
@Injectable()
export class KnowledgeIngestionService {
  private readonly logger = new Logger(KnowledgeIngestionService.name);

  // Char-based approximations of the token budgets in AI_ENGINE_DESIGN.md §5.
  private readonly maxChunkChars = 1800; // ~500 tokens
  private readonly minChunkChars = 60; //  ~50 tokens — discard smaller stubs
  private readonly overlapChars = 200; // ~50 tokens of overlap

  constructor(
    private readonly qdrant: QdrantClient,
    private readonly embeddings: EmbeddingService,
  ) {}

  async ingest(input: IngestionInput): Promise<IngestionOutput> {
    const collection = knowledgeCollection(input.businessId);
    const chunks = this.chunk(input.content);

    if (chunks.length === 0) {
      return { collection, chunksIndexed: 0, pointIds: [] };
    }

    await this.qdrant.ensureCollection(collection);

    const points: QdrantPoint[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const vector = await this.embeddings.embed(chunk);
      if (!vector) {
        this.logger.warn(
          `Embedding unavailable — skipping vector indexing for entry ${input.entryId}`,
        );
        return { collection, chunksIndexed: 0, pointIds: [] };
      }

      points.push({
        id: generateId(),
        vector,
        payload: {
          businessId: input.businessId,
          entryId: input.entryId,
          content: chunk,
          sourceType: input.sourceType,
          title: input.title ?? null,
          tags: input.tags ?? [],
          applicableIntents: input.applicableIntents ?? [],
          chunkIndex: i,
        },
      });
    }

    const ok = await this.qdrant.upsert(collection, points);
    if (!ok) {
      this.logger.warn(`Qdrant upsert failed for entry ${input.entryId}`);
      return { collection, chunksIndexed: 0, pointIds: [] };
    }

    this.logger.log(`Indexed ${points.length} chunk(s) for entry ${input.entryId} into ${collection}`);
    return { collection, chunksIndexed: points.length, pointIds: points.map((p) => p.id) };
  }

  /**
   * Remove every vector chunk belonging to one knowledge entry.
   *
   * Deletion is by payload filter, not by id: {@link ingest} generates a fresh
   * point id per chunk and only the first one is ever recorded, so an id-based
   * delete would strand chunks 2..N in the collection — still matching queries,
   * still grounding answers, with the entry gone from Postgres. The filter is
   * scoped by `businessId` as well as `entryId` so a delete can never reach
   * across tenants even if an entry id were guessed.
   *
   * Returns false when the vectors could not be removed; the caller must not
   * treat the entry as deleted in that case.
   */
  async remove(businessId: string, entryId: string): Promise<boolean> {
    const collection = knowledgeCollection(businessId);
    const ok = await this.qdrant.deleteByFilter(collection, {
      must: [
        { key: 'businessId', match: { value: businessId } },
        { key: 'entryId', match: { value: entryId } },
      ],
    });

    if (!ok) {
      this.logger.warn(`Qdrant delete failed for entry ${entryId} in ${collection}`);
      return false;
    }

    this.logger.log(`Removed vectors for entry ${entryId} from ${collection}`);
    return true;
  }

  /**
   * Semantic chunker. Splits on blank-line paragraph boundaries; any paragraph
   * over the max size is split on sentence boundaries. Adjacent chunks overlap
   * by ~`overlapChars` to avoid losing context at boundaries.
   * Exported as a pure method for direct unit testing.
   */
  chunk(text: string): string[] {
    const normalized = (text ?? '').replace(/\r\n/g, '\n').trim();
    if (normalized.length === 0) return [];

    const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const units: string[] = [];

    for (const para of paragraphs) {
      if (para.length <= this.maxChunkChars) {
        units.push(para);
      } else {
        units.push(...this.splitOversized(para));
      }
    }

    // Merge small adjacent units up to the max size, applying overlap.
    const chunks: string[] = [];
    let current = '';

    for (const unit of units) {
      if (current.length === 0) {
        current = unit;
      } else if (current.length + unit.length + 1 <= this.maxChunkChars) {
        current = `${current} ${unit}`;
      } else {
        chunks.push(current);
        const overlap = current.slice(-this.overlapChars);
        current = `${overlap} ${unit}`.trim();
      }
    }
    if (current.length > 0) chunks.push(current);

    return chunks.filter((c) => c.length >= this.minChunkChars);
  }

  private splitOversized(paragraph: string): string[] {
    const sentences = paragraph.match(/[^.!?]+[.!?]*\s*/g) ?? [paragraph];
    const result: string[] = [];
    let current = '';

    for (const sentence of sentences) {
      if (current.length + sentence.length <= this.maxChunkChars) {
        current += sentence;
      } else {
        if (current.trim().length > 0) result.push(current.trim());
        current = sentence;
      }
    }
    if (current.trim().length > 0) result.push(current.trim());
    return result;
  }
}
