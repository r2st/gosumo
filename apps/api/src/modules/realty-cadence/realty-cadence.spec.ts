/**
 * RealtyCadenceService unit tests.
 *
 * Coverage:
 *  1. Seeding — installs the default templates + 3 cadences; idempotent on re-run.
 *  2. Templates — create (name conflict), content edit re-opens approval, set approval.
 *  3. Cadences — create validates every referenced template; update replaces steps.
 *
 * The repository is mocked; no database is touched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { TemplateCategory, TemplateApprovalStatus, CadenceTrigger, CadenceStopOn } from '@gosumo/shared';

import { RealtyCadenceService } from './realty-cadence.service';
import { RealtyCadenceRepository } from './realty-cadence.repository';
import { DEFAULT_TEMPLATES } from './default-templates';

const TEMPLATE_COUNT = DEFAULT_TEMPLATES.length;

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const TEMPLATE_ID = '00000000-0000-4000-a000-000000000030';
const CADENCE_ID = '00000000-0000-4000-a000-000000000040';

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    business_id: BUSINESS_ID,
    name: 'followup_d1',
    category: 'UTILITY',
    language: 'en',
    body: 'hi {{1}}',
    variables: ['name'],
    approval_status: 'APPROVED',
    approved_at: new Date(),
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function makeCadence(overrides: Record<string, unknown> = {}) {
  return {
    id: CADENCE_ID,
    business_id: BUSINESS_ID,
    name: 'My cadence',
    description: null,
    trigger: 'NO_RESPONSE',
    is_active: true,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

describe('RealtyCadenceService', () => {
  let service: RealtyCadenceService;
  let repository: jest.Mocked<RealtyCadenceRepository>;

  beforeEach(async () => {
    const mockRepo: Partial<Record<keyof RealtyCadenceRepository, jest.Mock>> = {
      createTemplate: jest.fn(),
      findTemplateById: jest.fn(),
      findTemplateByName: jest.fn(),
      listTemplates: jest.fn(),
      updateTemplate: jest.fn(),
      softDeleteTemplate: jest.fn(),
      createCadence: jest.fn(),
      findCadenceById: jest.fn(),
      listCadences: jest.fn(),
      updateCadence: jest.fn(),
      softDeleteCadence: jest.fn(),
      createStep: jest.fn(),
      listStepsByCadence: jest.fn(),
      deleteStepsByCadence: jest.fn(),
      listEnrollments: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyCadenceService,
        { provide: RealtyCadenceRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get(RealtyCadenceService);
    repository = module.get(RealtyCadenceRepository) as jest.Mocked<RealtyCadenceRepository>;
    jest.clearAllMocks();
  });

  // ── Seeding ──
  describe('seedDefaults', () => {
    it('installs every default template and 3 cadences on a fresh tenant', async () => {
      repository.findTemplateByName.mockResolvedValue(null);
      repository.createTemplate.mockImplementation(async (d) => makeTemplate({ name: d.name }) as never);
      repository.listCadences.mockResolvedValue([]);
      repository.createCadence.mockResolvedValue(makeCadence() as never);
      repository.createStep.mockResolvedValue({} as never);

      const result = await service.seedDefaults(BUSINESS_ID);

      expect(result.templates).toBe(TEMPLATE_COUNT);
      expect(result.cadences).toBe(3);
      expect(repository.createTemplate).toHaveBeenCalledTimes(TEMPLATE_COUNT);
    });

    it('is idempotent — skips templates/cadences that already exist', async () => {
      repository.findTemplateByName.mockResolvedValue(makeTemplate() as never); // all exist
      repository.listCadences.mockResolvedValue([
        makeCadence({ name: 'No-response follow-up (D1 / D3 / D7)' }),
        makeCadence({ name: 'Post-visit nurture' }),
        makeCadence({ name: 'Dormant reactivation (D30 / D60 / D90)' }),
      ] as never);

      const result = await service.seedDefaults(BUSINESS_ID);

      expect(result.templates).toBe(0);
      expect(result.cadences).toBe(0);
      expect(repository.createTemplate).not.toHaveBeenCalled();
      expect(repository.createCadence).not.toHaveBeenCalled();
    });
  });

  // ── Templates ──
  describe('createTemplate', () => {
    it('rejects a duplicate template name', async () => {
      repository.findTemplateByName.mockResolvedValue(makeTemplate() as never);
      await expect(
        service.createTemplate(BUSINESS_ID, {
          name: 'followup_d1',
          category: TemplateCategory.UTILITY,
          language: 'en',
          body: 'hi',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates a new template', async () => {
      repository.findTemplateByName.mockResolvedValue(null);
      repository.createTemplate.mockResolvedValue(makeTemplate({ name: 'new_tpl' }) as never);
      const result = await service.createTemplate(BUSINESS_ID, {
        name: 'new_tpl',
        category: TemplateCategory.MARKETING,
        language: 'en',
        body: 'promo',
      });
      expect(result.name).toBe('new_tpl');
    });
  });

  describe('updateTemplate', () => {
    it('re-opens approval when the body changes', async () => {
      repository.findTemplateById.mockResolvedValue(makeTemplate() as never);
      repository.updateTemplate.mockResolvedValue(makeTemplate({ approval_status: 'PENDING' }) as never);

      await service.updateTemplate(BUSINESS_ID, TEMPLATE_ID, { body: 'new body' });

      const data = repository.updateTemplate.mock.calls[0]![2] as Record<string, unknown>;
      expect(data['approval_status']).toBe('PENDING');
      expect(data['approved_at']).toBeNull();
    });
  });

  describe('setTemplateApproval', () => {
    it('stamps approved_at when approving', async () => {
      repository.findTemplateById.mockResolvedValue(makeTemplate() as never);
      repository.updateTemplate.mockResolvedValue(makeTemplate() as never);

      await service.setTemplateApproval(BUSINESS_ID, TEMPLATE_ID, {
        approvalStatus: TemplateApprovalStatus.APPROVED,
      });

      const data = repository.updateTemplate.mock.calls[0]![2] as Record<string, unknown>;
      expect(data['approval_status']).toBe('APPROVED');
      expect(data['approved_at']).toBeInstanceOf(Date);
    });
  });

  // ── Cadences ──
  describe('createCadence', () => {
    it('validates that every referenced template exists', async () => {
      repository.findTemplateById.mockResolvedValue(null);
      await expect(
        service.createCadence(BUSINESS_ID, {
          name: 'C',
          trigger: CadenceTrigger.NO_RESPONSE,
          steps: [{ order: 0, dayOffset: 1, templateId: TEMPLATE_ID, stopOn: [CadenceStopOn.REPLY] }],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.createCadence).not.toHaveBeenCalled();
    });

    it('creates the cadence and writes its steps', async () => {
      repository.findTemplateById.mockResolvedValue(makeTemplate() as never);
      repository.createCadence.mockResolvedValue(makeCadence() as never);
      repository.createStep.mockResolvedValue({} as never);
      repository.findCadenceById.mockResolvedValue(makeCadence() as never);
      repository.listStepsByCadence.mockResolvedValue([]);

      await service.createCadence(BUSINESS_ID, {
        name: 'C',
        trigger: CadenceTrigger.NO_RESPONSE,
        steps: [
          { order: 1, dayOffset: 3, templateId: TEMPLATE_ID, stopOn: [] },
          { order: 0, dayOffset: 1, templateId: TEMPLATE_ID, stopOn: [CadenceStopOn.REPLY] },
        ],
      });

      // Steps are written ordered by `order` (0 then 1).
      expect(repository.createStep).toHaveBeenCalledTimes(2);
      const firstOrder = (repository.createStep.mock.calls[0]![0] as { stepOrder: number }).stepOrder;
      expect(firstOrder).toBe(0);
    });
  });

  describe('updateCadence', () => {
    it('replaces the step list when steps are provided', async () => {
      repository.findCadenceById.mockResolvedValue(makeCadence() as never);
      repository.findTemplateById.mockResolvedValue(makeTemplate() as never);
      repository.deleteStepsByCadence.mockResolvedValue(undefined as never);
      repository.createStep.mockResolvedValue({} as never);
      repository.listStepsByCadence.mockResolvedValue([]);

      await service.updateCadence(BUSINESS_ID, CADENCE_ID, {
        steps: [{ order: 0, dayOffset: 2, templateId: TEMPLATE_ID, stopOn: [] }],
      });

      expect(repository.deleteStepsByCadence).toHaveBeenCalledWith(BUSINESS_ID, CADENCE_ID);
      expect(repository.createStep).toHaveBeenCalledTimes(1);
    });
  });
});
