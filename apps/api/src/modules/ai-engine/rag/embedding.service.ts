import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { EMBEDDING_MODEL } from '../ai-engine.constants';

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
    if (cached) return cached;

    const url = process.env['EMBEDDINGS_URL'];
    const apiKey = process.env['EMBEDDINGS_API_KEY'];
    if (!url || !apiKey) {
      this.logger.debug('Embeddings provider not configured — RAG will run without vectors');
      return null;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: trimmed }),
      });

      if (!res.ok) {
        this.logger.warn(`Embeddings call failed: ${res.status}`);
        return null;
      }

      const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const vector = json.data?.[0]?.embedding;
      if (!vector || vector.length === 0) return null;

      this.cache.set(key, vector);
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
}
