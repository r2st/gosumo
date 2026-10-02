import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { clients, segments } from '@prisma/client';
import { ChannelType } from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';
import { escapeLikeTerm } from '../../common/utils/search-pattern.util';

// ─────────────────────────────────────────────
// Filter & pagination types
// ─────────────────────────────────────────────

export interface ContactListFilters {
  /** Free-text match across name, email, phone. */
  search?: string;
  /** Match any of these tags (OR semantics). */
  tags?: string[];
  channel?: ChannelType;
  minLtv?: number;
  maxChurnRisk?: number;
  minEngagement?: number;
  hasOrders?: boolean;
  page?: number;
  limit?: number;
}

export interface PaginatedClients {
  data: clients[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface UpdateContactData {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * The dynamic filter shape stored on `segments.filter` and evaluated
 * on-demand against `clients` — see contact.service.ts for validation.
 *
 * Every criterion here has two implementations that must agree:
 * {@link ContactRepository.segmentFilterToWhere} for set queries, and
 * `matchesSegmentFilter` in `segment-routing.util.ts` for the single-contact
 * question the AI router asks. See that file's header.
 */
export interface SegmentFilter {
  tags?: string[];
  channels?: ChannelType[];
  minLtv?: number;
  maxChurnRisk?: number;
  minEngagement?: number;
  hasOrders?: boolean;

  // ── Purchase history ──────────────────────────
  minTotalOrders?: number;
  maxTotalOrders?: number;
  /** Lifetime spend in **paise**, converted from `clients.total_spent` (rupees). */
  minTotalSpentPaise?: number;
  maxTotalSpentPaise?: number;

  // ── Behaviour ─────────────────────────────────
  /** Last interaction is no older than this many days. */
  activeWithinDays?: number;
  /** Last interaction is at least this many days old — or never happened. */
  inactiveForDays?: number;
  /** Has ever opened a conversation (true) / never has (false). */
  hasConversations?: boolean;
  /** First seen within the last N days (new customers). */
  newerThanDays?: number;
  /** First seen more than N days ago (established customers). */
  olderThanDays?: number;
}

/**
 * How a segment routes the contacts it matches. Mirrors the Prisma enum;
 * re-declared as a union so the module's own types do not depend on the
 * generated client's enum object.
 */
export type SegmentRoutingMode = 'INHERIT' | 'AI_ONLY' | 'AI_FIRST' | 'HUMAN_ONLY';

/**
 * The routing columns as plain values.
 *
 * Deliberately not `Prisma.segmentsUncheckedUpdateInput`: that type admits
 * field-update operations (`{ set: … }`, `{ increment: … }`) which are valid
 * for an update and rejected by a create, so the one helper could not be spread
 * into both.
 */
interface SegmentRoutingColumns {
  routing_mode?: SegmentRoutingMode;
  routing_priority?: number;
  auto_execute_threshold?: number | null;
  draft_review_threshold?: number | null;
  routing_assignee_id?: string | null;
}

/** The routing half of a segment, as stored. */
export interface SegmentRouting {
  mode: SegmentRoutingMode;
  priority: number;
  autoExecuteThreshold: number | null;
  draftReviewThreshold: number | null;
  assigneeId: string | null;
}

export interface CreateSegmentData {
  name: string;
  description?: string;
  filter: SegmentFilter;
  isActive?: boolean;
  routing?: Partial<SegmentRouting>;
}

export interface UpdateSegmentData {
  name?: string;
  description?: string | null;
  filter?: SegmentFilter;
  isActive?: boolean;
  routing?: Partial<SegmentRouting>;
}

/**
 * The raw columns behind a {@link ClientSegmentSnapshot}, as one row.
 *
 * `total_spent` is a rupee `Decimal` and the channels arrive as an aggregated
 * array, so the service converts; this is deliberately the shape Postgres
 * returns rather than the shape the evaluator wants.
 */
export interface ClientSnapshotRow {
  tags: string[];
  channels: string[];
  ltv_score: number | null;
  churn_risk: number | null;
  engagement_score: number | null;
  total_orders: number;
  total_spent_paise: number;
  last_interaction_at: Date | null;
  first_seen_at: Date;
  conversation_count: number;
}

/**
 * ContactRepository — all read/write Prisma access for the contact module.
 *
 * Contacts are the existing `clients` table; this module owns `segments`
 * and the `tags` column on `clients` (both introduced for contact
 * management/segmentation), but never owns client identity itself — that
 * remains channel-adapter/client-intelligence territory.
 */
@Injectable()
export class ContactRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────────────────────────────────────────────
  // Contacts (clients)
  // ───────────────────────────────────────────────────────────────────

  async findMany(businessId: string, filters: ContactListFilters): Promise<PaginatedClients> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;

    const where = this.buildWhere(businessId, filters);

    const [data, total] = await Promise.all([
      this.prisma.clients.findMany({
        where,
        orderBy: { last_interaction_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.clients.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1 };
  }

  private buildWhere(businessId: string, filters: ContactListFilters): Prisma.clientsWhereInput {
    const where: Prisma.clientsWhereInput = { business_id: businessId, deleted_at: null };

    if (filters.search) {
      // Escaped so `%`/`_` are searched for, not executed as LIKE wildcards.
      const search = escapeLikeTerm(filters.search);
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (filters.tags?.length) {
      where.tags = { hasSome: filters.tags };
    }
    if (filters.minLtv !== undefined) {
      where.ltv_score = { gte: filters.minLtv };
    }
    if (filters.maxChurnRisk !== undefined) {
      where.churn_risk = { lte: filters.maxChurnRisk };
    }
    if (filters.minEngagement !== undefined) {
      where.engagement_score = { gte: filters.minEngagement };
    }
    if (filters.hasOrders !== undefined) {
      where.total_orders = filters.hasOrders ? { gt: 0 } : { equals: 0 };
    }
    if (filters.channel) {
      where.channel_contacts = { some: { channel: filters.channel } };
    }

    return where;
  }

  async findById(businessId: string, id: string): Promise<clients | null> {
    return this.prisma.clients.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async update(businessId: string, id: string, data: UpdateContactData): Promise<clients> {
    return this.prisma.clients.update({
      where: { id, business_id: businessId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
      },
    });
  }

  /** Replace a contact's tag list wholesale (the service computes the merged/diffed set). */
  async setTags(businessId: string, id: string, tags: string[]): Promise<clients> {
    return this.prisma.clients.update({
      where: { id, business_id: businessId },
      data: { tags },
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Segment evaluation (dynamic filter against `clients`)
  // ───────────────────────────────────────────────────────────────────

  segmentFilterToWhere(businessId: string, filter: SegmentFilter): Prisma.clientsWhereInput {
    const where: Prisma.clientsWhereInput = { business_id: businessId, deleted_at: null };

    if (filter.tags?.length) {
      where.tags = { hasSome: filter.tags };
    }
    if (filter.minLtv !== undefined) {
      where.ltv_score = { gte: filter.minLtv };
    }
    if (filter.maxChurnRisk !== undefined) {
      where.churn_risk = { lte: filter.maxChurnRisk };
    }
    if (filter.minEngagement !== undefined) {
      where.engagement_score = { gte: filter.minEngagement };
    }
    if (filter.hasOrders !== undefined) {
      where.total_orders = filter.hasOrders ? { gt: 0 } : { equals: 0 };
    }
    if (filter.channels?.length) {
      where.channel_contacts = { some: { channel: { in: filter.channels } } };
    }

    // ── Purchase history ────────────────────────
    // `hasOrders` above may already have written `total_orders`; these merge
    // into it rather than replacing it, so `{hasOrders: true, maxTotalOrders: 5}`
    // means both and not just the last one applied.
    const totalOrders: Prisma.IntFilter = {
      ...((where.total_orders as Prisma.IntFilter | undefined) ?? {}),
    };
    if (filter.minTotalOrders !== undefined) totalOrders.gte = filter.minTotalOrders;
    if (filter.maxTotalOrders !== undefined) totalOrders.lte = filter.maxTotalOrders;
    if (Object.keys(totalOrders).length > 0) where.total_orders = totalOrders;

    // Filters are expressed in paise; the column is rupees. Converting the
    // *bound* rather than the column keeps the comparison indexable.
    const totalSpent: Prisma.DecimalFilter = {};
    if (filter.minTotalSpentPaise !== undefined) {
      totalSpent.gte = filter.minTotalSpentPaise / 100;
    }
    if (filter.maxTotalSpentPaise !== undefined) {
      totalSpent.lte = filter.maxTotalSpentPaise / 100;
    }
    if (Object.keys(totalSpent).length > 0) where.total_spent = totalSpent;

    // ── Behaviour ───────────────────────────────
    const now = Date.now();
    const daysAgo = (days: number): Date => new Date(now - days * 24 * 60 * 60 * 1000);

    if (filter.activeWithinDays !== undefined) {
      // A contact who has never interacted is not recently active. `gte` on a
      // null column is already false in SQL, so no explicit guard is needed.
      where.last_interaction_at = { gte: daysAgo(filter.activeWithinDays) };
    }
    if (filter.inactiveForDays !== undefined) {
      // The mirror image needs the guard: never-interacted *is* dormant, and
      // `lte` alone would drop those rows.
      const cutoff = daysAgo(filter.inactiveForDays);
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        { OR: [{ last_interaction_at: { lte: cutoff } }, { last_interaction_at: null }] },
      ];
    }
    if (filter.newerThanDays !== undefined) {
      where.first_seen_at = { gte: daysAgo(filter.newerThanDays) };
    }
    if (filter.olderThanDays !== undefined) {
      where.first_seen_at = {
        ...((where.first_seen_at as Prisma.DateTimeFilter | undefined) ?? {}),
        lte: daysAgo(filter.olderThanDays),
      };
    }
    if (filter.hasConversations !== undefined) {
      // Deliberately a boolean and not a `minConversations: number`. Prisma
      // cannot compare a relation's cardinality to a bound — only to zero — so
      // a numeric form would have to be approximated here while the
      // single-contact evaluator applied it exactly, and the two would disagree
      // about who is in the segment. A criterion that cannot be expressed
      // identically in both places is a criterion this module does not offer.
      where.conversations = filter.hasConversations
        ? { some: { deleted_at: null } }
        : { none: { deleted_at: null } };
    }

    return where;
  }

  async findBySegmentFilter(
    businessId: string,
    filter: SegmentFilter,
    page: number,
    limit: number,
  ): Promise<PaginatedClients> {
    const where = this.segmentFilterToWhere(businessId, filter);

    const [data, total] = await Promise.all([
      this.prisma.clients.findMany({
        where,
        orderBy: { last_interaction_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.clients.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1 };
  }

  async countBySegmentFilter(businessId: string, filter: SegmentFilter): Promise<number> {
    return this.prisma.clients.count({ where: this.segmentFilterToWhere(businessId, filter) });
  }

  // ───────────────────────────────────────────────────────────────────
  // Segments
  // ───────────────────────────────────────────────────────────────────

  async createSegment(businessId: string, data: CreateSegmentData): Promise<segments> {
    return this.prisma.segments.create({
      data: {
        business_id: businessId,
        name: data.name,
        description: data.description,
        filter: data.filter as unknown as Prisma.InputJsonValue,
        is_active: data.isActive ?? true,
        ...this.routingWrite(data.routing),
      },
    });
  }

  /**
   * Translate a partial routing payload into column writes. Keys absent from
   * the payload are left untouched; an explicit `null` clears the column.
   */
  private routingWrite(routing: Partial<SegmentRouting> | undefined): SegmentRoutingColumns {
    if (!routing) return {};
    const write: SegmentRoutingColumns = {};
    if (routing.mode !== undefined) write.routing_mode = routing.mode;
    if (routing.priority !== undefined) write.routing_priority = routing.priority;
    if (routing.autoExecuteThreshold !== undefined) {
      write.auto_execute_threshold = routing.autoExecuteThreshold;
    }
    if (routing.draftReviewThreshold !== undefined) {
      write.draft_review_threshold = routing.draftReviewThreshold;
    }
    if (routing.assigneeId !== undefined) write.routing_assignee_id = routing.assigneeId;
    return write;
  }

  /**
   * Every active segment that expresses a routing opinion, in the order the
   * resolver applies them: highest priority first, oldest segment breaking a
   * tie.
   *
   * INHERIT segments are excluded in the WHERE clause rather than filtered
   * afterwards, because for the overwhelming majority of tenants that is every
   * segment they have — the resolver's cheap path is this query returning zero
   * rows, which the (business_id, routing_mode, routing_priority) index answers
   * without touching the table.
   *
   * The tie-break is `created_at` and not `id`: a UUID v4 tie-break would be
   * stable but arbitrary, so which of two equal-priority segments won would
   * look random to whoever configured them.
   */
  async findRoutingSegments(businessId: string): Promise<segments[]> {
    return this.prisma.segments.findMany({
      where: {
        business_id: businessId,
        deleted_at: null,
        is_active: true,
        routing_mode: { not: 'INHERIT' },
      },
      orderBy: [{ routing_priority: 'desc' }, { created_at: 'asc' }],
    });
  }

  /**
   * Load, in one round trip, everything a segment filter can ask about one
   * contact.
   *
   * One query rather than four: the AI pipeline calls this on the inbound path
   * of every message from a known client, and the channel list and conversation
   * count are aggregated in Postgres so neither can pull an unbounded number of
   * rows into the process for a contact with a long history.
   *
   * Returns `null` when the client does not exist in this business — which is
   * the same answer as "not in any segment", and is what the resolver treats as
   * "no routing opinion".
   */
  async findClientSnapshot(businessId: string, clientId: string): Promise<ClientSnapshotRow | null> {
    const rows = await this.prisma.$queryRaw<ClientSnapshotRow[]>`
      SELECT c.tags,
             COALESCE(chan.channels, ARRAY[]::text[])            AS channels,
             c.ltv_score::float8                                  AS ltv_score,
             c.churn_risk::float8                                 AS churn_risk,
             c.engagement_score::float8                           AS engagement_score,
             c.total_orders::int                                  AS total_orders,
             ROUND(c.total_spent * 100)::bigint::int              AS total_spent_paise,
             c.last_interaction_at,
             c.first_seen_at,
             COALESCE(conv.count, 0)::int                         AS conversation_count
      FROM clients c
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(DISTINCT cc.channel::text) AS channels
        FROM channel_contacts cc
        WHERE cc.client_id = c.id AND cc.business_id = c.business_id
      ) chan ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS count
        FROM conversations cv
        WHERE cv.client_id = c.id
          AND cv.business_id = c.business_id
          AND cv.deleted_at IS NULL
      ) conv ON TRUE
      WHERE c.id = ${clientId}::uuid
        AND c.business_id = ${businessId}::uuid
        AND c.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async findSegments(businessId: string): Promise<segments[]> {
    return this.prisma.segments.findMany({
      where: { business_id: businessId, deleted_at: null },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
  }

  async findSegmentById(businessId: string, id: string): Promise<segments | null> {
    return this.prisma.segments.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async findSegmentByName(businessId: string, name: string): Promise<segments | null> {
    return this.prisma.segments.findFirst({
      where: { business_id: businessId, name, deleted_at: null },
    });
  }

  async updateSegment(businessId: string, id: string, data: UpdateSegmentData): Promise<segments> {
    return this.prisma.segments.update({
      where: { id, business_id: businessId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.filter !== undefined ? { filter: data.filter as unknown as Prisma.InputJsonValue } : {}),
        ...(data.isActive !== undefined ? { is_active: data.isActive } : {}),
        ...this.routingWrite(data.routing),
      },
    });
  }

  async softDeleteSegment(businessId: string, id: string): Promise<void> {
    await this.prisma.segments.update({
      where: { id, business_id: businessId },
      data: { deleted_at: new Date() },
    });
  }
}
