/**
 * RealtyCadenceController unit tests.
 *
 * The controller holds no business logic — it validates, delegates, and shapes
 * the response. So the property under test is narrow but the one that matters
 * for a multi-tenant API: **every handler forwards the `@TenantId()`-supplied
 * businessId, never an id taken from the body or the query.** A handler that
 * reads the tenant from the payload is forgeable by the caller.
 *
 * The two write paths that would be most damaging to get wrong — `enroll` and
 * `run` — go to the engine, not the management service, so the routing itself
 * is asserted alongside the scoping.
 *
 * Both services are mocked; the controller is exercised directly (guards and
 * pipes are Nest's concern and are covered by the contract specs).
 */

import { Test, TestingModule } from '@nestjs/testing';

import { RealtyCadenceController } from './realty-cadence.controller';
import { RealtyCadenceService } from './realty-cadence.service';
import { CadenceEngineService } from './cadence-engine.service';
import { CadenceTrigger } from '@gosumo/shared';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const TEMPLATE_ID = '00000000-0000-4000-c000-000000000001';
const CADENCE_ID = '00000000-0000-4000-b000-000000000001';
const LEAD_ID = '00000000-0000-4000-d000-000000000001';

describe('RealtyCadenceController', () => {
  let controller: RealtyCadenceController;
  let cadenceService: jest.Mocked<RealtyCadenceService>;
  let engine: jest.Mocked<CadenceEngineService>;

  beforeEach(async () => {
    const mockService: Partial<Record<keyof RealtyCadenceService, jest.Mock>> = {
      seedDefaults: jest.fn().mockResolvedValue({ templates: 12, cadences: 3 }),
      createTemplate: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
      listTemplates: jest.fn().mockResolvedValue([]),
      getTemplate: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
      updateTemplate: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
      setTemplateApproval: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
      deleteTemplate: jest.fn().mockResolvedValue(undefined),
      createCadence: jest.fn().mockResolvedValue({ id: CADENCE_ID }),
      listCadences: jest.fn().mockResolvedValue([]),
      getCadence: jest.fn().mockResolvedValue({ id: CADENCE_ID }),
      updateCadence: jest.fn().mockResolvedValue({ id: CADENCE_ID }),
      deleteCadence: jest.fn().mockResolvedValue(undefined),
      listEnrollments: jest.fn().mockResolvedValue([]),
    };
    const mockEngine: Partial<Record<keyof CadenceEngineService, jest.Mock>> = {
      enroll: jest.fn().mockResolvedValue({ id: 'enr-1' }),
      processDueEnrollments: jest
        .fn()
        .mockResolvedValue({ processed: 0, sent: 0, skipped: 0, stopped: 0, completed: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RealtyCadenceController],
      providers: [
        { provide: RealtyCadenceService, useValue: mockService },
        { provide: CadenceEngineService, useValue: mockEngine },
      ],
    }).compile();

    controller = module.get(RealtyCadenceController);
    cadenceService = module.get(RealtyCadenceService) as jest.Mocked<RealtyCadenceService>;
    engine = module.get(CadenceEngineService) as jest.Mocked<CadenceEngineService>;
  });

  // ─────────────────────────────────────────────
  // Seed
  // ─────────────────────────────────────────────

  describe('seed', () => {
    it('seeds the caller’s tenant and returns the counts', async () => {
      await expect(controller.seed(BUSINESS_ID)).resolves.toEqual({ templates: 12, cadences: 3 });
      expect(cadenceService.seedDefaults).toHaveBeenCalledWith(BUSINESS_ID);
    });
  });

  // ─────────────────────────────────────────────
  // Templates
  // ─────────────────────────────────────────────

  describe('templates', () => {
    it('creates under the caller’s tenant', async () => {
      const dto = {
        name: 'followup_d1',
        category: 'UTILITY',
        language: 'en',
        body: 'Hi',
      } as never;

      await controller.createTemplate(BUSINESS_ID, dto);

      expect(cadenceService.createTemplate).toHaveBeenCalledWith(BUSINESS_ID, dto);
    });

    it('forwards the list filters unchanged', async () => {
      const query = { category: 'UTILITY', approvalStatus: 'APPROVED' } as never;

      await controller.listTemplates(BUSINESS_ID, query);

      expect(cadenceService.listTemplates).toHaveBeenCalledWith(BUSINESS_ID, query);
    });

    it('reads one template under the caller’s tenant', async () => {
      await controller.getTemplate(BUSINESS_ID, TEMPLATE_ID);

      expect(cadenceService.getTemplate).toHaveBeenCalledWith(BUSINESS_ID, TEMPLATE_ID);
    });

    it('updates under the caller’s tenant', async () => {
      const dto = { body: 'Updated' } as never;

      await controller.updateTemplate(BUSINESS_ID, TEMPLATE_ID, dto);

      expect(cadenceService.updateTemplate).toHaveBeenCalledWith(BUSINESS_ID, TEMPLATE_ID, dto);
    });

    it('sets approval under the caller’s tenant', async () => {
      const dto = { approvalStatus: 'APPROVED' } as never;

      await controller.setApproval(BUSINESS_ID, TEMPLATE_ID, dto);

      expect(cadenceService.setTemplateApproval).toHaveBeenCalledWith(
        BUSINESS_ID,
        TEMPLATE_ID,
        dto,
      );
    });

    it('deletes under the caller’s tenant and returns no body', async () => {
      // The route is 204 — returning the service result would break that.
      await expect(controller.deleteTemplate(BUSINESS_ID, TEMPLATE_ID)).resolves.toBeUndefined();
      expect(cadenceService.deleteTemplate).toHaveBeenCalledWith(BUSINESS_ID, TEMPLATE_ID);
    });
  });

  // ─────────────────────────────────────────────
  // Cadences
  // ─────────────────────────────────────────────

  describe('cadences', () => {
    it('creates under the caller’s tenant', async () => {
      const dto = { name: 'Chase', trigger: 'NO_RESPONSE', steps: [] } as never;

      await controller.createCadence(BUSINESS_ID, dto);

      expect(cadenceService.createCadence).toHaveBeenCalledWith(BUSINESS_ID, dto);
    });

    it('forwards the trigger filter unchanged', async () => {
      const query = { trigger: 'POST_VISIT' } as never;

      await controller.listCadences(BUSINESS_ID, query);

      expect(cadenceService.listCadences).toHaveBeenCalledWith(BUSINESS_ID, query);
    });

    it('reads one cadence under the caller’s tenant', async () => {
      await controller.getCadence(BUSINESS_ID, CADENCE_ID);

      expect(cadenceService.getCadence).toHaveBeenCalledWith(BUSINESS_ID, CADENCE_ID);
    });

    it('updates under the caller’s tenant', async () => {
      const dto = { isActive: false } as never;

      await controller.updateCadence(BUSINESS_ID, CADENCE_ID, dto);

      expect(cadenceService.updateCadence).toHaveBeenCalledWith(BUSINESS_ID, CADENCE_ID, dto);
    });

    it('deletes under the caller’s tenant and returns no body', async () => {
      await expect(controller.deleteCadence(BUSINESS_ID, CADENCE_ID)).resolves.toBeUndefined();
      expect(cadenceService.deleteCadence).toHaveBeenCalledWith(BUSINESS_ID, CADENCE_ID);
    });
  });

  // ─────────────────────────────────────────────
  // Enrollments + engine
  // ─────────────────────────────────────────────

  describe('enrollments and engine', () => {
    it('forwards the enrolment filters unchanged', async () => {
      const query = { leadId: LEAD_ID, status: 'ACTIVE' } as never;

      await controller.listEnrollments(BUSINESS_ID, query);

      expect(cadenceService.listEnrollments).toHaveBeenCalledWith(BUSINESS_ID, query);
    });

    it('routes a manual enrolment to the engine with the caller’s tenant', async () => {
      // The lead and trigger come from the body; the tenant never does.
      await controller.enroll(BUSINESS_ID, {
        leadId: LEAD_ID,
        trigger: CadenceTrigger.POST_VISIT,
      } as never);

      expect(engine.enroll).toHaveBeenCalledWith(
        BUSINESS_ID,
        LEAD_ID,
        CadenceTrigger.POST_VISIT,
      );
    });

    it('returns null when the engine finds no active cadence to enrol into', async () => {
      engine.enroll.mockResolvedValue(null);

      await expect(
        controller.enroll(BUSINESS_ID, {
          leadId: LEAD_ID,
          trigger: CadenceTrigger.DORMANT,
        } as never),
      ).resolves.toBeNull();
    });

    it('scopes the manual engine tick to the caller’s tenant', async () => {
      // An unscoped run would process every tenant's due steps.
      await controller.run(BUSINESS_ID);

      expect(engine.processDueEnrollments).toHaveBeenCalledWith(expect.any(Date), BUSINESS_ID);
    });

    it('returns the processing summary from the tick', async () => {
      engine.processDueEnrollments.mockResolvedValue({
        processed: 3,
        sent: 2,
        skipped: 1,
        stopped: 0,
        completed: 0,
      });

      await expect(controller.run(BUSINESS_ID)).resolves.toEqual({
        processed: 3,
        sent: 2,
        skipped: 1,
        stopped: 0,
        completed: 0,
      });
    });
  });
});
