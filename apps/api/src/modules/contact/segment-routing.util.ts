import { ChannelType } from '@gosumo/shared';
import type { SegmentFilter } from './contact.repository';

/**
 * Segment evaluation, without a database.
 *
 * Segments are normally evaluated as SQL — `segmentFilterToWhere` turns a
 * stored filter into a `clients` WHERE clause and Postgres answers "who is in
 * this segment". That is the right shape for listing members and counting them,
 * and the wrong shape for the question the AI pipeline asks on every inbound
 * message: "which segments is *this one* contact in?". Answered as SQL that is
 * one query per segment per message, on the hottest path in the product.
 *
 * So the same predicates exist twice: once as a WHERE clause for set queries,
 * and once here as a pure function over a snapshot of the contact, which the
 * router loads in a single query and then tests against every segment for free.
 *
 * The duplication is the cost of not doing N queries per message, and it is
 * load-bearing that the two agree — a contact the SQL puts in a HUMAN_ONLY
 * segment but this function does not is a contact the AI answers anyway, with
 * the segment page still showing them as protected. `segment-routing.spec.ts`
 * pins the two key sets against each other so adding a criterion to one and
 * forgetting the other fails a test rather than silently diverging.
 */

/**
 * Everything a segment filter can ask about one contact, read once.
 *
 * Money is paise (integer) throughout, per the platform rule — `clients.total_spent`
 * is stored as rupees `Decimal(14,2)`, so the loader converts it here rather
 * than letting a rupee value reach a filter written in paise.
 */
export interface ClientSegmentSnapshot {
  tags: string[];
  /** Distinct channels this contact has ever been reached on. */
  channels: ChannelType[];
  ltvScore: number | null;
  churnRisk: number | null;
  engagementScore: number | null;
  totalOrders: number;
  totalSpentPaise: number;
  lastInteractionAt: Date | null;
  firstSeenAt: Date;
  conversationCount: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days between `then` and `now`, or null when `then` is absent. */
function daysSince(then: Date | null, now: Date): number | null {
  if (!then) return null;
  return (now.getTime() - then.getTime()) / MS_PER_DAY;
}

/**
 * The criteria a segment filter may carry, as a single list.
 *
 * Exported so the spec can assert that this function and
 * `ContactRepository.segmentFilterToWhere` understand the same set — see the
 * file header for why that matters.
 */
export const SEGMENT_FILTER_CRITERIA = [
  'tags',
  'channels',
  'minLtv',
  'maxChurnRisk',
  'minEngagement',
  'hasOrders',
  'minTotalOrders',
  'maxTotalOrders',
  'minTotalSpentPaise',
  'maxTotalSpentPaise',
  'activeWithinDays',
  'inactiveForDays',
  'hasConversations',
  'newerThanDays',
  'olderThanDays',
] as const;

/**
 * Does `snapshot` satisfy every criterion `filter` states?
 *
 * AND across criteria, OR within a list-valued one (`tags: ['vip','wholesale']`
 * matches a contact with either). An empty filter matches everyone, which is
 * the same answer the SQL form gives for `{}` — a segment with no criteria is
 * "all contacts", not "no contacts".
 *
 * A criterion whose input is unknown for this contact (`minLtv` against a
 * client whose LTV has never been scored) does **not** match. That is the same
 * verdict Postgres reaches — `NULL >= 5` is NULL, which is not true — and it is
 * the safe direction: a contact is only ever routed by a rule that positively
 * describes them.
 */
export function matchesSegmentFilter(
  filter: SegmentFilter,
  snapshot: ClientSegmentSnapshot,
  now: Date = new Date(),
): boolean {
  if (filter.tags?.length) {
    const wanted = new Set(filter.tags);
    if (!snapshot.tags.some((t) => wanted.has(t))) return false;
  }

  if (filter.channels?.length) {
    const wanted = new Set<string>(filter.channels);
    if (!snapshot.channels.some((c) => wanted.has(c))) return false;
  }

  if (filter.minLtv !== undefined) {
    if (snapshot.ltvScore === null || snapshot.ltvScore < filter.minLtv) return false;
  }

  if (filter.maxChurnRisk !== undefined) {
    if (snapshot.churnRisk === null || snapshot.churnRisk > filter.maxChurnRisk) return false;
  }

  if (filter.minEngagement !== undefined) {
    if (snapshot.engagementScore === null || snapshot.engagementScore < filter.minEngagement) {
      return false;
    }
  }

  if (filter.hasOrders !== undefined) {
    const has = snapshot.totalOrders > 0;
    if (has !== filter.hasOrders) return false;
  }

  if (filter.minTotalOrders !== undefined && snapshot.totalOrders < filter.minTotalOrders) {
    return false;
  }
  if (filter.maxTotalOrders !== undefined && snapshot.totalOrders > filter.maxTotalOrders) {
    return false;
  }

  if (
    filter.minTotalSpentPaise !== undefined &&
    snapshot.totalSpentPaise < filter.minTotalSpentPaise
  ) {
    return false;
  }
  if (
    filter.maxTotalSpentPaise !== undefined &&
    snapshot.totalSpentPaise > filter.maxTotalSpentPaise
  ) {
    return false;
  }

  if (filter.activeWithinDays !== undefined) {
    const days = daysSince(snapshot.lastInteractionAt, now);
    // Never interacted is not "active within N days", however large N is.
    if (days === null || days > filter.activeWithinDays) return false;
  }

  if (filter.inactiveForDays !== undefined) {
    const days = daysSince(snapshot.lastInteractionAt, now);
    // Never interacted *is* dormant — there is no last touch to be recent.
    // This is the one place the SQL form needs an explicit `OR IS NULL`.
    if (days !== null && days < filter.inactiveForDays) return false;
  }

  if (filter.hasConversations !== undefined) {
    const has = snapshot.conversationCount > 0;
    if (has !== filter.hasConversations) return false;
  }

  if (filter.newerThanDays !== undefined) {
    const days = daysSince(snapshot.firstSeenAt, now);
    if (days === null || days > filter.newerThanDays) return false;
  }

  if (filter.olderThanDays !== undefined) {
    const days = daysSince(snapshot.firstSeenAt, now);
    if (days === null || days < filter.olderThanDays) return false;
  }

  return true;
}
