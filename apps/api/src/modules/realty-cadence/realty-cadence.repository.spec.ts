/**
 * RealtyCadenceRepository unit tests.
 *
 * Focused on the batched readers and the batched step insert that replaced the
 * per-row loops in the service. Those loops were correct but issued one query
 * per step or per cadence; the batched forms have to hold two properties the
 * loops got for free — every query stays scoped to the tenant and excludes
 * soft-deleted rows, and the grouping returns each row under the right parent.
 *
 * PrismaService is mocked; the assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';

import { RealtyCadenceRepository } from './realty-cadence.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CADENCE_A = '00000000-0000-4000-b000-00000000000a';
const CADENCE_B = '00000000-0000-4000-b000-00000000000b';
const TEMPLATE_A = '00000000-0000-4000-c000-00000000000a';
const TEMPLATE_B = '00000000-0000-4000-c000-00000000000b';

function step(overrides: Record<string, unknown> = {}) {
  return {
    id: 'step-1',
    business_id: BUSINESS_ID,
    cadence_id: CADENCE_A,
    template_id: TEMPLATE_A,
    step_order: 0,
    day_offset: 1,
    condition: {},
    stop_on: [],
    deleted_at: null,
    template: { id: TEMPLATE_A },
    ...overrides,
  };
}

describe('RealtyCadenceRepository', () => {
  let repository: RealtyCadenceRepository;
  let prisma: {
    realty_message_templates: { findMany: jest.Mock };
    realty_cadence_steps: { findMany: jest.Mock; createMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      realty_message_templates: { findMany: jest.fn().mockResolvedValue([]) },
      realty_cadence_steps: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyCadenceRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(RealtyCadenceRepository);
  });

  // ── findTemplatesByIds ─────────────────────────

  describe('findTemplatesByIds', () => {
    it('issues no query for an empty id list', async () => {
      expect(await repository.findTemplatesByIds(BUSINESS_ID, [])).toEqual([]);
      expect(prisma.realty_message_templates.findMany).not.toHaveBeenCalled();
    });

    it('scopes to the tenant, skips soft-deleted rows, and dedupes ids', async () => {
      await repository.findTemplatesByIds(BUSINESS_ID, [TEMPLATE_A, TEMPLATE_B, TEMPLATE_A]);

      expect(prisma.realty_message_templates.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: [TEMPLATE_A, TEMPLATE_B] },
          business_id: BUSINESS_ID,
          deleted_at: null,
        },
      });
    });
  });

  // ── findTemplatesByNames ───────────────────────

  describe('findTemplatesByNames', () => {
    it('issues no query for an empty name list', async () => {
      expect(await repository.findTemplatesByNames(BUSINESS_ID, [])).toEqual([]);
      expect(prisma.realty_message_templates.findMany).not.toHaveBeenCalled();
    });

    it('scopes to the tenant and dedupes names', async () => {
      await repository.findTemplatesByNames(BUSINESS_ID, ['a', 'b', 'a']);

      expect(prisma.realty_message_templates.findMany).toHaveBeenCalledWith({
        where: { name: { in: ['a', 'b'] }, business_id: BUSINESS_ID, deleted_at: null },
      });
    });
  });

  // ── listStepsByCadences ────────────────────────

  describe('listStepsByCadences', () => {
    it('returns an empty map without querying when given no cadences', async () => {
      const result = await repository.listStepsByCadences(BUSINESS_ID, []);

      expect(result.size).toBe(0);
      expect(prisma.realty_cadence_steps.findMany).not.toHaveBeenCalled();
    });

    it('fetches every cadence\'s steps in one tenant-scoped query', async () => {
      await repository.listStepsByCadences(BUSINESS_ID, [CADENCE_A, CADENCE_B]);

      expect(prisma.realty_cadence_steps.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.realty_cadence_steps.findMany).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          cadence_id: { in: [CADENCE_A, CADENCE_B] },
          deleted_at: null,
        },
        orderBy: [{ cadence_id: 'asc' }, { step_order: 'asc' }],
        include: { template: true },
      });
    });

    it('groups each step under its own cadence, preserving step order', async () => {
      prisma.realty_cadence_steps.findMany.mockResolvedValue([
        step({ id: 's1', cadence_id: CADENCE_A, step_order: 0 }),
        step({ id: 's2', cadence_id: CADENCE_A, step_order: 1 }),
        step({ id: 's3', cadence_id: CADENCE_B, step_order: 0 }),
      ]);

      const result = await repository.listStepsByCadences(BUSINESS_ID, [CADENCE_A, CADENCE_B]);

      expect(result.get(CADENCE_A)!.map((s) => s.id)).toEqual(['s1', 's2']);
      expect(result.get(CADENCE_B)!.map((s) => s.id)).toEqual(['s3']);
    });

    it('omits a cadence that has no steps rather than mapping it to undefined', async () => {
      prisma.realty_cadence_steps.findMany.mockResolvedValue([
        step({ cadence_id: CADENCE_A }),
      ]);

      const result = await repository.listStepsByCadences(BUSINESS_ID, [CADENCE_A, CADENCE_B]);

      expect(result.has(CADENCE_B)).toBe(false);
      expect(result.get(CADENCE_B)).toBeUndefined();
    });
  });

  // ── createSteps ────────────────────────────────

  describe('createSteps', () => {
    it('writes nothing for an empty step list', async () => {
      await repository.createSteps([]);

      expect(prisma.realty_cadence_steps.createMany).not.toHaveBeenCalled();
    });

    it('inserts the whole list in one statement', async () => {
      await repository.createSteps([
        {
          businessId: BUSINESS_ID,
          cadenceId: CADENCE_A,
          templateId: TEMPLATE_A,
          stepOrder: 0,
          dayOffset: 1,
          stopOn: [],
        },
        {
          businessId: BUSINESS_ID,
          cadenceId: CADENCE_A,
          templateId: TEMPLATE_B,
          stepOrder: 1,
          dayOffset: 3,
          stopOn: [],
        },
      ]);

      expect(prisma.realty_cadence_steps.createMany).toHaveBeenCalledTimes(1);
      const { data } = prisma.realty_cadence_steps.createMany.mock.calls[0][0];
      expect(data).toHaveLength(2);
      expect(data[0]).toMatchObject({
        business_id: BUSINESS_ID,
        cadence_id: CADENCE_A,
        template_id: TEMPLATE_A,
        step_order: 0,
        day_offset: 1,
      });
    });

    it('defaults an absent condition to an empty object, not undefined', async () => {
      await repository.createSteps([
        {
          businessId: BUSINESS_ID,
          cadenceId: CADENCE_A,
          templateId: TEMPLATE_A,
          stepOrder: 0,
          dayOffset: 1,
          stopOn: [],
        },
      ]);

      const { data } = prisma.realty_cadence_steps.createMany.mock.calls[0][0];
      expect(data[0].condition).toEqual({});
    });

    it('keeps an explicit condition', async () => {
      await repository.createSteps([
        {
          businessId: BUSINESS_ID,
          cadenceId: CADENCE_A,
          templateId: TEMPLATE_A,
          stepOrder: 0,
          dayOffset: 1,
          stopOn: [],
          condition: { stage: 'HOT' },
        },
      ]);

      const { data } = prisma.realty_cadence_steps.createMany.mock.calls[0][0];
      expect(data[0].condition).toEqual({ stage: 'HOT' });
    });
  });
});
