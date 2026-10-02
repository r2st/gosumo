/**
 * Contract for the per-tenant rate limits.
 *
 * Two failure modes are invisible at runtime and both are one word wide:
 *
 *  - **A bucket named on a route that does not exist in the table.** The
 *    limiter admits the request (refusing traffic over our own typo would be
 *    worse), so the route the author meant to protect is simply unprotected
 *    and nothing anywhere says so.
 *  - **A decorator that falls off an expensive route.** The route keeps
 *    working. It is only when a tenant loops it at 3am that anyone discovers
 *    the ceiling was never there.
 *
 * Neither shows up in a unit test of the limiter or the guard, because both
 * pass with an empty decorator set. This file is where they fail.
 */
import { Reflector } from '@nestjs/core';
import { TENANT_RATE_LIMIT_BUCKETS } from './tenant-rate-limit.constants';
import { TENANT_RATE_LIMIT_BUCKET } from './tenant-rate-limit.decorator';
import { AiEngineController } from '../../modules/ai-engine/ai-engine.controller';
import { HitlController } from '../../modules/hitl/hitl.controller';
import { ConversationSearchController } from '../../modules/conversation-search/conversation-search.controller';
import { MessageController } from '../../modules/message/message.controller';
import { RealtyIngestionController } from '../../modules/realty-ingestion/realty-ingestion.controller';
import { DataExportController } from '../../modules/data-export/data-export.controller';
import { ChannelsController } from '../../modules/channels/channels.controller';
import { BillingController } from '../../modules/billing/billing.controller';

/**
 * [description, controller, handler name, expected bucket]
 *
 * A route belongs here when one call costs a resource the whole platform
 * shares: a metered LLM allocation, a channel provider's sending reputation,
 * an unanchored scan of a tenant's whole message history, a bulk disclosure of
 * personal data, or a fan-out into thousands of rows.
 */
const RATIONED: Array<[string, NewableFunction, string, string]> = [
  // Full AI pipeline — RAG retrieval plus one or more LLM completions against
  // a free-tier allocation held by the entire platform.
  ['POST /ai/process', AiEngineController, 'process', 'ai-invoke'],
  ['POST /ai/decisions/:id/regenerate', AiEngineController, 'regenerate', 'ai-invoke'],
  // Single-shot LLM call — cheaper, still metered.
  ['POST /ai/classify', AiEngineController, 'classifyIntent', 'ai-classify'],
  // Chunks, embeds and upserts vectors that stay written.
  ['POST /ai/knowledge', AiEngineController, 'ingestKnowledge', 'knowledge-ingest'],

  // Puts a message on a customer's phone. The ceiling protects the tenant's
  // own channel reputation as much as our database — a burst costs them a
  // WhatsApp quality rating we cannot restore for them.
  ['POST /hitl/tasks/:id/approve', HitlController, 'approveDraft', 'message-ingest'],
  ['POST /hitl/tasks/:id/edit-send', HitlController, 'editAndSendDraft', 'message-ingest'],
  [
    'POST /hitl/conversations/:id/manual-response',
    HitlController,
    'sendManualResponse',
    'message-ingest',
  ],

  // Unanchored ILIKE across a tenant's whole history, paid in a connection
  // pool this deployment shares with another service.
  ['GET /search/messages', ConversationSearchController, 'messages', 'search'],
  ['GET /search/conversations', ConversationSearchController, 'conversations', 'search'],
  ['GET /messages/search', MessageController, 'searchMessages', 'search'],
  ['GET /ai/knowledge/search', AiEngineController, 'searchKnowledge', 'search'],

  // One request fans out into thousands of rows.
  ['POST /realty/ingestion/csv', RealtyIngestionController, 'importCsv', 'bulk-write'],

  // A bulk disclosure of one person's entire history. The ceiling is a
  // containment measure as much as a performance one — a leaked token must not
  // drain a tenant's customer records faster than anyone can notice.
  ['GET /data-export/clients/:id', DataExportController, 'exportClient', 'export'],
  ['GET /data-export/clients/:id/summary', DataExportController, 'summary', 'export'],
  ['POST /data-export/resolve', DataExportController, 'resolve', 'export'],

  // Channel connect/disconnect mutates integration state and hits external
  // providers. A compromised manager token must not churn channels in a loop.
  ['POST /channels/:type/connect', ChannelsController, 'connectChannel', 'channel-management'],
  ['DELETE /channels/:id', ChannelsController, 'disconnectChannel', 'channel-management'],

  // Subscription tier changes move money and are the owner's decision.
  ['POST /billing/upgrade', BillingController, 'upgrade', 'billing-change'],
];

describe('per-tenant rate-limit contract', () => {
  const reflector = new Reflector();

  const bucketOf = (controller: NewableFunction, handler: string): string | undefined => {
    const method = (controller.prototype as Record<string, unknown>)[handler];
    // A renamed or removed handler must fail here rather than reading as
    // "carries no bucket", which is the same symptom as a dropped decorator
    // and would send the next reader looking in the wrong place.
    expect(typeof method).toBe('function');
    return reflector.getAllAndOverride<string>(TENANT_RATE_LIMIT_BUCKET, [
      method as () => unknown,
      controller,
    ]);
  };

  describe('every rationed route still carries its bucket', () => {
    it.each(RATIONED)('%s is limited by "%s"', (_desc, controller, handler, bucket) => {
      // Guards against the decorator quietly falling off during a refactor.
      // The route keeps working without it, which is exactly why nothing else
      // would notice.
      expect(bucketOf(controller, handler)).toBe(bucket);
    });
  });

  describe('every bucket in use has a rule', () => {
    it.each(RATIONED)('%s names a bucket that exists', (_desc, _controller, _handler, bucket) => {
      // A bucket with no rule is a silent no-op: the limiter admits everything
      // and the route is unprotected with no error anywhere.
      expect(TENANT_RATE_LIMIT_BUCKETS[bucket]).toBeDefined();
    });

    it('leaves no rule in the table unused', () => {
      // An unused rule is either a route that lost its decorator or a ceiling
      // somebody sized and then never applied. Both are worth a failing test,
      // because both read as "protected" to anyone auditing the constants.
      const used = new Set(RATIONED.map(([, , , bucket]) => bucket));
      const defined = Object.keys(TENANT_RATE_LIMIT_BUCKETS);

      expect(defined.filter((b) => !used.has(b))).toEqual([]);
    });
  });

  describe('the rules themselves', () => {
    const rules = Object.entries(TENANT_RATE_LIMIT_BUCKETS);

    it.each(rules)('%s has a positive ceiling and window', (_bucket, rule) => {
      // A limit of 0 blocks the route entirely; a window of 0 makes every
      // request start a fresh window, which is no limit at all. Both are
      // plausible typos and neither fails anywhere else.
      expect(rule.limit).toBeGreaterThan(0);
      expect(rule.windowMs).toBeGreaterThan(0);
    });

    it.each(rules)('%s describes the resource for the 429 body', (_bucket, rule) => {
      // The description is what the caller is shown. An empty one leaves them
      // with "retry in 42s" and no idea what to slow down.
      expect(rule.description.trim().length).toBeGreaterThan(0);
    });

    it('keeps the AI ceilings the tightest, since they alone spend a shared allocation', () => {
      // Encodes the sizing intent rather than the numbers: a future edit that
      // raises `ai-invoke` above the general message ceiling has inverted the
      // priority without anyone deciding to.
      expect(TENANT_RATE_LIMIT_BUCKETS['ai-invoke']!.limit).toBeLessThan(
        TENANT_RATE_LIMIT_BUCKETS['message-ingest']!.limit,
      );
      expect(TENANT_RATE_LIMIT_BUCKETS['ai-invoke']!.limit).toBeLessThanOrEqual(
        TENANT_RATE_LIMIT_BUCKETS['ai-classify']!.limit,
      );
    });
  });
});
