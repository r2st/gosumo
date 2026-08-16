/**
 * Constants for the audit-log read API.
 *
 * The write side lives in `common/services/audit-log.service.ts` and is
 * deliberately not touched here: `audit_logs` is append-only, enforced in the
 * database by `audit_logs_no_update` / `audit_logs_no_delete`, so this module
 * exposes reads and nothing else. There is no update endpoint to add later.
 */

/** Actor types the writer records, and the only values worth filtering on. */
export const AUDIT_ACTOR_TYPES = ['TEAM_MEMBER', 'AI', 'SYSTEM', 'API'] as const;

export type AuditActorTypeFilter = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * Default window when the caller names neither end.
 *
 * The table is append-only and never pruned by this module, so an unbounded
 * default would make the first page of a long-lived tenant an unindexed scan
 * over its entire history. 30 days matches what the dashboard opens on.
 */
export const DEFAULT_AUDIT_WINDOW_DAYS = 30;

/** Longest window a single query may span, in days. */
export const MAX_AUDIT_WINDOW_DAYS = 366;

/** Page size when the caller does not ask for one. */
export const DEFAULT_AUDIT_PAGE_SIZE = 50;

/**
 * Longest free-text `resourceType` filter accepted.
 *
 * Mirrors the column width. The value is compared for equality rather than
 * matched, so this is a validation bound and not a scan bound.
 */
export const MAX_RESOURCE_TYPE_LENGTH = 100;

/**
 * Cap on the rows one export walk may return.
 *
 * `listAll` exists for "give me the whole window" callers (a compliance
 * export). It is bounded rather than streaming because everything downstream
 * of it buffers, and an unbounded read of an append-only table is the one query
 * here that can outgrow memory.
 */
export const MAX_AUDIT_EXPORT_ROWS = 10_000;
