/**
 * Bounds every paginated list endpoint agrees on.
 *
 * `limit` was already capped at 100 almost everywhere, by each DTO writing
 * `@Max(100)` out longhand. These constants exist so the few that were written
 * without a cap, and everything added later, have one obvious thing to reach
 * for.
 *
 * The page bound is the one that was missing everywhere. `page` carried
 * `@Min(1)` and nothing above it, and repositories turn it into
 * `skip: (page - 1) * limit`. Postgres is content with an enormous OFFSET — it
 * simply runs out of rows — so this is not the scan risk the search-term cap
 * addressed. What it is, is an unhandled 500: past roughly 1e20 the computed
 * skip stops being an integer Prisma will accept, and
 * `PrismaClientValidationError` is not a `PrismaClientKnownRequestError`, so
 * the global filter has no mapping for it and returns a generic 500. A caller
 * typo becomes a server fault in the logs.
 *
 * 100,000 pages is ten million rows deep at the maximum page size — far past
 * any list a person is scrolling, and past any export loop that should be using
 * a keyset walk instead (see `listLeadsForAggregation`). It exists to turn an
 * absurd value into a 400 that names the field, not to constrain real paging.
 */

/** Largest `limit` any list endpoint accepts. */
export const MAX_PAGE_SIZE = 100;

/** Largest `page` any list endpoint accepts. */
export const MAX_PAGE_NUMBER = 100_000;

/**
 * Largest `offset` any list endpoint accepts.
 *
 * A few endpoints page by raw row offset rather than page number. The bound is
 * the same depth `page` allows at the maximum page size, so the two styles of
 * pagination cannot be walked to different depths, and it fails for the same
 * reason: a large enough `skip` stops being an integer Prisma accepts and the
 * caller's typo surfaces as a 500 rather than a 400 naming the field.
 */
export const MAX_ROW_OFFSET = MAX_PAGE_NUMBER * MAX_PAGE_SIZE;
