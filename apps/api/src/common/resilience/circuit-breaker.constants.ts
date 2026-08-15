/**
 * Per-dependency breaker settings.
 *
 * The names are the strings that appear in `GET /v1/health/ready` and in every
 * `CircuitOpenError`, so they are operator-facing and must stay stable.
 *
 * The thresholds are not uniform, because the cost of a false open is not
 * uniform. Two questions set them:
 *
 *  - **How much does one wasted call cost?** A channel send is on the inbound
 *    hot path and is retried by BullMQ, so a stalled one costs a concurrency
 *    slot for the full 10s deadline, three times over. A payment-gateway call
 *    is rarer but holds a Postgres connection from a 50-connection budget
 *    while it waits.
 *  - **How bad is failing a healthy call?** Opening on Razorpay stops payment
 *    links being created for every tenant, so it wants more evidence than a
 *    channel adapter, where the send is queued and simply retried later.
 *
 * Cooldowns are all short (30–45s). The breaker's job is to stop a stampede,
 * not to hold an outage open: an over-long cooldown keeps failing requests
 * after the provider is back, which reads to a tenant exactly like the outage
 * it was protecting them from.
 */

export interface BreakerSettings {
  name: string;
  failureThreshold: number;
  cooldownMs: number;
}

/**
 * Payment gateways.
 *
 * Higher threshold (6): a false open means no tenant can take money, and the
 * call volume is low enough that six consecutive failures is still seconds,
 * not minutes. Longer cooldown (45s) because a gateway that has just failed
 * six times in a row is rarely back within thirty.
 */
export const RAZORPAY_BREAKER: BreakerSettings = {
  name: 'Razorpay',
  failureThreshold: 6,
  cooldownMs: 45_000,
};

export const STRIPE_BREAKER: BreakerSettings = {
  name: 'Stripe',
  failureThreshold: 6,
  cooldownMs: 45_000,
};

/**
 * Outbound channel sends.
 *
 * Shorter cooldown (30s): these sit on the hot path with a BullMQ retry behind
 * them, so a wrongly-refused send is re-attempted automatically half a minute
 * later, while a *not* refused send parks a worker slot for 10s per attempt.
 * Cheap to be wrong, expensive to be slow — the opposite trade-off to the
 * gateways above.
 *
 * **The threshold counts attempts, not messages.** These breakers sit inside
 * `BaseChannelAdapter.sendWithRetry`, which makes up to `maxAttempts` (3)
 * calls per send. Six is therefore two complete sends' worth of evidence — the
 * same order of confidence as the gateways' six, arrived at faster because
 * each send supplies three data points instead of one.
 *
 * Meta is split by product rather than shared: WhatsApp Cloud API and the
 * Instagram Messaging API are different graph endpoints with independent
 * availability, and collapsing them would let an Instagram incident stop
 * WhatsApp replies for every tenant.
 */
export const WHATSAPP_BREAKER: BreakerSettings = {
  name: 'WhatsApp',
  failureThreshold: 6,
  cooldownMs: 30_000,
};

export const INSTAGRAM_BREAKER: BreakerSettings = {
  name: 'Instagram',
  failureThreshold: 6,
  cooldownMs: 30_000,
};

export const TWILIO_BREAKER: BreakerSettings = {
  name: 'Twilio',
  failureThreshold: 6,
  cooldownMs: 30_000,
};

export const SENDGRID_BREAKER: BreakerSettings = {
  name: 'SendGrid',
  failureThreshold: 6,
  cooldownMs: 30_000,
};
