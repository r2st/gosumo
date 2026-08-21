/**
 * KnowledgeController route wiring.
 *
 * The controller holds no logic, so what is asserted here is the wiring that
 * silently misbehaves rather than throwing:
 *
 *  - **Route order.** `slug/:slug` must be declared before `:id`. Nest matches
 *    in declaration order, so with them the other way round
 *    `/knowledge/slug/refund-policy` is captured by the UUID route and the
 *    caller gets a 400 about a malformed UUID for a perfectly good URL. The
 *    same applies to the literal `search` and `stats` paths.
 *  - **Tenant threading.** Every handler must pass the resolved tenant, not
 *    read one from the body.
 *  - **Write authorisation.** Creating, editing and deleting articles changes
 *    what the AI tells customers, so those routes carry a role requirement
 *    while the read routes do not.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { TeamMemberRole } from '@gosumo/database';
import { IntentType } from '@gosumo/shared';

import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';

const BIZ = '00000000-0000-4000-a000-000000000001';
const ID = '00000000-0000-4000-b000-000000000001';
const USER = '00000000-0000-4000-c000-000000000001';

describe('KnowledgeController', () => {
  let controller: KnowledgeController;
  let service: Record<string, jest.Mock>;

  beforeEach(async () => {
    service = {
      create: jest.fn().mockResolvedValue({ id: ID }),
      list: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20, totalPages: 1 }),
      search: jest.fn().mockResolvedValue([]),
      stats: jest.fn().mockResolvedValue({}),
      get: jest.fn().mockResolvedValue({ id: ID }),
      getBySlug: jest.fn().mockResolvedValue({ id: ID }),
      update: jest.fn().mockResolvedValue({ id: ID }),
      publish: jest.fn().mockResolvedValue({ id: ID }),
      archive: jest.fn().mockResolvedValue({ id: ID }),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      controllers: [KnowledgeController],
      providers: [{ provide: KnowledgeService, useValue: service }],
    }).compile();

    controller = module.get(KnowledgeController);
  });

  // ─────────────────────────────────────────────
  // Route declaration order
  // ─────────────────────────────────────────────

  describe('route order', () => {
    /** GET routes in declaration order, as Nest will try them. */
    const getPaths = (): string[] =>
      Object.getOwnPropertyNames(KnowledgeController.prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => {
          const handler = Object.getOwnPropertyDescriptor(
            KnowledgeController.prototype,
            name,
          )?.value as unknown;
          return {
            path: Reflect.getMetadata(PATH_METADATA, handler as object) as string | undefined,
            method: Reflect.getMetadata(METHOD_METADATA, handler as object) as
              | RequestMethod
              | undefined,
          };
        })
        .filter((r) => r.method === RequestMethod.GET && r.path !== undefined)
        .map((r) => r.path as string);

    it.each(['search', 'stats', 'slug/:slug'])(
      'declares the literal route %s before the :id catch-all',
      (literal) => {
        const paths = getPaths();

        expect(paths).toContain(literal);
        expect(paths).toContain(':id');
        expect(paths.indexOf(literal)).toBeLessThan(paths.indexOf(':id'));
      },
    );
  });

  // ─────────────────────────────────────────────
  // Authorisation
  // ─────────────────────────────────────────────

  describe('authorisation', () => {
    const rolesOn = (method: string): unknown =>
      Reflect.getMetadata(
        ROLES_KEY,
        Object.getOwnPropertyDescriptor(KnowledgeController.prototype, method)?.value as object,
      );

    it.each(['create', 'update', 'publish', 'archive', 'remove'])(
      'requires a manager to %s an article',
      (method) => {
        // These routes change what the AI quotes to customers.
        expect(rolesOn(method)).toEqual(expect.arrayContaining([TeamMemberRole.MANAGER]));
      },
    );

    it.each(['list', 'get', 'getBySlug', 'search', 'stats'])(
      'leaves %s open to any authenticated team member',
      (method) => {
        expect(rolesOn(method)).toBeUndefined();
      },
    );
  });

  // ─────────────────────────────────────────────
  // Delegation
  // ─────────────────────────────────────────────

  describe('delegation', () => {
    it('threads the resolved tenant and user into a create', async () => {
      await controller.create(BIZ, USER, { title: 'T', body: 'b' });

      expect(service.create).toHaveBeenCalledWith(BIZ, { title: 'T', body: 'b' }, USER);
    });

    it('passes list filters through untouched', async () => {
      await controller.list(BIZ, { search: 'refund', page: 2 });

      expect(service.list).toHaveBeenCalledWith(BIZ, { search: 'refund', page: 2 });
    });

    it('passes the search query through, intent included', async () => {
      await controller.search(BIZ, { q: 'refund', intent: IntentType.GENERAL_INQUIRY });

      expect(service.search).toHaveBeenCalledWith(BIZ, {
        q: 'refund',
        intent: IntentType.GENERAL_INQUIRY,
      });
    });

    it('resolves an article by slug without touching the id route', async () => {
      await controller.getBySlug(BIZ, 'refund-policy');

      expect(service.getBySlug).toHaveBeenCalledWith(BIZ, 'refund-policy');
      expect(service.get).not.toHaveBeenCalled();
    });

    it('threads the acting user into publish and archive', async () => {
      await controller.publish(BIZ, USER, ID);
      await controller.archive(BIZ, USER, ID);

      expect(service.publish).toHaveBeenCalledWith(BIZ, ID, USER);
      expect(service.archive).toHaveBeenCalledWith(BIZ, ID, USER);
    });

    it('returns nothing from a delete, so the 204 has no body', async () => {
      await expect(controller.remove(BIZ, ID)).resolves.toBeUndefined();
      expect(service.remove).toHaveBeenCalledWith(BIZ, ID);
    });
  });
});
