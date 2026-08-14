/**
 * Contract tests coupling the hot-path queries to the indexes that serve them.
 *
 * An index that goes missing breaks nothing visibly: every query still returns
 * the right rows, just by reading the whole table. That silence is the reason
 * this file exists — the regression only surfaces as a slow screen, months
 * later, on the tenant with the most data.
 *
 * Two things are asserted:
 *
 *  1. Each index the repositories depend on is declared in `schema.prisma`.
 *     Composite indexes are compared as an ordered column list, because column
 *     *order* is the whole point: an index on (business_id, status,
 *     last_message_at) does not serve a query that filters on business_id and
 *     sorts by last_message_at.
 *  2. Migration 0034 and `schema.prisma` agree, so a hand-applied database and
 *     a `prisma migrate diff` database end up with the same indexes.
 *
 * The queries themselves are asserted in each module's repository spec; what is
 * pinned here is only the index they assume.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const DATABASE_DIR = join(__dirname, '../../../../packages/database/prisma');

const schema = readFileSync(join(DATABASE_DIR, 'schema.prisma'), 'utf8');
const migration0034 = readFileSync(
  join(DATABASE_DIR, 'migrations/0034_add_search_and_inbox_indexes.sql'),
  'utf8',
);

/**
 * The `@@index([...])` declarations inside one model block, each normalized to
 * an ordered list of column names with modifiers (`(sort: Desc)`, `(ops: ...)`)
 * stripped.
 */
function indexesFor(model: string): string[][] {
  const block = new RegExp(`\\nmodel ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!block) throw new Error(`model ${model} not found in schema.prisma`);

  return [...block[1]!.matchAll(/@@index\(\[([^\]]+)\]/g)].map((m) =>
    m[1]!.split(',').map((col) => col.trim().replace(/\(.*$/, '')),
  );
}

function hasIndex(model: string, columns: string[]): boolean {
  return indexesFor(model).some(
    (idx) => idx.length === columns.length && idx.every((c, i) => c === columns[i]),
  );
}

describe('hot-path index contract', () => {
  describe('conversations', () => {
    it('can sort the default inbox without a status filter', () => {
      // ConversationRepository.list() orders by last_message_at and only
      // filters status when the caller supplies one — which the inbox's
      // default "All" view does not.
      expect(hasIndex('conversations', ['business_id', 'last_message_at'])).toBe(true);
    });

    it('keeps the status-filtered inbox index too', () => {
      expect(hasIndex('conversations', ['business_id', 'status', 'last_message_at'])).toBe(true);
    });

    it('can seek the snooze-wake sweep by due time', () => {
      // findSnoozedDue filters status + snoozed_until and orders by
      // snoozed_until; the status index alone stops one column short.
      expect(hasIndex('conversations', ['business_id', 'status', 'snoozed_until'])).toBe(true);
    });

    it('resolves the active conversation for an inbound message', () => {
      // findActiveByClientAndChannel runs once per inbound message.
      expect(hasIndex('conversations', ['business_id', 'client_id'])).toBe(true);
    });

    it('indexes both columns the list search ORs over', () => {
      expect(hasIndex('conversations', ['subject'])).toBe(true);
      expect(hasIndex('conversations', ['current_topic'])).toBe(true);
    });
  });

  describe('messages', () => {
    it('pages the conversation view by (conversation_id, created_at)', () => {
      expect(hasIndex('messages', ['conversation_id', 'created_at'])).toBe(true);
    });

    it('dedupes inbound retries by external_id', () => {
      expect(hasIndex('messages', ['external_id'])).toBe(true);
    });

    it('indexes the searched text column', () => {
      expect(hasIndex('messages', ['text_content'])).toBe(true);
    });
  });

  describe('clients', () => {
    it('sorts the contact list by last interaction', () => {
      expect(hasIndex('clients', ['business_id', 'last_interaction_at'])).toBe(true);
    });

    it('indexes all three columns the contact search ORs over', () => {
      // Missing any one of these puts the whole OR back on a table scan —
      // Postgres cannot BitmapOr a partially indexed disjunction.
      expect(hasIndex('clients', ['name'])).toBe(true);
      expect(hasIndex('clients', ['email'])).toBe(true);
      expect(hasIndex('clients', ['phone'])).toBe(true);
    });
  });

  describe('realty_leads', () => {
    it('windows the intelligence aggregation by first_touch_at', () => {
      expect(hasIndex('realty_leads', ['business_id', 'first_touch_at'])).toBe(true);
    });
  });

  describe('search indexes use trigram ops', () => {
    // A plain btree on these columns would be built, maintained, and never
    // used: `ILIKE '%term%'` is unanchored, so only a trigram GIN can serve it.
    it.each([
      ['messages', 'text_content'],
      ['conversations', 'subject'],
      ['conversations', 'current_topic'],
      ['clients', 'name'],
      ['clients', 'email'],
      ['clients', 'phone'],
    ])('%s.%s is a GIN trigram index', (model, column) => {
      const block = new RegExp(`\\nmodel ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema)![1]!;
      const decl = new RegExp(
        `@@index\\(\\[${column}\\(ops: raw\\("gin_trgm_ops"\\)\\)\\], type: Gin\\)`,
      );
      expect(decl.test(block)).toBe(true);
    });

    it('declares the pg_trgm extension the GIN ops class needs', () => {
      expect(schema).toMatch(/extensions\s*=\s*\[[^\]]*pgTrgm\(map: "pg_trgm"\)/);
      expect(migration0034).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_trgm/);
    });
  });

  describe('migration 0034 matches schema.prisma', () => {
    // Index names are what tie the two together: the migration deliberately
    // reuses the names `prisma migrate diff` generates, so a hand-applied
    // database and a diff-applied one converge.
    it.each([
      'conversations_business_id_last_message_at_idx',
      'conversations_business_id_status_snoozed_until_idx',
      'messages_text_content_idx',
      'conversations_subject_idx',
      'conversations_current_topic_idx',
      'clients_name_idx',
      'clients_email_idx',
      'clients_phone_idx',
    ])('creates %s', (name) => {
      expect(migration0034).toContain(`CREATE INDEX IF NOT EXISTS "${name}"`);
    });

    it('spells the threading index with the operator Prisma emits', () => {
      // `metadata ->> 'reply_to_message_id'` indexes the same value but is a
      // different expression, so the planner would not match it to the query
      // and the sequential scan would stay in place, silently.
      expect(migration0034).toContain("(metadata #>> '{reply_to_message_id}')");
      expect(migration0034).not.toMatch(/metadata ->> 'reply_to_message_id'\)\)\s*$/m);
    });

    it('is written to be re-runnable', () => {
      const unguarded = migration0034.match(/^CREATE INDEX(?! IF NOT EXISTS)/gm) ?? [];
      expect(unguarded).toHaveLength(0);
      expect(migration0034.match(/^CREATE INDEX IF NOT EXISTS/gm)).toHaveLength(9);
    });
  });
});
