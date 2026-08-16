import { Injectable, Logger } from '@nestjs/common';
import type { segments } from '@prisma/client';
import { ChannelType } from '@gosumo/shared';
import {
  ContactRepository,
  type SegmentFilter,
  type SegmentRoutingMode,
} from './contact.repository';
import { matchesSegmentFilter, type ClientSegmentSnapshot } from './segment-routing.util';

/**
 * What the AI pipeline should do with a turn from this contact.
 *
 * `mode: 'INHERIT'` with a null `segmentId` is the answer for the overwhelming
 * majority of contacts, and means "nothing here has an opinion" — the tenant's
 * own confidence bands decide, exactly as they did before segments carried
 * routing.
 */
export interface SegmentRoutingDecision {
  mode: SegmentRoutingMode;
  /** The segment that decided, or null when nothing matched. */
  segmentId: string | null;
  segmentName: string | null;
  /** Per-segment confidence bands (0–100), when the matched segment sets them. */
  autoExecuteThreshold: number | null;
  draftReviewThreshold: number | null;
  /** Team member this segment's conversations belong to, when configured. */
  assigneeId: string | null;
}

/** The answer when no segment expresses an opinion. */
export const NO_SEGMENT_ROUTING: SegmentRoutingDecision = Object.freeze({
  mode: 'INHERIT' as const,
  segmentId: null,
  segmentName: null,
  autoExecuteThreshold: null,
  draftReviewThreshold: null,
  assigneeId: null,
});

/**
 * SegmentRoutingService — decides, per contact, whether the AI may answer.
 *
 * ## Where this runs
 *
 * On the inbound path of every message from a known client, between context
 * loading and confidence scoring. That placement is what makes the cost model
 * the important part of this class:
 *
 *   - Tenants with no routing segments — every tenant, until someone configures
 *     one — pay a single indexed query that returns zero rows, and the method
 *     returns before touching `clients`.
 *   - Tenants that do configure routing pay that query plus one snapshot read,
 *     and then evaluate every segment in memory. The cost does not grow with
 *     the number of segments, which is what a "one count query per segment"
 *     implementation would have done.
 *
 * ## Failure posture
 *
 * Split deliberately, because the two reads mean different things:
 *
 *   - The **segment list** failing is treated as INHERIT. A failure there is
 *     indistinguishable from the ordinary empty result, and the ordinary result
 *     *is* empty for almost every tenant — so failing closed would escalate
 *     every message on the platform to a human to protect a control that, in
 *     all likelihood, nobody had configured.
 *   - The **snapshot** failing, once the list is known to be non-empty, is
 *     treated as HUMAN_ONLY. Here we know a control exists and only that we
 *     cannot tell whether it applies. "Do not let the AI talk to these
 *     customers" is a safety rule, and the safe reading of an unknown is that
 *     it might be one of them. Escalating a turn still answers the customer —
 *     a person picks it up — so the failure mode is a slower reply, not a
 *     dropped one.
 */
@Injectable()
export class SegmentRoutingService {
  private readonly logger = new Logger(SegmentRoutingService.name);

  constructor(private readonly repository: ContactRepository) {}

  /**
   * The highest-priority routing segment this contact matches, or
   * {@link NO_SEGMENT_ROUTING}.
   *
   * Never throws — see the class docstring for what each failure resolves to.
   */
  async resolve(
    businessId: string,
    clientId: string | null | undefined,
    now: Date = new Date(),
  ): Promise<SegmentRoutingDecision> {
    if (!clientId) return NO_SEGMENT_ROUTING;

    let routingSegments: segments[];
    try {
      routingSegments = await this.repository.findRoutingSegments(businessId);
    } catch (err) {
      this.logger.warn(
        `Segment routing lookup failed for business ${businessId}; this turn is routed by the ` +
          `tenant's own thresholds: ${err instanceof Error ? err.message : String(err)}`,
      );
      return NO_SEGMENT_ROUTING;
    }

    if (routingSegments.length === 0) return NO_SEGMENT_ROUTING;

    let snapshot: ClientSegmentSnapshot | null;
    try {
      snapshot = await this.loadSnapshot(businessId, clientId);
    } catch (err) {
      this.logger.error(
        `Segment membership could not be determined for client ${clientId} while ` +
          `${routingSegments.length} routing segment(s) are active — escalating this turn rather ` +
          `than guessing: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ...NO_SEGMENT_ROUTING, mode: 'HUMAN_ONLY' };
    }

    // No such client in this business. Not an error and not a reason to
    // escalate: an unknown contact is in no segment, so no segment routes them.
    if (!snapshot) return NO_SEGMENT_ROUTING;

    for (const segment of routingSegments) {
      const filter = (segment.filter ?? {}) as unknown as SegmentFilter;
      if (matchesSegmentFilter(filter, snapshot, now)) {
        return {
          mode: segment.routing_mode as SegmentRoutingMode,
          segmentId: segment.id,
          segmentName: segment.name,
          autoExecuteThreshold: segment.auto_execute_threshold,
          draftReviewThreshold: segment.draft_review_threshold,
          assigneeId: segment.routing_assignee_id,
        };
      }
    }

    return NO_SEGMENT_ROUTING;
  }

  /**
   * The contact, in the shape the evaluator wants: money in paise, channels as
   * a typed list, `Decimal` columns as numbers.
   */
  private async loadSnapshot(
    businessId: string,
    clientId: string,
  ): Promise<ClientSegmentSnapshot | null> {
    const row = await this.repository.findClientSnapshot(businessId, clientId);
    if (!row) return null;

    return {
      tags: row.tags ?? [],
      channels: (row.channels ?? []).filter(
        (c): c is ChannelType => c in ChannelType || Object.values(ChannelType).includes(c as ChannelType),
      ),
      ltvScore: row.ltv_score,
      churnRisk: row.churn_risk,
      engagementScore: row.engagement_score,
      totalOrders: row.total_orders,
      totalSpentPaise: row.total_spent_paise,
      lastInteractionAt: row.last_interaction_at,
      firstSeenAt: row.first_seen_at,
      conversationCount: row.conversation_count,
    };
  }
}
