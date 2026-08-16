import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditAction, ContactMergeStrategy } from '@gosumo/database';
import { Prisma } from '@prisma/client';
import type { clients, contact_merges } from '@prisma/client';
import { AuditLogService } from '../../../common/services/audit-log.service';
import {
  ContactMergeRepository,
  RelocationCounts,
} from './contact-merge.repository';
import {
  DedupCandidate,
  DuplicateSignal,
  chooseSurvivor,
  scoreDuplicate,
} from './contact-dedup.util';
import {
  DUPLICATE_SUGGEST_THRESHOLD,
  MAX_DEDUP_SCAN_CONTACTS,
  MAX_DUPLICATE_CANDIDATES,
  MERGE_CONFLICT_FIELDS,
  MergeConflictField,
} from './contact-merge.constants';

/** One suggested duplicate pair. */
export interface DuplicatePair {
  survivorId: string;
  duplicateId: string;
  score: number;
  reason: string;
  signals: DuplicateSignal[];
  survivor: { id: string; name: string | null; email: string | null; phone: string | null };
  duplicate: { id: string; name: string | null; email: string | null; phone: string | null };
}

/** Per-field decision for one merge. */
export interface FieldResolution {
  chosen: string | null;
  survivor: string | null;
  duplicate: string | null;
  /** True when both records held a different non-empty value. */
  conflicted: boolean;
}

export interface MergePreview {
  survivorId: string;
  duplicateId: string;
  strategy: ContactMergeStrategy;
  fields: Record<string, FieldResolution>;
  /** Rows that would move, per table. */
  moves: RelocationCounts;
  score: number | null;
  reason: string | null;
}

export interface MergeResult {
  mergeId: string;
  survivorId: string;
  duplicateId: string;
  moved: RelocationCounts;
  reversible: boolean;
  fields: Record<string, FieldResolution>;
}

/** Explicit per-field overrides, used with the MANUAL strategy. */
export type FieldOverrides = Partial<Record<MergeConflictField, string | null>>;

/**
 * ContactMergeService — find duplicate contacts, and merge them reversibly.
 *
 * A merge moves every conversation, order, payment and booking from one
 * customer record onto another and retires the loser. It is the most
 * destructive thing a tenant can do to their own CRM in a single call, and the
 * false positive it guards against is specific and common: two brothers on one
 * family phone, two colleagues on a shared office address. Three rules follow
 * from that.
 *
 *  - **Detection never merges.** `findDuplicates` returns suggestions at any
 *    score; nothing acts on them without an explicit call naming both ids.
 *  - **Every merge is previewable**, and the preview is computed by the same
 *    code that performs it — so what the operator approves is what runs.
 *  - **Every merge is reversible**, unless it moved more rows than can be
 *    recorded, in which case it says so up front rather than at revert time.
 */
@Injectable()
export class ContactMergeService {
  private readonly logger = new Logger(ContactMergeService.name);

  constructor(
    private readonly repository: ContactMergeRepository,
    private readonly audit: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Suggest duplicate pairs within a tenant.
   *
   * O(n²) over a bounded scan. Blocking by a shared identifier would be faster,
   * but every blocking key is also the thing being compared: two rows that
   * differ only in country-code formatting share no exact key, and those are
   * precisely the duplicates worth finding.
   */
  async findDuplicates(
    businessId: string,
    options: { threshold?: number; limit?: number } = {},
  ): Promise<DuplicatePair[]> {
    const threshold = options.threshold ?? DUPLICATE_SUGGEST_THRESHOLD;
    const limit = Math.min(options.limit ?? MAX_DUPLICATE_CANDIDATES, MAX_DUPLICATE_CANDIDATES);

    const contacts = await this.repository.findDedupCandidates(
      businessId,
      MAX_DEDUP_SCAN_CONTACTS,
    );
    if (contacts.length < 2) return [];

    const externalIds = await this.repository.findExternalIds(
      businessId,
      contacts.map((c) => c.id),
    );
    const candidates: DedupCandidate[] = contacts.map((client) => ({
      client,
      externalIds: externalIds.get(client.id) ?? [],
    }));

    const pairs: DuplicatePair[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const a = candidates[i]!;
        const b = candidates[j]!;
        const scored = scoreDuplicate(a, b);
        if (scored.score < threshold) continue;

        const survivor = chooseSurvivor(a, b);
        const duplicate = survivor === a ? b : a;
        pairs.push({
          survivorId: survivor.client.id,
          duplicateId: duplicate.client.id,
          score: scored.score,
          reason: scored.reason,
          signals: scored.signals,
          survivor: identityOf(survivor.client),
          duplicate: identityOf(duplicate.client),
        });
      }
    }

    return pairs.sort((x, y) => y.score - x.score).slice(0, limit);
  }

  /** What a merge would do, without doing it. */
  async previewMerge(
    businessId: string,
    survivorId: string,
    duplicateId: string,
    strategy: ContactMergeStrategy = ContactMergeStrategy.PREFER_SURVIVOR,
    overrides: FieldOverrides = {},
  ): Promise<MergePreview> {
    const { survivor, duplicate } = await this.loadPair(businessId, survivorId, duplicateId);
    const fields = this.resolveFields(survivor, duplicate, strategy, overrides);
    const moves = await this.repository.countReferences(businessId, duplicateId);
    const scored = scoreDuplicate({ client: survivor }, { client: duplicate });

    return {
      survivorId,
      duplicateId,
      strategy,
      fields,
      moves,
      score: scored.score,
      reason: scored.reason,
    };
  }

  /** Perform the merge. */
  async merge(
    businessId: string,
    survivorId: string,
    duplicateId: string,
    options: {
      strategy?: ContactMergeStrategy;
      overrides?: FieldOverrides;
      performedBy?: string | null;
      actorEmail?: string | null;
      requestId?: string | null;
      ipAddress?: string | null;
    } = {},
  ): Promise<MergeResult> {
    const strategy = options.strategy ?? ContactMergeStrategy.PREFER_SURVIVOR;
    const { survivor, duplicate } = await this.loadPair(businessId, survivorId, duplicateId);

    const fields = this.resolveFields(survivor, duplicate, strategy, options.overrides ?? {});
    const resolved: Record<string, string | null> = {};
    for (const [field, resolution] of Object.entries(fields)) {
      resolved[field] = resolution.chosen;
    }

    const scored = scoreDuplicate({ client: survivor }, { client: duplicate });

    const { merge, execution } = await this.repository.executeMerge({
      businessId,
      survivor,
      duplicate,
      resolved,
      strategy,
      fieldResolutions: fields as unknown as Prisma.InputJsonValue,
      matchReason: scored.reason,
      matchScore: scored.score,
      performedBy: options.performedBy ?? null,
    });

    await this.audit.record({
      businessId,
      actorType: options.performedBy ? 'TEAM_MEMBER' : 'API',
      actorId: options.performedBy ?? null,
      actorEmail: options.actorEmail ?? null,
      action: AuditAction.UPDATE,
      resourceType: 'contact_merge',
      resourceId: merge.id,
      requestId: options.requestId ?? null,
      ipAddress: options.ipAddress ?? null,
      after: {
        survivorId,
        duplicateId,
        strategy,
        moved: execution.counts,
        reversible: execution.reversible,
      },
      description: `Merged contact ${duplicateId} into ${survivorId}`,
    });

    this.eventEmitter.emit('contact.merged', {
      businessId,
      mergeId: merge.id,
      survivorId,
      duplicateId,
      timestamp: new Date().toISOString(),
    });

    if (!execution.reversible) {
      this.logger.warn(
        `Merge ${merge.id} is not reversible: ${execution.unrecorded.join(', ')} ` +
          'exceeded the recordable row cap',
      );
    }
    this.logger.log(
      `Merged contact ${duplicateId} into ${survivorId} (${totalMoved(execution.counts)} rows)`,
    );

    return {
      mergeId: merge.id,
      survivorId,
      duplicateId,
      moved: execution.counts,
      reversible: execution.reversible,
      fields,
    };
  }

  /** Undo a merge. */
  async revert(
    businessId: string,
    mergeId: string,
    options: { revertedBy?: string | null; actorEmail?: string | null } = {},
  ): Promise<{ mergeId: string; restored: RelocationCounts }> {
    const merge = await this.repository.findMerge(businessId, mergeId);
    if (!merge) {
      throw new NotFoundException('Merge not found');
    }
    if (merge.reverted_at) {
      throw new BadRequestException('This merge has already been reverted');
    }

    const snapshot = merge.snapshot as { reversible?: boolean; unrecorded?: string[] } | null;
    if (snapshot?.reversible === false) {
      // Refused rather than half-applied. A partial revert leaves the contact
      // restored with only some of its history, which looks like data loss and
      // is harder to reason about than the merge it was undoing.
      throw new BadRequestException(
        'This merge cannot be reverted: it moved more rows than could be recorded ' +
          `(${(snapshot.unrecorded ?? []).join(', ')}).`,
      );
    }

    const { restored } = await this.repository.revertMerge(
      businessId,
      merge,
      options.revertedBy ?? null,
    );

    await this.audit.record({
      businessId,
      actorType: options.revertedBy ? 'TEAM_MEMBER' : 'API',
      actorId: options.revertedBy ?? null,
      actorEmail: options.actorEmail ?? null,
      action: AuditAction.UPDATE,
      resourceType: 'contact_merge_revert',
      resourceId: mergeId,
      after: { restored },
      description: `Reverted contact merge ${mergeId}`,
    });

    this.eventEmitter.emit('contact.merge.reverted', {
      businessId,
      mergeId,
      survivorId: merge.survivor_id,
      duplicateId: merge.duplicate_id,
      timestamp: new Date().toISOString(),
    });

    return { mergeId, restored };
  }

  async listMerges(
    businessId: string,
    params: { limit?: number; offset?: number } = {},
  ): Promise<{ data: contact_merges[]; total: number }> {
    return this.repository.listMerges(businessId, {
      limit: Math.min(Math.max(params.limit ?? 20, 1), 100),
      offset: Math.max(params.offset ?? 0, 0),
    });
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  /**
   * Load both contacts, refusing the shapes a merge must never accept.
   *
   * Both are looked up tenant-scoped, so an id from another business is a 404
   * rather than a cross-tenant merge — which would be the single worst bug this
   * module could have.
   */
  private async loadPair(
    businessId: string,
    survivorId: string,
    duplicateId: string,
  ): Promise<{ survivor: clients; duplicate: clients }> {
    if (survivorId === duplicateId) {
      throw new BadRequestException('A contact cannot be merged into itself');
    }

    const [survivor, duplicate] = await Promise.all([
      this.repository.findClient(businessId, survivorId),
      this.repository.findClient(businessId, duplicateId),
    ]);

    if (!survivor) throw new NotFoundException(`Contact ${survivorId} not found`);
    if (!duplicate) throw new NotFoundException(`Contact ${duplicateId} not found`);

    return { survivor, duplicate };
  }

  /**
   * Decide each conflicting field.
   *
   * A missing value never wins. Whatever the strategy says, if the preferred
   * record's field is empty the other record's value is taken — the point of a
   * merge is one complete record, and a strategy that let PREFER_SURVIVOR erase
   * the only phone number on file would destroy data to honour a preference
   * about which of two values to keep when there are two.
   */
  private resolveFields(
    survivor: clients,
    duplicate: clients,
    strategy: ContactMergeStrategy,
    overrides: FieldOverrides,
  ): Record<string, FieldResolution> {
    const preferDuplicate =
      strategy === ContactMergeStrategy.PREFER_DUPLICATE ||
      (strategy === ContactMergeStrategy.PREFER_MOST_RECENT &&
        isMoreRecent(duplicate, survivor));

    const out: Record<string, FieldResolution> = {};
    for (const field of MERGE_CONFLICT_FIELDS) {
      const survivorValue = normalize(survivor[field]);
      const duplicateValue = normalize(duplicate[field]);

      let chosen: string | null;
      if (strategy === ContactMergeStrategy.MANUAL && field in overrides) {
        chosen = normalize(overrides[field]);
      } else {
        const preferred = preferDuplicate ? duplicateValue : survivorValue;
        const fallback = preferDuplicate ? survivorValue : duplicateValue;
        chosen = preferred ?? fallback;
      }

      out[field] = {
        chosen,
        survivor: survivorValue,
        duplicate: duplicateValue,
        conflicted:
          survivorValue !== null && duplicateValue !== null && survivorValue !== duplicateValue,
      };
    }
    return out;
  }
}

function identityOf(client: Pick<clients, 'id' | 'name' | 'email' | 'phone'>) {
  return { id: client.id, name: client.name, email: client.email, phone: client.phone };
}

/** Most recent by last interaction, falling back to creation. */
function isMoreRecent(a: clients, b: clients): boolean {
  const at = a.last_interaction_at?.getTime() ?? a.created_at.getTime();
  const bt = b.last_interaction_at?.getTime() ?? b.created_at.getTime();
  return at > bt;
}

function normalize(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function totalMoved(counts: RelocationCounts): number {
  return Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
}
