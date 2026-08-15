/**
 * The global `deleted_at IS NULL` scope.
 *
 * CLAUDE.md rule #5 is "soft delete only": business data is retired by stamping
 * `deleted_at`, never by `DELETE`. That rule is only half a rule, though — a
 * row that is still in the table is still returned by every query that does not
 * say otherwise, so "soft delete" without a matching read-side scope is not a
 * delete at all. It is a flag nobody checks.
 *
 * And nobody checked it consistently. Auditing every read against the 43
 * soft-deletable models turned up 34 that had no `deleted_at` in their filter:
 * a soft-deleted business still authenticated (`auth.repository`), a deleted
 * client still resolved into the AI context loader, deleted conversations were
 * still counted in analytics, a deleted lead still matched an inbound message.
 * None of those are exotic paths; they are the hot ones. The pattern is the
 * problem, not the individual misses — the filter is invisible by omission, so
 * every new query starts out wrong and only becomes right if the author happens
 * to remember.
 *
 * This inverts that default. Reads are scoped unless the caller opts out, so
 * forgetting now produces the *safe* behaviour, and including deleted rows is a
 * thing you have to write down.
 *
 * ## Middleware, not a client extension
 *
 * `$extends` returns a *new* client object rather than mutating the one it was
 * called on, and `PrismaService extends PrismaClient` is injected as a class
 * into some fifty modules that call `this.prisma.<model>`. Adopting an
 * extension means either re-providing the extended client under a different
 * token and rewriting every injection site, or keeping a second unextended
 * client alive next to it — a second connection pool, against a Postgres this
 * box shares with another service. `$use` mutates in place, so every existing
 * injection keeps working and the scope cannot be bypassed by reaching for the
 * "raw" client, because there isn't one.
 *
 * ## What is scoped
 *
 * Reads only: `findUnique`, `findFirst`, `findMany`, their `OrThrow` variants,
 * `count`, `aggregate`, `groupBy`. Writes are deliberately untouched — the
 * soft delete itself is an `update`, a restore is an `update` on a row this
 * scope would hide, and the DPDPA retention sweep hard-deletes rows *because*
 * they are soft-deleted. Scoping writes would break all three.
 *
 * Non-unique fields in a `findUnique` where are valid from Prisma 5.0
 * (`extendedWhereUnique`, GA in the version this repo pins), which is what lets
 * the scope apply there without rewriting the action to `findFirst`.
 *
 * ## Opting out
 *
 * Mention `deleted_at` anywhere in the `where` — at the top level or inside an
 * `AND`/`OR`/`NOT` — and this leaves the query completely alone. That covers
 * both directions: `deleted_at: { not: null }` (the trash view) and
 * `deleted_at: { lt: cutoff }` (the retention sweep) already read as explicit,
 * so no existing caller changes behaviour. To read *both* states, use
 * {@link includeSoftDeleted}.
 *
 * ## Nested relations
 *
 * A relation loaded through `include`/`select` is its own read that never
 * reaches a middleware of its own, so the top-level scope does not cover it.
 * List relations are therefore scoped too, recursively. **To-one relations are
 * not**: filtering `include: { client: true }` would return `client: null` for
 * a conversation whose client was deleted, and every DTO mapper that reads
 * `conversation.client.name` would throw on a page that used to render. A
 * deleted parent still being nameable on the row that references it is also the
 * defensible answer — the conversation genuinely belongs to that person. A
 * shorter list is not a lie; a null required parent is a crash.
 */

import { Prisma } from '@prisma/client';

/** The column that marks a row retired. */
export const SOFT_DELETE_FIELD = 'deleted_at';

/**
 * Read actions the scope applies to.
 *
 * `findUnique`/`findUniqueOrThrow` are included: a caller that has an id has
 * not thereby been told the row is live, and `getById` returning a deleted row
 * is the single most common way one reaches an API response.
 */
export const SOFT_DELETE_READ_ACTIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Where-keys whose values are themselves where-clauses. */
const COMPOSITE_KEYS = ['AND', 'OR', 'NOT'] as const;

/**
 * Every model carrying a `deleted_at` column, read from the generated client's
 * datamodel rather than from a hand-kept list.
 *
 * A list in this file would be correct exactly until the next migration, and
 * its rotting is silent: a new soft-deletable model would simply never be
 * scoped, which looks identical to a model that has no such column. Reading the
 * DMMF means adding `deleted_at` to a model is all it takes.
 */
export function softDeletableModels(): Set<string> {
  const models = new Set<string>();
  for (const model of Prisma.dmmf.datamodel.models) {
    if (model.fields.some((field) => field.name === SOFT_DELETE_FIELD)) {
      models.add(model.name);
    }
  }
  return models;
}

/** Relation name → target model, for every to-many relation on a model. */
type ListRelationMap = ReadonlyMap<string, string>;

/**
 * Per-model map of list relations, built once.
 *
 * Only `isList` object fields are recorded — see the class doc for why to-one
 * relations are left unscoped.
 */
export function listRelationsByModel(): Map<string, ListRelationMap> {
  const byModel = new Map<string, ListRelationMap>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const relations = new Map<string, string>();
    for (const field of model.fields) {
      if (field.kind === 'object' && field.isList) {
        relations.set(field.name, field.type);
      }
    }
    byModel.set(model.name, relations);
  }
  return byModel;
}

/**
 * True when the caller has already said something about `deleted_at`.
 *
 * Walks `AND`/`OR`/`NOT` because that is where a filter built up in pieces ends
 * up: `{ AND: [{ business_id }, { deleted_at: null }] }` is as explicit as the
 * flat form and must be left alone just the same. Key *presence* is the test,
 * not the value — `{ deleted_at: undefined }` is how {@link includeSoftDeleted}
 * says "both states", and Prisma reads an undefined filter as no filter.
 */
export function mentionsSoftDeleteField(where: unknown): boolean {
  if (where === null || typeof where !== 'object') return false;

  if (Array.isArray(where)) {
    return where.some((branch) => mentionsSoftDeleteField(branch));
  }

  const record = where as Record<string, unknown>;
  if (SOFT_DELETE_FIELD in record) return true;

  return COMPOSITE_KEYS.some(
    (key) => key in record && mentionsSoftDeleteField(record[key]),
  );
}

/**
 * Add `deleted_at: undefined` so the scope stands down for this query.
 *
 * The explicit escape hatch, for the handful of callers that genuinely want
 * both states — an admin "all records including deleted" view, a reconciliation
 * job counting what a sweep will touch. Named rather than expecting callers to
 * remember the sentinel, so the intent is greppable and the reason can be put
 * in a comment next to it.
 */
export function includeSoftDeleted<T extends object>(
  where: T,
): T & { deleted_at: undefined } {
  return { ...where, [SOFT_DELETE_FIELD]: undefined } as T & { deleted_at: undefined };
}

/**
 * Scope a relation subtree, in place.
 *
 * `include`/`select` values are `true`, or an object that may carry its own
 * `where`, `include` and `select`. A `true` is rewritten to
 * `{ where: { deleted_at: null } }` — which is the same query, minus the
 * deleted rows.
 */
function scopeRelations(
  node: unknown,
  model: string,
  relations: Map<string, ListRelationMap>,
  softModels: Set<string>,
  depth: number,
): void {
  // Bounded because `include` trees are caller-supplied and self-referential
  // models (a lead's related leads) can describe a cycle. Ten is far past any
  // include this app writes and far short of a stack that matters.
  if (depth > 10 || node === null || typeof node !== 'object') return;

  const container = node as Record<string, unknown>;
  const modelRelations = relations.get(model);
  if (!modelRelations) return;

  for (const key of ['include', 'select'] as const) {
    const branch = container[key];
    if (branch === null || typeof branch !== 'object') continue;

    const entries = branch as Record<string, unknown>;
    for (const [relationName, value] of Object.entries(entries)) {
      const target = modelRelations.get(relationName);
      if (!target) continue;

      if (softModels.has(target)) {
        if (value === true) {
          entries[relationName] = { where: { [SOFT_DELETE_FIELD]: null } };
          continue;
        }
        if (value !== null && typeof value === 'object') {
          const nested = value as Record<string, unknown>;
          if (!mentionsSoftDeleteField(nested['where'])) {
            nested['where'] = {
              ...((nested['where'] as Record<string, unknown>) ?? {}),
              [SOFT_DELETE_FIELD]: null,
            };
          }
        }
      }

      if (value !== null && typeof value === 'object') {
        scopeRelations(value, target, relations, softModels, depth + 1);
      }
    }
  }
}

/**
 * Apply the scope to one query's arguments, in place.
 *
 * Exported so the whole decision is testable without a database or a client:
 * this is where every rule above actually lives, and the middleware below is a
 * three-line adapter onto it.
 *
 * Returns whether anything was changed, which is only used by tests.
 */
export function applySoftDeleteScope(
  params: { model?: string; action: string; args?: unknown },
  softModels: Set<string>,
  relations: Map<string, ListRelationMap>,
): boolean {
  const model = params.model;
  // `$queryRaw` and friends arrive with no model. They are raw SQL by
  // definition — there is no `where` to scope and no honest way to invent one.
  if (!model || !SOFT_DELETE_READ_ACTIONS.has(params.action)) return false;

  const scopedModel = softModels.has(model);
  if (!scopedModel && !relations.get(model)?.size) return false;

  // `findMany()` with no arguments at all is legal and is the query most likely
  // to return everything, so it is materialised rather than skipped.
  const args = (params.args ?? {}) as Record<string, unknown>;
  params.args = args;

  let changed = false;

  if (scopedModel && !mentionsSoftDeleteField(args['where'])) {
    args['where'] = {
      ...((args['where'] as Record<string, unknown>) ?? {}),
      [SOFT_DELETE_FIELD]: null,
    };
    changed = true;
  }

  scopeRelations(args, model, relations, softModels, 0);

  return changed;
}

/**
 * The middleware, ready for `prisma.$use()`.
 *
 * The model and relation maps are resolved once at construction: they are
 * derived from the generated client, which cannot change while the process is
 * running, and re-deriving them per query would put a 74-model scan on the hot
 * path.
 */
export function createSoftDeleteMiddleware(
  softModels: Set<string> = softDeletableModels(),
  relations: Map<string, ListRelationMap> = listRelationsByModel(),
): Prisma.Middleware {
  return async (params, next) => {
    applySoftDeleteScope(params, softModels, relations);
    return next(params);
  };
}
