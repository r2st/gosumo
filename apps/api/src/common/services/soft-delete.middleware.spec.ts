import { Prisma } from '@prisma/client';

import {
  SOFT_DELETE_READ_ACTIONS,
  applySoftDeleteScope,
  createSoftDeleteMiddleware,
  includeSoftDeleted,
  listRelationsByModel,
  mentionsSoftDeleteField,
  softDeletableModels,
} from './soft-delete.middleware';

/**
 * The global soft-delete scope.
 *
 * Every rule lives in `applySoftDeleteScope`, so most of this drives that
 * directly. The last block is the one that matters operationally: it runs a
 * real middleware over a fake store and asserts that a soft-deleted row cannot
 * reach the caller — the thing a repository would map into a DTO and serve.
 */
describe('soft-delete middleware', () => {
  const softModels = softDeletableModels();
  const relations = listRelationsByModel();

  const scope = (params: { model?: string; action: string; args?: unknown }) => {
    applySoftDeleteScope(params, softModels, relations);
    return params.args as Record<string, unknown> | undefined;
  };

  describe('the model list', () => {
    it('comes from the generated datamodel, not a hand-kept list', () => {
      // If this ever drifts, it drifts because a migration added or removed the
      // column — which is exactly the case a literal list would get wrong.
      const fromDmmf = Prisma.dmmf.datamodel.models
        .filter((model) => model.fields.some((f) => f.name === 'deleted_at'))
        .map((model) => model.name);

      expect([...softModels].sort()).toEqual([...fromDmmf].sort());
    });

    it('covers the tenant-facing tables an API response is built from', () => {
      for (const model of ['clients', 'conversations', 'businesses', 'orders', 'realty_leads']) {
        expect(softModels.has(model)).toBe(true);
      }
    });

    it('excludes the append-only tables, which have no such column', () => {
      for (const model of ['messages', 'audit_logs', 'webhook_events']) {
        expect(softModels.has(model)).toBe(false);
      }
    });
  });

  describe('scoping reads', () => {
    it.each([...SOFT_DELETE_READ_ACTIONS])('scopes %s', (action) => {
      const args = scope({ model: 'clients', action, args: { where: { business_id: 'b1' } } });
      expect(args?.['where']).toEqual({ business_id: 'b1', deleted_at: null });
    });

    it('materialises a where for a findMany called with no arguments at all', () => {
      const args = scope({ model: 'clients', action: 'findMany' });
      expect(args?.['where']).toEqual({ deleted_at: null });
    });

    it('scopes findUnique, so getById cannot serve a deleted row', () => {
      const args = scope({ model: 'orders', action: 'findUnique', args: { where: { id: 'o1' } } });
      expect(args?.['where']).toEqual({ id: 'o1', deleted_at: null });
    });

    it('leaves the rest of the query untouched', () => {
      const args = scope({
        model: 'conversations',
        action: 'findMany',
        args: { where: { business_id: 'b1' }, orderBy: { updated_at: 'desc' }, take: 20 },
      });
      expect(args?.['orderBy']).toEqual({ updated_at: 'desc' });
      expect(args?.['take']).toBe(20);
    });
  });

  describe('what it does not touch', () => {
    it('leaves writes alone, so the soft delete itself still lands', () => {
      // `update` setting deleted_at is how a row is retired. A scope here would
      // be harmless once and fatal on the restore that follows.
      const args = scope({
        model: 'clients',
        action: 'update',
        args: { where: { id: 'c1' }, data: { deleted_at: new Date() } },
      });
      expect(args?.['where']).toEqual({ id: 'c1' });
    });

    it('leaves a restore alone', () => {
      const args = scope({
        model: 'clients',
        action: 'update',
        args: { where: { id: 'c1' }, data: { deleted_at: null } },
      });
      expect(args?.['where']).toEqual({ id: 'c1' });
    });

    it('leaves the retention sweep alone — it hard-deletes *because* rows are deleted', () => {
      const cutoff = new Date('2026-01-01');
      const args = scope({
        model: 'clients',
        action: 'deleteMany',
        args: { where: { deleted_at: { lt: cutoff } } },
      });
      expect(args?.['where']).toEqual({ deleted_at: { lt: cutoff } });
    });

    it('leaves models with no deleted_at column alone', () => {
      const args = scope({
        model: 'messages',
        action: 'findMany',
        args: { where: { conversation_id: 'c1' } },
      });
      expect(args?.['where']).toEqual({ conversation_id: 'c1' });
    });

    it('leaves raw queries alone — there is no where to scope', () => {
      const params = { action: 'queryRaw', args: { query: 'SELECT 1' } };
      expect(applySoftDeleteScope(params, softModels, relations)).toBe(false);
      expect(params.args).toEqual({ query: 'SELECT 1' });
    });
  });

  describe('opting out', () => {
    it('stands down when the caller filters on deleted_at directly', () => {
      const args = scope({
        model: 'clients',
        action: 'findMany',
        args: { where: { business_id: 'b1', deleted_at: { not: null } } },
      });
      expect(args?.['where']).toEqual({ business_id: 'b1', deleted_at: { not: null } });
    });

    it.each(['AND', 'OR', 'NOT'])('stands down when deleted_at is inside %s', (key) => {
      const where = { business_id: 'b1', [key]: [{ deleted_at: null }] };
      const args = scope({ model: 'clients', action: 'findMany', args: { where } });
      expect(args?.['where']).toEqual(where);
    });

    it('reads both states through includeSoftDeleted', () => {
      const args = scope({
        model: 'clients',
        action: 'findMany',
        args: { where: includeSoftDeleted({ business_id: 'b1' }) },
      });
      // The key is present with an undefined value: explicit to this middleware,
      // and "no filter" to Prisma.
      expect(args?.['where']).toHaveProperty('deleted_at', undefined);
      expect(Object.keys(args?.['where'] as object)).toContain('deleted_at');
    });

    it('does not mistake a nested field named deleted_at on an unrelated key', () => {
      expect(mentionsSoftDeleteField({ client: { deleted_at: null } })).toBe(false);
      expect(mentionsSoftDeleteField({ AND: [{ client: { deleted_at: null } }] })).toBe(false);
    });
  });

  describe('nested relations', () => {
    it('scopes a to-many relation loaded with `true`', () => {
      const args = scope({
        model: 'businesses',
        action: 'findFirst',
        args: { where: { id: 'b1' }, include: { team_members: true } },
      });
      expect(args?.['include']).toEqual({ team_members: { where: { deleted_at: null } } });
    });

    it('merges into a relation that already has its own where', () => {
      const args = scope({
        model: 'businesses',
        action: 'findFirst',
        args: { where: { id: 'b1' }, include: { clients: { where: { phone: '+91' } } } },
      });
      expect(args?.['include']).toEqual({
        clients: { where: { phone: '+91', deleted_at: null } },
      });
    });

    it('leaves a relation the caller already scoped', () => {
      const args = scope({
        model: 'businesses',
        action: 'findFirst',
        args: { where: { id: 'b1' }, include: { clients: { where: { deleted_at: { not: null } } } } },
      });
      expect(args?.['include']).toEqual({ clients: { where: { deleted_at: { not: null } } } });
    });

    it('leaves to-one relations alone, so a required parent never becomes null', () => {
      // Nulling `client` here would crash every DTO mapper that reads
      // `conversation.client.name` — and a deleted client is still whose
      // conversation this is.
      const args = scope({
        model: 'conversations',
        action: 'findMany',
        args: { where: { business_id: 'b1' }, include: { client: true } },
      });
      expect(args?.['include']).toEqual({ client: true });
    });

    it('recurses into nested includes', () => {
      const args = scope({
        model: 'businesses',
        action: 'findFirst',
        args: { where: { id: 'b1' }, include: { clients: { include: { conversations: true } } } },
      });
      expect(args?.['include']).toEqual({
        clients: {
          where: { deleted_at: null },
          include: { conversations: { where: { deleted_at: null } } },
        },
      });
    });

    it('ignores relations to models with no deleted_at', () => {
      const args = scope({
        model: 'conversations',
        action: 'findFirst',
        args: { where: { id: 'c1' }, include: { messages: true } },
      });
      expect(args?.['include']).toEqual({ messages: true });
    });

    it('does not recurse forever on a self-referential include', () => {
      const build = (depth: number): Record<string, unknown> =>
        depth === 0 ? { where: {} } : { where: {}, include: { clients: build(depth - 1) } };

      expect(() =>
        scope({ model: 'businesses', action: 'findFirst', args: build(40) }),
      ).not.toThrow();
    });
  });

  describe('over a store, end to end', () => {
    /**
     * A stand-in for the database that honours exactly one filter: `deleted_at`.
     * That is enough to answer the question this suite exists for — would a
     * soft-deleted row reach the caller, and therefore the DTO and the response
     * body — without needing a container.
     */
    const rows = [
      { id: 'c1', name: 'Live client', deleted_at: null },
      { id: 'c2', name: 'Retired client', deleted_at: new Date('2026-02-01') },
    ];

    const store: Prisma.Middleware = async (params) => {
      const where = (params.args as { where?: Record<string, unknown> } | undefined)?.where ?? {};
      if (!('deleted_at' in where)) return rows;
      if (where['deleted_at'] === null) return rows.filter((r) => r.deleted_at === null);
      return rows;
    };

    const middleware = createSoftDeleteMiddleware(softModels, relations);

    it('keeps a soft-deleted row out of a list response', async () => {
      const result = (await middleware(
        { model: 'clients', action: 'findMany', args: { where: { business_id: 'b1' } } } as never,
        store as never,
      )) as typeof rows;

      expect(result.map((r) => r.id)).toEqual(['c1']);
    });

    it('keeps a soft-deleted row out of a by-id response', async () => {
      const result = (await middleware(
        { model: 'clients', action: 'findUnique', args: { where: { id: 'c2' } } } as never,
        store as never,
      )) as typeof rows;

      expect(result.find((r) => r.id === 'c2')).toBeUndefined();
    });

    it('still returns it when the caller asked for both states', async () => {
      const result = (await middleware(
        {
          model: 'clients',
          action: 'findMany',
          args: { where: includeSoftDeleted({ business_id: 'b1' }) },
        } as never,
        store as never,
      )) as typeof rows;

      expect(result.map((r) => r.id)).toEqual(['c1', 'c2']);
    });

    it('passes the result through untouched', async () => {
      const passthrough = jest.fn().mockResolvedValue('whatever the engine said');
      await expect(
        middleware({ model: 'clients', action: 'count', args: {} } as never, passthrough as never),
      ).resolves.toBe('whatever the engine said');
    });
  });
});
