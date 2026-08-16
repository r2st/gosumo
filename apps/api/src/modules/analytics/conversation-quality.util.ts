import { round2 } from './analytics.util';

/**
 * The CSAT proxy: a satisfaction estimate for the ~99% of conversations that
 * never receive an actual rating.
 *
 * ## Why a proxy at all
 *
 * `conversations.csat_score` exists and is honest, but it is only ever set when
 * a customer answers a survey. On WhatsApp and Instagram, for a small Indian
 * business that does not send one, that is almost never — so the tenant's real
 * CSAT is computed over a sample that is both tiny and self-selected, which
 * makes it worse than useless as a trend line. The proxy gives every resolved
 * conversation a number derived from what actually happened to it.
 *
 * ## What it is not
 *
 * It is not a measurement of satisfaction and it is not blended into the
 * explicit score. `ConversationQualityDto` reports the two separately, each
 * with its own sample size, and the combined figure carries both — because a
 * tenant reading "CSAT 4.2" needs to know whether four customers said so or
 * whether an algorithm inferred it from four thousand conversations.
 *
 * ## The model
 *
 * Start at {@link CSAT_PROXY_MAX} and subtract for each thing that went wrong,
 * floored at {@link CSAT_PROXY_MIN}. Deliberately additive penalties over
 * observable facts rather than a fitted model: every point of the score can be
 * explained to the business owner looking at it ("this one escalated and took
 * three days"), and nothing here needs training data the platform does not have.
 *
 * The four signals are the ones that survive being asked "would a customer have
 * noticed this?":
 *
 *   - **escalated** — the AI could not handle it and a person had to step in.
 *     The customer experienced a wait and, usually, a repeat of their question.
 *   - **breached** — an SLA the tenant set for itself was missed. The tenant's
 *     own definition of "too slow", so it needs no threshold here.
 *   - **slow** — resolution took longer than {@link CSAT_PROXY_SLOW_HOURS},
 *     whether or not an SLA policy existed to catch it.
 *   - **chatty** — the customer sent more than
 *     {@link CSAT_PROXY_CHATTY_INBOUND} messages. Repeating yourself is the
 *     single most reliable signal of a bad support experience, and it is the
 *     one a resolution-time metric cannot see: a thread resolved in ten minutes
 *     after the customer asked the same thing five times is not a good outcome.
 *
 * Weights are equal on purpose. Any relative weighting would be invented, and
 * an invented weighting is harder to argue with than an obviously flat one.
 */

/** Best possible proxy score — a clean, fast, single-pass resolution. */
export const CSAT_PROXY_MAX = 5;

/** Floor. A conversation that hit every penalty still scores 1, not 0 — the
 * scale is 1–5 to match `conversations.csat_score`, so that a proxy average and
 * an explicit average are read on the same axis. */
export const CSAT_PROXY_MIN = 1;

/** Points deducted per signal. Flat, for the reason in the file header. */
export const CSAT_PROXY_PENALTY = 1;

/** Resolution slower than this counts as "slow" regardless of SLA policy. */
export const CSAT_PROXY_SLOW_HOURS = 24;

/** More inbound messages than this counts as the customer repeating themselves. */
export const CSAT_PROXY_CHATTY_INBOUND = 4;

/** The observable facts about one resolved conversation that feed the proxy. */
export interface CsatProxySignals {
  escalated: boolean;
  breached: boolean;
  slow: boolean;
  chatty: boolean;
}

/**
 * A distinct combination of signals and how many resolved conversations had it.
 *
 * The repository groups by the signal tuple rather than returning one row per
 * conversation: there are at most 16 combinations, so a tenant with a million
 * resolved conversations produces at most 16 rows, and the scoring policy stays
 * here in TypeScript where it can be read and tested without a database.
 */
export interface CsatProxyGroup extends CsatProxySignals {
  count: number;
}

/** The 1–5 proxy score for one combination of signals. */
export function csatProxyScore(signals: CsatProxySignals): number {
  const penalties =
    (signals.escalated ? 1 : 0) +
    (signals.breached ? 1 : 0) +
    (signals.slow ? 1 : 0) +
    (signals.chatty ? 1 : 0);

  return Math.max(CSAT_PROXY_MIN, CSAT_PROXY_MAX - penalties * CSAT_PROXY_PENALTY);
}

/** A 1–5 score distribution, as the dashboard renders it. */
export type ScoreDistribution = Record<'1' | '2' | '3' | '4' | '5', number>;

export interface CsatSummary {
  /** Conversations that received an actual rating. */
  explicitResponses: number;
  /** Mean of those ratings, or null when nobody rated anything. */
  explicitAverage: number | null;
  /** Conversations scored by the proxy (i.e. resolved and *not* rated). */
  proxySampled: number;
  proxyAverage: number | null;
  /**
   * Explicit and proxy scores pooled, each conversation counting once.
   *
   * Reported because it is the number a dashboard tile wants, and reported
   * alongside both components because pooling a handful of real answers with
   * thousands of inferred ones is a thing the reader has to be able to see.
   */
  combinedAverage: number | null;
  combinedSampled: number;
  distribution: ScoreDistribution;
}

function emptyDistribution(): ScoreDistribution {
  return { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
}

/**
 * Fold explicit ratings and proxy signal groups into one summary.
 *
 * `explicit` is `[score, count]` pairs straight from the database; scores
 * outside 1–5 are ignored rather than clamped, because a value outside the
 * column's documented range means the data is wrong and averaging it in would
 * hide that.
 */
export function summarizeCsat(
  explicit: { score: number; count: number }[],
  proxyGroups: CsatProxyGroup[],
): CsatSummary {
  const distribution = emptyDistribution();

  let explicitResponses = 0;
  let explicitTotal = 0;
  for (const row of explicit) {
    if (!Number.isInteger(row.score) || row.score < 1 || row.score > 5) continue;
    explicitResponses += row.count;
    explicitTotal += row.score * row.count;
    distribution[String(row.score) as keyof ScoreDistribution] += row.count;
  }

  let proxySampled = 0;
  let proxyTotal = 0;
  for (const group of proxyGroups) {
    const score = csatProxyScore(group);
    proxySampled += group.count;
    proxyTotal += score * group.count;
    distribution[String(score) as keyof ScoreDistribution] += group.count;
  }

  const combinedSampled = explicitResponses + proxySampled;

  return {
    explicitResponses,
    explicitAverage: explicitResponses > 0 ? round2(explicitTotal / explicitResponses) : null,
    proxySampled,
    proxyAverage: proxySampled > 0 ? round2(proxyTotal / proxySampled) : null,
    combinedSampled,
    combinedAverage:
      combinedSampled > 0 ? round2((explicitTotal + proxyTotal) / combinedSampled) : null,
    distribution,
  };
}
