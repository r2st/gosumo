/**
 * Bounds and table inventory for contact merges.
 */

/**
 * Every table that carries a `client_id`, in the order a merge relocates them.
 *
 * Written out rather than derived from Prisma's DMMF at runtime, because a
 * table added to the schema and forgotten here should be a visible omission in
 * a reviewed list, not a silent one that leaves rows pointing at a
 * soft-deleted contact. `contact-merge.spec.ts` asserts this list against the
 * schema so adding a `client_id` column fails a test rather than shipping.
 *
 * `notification_preferences` is last on purpose: it is the only one with a
 * `client_id`-scoped unique constraint, so it needs conflict handling the
 * others do not, and doing it after the plain moves keeps that special case out
 * of the loop.
 */
export const MERGE_RELOCATION_TABLES = [
  'channel_contacts',
  'conversations',
  'orders',
  'payments',
  'invoices',
  'shipping_addresses',
  'carts',
  'bookings',
  'booking_recurrences',
  'analytics_events',
  'notifications',
  'realty_leads',
  'notification_preferences',
] as const;

export type MergeRelocationTable = (typeof MERGE_RELOCATION_TABLES)[number];

/**
 * Tables that carry a `client_id` and are deliberately **not** relocated.
 *
 * Every `client_id` column has to be classified one way or the other, and the
 * spec asserts that — an unclassified table is one whose rows silently end up
 * pointing at a retired contact.
 *
 * `data_export_jobs` records that a specific customer record was disclosed to a
 * specific person at a specific time. Reassigning it to the survivor would
 * rewrite that: the export was of the duplicate's data as it stood before the
 * merge, and re-pointing the row would claim a disclosure of the survivor that
 * never happened. It keeps pointing at the retired row, which still exists —
 * a merge soft-deletes the duplicate, it does not remove it.
 */
export const MERGE_NON_RELOCATED_TABLES = ['data_export_jobs'] as const;

/**
 * Fields on `clients` whose value the merge has to choose between.
 *
 * The score columns are deliberately absent: `ltv_score`, `churn_risk` and
 * `engagement_score` are model outputs over a history that just changed, so
 * copying either contact's is asserting a number nobody computed for the merged
 * record. They are cleared instead, and the scoring job recomputes them.
 */
export const MERGE_CONFLICT_FIELDS = [
  'name',
  'email',
  'phone',
  'avatar_url',
  'consumer_user_id',
] as const;

export type MergeConflictField = (typeof MERGE_CONFLICT_FIELDS)[number];

/**
 * Rows one table may relocate and still leave the merge reversible.
 *
 * Revert works by moving back exactly the rows the merge moved, which means
 * recording their ids. That list lives in the merge's `snapshot` JSONB, so it
 * has to stay a sane size. Past this, the merge still runs — refusing to merge
 * a customer because they have too much history would be worse — but it is
 * recorded as irreversible, and `revert` says so rather than half-restoring.
 */
export const MAX_REVERSIBLE_ROWS_PER_TABLE = 1_000;

/** Duplicate candidates returned by one detection sweep. */
export const MAX_DUPLICATE_CANDIDATES = 100;

/** Contacts one detection pass examines. Bounds the O(n²) comparison. */
export const MAX_DEDUP_SCAN_CONTACTS = 2_000;

/**
 * Score at or above which two contacts are offered as a probable duplicate.
 *
 * Detection only ever *suggests*. Nothing merges automatically at any score:
 * the false positive here is two brothers on one family phone or a shared
 * office email, and welding two real customers together is not a mistake a
 * confidence threshold should be trusted to avoid on its own.
 */
export const DUPLICATE_SUGGEST_THRESHOLD = 0.6;
