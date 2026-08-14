import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMBEDDING_DIMENSIONS } from '../ai-engine.constants';
import { fetchWithTimeout } from '../../../common/utils/http-timeout.util';

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantSearchHit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface QdrantFilter {
  must?: Array<{ key: string; match: { value: unknown } }>;
}

/**
 * Minimal Qdrant REST client built on `fetch`.
 *
 * It is intentionally tolerant: when Qdrant is unreachable, every read
 * degrades to an empty result and every write returns `false` rather than
 * throwing. The AI pipeline must never crash because the vector store is down
 * — it proceeds without RAG context and the confidence calculator penalizes
 * `dataAvailability` accordingly (see module CLAUDE.md).
 */
@Injectable()
export class QdrantClient {
  private readonly logger = new Logger(QdrantClient.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('qdrant.url', 'http://localhost:6333').replace(/\/$/, '');
  }

  /** Ensure a collection exists with the expected vector size (idempotent). */
  async ensureCollection(collection: string, vectorSize = EMBEDDING_DIMENSIONS): Promise<boolean> {
    try {
      const existing = await this.request('GET', `/collections/${collection}`);
      if (existing.ok) return true;

      const created = await this.request('PUT', `/collections/${collection}`, {
        vectors: { size: vectorSize, distance: 'Cosine' },
      });
      return created.ok;
    } catch (err) {
      this.logger.warn(`ensureCollection(${collection}) failed: ${this.msg(err)}`);
      return false;
    }
  }

  /** Upsert points into a collection. Returns false on any failure. */
  async upsert(collection: string, points: QdrantPoint[]): Promise<boolean> {
    if (points.length === 0) return true;
    try {
      const res = await this.request('PUT', `/collections/${collection}/points`, { points });
      return res.ok;
    } catch (err) {
      this.logger.warn(`upsert into ${collection} failed: ${this.msg(err)}`);
      return false;
    }
  }

  /** Vector search. Returns `[]` on any failure. */
  async search(
    collection: string,
    vector: number[],
    opts: { limit?: number; scoreThreshold?: number; filter?: QdrantFilter } = {},
  ): Promise<QdrantSearchHit[]> {
    try {
      const res = await this.request('POST', `/collections/${collection}/points/search`, {
        vector,
        limit: opts.limit ?? 10,
        with_payload: true,
        ...(opts.scoreThreshold !== undefined && { score_threshold: opts.scoreThreshold }),
        ...(opts.filter && { filter: opts.filter }),
      });
      if (!res.ok) return [];

      const json = (await res.json()) as { result?: Array<{ id: string; score: number; payload: Record<string, unknown> }> };
      return (json.result ?? []).map((r) => ({ id: String(r.id), score: r.score, payload: r.payload ?? {} }));
    } catch (err) {
      this.logger.warn(`search in ${collection} failed: ${this.msg(err)}`);
      return [];
    }
  }

  /** Delete points by id. Returns false on failure. */
  async deletePoints(collection: string, ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    try {
      const res = await this.request('POST', `/collections/${collection}/points/delete`, { points: ids });
      return res.ok;
    } catch (err) {
      this.logger.warn(`deletePoints in ${collection} failed: ${this.msg(err)}`);
      return false;
    }
  }

  private request(method: string, path: string, body?: unknown): Promise<Response> {
    return fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      },
      { service: 'Qdrant' },
    );
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
