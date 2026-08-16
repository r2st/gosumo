import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConversationTagSource, MessageDirection } from '@gosumo/database';
import type { conversation_tag_assignments, conversations } from '@prisma/client';
import { LlmClientService } from '../../ai-engine/pipeline/llm-client.service';
import { FAST_MODEL } from '../../ai-engine/ai-engine.constants';
import { MessageService } from '../../message/message.service';
import { ConversationRepository } from '../conversation.repository';
import { ConversationTagRepository } from './conversation-tag.repository';
import {
  CONVERSATION_TAGGING_SYSTEM_PROMPT,
  LlmTagResult,
  TaggingTurn,
  buildTaggingUserPrompt,
} from './conversation-tagging.prompt';
import {
  CONVERSATION_TAG_TAXONOMY,
  MAX_AI_TAGS_PER_CONVERSATION,
  MAX_TAGS_PER_CONVERSATION,
  MIN_TAG_CONFIDENCE,
  TAGGING_CONTEXT_MESSAGES,
  normalizeTag,
} from './conversation-tagging.constants';

/** Outcome of one auto-tagging pass. */
export interface AutoTagResult {
  conversationId: string;
  /** Tags newly written by this pass. */
  applied: string[];
  /** Proposed but below `MIN_TAG_CONFIDENCE`. */
  rejectedLowConfidence: string[];
  /** Proposed but previously removed by a human, so never re-applied. */
  skippedSuppressed: string[];
  /** Proposed but not in the allowed vocabulary. */
  skippedUnknown: string[];
  /** The conversation's full live tag set after the pass. */
  tags: string[];
  model: string | null;
}

/** How many of the tenant's own tags are offered to the model. */
const TENANT_VOCABULARY_LIMIT = 40;

/**
 * ConversationTaggingService — AI topic/intent tagging with a manual override
 * that actually holds.
 *
 * The manual override is the part worth being careful about. An auto-tagger
 * with no memory of human decisions re-applies a tag the moment the
 * conversation changes, so removing a wrong tag lasts until the next inbound
 * message — which reads to the operator as the remove button not working. Every
 * removal therefore writes a tombstone (`suppressed = true`) that the tagger
 * consults before proposing anything, and only a person can clear it by
 * deliberately re-adding the tag.
 *
 * `conversations.tags` stays the array the inbox filters on. This service is
 * the only writer that keeps it and the provenance table in step: every
 * mutation ends in `reconcile`, which recomputes the array from the live rows.
 */
@Injectable()
export class ConversationTaggingService {
  private readonly logger = new Logger(ConversationTaggingService.name);

  constructor(
    private readonly tags: ConversationTagRepository,
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageService,
    private readonly llm: LlmClientService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Classify a conversation and apply the tags it earns.
   *
   * Never throws on an LLM failure. Tagging is an enrichment: a conversation
   * with no tags is merely less searchable, while an exception here would fail
   * whatever inbound path invoked it. The result reports what happened.
   */
  async autoTag(businessId: string, conversationId: string): Promise<AutoTagResult> {
    const conversation = await this.requireConversation(businessId, conversationId);

    const [turns, suppressed, vocabulary] = await Promise.all([
      this.loadTranscript(businessId, conversationId),
      this.tags.findSuppressedTags(businessId, conversationId),
      this.tags.findTenantVocabulary(businessId, TENANT_VOCABULARY_LIMIT),
    ]);

    const empty: AutoTagResult = {
      conversationId,
      applied: [],
      rejectedLowConfidence: [],
      skippedSuppressed: [],
      skippedUnknown: [],
      tags: conversation.tags,
      model: null,
    };

    if (turns.length === 0) {
      return empty;
    }

    let parsed: LlmTagResult | null = null;
    let model: string | null = null;
    try {
      const result = await this.llm.complete({
        system: CONVERSATION_TAGGING_SYSTEM_PROMPT,
        user: buildTaggingUserPrompt(turns, vocabulary),
        model: FAST_MODEL,
        maxTokens: 400,
        temperature: 0,
      });
      model = result.modelId;
      parsed = this.llm.extractJson<LlmTagResult>(result.text);
    } catch (err) {
      this.logger.warn(
        `Auto-tagging failed for conversation ${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return empty;
    }

    if (!parsed || !Array.isArray(parsed.tags)) {
      this.logger.warn(`Auto-tagger returned an unusable result for ${conversationId}`);
      return { ...empty, model };
    }

    const allowed = new Set([...CONVERSATION_TAG_TAXONOMY, ...vocabulary]);
    const suppressedSet = new Set(suppressed);
    const existing = new Set(conversation.tags);

    const applied: string[] = [];
    const rejectedLowConfidence: string[] = [];
    const skippedSuppressed: string[] = [];
    const skippedUnknown: string[] = [];

    for (const proposal of parsed.tags.slice(0, MAX_AI_TAGS_PER_CONVERSATION)) {
      const tag = normalizeTag(String(proposal?.tag ?? ''));
      if (!tag) continue;

      // Order matters: a suppressed tag is reported as suppressed even if it is
      // also out of vocabulary or low-confidence, because that is the fact an
      // operator wondering why their removal stuck actually needs.
      if (suppressedSet.has(tag)) {
        skippedSuppressed.push(tag);
        continue;
      }
      if (!allowed.has(tag)) {
        skippedUnknown.push(tag);
        continue;
      }

      const confidence = clamp01(proposal?.confidence);
      if (confidence < MIN_TAG_CONFIDENCE) {
        rejectedLowConfidence.push(tag);
        continue;
      }
      if (existing.has(tag)) continue;
      if (existing.size + applied.length >= MAX_TAGS_PER_CONVERSATION) break;

      await this.tags.upsert(businessId, conversationId, {
        tag,
        source: ConversationTagSource.AI,
        confidence,
        model,
        rationale: proposal?.rationale ? String(proposal.rationale).slice(0, 500) : null,
      });
      applied.push(tag);
    }

    const updated = await this.reconcile(businessId, conversationId);

    if (applied.length > 0) {
      this.eventEmitter.emit('conversation.tagged', {
        businessId,
        conversationId,
        tags: applied,
        source: ConversationTagSource.AI,
        timestamp: new Date().toISOString(),
      });
      this.logger.log(
        `Auto-tagged conversation ${conversationId}: ${applied.join(', ')}`,
      );
    }

    return {
      conversationId,
      applied,
      rejectedLowConfidence,
      skippedSuppressed,
      skippedUnknown,
      tags: updated.tags,
      model,
    };
  }

  /**
   * Apply tags manually.
   *
   * A manual add clears any tombstone on that tag — a person re-adding
   * something they removed is overriding their own earlier decision, and that
   * has to stick.
   */
  async addTags(
    businessId: string,
    conversationId: string,
    rawTags: string[],
    actorId?: string | null,
  ): Promise<conversations> {
    const conversation = await this.requireConversation(businessId, conversationId);
    const normalized = this.normalizeAll(rawTags);
    if (normalized.length === 0) {
      throw new BadRequestException('No usable tags were supplied');
    }
    if (conversation.tags.length + normalized.length > MAX_TAGS_PER_CONVERSATION) {
      throw new BadRequestException(
        `A conversation may carry at most ${MAX_TAGS_PER_CONVERSATION} tags`,
      );
    }

    for (const tag of normalized) {
      await this.tags.upsert(businessId, conversationId, {
        tag,
        source: ConversationTagSource.MANUAL,
        createdBy: actorId ?? null,
      });
    }

    const updated = await this.reconcile(businessId, conversationId);
    this.eventEmitter.emit('conversation.tagged', {
      businessId,
      conversationId,
      tags: normalized,
      source: ConversationTagSource.MANUAL,
      timestamp: new Date().toISOString(),
    });
    return updated;
  }

  /**
   * Remove a tag and remember that a human did so.
   *
   * Idempotent: removing a tag that is not there succeeds and changes nothing,
   * because the caller's intent — "this conversation should not carry this tag"
   * — is already satisfied.
   */
  async removeTag(
    businessId: string,
    conversationId: string,
    rawTag: string,
    actorId?: string | null,
  ): Promise<conversations> {
    await this.requireConversation(businessId, conversationId);
    const tag = normalizeTag(rawTag);
    if (!tag) {
      throw new BadRequestException('Tag is empty after normalization');
    }

    const suppressed = await this.tags.suppress(businessId, conversationId, tag, actorId);
    const updated = await this.reconcile(businessId, conversationId);

    if (suppressed) {
      this.eventEmitter.emit('conversation.untagged', {
        businessId,
        conversationId,
        tag,
        timestamp: new Date().toISOString(),
      });
    }
    return updated;
  }

  /**
   * Replace the whole tag set manually.
   *
   * Every tag that disappears is suppressed rather than dropped — a wholesale
   * replace is as much a human decision as removing one tag, and the tagger
   * must honour it the same way.
   */
  async setTags(
    businessId: string,
    conversationId: string,
    rawTags: string[],
    actorId?: string | null,
  ): Promise<conversations> {
    await this.requireConversation(businessId, conversationId);
    const desired = this.normalizeAll(rawTags);
    if (desired.length > MAX_TAGS_PER_CONVERSATION) {
      throw new BadRequestException(
        `A conversation may carry at most ${MAX_TAGS_PER_CONVERSATION} tags`,
      );
    }

    const current = await this.tags.findActiveTags(businessId, conversationId);
    const desiredSet = new Set(desired);

    for (const tag of current) {
      if (!desiredSet.has(tag)) {
        await this.tags.suppress(businessId, conversationId, tag, actorId);
      }
    }
    for (const tag of desired) {
      await this.tags.upsert(businessId, conversationId, {
        tag,
        source: ConversationTagSource.MANUAL,
        createdBy: actorId ?? null,
      });
    }

    return this.reconcile(businessId, conversationId);
  }

  /** Provenance rows for one conversation — who applied what, and why. */
  async listAssignments(
    businessId: string,
    conversationId: string,
  ): Promise<conversation_tag_assignments[]> {
    await this.requireConversation(businessId, conversationId);
    return this.tags.findByConversation(businessId, conversationId);
  }

  /** Tag usage across the tenant, for the tag-management screen. */
  async tagStats(businessId: string) {
    return this.tags.statsByTag(businessId);
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  /**
   * Recompute `conversations.tags` from the live assignment rows.
   *
   * The array is derived state, and this is the only thing that derives it.
   * Writing the array anywhere else is what would let the two drift, at which
   * point the inbox filter and the provenance screen disagree and neither is
   * obviously wrong.
   */
  private async reconcile(
    businessId: string,
    conversationId: string,
  ): Promise<conversations> {
    const active = await this.tags.findActiveTags(businessId, conversationId);
    const bounded = active.slice(0, MAX_TAGS_PER_CONVERSATION);
    return this.conversations.update(businessId, conversationId, { tags: bounded });
  }

  private normalizeAll(raw: string[]): string[] {
    return [...new Set((raw ?? []).map(normalizeTag).filter(Boolean))];
  }

  /**
   * Load the transcript the tagger reads.
   *
   * Direction, not sender identity, decides the role: the tagger is
   * categorizing a topic and has no business seeing which agent said what.
   */
  private async loadTranscript(
    businessId: string,
    conversationId: string,
  ): Promise<TaggingTurn[]> {
    const messages = await this.messages.getLastNMessages(
      businessId,
      conversationId,
      TAGGING_CONTEXT_MESSAGES,
    );

    return messages
      .map((m) => ({
        role: (m.direction === MessageDirection.INBOUND
          ? 'customer'
          : 'business') as TaggingTurn['role'],
        text: m.text_content ?? '',
      }))
      .filter((t) => t.text.trim().length > 0);
  }

  private async requireConversation(businessId: string, conversationId: string) {
    const conversation = await this.conversations.findById(businessId, conversationId);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }
}

/** Coerce an untrusted confidence into [0,1]; anything unusable scores 0. */
function clamp01(value: unknown): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, num));
}
