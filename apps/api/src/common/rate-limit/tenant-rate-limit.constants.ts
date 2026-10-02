/**
 * Per-tenant ceilings for the authenticated API surface.
 *
 * `JwtAuthGuard` already stops an anonymous caller, and `AuthThrottleLimiter`
 * rations the handful of `@Public()` routes that let one in. Neither bounds
 * what a caller does *once they hold a valid token* — and on a multi-tenant
 * deployment sharing one Postgres (a 50-connection ceiling shared with another
 * service), one metered LLM account, and one Redis, that is the gap that
 * matters: a runaway integration, a retry loop in somebody's script, or a
 * dashboard tab left refreshing overnight costs every *other* tenant their
 * latency. The abusive caller here is authenticated, usually not malicious,
 * and entirely capable of taking the platform down by accident.
 *
 * The key is the business, not the user or the IP, for two reasons. It is the
 * unit that is billed, so a ceiling on it is a limit somebody agreed to rather
 * than an arbitrary throttle. And it is the unit that cannot be multiplied: a
 * tenant can mint more team members and call from more addresses, but they
 * cannot spawn more businesses to get around a quota without paying for them.
 *
 * Every bucket below is **opt-in**. A route with no `@TenantRateLimit()` is
 * not rationed at all — the guard returns before it touches the limiter — so
 * adding this to the global chain cannot change the behaviour of a route that
 * has not asked for it. That is deliberate: a blanket per-tenant ceiling
 * across an API this wide would be a number nobody could size, and the first
 * legitimate bulk operation to hit it would be reported as an outage.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** A fixed-window ceiling: `limit` requests per `windowMs` for one tenant. */
export interface TenantRateLimitRule {
  limit: number;
  windowMs: number;
  /**
   * What the ceiling protects, in one phrase. Goes into the 429 body so the
   * caller learns *which* of their behaviours to slow down rather than being
   * told only that they were too fast.
   *
   * Written for the tenant's developer, not for us: it names the resource, and
   * never the internal component, the tenant id, or the current usage of
   * anybody else.
   */
  description: string;
}

/**
 * Buckets referenced by `@TenantRateLimit('<bucket>')`.
 *
 * Sizing rule used throughout: **an order of magnitude above what the product
 * generates in normal use, and well below what makes the endpoint useful as a
 * lever against the rest of the platform.** A limit tight enough to be
 * interesting is a limit that pages somebody at 2am for a customer doing
 * nothing wrong.
 *
 * A bucket named on a route but missing from this table is a silent no-op —
 * the route the author meant to protect is unprotected and nothing says so.
 * `tenant-rate-limit-contract.spec.ts` is what makes that a test failure.
 */
export const TENANT_RATE_LIMIT_BUCKETS: Record<string, TenantRateLimitRule> = {
  /**
   * Writes that put a message on a customer's phone.
   *
   * The ceiling is not really about our database — it is about the channel
   * providers downstream. Meta and Twilio ration per sending number and
   * penalise the *sender's* reputation for bursts, so a loop here does damage
   * that outlives the loop: the tenant's WhatsApp quality rating drops, and
   * that is not something we can restore for them. 300/minute is far past a
   * human inbox and past any reasonable bulk send, which goes through the
   * campaign queue rather than this path.
   */
  'message-ingest': {
    limit: 300,
    windowMs: MINUTE,
    description: 'outbound and inbound message writes',
  },

  /**
   * Endpoints that run the full AI pipeline: RAG retrieval, prompt assembly,
   * and one or more LLM completions.
   *
   * The tightest bucket here, because it is the only one where a single
   * request costs a shared, metered, *rationed* resource — the OpenRouter free
   * tier is an allocation held by the whole platform, so one tenant looping
   * `POST /ai/process` exhausts the models every other tenant's conversations
   * depend on. The model fallback chain buys resilience against a slug being
   * rationed; it does not create quota. 60/minute is one full pipeline run a
   * second, which no human conversation approaches.
   */
  'ai-invoke': {
    limit: 60,
    windowMs: MINUTE,
    description: 'AI pipeline runs',
  },

  /**
   * Intent classification and other single-shot LLM calls.
   *
   * Looser than `ai-invoke` because a classification is one small completion
   * with no RAG round-trip, and the dashboard calls it interactively while
   * somebody is typing. Still rationed: it is an LLM call, and the free-tier
   * allocation does not care that the prompt was short.
   */
  'ai-classify': {
    limit: 120,
    windowMs: MINUTE,
    description: 'AI classification calls',
  },

  /**
   * Knowledge-base ingestion — chunk, embed, upsert into Qdrant.
   *
   * Per *hour*, unlike its neighbours, because the shape of the abuse is
   * different: ingestion is a bulk operation nobody performs continuously, and
   * each call writes vectors that stay written. A per-minute window sized for
   * a legitimate bulk load would admit that same load every minute forever,
   * which is how a vector store fills up.
   */
  'knowledge-ingest': {
    limit: 100,
    windowMs: HOUR,
    description: 'knowledge-base ingestion',
  },

  /**
   * Unanchored `ILIKE '%term%'` searches across messages, conversations and
   * contacts.
   *
   * Trigram indexes make these survivable rather than free, and the cost is
   * paid in the connection pool this deployment shares. A type-ahead search
   * box debounced at 300ms produces ~3 requests a second per user; 200/minute
   * covers a large team all searching at once.
   */
  search: {
    limit: 200,
    windowMs: MINUTE,
    description: 'search queries',
  },

  /**
   * Whole-subject data exports (see the `data-export` module).
   *
   * The most expensive read the API offers — one call walks every message,
   * order, payment and booking held for one customer. It is also, by
   * construction, a bulk disclosure of personal data, so a ceiling here is a
   * containment measure as much as a performance one: a leaked token should
   * not be able to drain a tenant's customer records faster than anyone can
   * notice. Per hour, and small, because the legitimate rate is "a handful of
   * subject-access requests a month".
   */
  export: {
    limit: 30,
    windowMs: HOUR,
    description: 'customer data exports',
  },

  /**
   * Bulk writes — CSV imports, campaign sends, segment recomputation.
   *
   * One request here fans out into thousands of rows and, for a campaign,
   * thousands of outbound messages. The point of the ceiling is that the *fan
   * out* is unbounded, so the request count is the only thing left to bound.
   */
  'bulk-write': {
    limit: 20,
    windowMs: HOUR,
    description: 'bulk imports and campaign sends',
  },

  /**
   * Channel connect/disconnect/test operations.
   *
   * These are infrequent admin actions — a business connects a channel once
   * and tests it a handful of times. The ceiling is generous enough for a
   * setup session and restrictive enough that a leaked manager token cannot
   * churn channel state in a loop.
   */
  'channel-management': {
    limit: 30,
    windowMs: HOUR,
    description: 'channel management operations',
  },

  /**
   * Subscription tier changes.
   *
   * A single upgrade or downgrade per business should happen at most a few
   * times a month. The per-hour ceiling keeps a compromised owner token from
   * thrashing the billing state.
   */
  'billing-change': {
    limit: 10,
    windowMs: HOUR,
    description: 'subscription plan changes',
  },
};

/**
 * Past this many resident windows the limiter sweeps elapsed ones before
 * admitting a new key.
 *
 * The tenant key space is not attacker-controlled the way `AuthThrottle`'s IP
 * space is — a caller cannot invent businesses — so this is a memory bound
 * rather than a defence, and it is set well above any plausible tenant count
 * so the sweep never runs on a healthy deployment. It exists because
 * "bounded by how many customers we have" is a bound that holds right up until
 * it doesn't, and an unswept map is the one bug a rate limiter must not have:
 * the mitigation for one resource exhaustion quietly becoming another.
 */
export const TENANT_RATE_LIMIT_SWEEP_THRESHOLD = 50_000;
