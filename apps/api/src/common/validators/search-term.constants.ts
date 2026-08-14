/**
 * Upper bound on any free-text search term accepted by a list endpoint.
 *
 * Every one of these terms ends up in a Prisma `contains` with
 * `mode: 'insensitive'`, which Postgres runs as `ILIKE '%term%'` against the
 * GIN trigram indexes migration 0034 added. That plan is fast for a search box
 * and quadratic-feeling for an abusive one: pg_trgm has to extract a trigram
 * per character of the pattern, and every candidate row is then rechecked
 * against the full pattern. A term the length of a URL — and a query string can
 * carry kilobytes of them — turns one unauthenticated-cost list call into a
 * sustained CPU burn on a database this deployment shares with another service.
 *
 * 200 characters is well past any real search a person types into an inbox
 * filter, and the conversation inbox has been capped there since its own list
 * DTO was written. This constant exists so the other search surfaces agree with
 * it rather than each picking a number, or — as they had been — picking none.
 */
export const SEARCH_TERM_MAX_LENGTH = 200;
