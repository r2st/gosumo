import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { EMBEDDING_MODEL } from '../ai-engine.constants';
import { fetchWithTimeout } from '../../../common/utils/http-timeout.util';

/**
 * How many vectors the in-process embedding cache keeps before evicting the
 * least recently used one.
 *
 * The cache used to be an unbounded `Map`, which is only safe if the set of
 * texts a process embeds is itself bounded. It is not, in either direction:
 *
 *   - `RagRetrieverService` embeds the *customer's message text* on the hot path
 *     of every inbound message, so the key space grows with traffic and never
 *     repeats — a WhatsApp inbox generates a new key per message, forever.
 *   - `KnowledgeIngestionService` embeds every chunk of every ingested document.
 *     Ingestion is one-shot, so those entries are pure ballast: they are written
 *     once and can never be read again, and a single large knowledge base
 *     inserts thousands of them in one burst.
 *
 * Each entry is a {@link EMBEDDING_DIMENSIONS}-element `number[]`, which V8
 * stores as unboxed doubles — ~12 KB per vector plus the hex key. 10k distinct
 * texts is therefore ~120 MB of resident heap that nothing ever frees, in a
 * long-lived API process that the deployment already runs close to its heap cap.
 *
 * 512 entries (~6 MB) keeps the property the cache exists for — two callers
 * embedding the same text within a request share one provider call — while
 * making the ceiling a constant instead of a function of uptime. Eviction is LRU
 * rather than insert-order so an ingestion burst cannot flush the query vectors
 * that are actually being re-read.
 */
export const EMBEDDING_CACHE_MAX_ENTRIES = 512;

/**
 * EmbeddingService — converts text into vectors for RAG indexing and querying.
 *
 * It targets any OpenAI-compatible embeddings endpoint (configured via
 * `EMBEDDINGS_URL` + `EMBEDDINGS_API_KEY`). When no endpoint is configured —
 * e.g. in unit tests or a minimal dev box — `embed()` returns `null` and the
 * RAG layer degrades gracefully rather than failing the pipeline.
 *
 * Query embeddings are deduplicated by a content hash so the same message text
 * is never embedded twice within a process tick (a lightweight in-memory cache;
 * the production deployment also caches in Redis with a 5-minute TTL).
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  /**
   * Content-hash → vector, most-recently-used last. See
   * {@link EMBEDDING_CACHE_MAX_ENTRIES} for why the ordering matters.
   */
  private readonly cache = new Map<string, number[]>();

  constructor(private readonly configService: ConfigService) {}

  /**
   * Embed a single string. Returns `null` when embeddings are not configured
   * or the provider call fails.
   */
  async embed(text: string): Promise<number[] | null> {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return null;

    const key = this.hash(trimmed);
    const cached = this.cache.get(key);
    if (cached) {
      // A read is a use: re-insert so this key moves to the MRU end and is not
      // the one evicted next.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const url = process.env['EMBEDDINGS_URL'];
    const apiKey = process.env['EMBEDDINGS_API_KEY'];
    if (!url || !apiKey) {
      this.logger.debug('Embeddings provider not configured — RAG will run without vectors');
      return null;
    }

    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model: EMBEDDING_MODEL, input: trimmed }),
        },
        { service: 'Embeddings' },
      );

      if (!res.ok) {
        this.logger.warn(`Embeddings call failed: ${res.status}`);
        return null;
      }

      const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const vector = json.data?.[0]?.embedding;
      if (!vector || vector.length === 0) return null;

      this.remember(key, vector);
      return vector;
    } catch (err) {
      this.logger.warn(`Embeddings call errored: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** SHA-256 of the text — also used as the content hash for re-index tracking. */
  hash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  /**
   * Store `vector` as the most recently used entry, evicting from the LRU end
   * until the cache is back within {@link EMBEDDING_CACHE_MAX_ENTRIES}.
   *
   * `Map` iterates in insertion order, so the first key it yields is the least
   * recently used one — provided every read re-inserts, which `embed()` does.
   */
  private remember(key: string, vector: number[]): void {
    this.cache.delete(key);
    this.cache.set(key, vector);

    while (this.cache.size > EMBEDDING_CACHE_MAX_ENTRIES) {
      const lru = this.cache.keys().next();
      // Defensive: an exhausted iterator on a non-empty map is impossible, but
      // deleting `undefined` would spin this loop forever if it happened.
      if (lru.done) break;
      this.cache.delete(lru.value);
    }
  }
}
