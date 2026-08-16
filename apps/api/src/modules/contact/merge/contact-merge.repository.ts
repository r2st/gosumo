import { Injectable, Logger } from '@nestjs/common';
import { ContactMergeStrategy, Prisma } from '@prisma/client';
import type { clients, contact_merges } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma.service';
import {
  MAX_REVERSIBLE_ROWS_PER_TABLE,
  MERGE_RELOCATION_TABLES,
  MergeRelocationTable,
} from './contact-merge.constants';

/** Ids relocated per table, so a revert can move back exactly those rows. */
export type RelocationRecord = Partial<Record<MergeRelocationTable, string[]>>;

/** Row counts moved per table, for the operator-facing summary. */
export type RelocationCounts = Partial<Record<MergeRelocationTable, number>>;

export interface MergeExecution {
  counts: RelocationCounts;
  moved: RelocationRecord;
  /** False when some table exceeded the record cap. */
  reversible: boolean;
  /** Tables whose ids were too numerous to record. */
  unrecorded: MergeRelocationTable[];
}

export interface ExecuteMergeParams {
  businessId: string;
  survivor: clients;
  duplicate: clients;
  /** Final field values for the survivor. */
  resolved: Partial<Record<string, string | null>>;
  strategy: ContactMergeStrategy;
  fieldResolutions: Prisma.InputJsonValue;
  matchReason: string | null;
  matchScore: number | null;
  performedBy: string | null;
}

/**
 * ContactMergeRepository — the transactional core of a merge, and its undo.
 *
 * Everything a merge does happens inside one `$transaction`. That is not
 * incidental: a merge half-applied leaves conversations pointing at a
 * soft-deleted contact while orders still point at the live one, which is a
 * state no screen in the product knows how to render and no sweep repairs.
 */
@Injectable()
export class ContactMergeRepository {
  private readonly logger = new Logger(ContactMergeRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async findClient(businessId: string, id: string): Promise<clients | null> {
    return this.prisma.clients.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  /** Contacts to compare in a detection sweep, newest activity first. */
  async findDedupCandidates(businessId: string, limit: number): Promise<clients[]> {
    return this.prisma.clients.findMany({
      where: { business_id: businessId, deleted_at: null },
      orderBy: { last_interaction_at: 'desc' },
      take: limit,
    });
  }

  /** Channel identities for a set of contacts, grouped by contact. */
  async findExternalIds(
    businessId: string,
    clientIds: string[],
  ): Promise<Map<string, string[]>> {
    const rows = await this.prisma.channel_contacts.findMany({
      where: { business_id: businessId, client_id: { in: clientIds } },
      select: { client_id: true, external_id: true },
    });

    const byClient = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.client_id) continue;
      const list = byClient.get(row.client_id) ?? [];
      list.push(row.external_id);
      byClient.set(row.client_id, list);
    }
    return byClient;
  }

  /** Rows referencing a contact, per table. Powers the pre-merge preview. */
  async countReferences(businessId: string, clientId: string): Promise<RelocationCounts> {
    const counts: RelocationCounts = {};
    for (const table of MERGE_RELOCATION_TABLES) {
      counts[table] = await this.delegate(table).count({
        where: { business_id: businessId, client_id: clientId },
      });
    }
    return counts;
  }

  /**
   * Execute the merge.
   *
   * Ordering inside the transaction is load-bearing:
   *
   *  1. **The duplicate's unique identity fields are cleared first.** `clients`
   *     has `(business_id, phone)` and `(business_id, email)` unique, and those
   *     indexes count soft-deleted rows. Writing the duplicate's phone onto the
   *     survivor while the duplicate still holds it violates the constraint —
   *     so the merge would fail precisely in the case it exists for, where the
   *     duplicate has the identifier worth keeping.
   *  2. **Child rows are relocated**, recording ids so the move can be undone.
   *  3. **`notification_preferences` is merged with conflict handling**, not
   *     moved — see `mergePreferences`.
   *  4. The survivor is updated and the duplicate soft-deleted.
   *  5. The audit row is written last, with everything the first four steps
   *     learned.
   */
  async executeMerge(
    params: ExecuteMergeParams,
  ): Promise<{ merge: contact_merges; survivor: clients; execution: MergeExecution }> {
    const { businessId, survivor, duplicate } = params;

    return this.prisma.$transaction(async (tx) => {
      // 1. Free the duplicate's unique identifiers before anything claims them.
      //
      // Every write below carries `business_id` in its own `where` alongside the
      // id, rather than trusting that the rows were fetched through a scoped
      // read. The ids reaching here did come from scoped reads, but a merge
      // writes across fourteen tables and the predicate is the only thing that
      // stays true if a later caller ever hands this method a row it looked up
      // some other way.
      await tx.clients.update({
        where: { id: duplicate.id, business_id: businessId },
        data: { phone: null, email: null },
      });

      // 2. Relocate.
      const counts: RelocationCounts = {};
      const moved: RelocationRecord = {};
      const unrecorded: MergeRelocationTable[] = [];

      for (const table of MERGE_RELOCATION_TABLES) {
        if (table === 'notification_preferences') continue;

        const rows = await (tx as never as PrismaDelegates)[table].findMany({
          where: { business_id: businessId, client_id: duplicate.id },
          select: { id: true },
          take: MAX_REVERSIBLE_ROWS_PER_TABLE + 1,
        });

        if (rows.length === 0) {
          counts[table] = 0;
          continue;
        }

        if (rows.length > MAX_REVERSIBLE_ROWS_PER_TABLE) {
          // Too many to record. The merge still runs — refusing because a
          // customer has a long history would be the worse failure — but it is
          // recorded as irreversible rather than half-revertible.
          unrecorded.push(table);
        } else {
          moved[table] = rows.map((r) => r.id);
        }

        const result = await (tx as never as PrismaDelegates)[table].updateMany({
          where: { business_id: businessId, client_id: duplicate.id },
          data: { client_id: survivor.id },
        });
        counts[table] = result.count;
      }

      // 3. Preferences, with conflict handling.
      counts['notification_preferences'] = await this.mergePreferences(
        tx,
        businessId,
        survivor.id,
        duplicate.id,
      );

      // 4. Apply the resolved identity to the survivor and retire the duplicate.
      const updatedSurvivor = await tx.clients.update({
        where: { id: survivor.id, business_id: businessId },
        data: {
          ...params.resolved,
          // Recomputed by the scoring job. Carrying either contact's scores
          // forward would assert a number nobody computed for the merged
          // history.
          ltv_score: null,
          churn_risk: null,
          engagement_score: null,
          scores_updated_at: null,
          tags: Array.from(new Set([...survivor.tags, ...duplicate.tags])),
          total_orders: survivor.total_orders + duplicate.total_orders,
          total_spent: survivor.total_spent.add(duplicate.total_spent),
          last_interaction_at: laterOf(
            survivor.last_interaction_at,
            duplicate.last_interaction_at,
          ),
          first_seen_at: earlierOf(survivor.first_seen_at, duplicate.first_seen_at),
        },
      });

      await tx.clients.update({
        where: { id: duplicate.id, business_id: businessId },
        data: { deleted_at: new Date() },
      });

      // 5. The audit row.
      const merge = await tx.contact_merges.create({
        data: {
          business_id: businessId,
          survivor_id: survivor.id,
          duplicate_id: duplicate.id,
          strategy: params.strategy,
          field_resolutions: params.fieldResolutions,
          moved: counts as unknown as Prisma.InputJsonValue,
          snapshot: {
            duplicate: serializeClient(duplicate),
            survivorBefore: serializeClient(survivor),
            relocated: moved as unknown as Prisma.JsonObject,
            reversible: unrecorded.length === 0,
            unrecorded,
          } as unknown as Prisma.InputJsonValue,
          match_reason: params.matchReason,
          match_score: params.matchScore,
          performed_by: params.performedBy,
        },
      });

      return {
        merge,
        survivor: updatedSurvivor,
        execution: { counts, moved, reversible: unrecorded.length === 0, unrecorded },
      };
    });
  }

  /**
   * Move the duplicate's notification preferences onto the survivor.
   *
   * The only relocation that can collide: `(client_id, channel, category)` is
   * unique, so both contacts may hold a row for the same pair. Where they do,
   * **the more restrictive setting wins** — a disabled preference on either
   * record disables it on the merged one.
   *
   * That direction is not arbitrary. These rows record a person's consent, and
   * the two failure modes are not symmetric: keeping a notification switched
   * off that the customer would have accepted costs a message, while switching
   * one back on because it happened to be the survivor's row is sending
   * marketing to someone who opted out — which is the thing the DPDPA is about
   * and which no operator asked the merge to do.
   */
  private async mergePreferences(
    tx: Prisma.TransactionClient,
    businessId: string,
    survivorId: string,
    duplicateId: string,
  ): Promise<number> {
    const incoming = await tx.notification_preferences.findMany({
      where: { business_id: businessId, client_id: duplicateId },
    });
    if (incoming.length === 0) return 0;

    const existing = await tx.notification_preferences.findMany({
      where: { business_id: businessId, client_id: survivorId },
    });
    const key = (p: { channel: string; category: string | null }) =>
      `${p.channel}::${p.category ?? '*'}`;
    const bySurvivorKey = new Map(existing.map((p) => [key(p), p]));

    let moved = 0;
    for (const pref of incoming) {
      const clash = bySurvivorKey.get(key(pref));
      if (!clash) {
        await tx.notification_preferences.update({
          where: { id: pref.id, business_id: businessId },
          data: { client_id: survivorId },
        });
        moved += 1;
        continue;
      }

      if (clash.is_enabled && !pref.is_enabled) {
        await tx.notification_preferences.update({
          where: { id: clash.id, business_id: businessId },
          data: { is_enabled: false },
        });
      }
      // The duplicate's row cannot move onto an occupied key, and it describes a
      // contact that is about to be retired. Deleted rather than left pointing
      // at the retired record, where it would resurface if the merge is undone
      // and immediately collide again.
      await tx.notification_preferences.delete({
        where: { id: pref.id, business_id: businessId },
      });
    }
    return moved;
  }

  async findMerge(businessId: string, id: string): Promise<contact_merges | null> {
    return this.prisma.contact_merges.findFirst({
      where: { id, business_id: businessId },
    });
  }

  async listMerges(
    businessId: string,
    params: { limit: number; offset: number },
  ): Promise<{ data: contact_merges[]; total: number }> {
    const where = { business_id: businessId };
    const [data, total] = await Promise.all([
      this.prisma.contact_merges.findMany({
        where,
        orderBy: { performed_at: 'desc' },
        take: params.limit,
        skip: params.offset,
      }),
      this.prisma.contact_merges.count({ where }),
    ]);
    return { data, total };
  }

  /**
   * Undo a merge by moving back exactly the rows it moved.
   *
   * Restores the duplicate's identity from the snapshot, un-deletes it, moves
   * the recorded rows back, and restores the survivor's own overwritten fields.
   * The duplicate's identity is restored **before** the survivor's, for the
   * same unique-index reason the merge clears it first.
   */
  async revertMerge(
    businessId: string,
    merge: contact_merges,
    revertedBy: string | null,
  ): Promise<{ restored: RelocationCounts }> {
    const snapshot = merge.snapshot as unknown as {
      duplicate: Record<string, unknown>;
      survivorBefore: Record<string, unknown>;
      relocated: RelocationRecord;
    };

    return this.prisma.$transaction(async (tx) => {
      // Free the survivor's identifiers first — it currently holds whichever of
      // the duplicate's phone/email the merge chose.
      await tx.clients.update({
        where: { id: merge.survivor_id, business_id: businessId },
        data: { phone: null, email: null },
      });

      await tx.clients.update({
        where: { id: merge.duplicate_id, business_id: businessId },
        data: {
          deleted_at: null,
          name: asString(snapshot.duplicate['name']),
          email: asString(snapshot.duplicate['email']),
          phone: asString(snapshot.duplicate['phone']),
        },
      });

      const restored: RelocationCounts = {};
      for (const [table, ids] of Object.entries(snapshot.relocated ?? {})) {
        if (!Array.isArray(ids) || ids.length === 0) continue;
        const result = await (tx as never as PrismaDelegates)[
          table as MergeRelocationTable
        ].updateMany({
          where: { business_id: businessId, id: { in: ids }, client_id: merge.survivor_id },
          data: { client_id: merge.duplicate_id },
        });
        restored[table as MergeRelocationTable] = result.count;
      }

      await tx.clients.update({
        where: { id: merge.survivor_id, business_id: businessId },
        data: {
          name: asString(snapshot.survivorBefore['name']),
          email: asString(snapshot.survivorBefore['email']),
          phone: asString(snapshot.survivorBefore['phone']),
          ltv_score: null,
          churn_risk: null,
          engagement_score: null,
          scores_updated_at: null,
        },
      });

      await tx.contact_merges.update({
        where: { id: merge.id, business_id: businessId },
        data: { reverted_at: new Date(), reverted_by: revertedBy },
      });

      return { restored };
    });
  }

  /** Narrow a table name to its Prisma delegate. */
  private delegate(table: MergeRelocationTable) {
    return (this.prisma as never as PrismaDelegates)[table];
  }
}

/**
 * The subset of a Prisma delegate this module uses.
 *
 * The relocation loop is generic over thirteen tables whose Prisma delegates
 * have thirteen different `where` types, and TypeScript cannot express "the
 * delegate for whichever of these names" without a mapped type over the whole
 * client. This names exactly the four calls the loop makes, so the escape hatch
 * is one small declared interface rather than `any` at every call site.
 */
interface MergeDelegate {
  count(args: { where: { business_id: string; client_id: string } }): Promise<number>;
  findMany(args: {
    where: { business_id: string; client_id: string };
    select: { id: true };
    take: number;
  }): Promise<Array<{ id: string }>>;
  updateMany(args: {
    where: {
      business_id: string;
      client_id?: string;
      id?: { in: string[] };
    };
    data: { client_id: string };
  }): Promise<{ count: number }>;
}

type PrismaDelegates = Record<MergeRelocationTable, MergeDelegate>;

/** The duplicate's row as it stood, for the snapshot. */
function serializeClient(client: clients): Record<string, unknown> {
  return {
    id: client.id,
    name: client.name,
    email: client.email,
    phone: client.phone,
    avatar_url: client.avatar_url,
    consumer_user_id: client.consumer_user_id,
    tags: client.tags,
    profile: client.profile,
    opt_outs: client.opt_outs,
    total_orders: client.total_orders,
    total_spent: client.total_spent.toString(),
    first_seen_at: client.first_seen_at.toISOString(),
    last_interaction_at: client.last_interaction_at?.toISOString() ?? null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function earlierOf(a: Date, b: Date): Date {
  return a < b ? a : b;
}
