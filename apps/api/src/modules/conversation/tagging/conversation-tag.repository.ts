import { Injectable } from '@nestjs/common';
import { ConversationTagSource } from '@gosumo/database';
import type { conversation_tag_assignments } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma.service';

/** One tag the service wants recorded. */
export interface TagAssignmentInput {
  tag: string;
  source: ConversationTagSource;
  confidence?: number | null;
  model?: string | null;
  rationale?: string | null;
  createdBy?: string | null;
}

/**
 * ConversationTagRepository — provenance rows for conversation tags.
 *
 * `conversations.tags` remains the array the inbox filters on; this table
 * records how each entry got there. The two are kept consistent by the service,
 * which recomputes the array from the non-suppressed rows after every write —
 * see `ConversationTaggingService.reconcile`.
 */
@Injectable()
export class ConversationTagRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByConversation(
    businessId: string,
    conversationId: string,
  ): Promise<conversation_tag_assignments[]> {
    return this.prisma.conversation_tag_assignments.findMany({
      where: { business_id: businessId, conversation_id: conversationId },
      orderBy: { created_at: 'asc' },
    });
  }

  /**
   * Tags a human has explicitly removed from this conversation.
   *
   * The auto-tagger reads this before proposing anything. Without it, removing
   * a wrong AI tag lasts exactly until the next inbound message re-runs the
   * tagger, which is indistinguishable from the removal not working.
   */
  async findSuppressedTags(businessId: string, conversationId: string): Promise<string[]> {
    const rows = await this.prisma.conversation_tag_assignments.findMany({
      where: { business_id: businessId, conversation_id: conversationId, suppressed: true },
      select: { tag: true },
    });
    return rows.map((r) => r.tag);
  }

  /**
   * Insert or update one assignment.
   *
   * An upsert rather than a create, because the same tag arriving twice is
   * normal: the tagger re-runs as a conversation grows, and a manual tag can
   * confirm one the AI already proposed. The unique index on
   * `(conversation_id, tag)` is what makes this collapse instead of duplicating.
   */
  async upsert(
    businessId: string,
    conversationId: string,
    input: TagAssignmentInput,
  ): Promise<conversation_tag_assignments> {
    const shared = {
      source: input.source,
      confidence: input.confidence ?? null,
      model: input.model ?? null,
      rationale: input.rationale ?? null,
    };

    return this.prisma.conversation_tag_assignments.upsert({
      where: {
        conversation_id_tag: { conversation_id: conversationId, tag: input.tag },
      },
      create: {
        business_id: businessId,
        conversation_id: conversationId,
        tag: input.tag,
        created_by: input.createdBy ?? null,
        ...shared,
      },
      update: {
        ...shared,
        // Re-applying a tag clears its tombstone. Only a manual re-add can
        // reach this — the auto-tagger filters suppressed tags out before it
        // proposes anything — so this is a person overriding their own earlier
        // removal, which must be allowed to stick.
        suppressed: false,
        suppressed_at: null,
        suppressed_by: null,
      },
    });
  }

  /**
   * Tombstone a tag rather than deleting it.
   *
   * Deleting would make "a human said no" and "nobody has considered this tag"
   * the same state, and the auto-tagger cannot tell them apart. Returns false
   * when there was no such assignment to suppress.
   */
  async suppress(
    businessId: string,
    conversationId: string,
    tag: string,
    suppressedBy?: string | null,
  ): Promise<boolean> {
    const result = await this.prisma.conversation_tag_assignments.updateMany({
      where: {
        business_id: businessId,
        conversation_id: conversationId,
        tag,
        suppressed: false,
      },
      data: {
        suppressed: true,
        suppressed_at: new Date(),
        suppressed_by: suppressedBy ?? null,
      },
    });
    return result.count > 0;
  }

  /** Live (non-suppressed) tags for one conversation, in insertion order. */
  async findActiveTags(businessId: string, conversationId: string): Promise<string[]> {
    const rows = await this.prisma.conversation_tag_assignments.findMany({
      where: { business_id: businessId, conversation_id: conversationId, suppressed: false },
      select: { tag: true },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((r) => r.tag);
  }

  /**
   * The tenant's own tag vocabulary — distinct tags already in use, most common
   * first. Fed to the tagger so a business's invented tags keep being applied.
   */
  async findTenantVocabulary(businessId: string, limit: number): Promise<string[]> {
    const rows = await this.prisma.conversation_tag_assignments.groupBy({
      by: ['tag'],
      where: { business_id: businessId, suppressed: false },
      _count: { tag: true },
      orderBy: { _count: { tag: 'desc' } },
      take: limit,
    });
    return rows.map((r) => r.tag);
  }

  /** Usage counts per tag across the tenant — the tag-management screen's read. */
  async statsByTag(
    businessId: string,
  ): Promise<Array<{ tag: string; count: number; source: ConversationTagSource }>> {
    const rows = await this.prisma.conversation_tag_assignments.groupBy({
      by: ['tag', 'source'],
      where: { business_id: businessId, suppressed: false },
      _count: { tag: true },
      orderBy: { _count: { tag: 'desc' } },
    });
    return rows.map((r) => ({ tag: r.tag, count: r._count.tag, source: r.source }));
  }
}
