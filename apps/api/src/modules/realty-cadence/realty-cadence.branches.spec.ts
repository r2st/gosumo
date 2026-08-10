/**
 * RealtyCadenceService — coverage for the read/delete surface and the DTO mappers.
 *
 * The sibling `realty-cadence.spec.ts` covers seeding, template approval
 * re-opening, and the batched cadence writes. What is left is the plainer half
 * of the service, which is exactly where a silent mistake is cheapest to make:
 *
 *  - **The must-find guards.** Every read/update/delete routes through
 *    `mustFindTemplate` / `mustFindCadence`, which is what turns a foreign or
 *    stale id into a 404 instead of a write against another tenant's row. A
 *    delete that skips the guard is the dangerous case, so each is asserted to
 *    check first and to not call the repository when the guard fails.
 *  - **The mappers.** `mapTemplate` / `mapStep` / `mapEnrollment` translate
 *    snake_case columns to the camelCase API contract. A swapped or dropped
 *    field here is invisible to the type checker when both sides are strings.
 *
 * The repository is mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';

import { RealtyCadenceService } from './realty-cadence.service';
import { RealtyCadenceRepository } from './realty-cadence.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const TEMPLATE_ID = '00000000-0000-4000-c000-000000000001';
const CADENCE_ID = '00000000-0000-4000-b000-000000000001';
const LEAD_ID = '00000000-0000-4000-d000-000000000001';
const CREATED_AT = new Date('2026-05-01T09:00:00Z');
const UPDATED_AT = new Date('2026-05-02T09:00:00Z');

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    business_id: BUSINESS_ID,
    name: 'followup_d1',
    category: 'UTILITY',
    language: 'en',
    body: 'Hi {{1}}, still looking?',
    variables: ['name'],
    approval_status: 'APPROVED',
    approved_at: CREATED_AT,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    deleted_at: null,
    ...overrides,
  } as never;
}

function makeCadence(overrides: Record<string, unknown> = {}) {
  return {
    id: CADENCE_ID,
    business_id: BUSINESS_ID,
    name: 'No-response chase',
    description: 'D1/D3/D7',
    trigger: 'NO_RESPONSE',
    is_active: true,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    deleted_at: null,
    ...overrides,
  } as never;
}

function makeStep(overrides: Record<string, unknown> = {}) {
  return {
    id: 'step-1',
    business_id: BUSINESS_ID,
    cadence_id: CADENCE_ID,
    template_id: TEMPLATE_ID,
    step_order: 0,
    day_offset: 1,
    condition: {},
    stop_on: ['REPLY'],
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    deleted_at: null,
    template: makeTemplate(),
    ...overrides,
  } as never;
}

function makeEnrollment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'enr-1',
    business_id: BUSINESS_ID,
    cadence_id: CADENCE_ID,
    lead_id: LEAD_ID,
    trigger: 'NO_RESPONSE',
    status: 'ACTIVE',
    current_step: 1,
    next_run_at: UPDATED_AT,
    stop_reason: null,
    last_step_sent_at: CREATED_AT,
    started_at: CREATED_AT,
    completed_at: null,
    ...overrides,
  } as never;
}

describe('RealtyCadenceService (reads, deletes, mappers)', () => {
  let service: RealtyCadenceService;
  let repository: jest.Mocked<RealtyCadenceRepository>;

  beforeEach(async () => {
    const mockRepo: Partial<Record<keyof RealtyCadenceRepository, jest.Mock>> = {
      findTemplateById: jest.fn().mockResolvedValue(makeTemplate()),
      listTemplates: jest.fn().mockResolvedValue([]),
      softDeleteTemplate: jest.fn().mockResolvedValue(makeTemplate()),
      updateTemplate: jest.fn().mockResolvedValue(makeTemplate()),
      findCadenceById: jest.fn().mockResolvedValue(makeCadence()),
      listStepsByCadence: jest.fn().mockResolvedValue([]),
      softDeleteCadence: jest.fn().mockResolvedValue(makeCadence()),
      updateCadence: jest.fn().mockResolvedValue(makeCadence()),
      listEnrollments: jest.fn().mockResolvedValue([]),
      findTemplatesByIds: jest.fn().mockResolvedValue([makeTemplate()]),
      findTemplatesByNames: jest.fn().mockResolvedValue([]),
      createTemplate: jest.fn().mockResolvedValue(makeTemplate()),
      createCadence: jest.fn().mockResolvedValue(makeCadence()),
      createSteps: jest.fn().mockResolvedValue(undefined),
      deleteStepsByCadence: jest.fn().mockResolvedValue(undefined),
      listCadences: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyCadenceService,
        { provide: RealtyCadenceRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get(RealtyCadenceService);
    repository = module.get(RealtyCadenceRepository) as jest.Mocked<RealtyCadenceRepository>;
  });

  // ─────────────────────────────────────────────
  // Templates
  // ─────────────────────────────────────────────

  describe('listTemplates', () => {
    it('passes both filters through to the repository', async () => {
      await service.listTemplates(BUSINESS_ID, {
        category: 'MARKETING',
        approvalStatus: 'PENDING',
      } as never);

      expect(repository.listTemplates).toHaveBeenCalledWith(BUSINESS_ID, {
        category: 'MARKETING',
        approvalStatus: 'PENDING',
      });
    });

    it('passes undefined filters through untouched', async () => {
      await service.listTemplates(BUSINESS_ID, {} as never);

      expect(repository.listTemplates).toHaveBeenCalledWith(BUSINESS_ID, {
        category: undefined,
        approvalStatus: undefined,
      });
    });

    it('maps every row onto the API contract', async () => {
      repository.listTemplates.mockResolvedValue([makeTemplate(), makeTemplate({ id: 'tpl-2' })]);

      const result = await service.listTemplates(BUSINESS_ID, {} as never);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: TEMPLATE_ID,
        name: 'followup_d1',
        category: 'UTILITY',
        language: 'en',
        body: 'Hi {{1}}, still looking?',
        variables: ['name'],
        approvalStatus: 'APPROVED',
        approvedAt: CREATED_AT,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      });
    });

    it('returns an empty list for a tenant with no templates', async () => {
      await expect(service.listTemplates(BUSINESS_ID, {} as never)).resolves.toEqual([]);
    });

    it('defaults a null variable column to an empty list', async () => {
      repository.listTemplates.mockResolvedValue([makeTemplate({ variables: null })]);

      const [template] = await service.listTemplates(BUSINESS_ID, {} as never);

      expect(template!.variables).toEqual([]);
    });
  });

  describe('getTemplate', () => {
    it('returns the mapped template', async () => {
      const result = await service.getTemplate(BUSINESS_ID, TEMPLATE_ID);

      expect(repository.findTemplateById).toHaveBeenCalledWith(BUSINESS_ID, TEMPLATE_ID);
      expect(result).toMatchObject({ id: TEMPLATE_ID, approvalStatus: 'APPROVED' });
    });

    it('404s on an id the tenant cannot see', async () => {
      repository.findTemplateById.mockResolvedValue(null);

      await expect(service.getTemplate(BUSINESS_ID, TEMPLATE_ID)).rejects.toThrow(
        new NotFoundException(`Template ${TEMPLATE_ID} not found`),
      );
    });

    it('carries a null approval stamp through unchanged', async () => {
      repository.findTemplateById.mockResolvedValue(
        makeTemplate({ approval_status: 'PENDING', approved_at: null }),
      );

      const result = await service.getTemplate(BUSINESS_ID, TEMPLATE_ID);

      expect(result).toMatchObject({ approvalStatus: 'PENDING', approvedAt: null });
    });
  });

  describe('setTemplateApproval', () => {
    it('clears the approval stamp when rejecting', async () => {
      // Only APPROVED carries a stamp — a rejected template must not look
      // approved-at-some-point to the compliance gate.
      await service.setTemplateApproval(BUSINESS_ID, TEMPLATE_ID, {
        approvalStatus: 'REJECTED',
      } as never);

      expect(repository.updateTemplate).toHaveBeenCalledWith(BUSINESS_ID, TEMPLATE_ID, {
        approval_status: 'REJECTED',
        approved_at: null,
      });
    });

    it('clears the approval stamp when moving back to PENDING', async () => {
      await service.setTemplateApproval(BUSINESS_ID, TEMPLATE_ID, {
        approvalStatus: 'PENDING',
      } as never);

      expect(repository.updateTemplate).toHaveBeenCalledWith(BUSINESS_ID, TEMPLATE_ID, {
        approval_status: 'PENDING',
        approved_at: null,
      });
    });

    it('404s and writes nothing when the template is not visible', async () => {
      repository.findTemplateById.mockResolvedValue(null);

      await expect(
        service.setTemplateApproval(BUSINESS_ID, TEMPLATE_ID, {
          approvalStatus: 'APPROVED',
        } as never),
      ).rejects.toThrow(NotFoundException);
      expect(repository.updateTemplate).not.toHaveBeenCalled();
    });
  });

  describe('updateTemplate patches', () => {
    /** The column patch the service built from the DTO. */
    function patch(): Record<string, unknown> {
      return repository.updateTemplate.mock.calls[0]![2] as Record<string, unknown>;
    }

    it('sends an empty patch when the DTO is empty', async () => {
      await service.updateTemplate(BUSINESS_ID, TEMPLATE_ID, {} as never);

      expect(patch()).toEqual({});
    });

    it('renames without touching approval', async () => {
      // A rename is not a content change — re-opening approval here would
      // needlessly take a working template out of service.
      await service.updateTemplate(BUSINESS_ID, TEMPLATE_ID, { name: 'renamed' } as never);

      expect(patch()).toEqual({ name: 'renamed' });
    });

    it('changes language without touching approval', async () => {
      await service.updateTemplate(BUSINESS_ID, TEMPLATE_ID, { language: 'hi' } as never);

      expect(patch()).toEqual({ language: 'hi' });
    });

    it('replaces the variable list without touching approval', async () => {
      await service.updateTemplate(BUSINESS_ID, TEMPLATE_ID, {
        variables: ['name', 'project'],
      } as never);

      expect(patch()).toEqual({ variables: ['name', 'project'] });
    });

    it('re-opens approval when the category changes', async () => {
      // Category drives the compliance gate, so a change is a content change.
      await service.updateTemplate(BUSINESS_ID, TEMPLATE_ID, { category: 'MARKETING' } as never);

      expect(patch()).toEqual({
        category: 'MARKETING',
        approval_status: 'PENDING',
        approved_at: null,
      });
    });

    it('re-opens approval once when body and category both change', async () => {
      await service.updateTemplate(BUSINESS_ID, TEMPLATE_ID, {
        body: 'New copy',
        category: 'UTILITY',
      } as never);

      expect(patch()).toEqual({
        body: 'New copy',
        category: 'UTILITY',
        approval_status: 'PENDING',
        approved_at: null,
      });
    });

    it('writes every field at once', async () => {
      await service.updateTemplate(BUSINESS_ID, TEMPLATE_ID, {
        name: 'renamed',
        category: 'MARKETING',
        language: 'hi',
        body: 'New copy',
        variables: ['name'],
      } as never);

      expect(patch()).toEqual({
        name: 'renamed',
        category: 'MARKETING',
        language: 'hi',
        body: 'New copy',
        variables: ['name'],
        approval_status: 'PENDING',
        approved_at: null,
      });
    });

    it('404s and writes nothing when the template is not visible', async () => {
      repository.findTemplateById.mockResolvedValue(null);

      await expect(
        service.updateTemplate(BUSINESS_ID, TEMPLATE_ID, { body: 'x' } as never),
      ).rejects.toThrow(NotFoundException);
      expect(repository.updateTemplate).not.toHaveBeenCalled();
    });
  });

  describe('deleteTemplate', () => {
    it('soft-deletes after confirming the template belongs to the tenant', async () => {
      await service.deleteTemplate(BUSINESS_ID, TEMPLATE_ID);

      expect(repository.findTemplateById).toHaveBeenCalledWith(BUSINESS_ID, TEMPLATE_ID);
      expect(repository.softDeleteTemplate).toHaveBeenCalledWith(BUSINESS_ID, TEMPLATE_ID);
    });

    it('404s and writes nothing when the template is not visible', async () => {
      // Without the guard this would soft-delete another tenant's row.
      repository.findTemplateById.mockResolvedValue(null);

      await expect(service.deleteTemplate(BUSINESS_ID, TEMPLATE_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.softDeleteTemplate).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // Cadences
  // ─────────────────────────────────────────────

  describe('getCadence', () => {
    it('assembles the cadence with its mapped steps', async () => {
      repository.listStepsByCadence.mockResolvedValue([
        makeStep({ id: 'step-1', step_order: 0, day_offset: 1 }),
        makeStep({ id: 'step-2', step_order: 1, day_offset: 3, stop_on: ['REPLY', 'OPTOUT'] }),
      ]);

      const result = await service.getCadence(BUSINESS_ID, CADENCE_ID);

      expect(result).toMatchObject({
        id: CADENCE_ID,
        name: 'No-response chase',
        description: 'D1/D3/D7',
        trigger: 'NO_RESPONSE',
        isActive: true,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      });
      expect(result.steps).toEqual([
        {
          id: 'step-1',
          order: 0,
          dayOffset: 1,
          templateId: TEMPLATE_ID,
          templateName: 'followup_d1',
          stopOn: ['REPLY'],
        },
        {
          id: 'step-2',
          order: 1,
          dayOffset: 3,
          templateId: TEMPLATE_ID,
          templateName: 'followup_d1',
          stopOn: ['REPLY', 'OPTOUT'],
        },
      ]);
    });

    it('defaults a null stop_on column to an empty list', async () => {
      repository.listStepsByCadence.mockResolvedValue([makeStep({ stop_on: null })]);

      const result = await service.getCadence(BUSINESS_ID, CADENCE_ID);

      expect(result.steps[0]!.stopOn).toEqual([]);
    });

    it('carries a null description through unchanged', async () => {
      repository.findCadenceById.mockResolvedValue(makeCadence({ description: null }));

      await expect(service.getCadence(BUSINESS_ID, CADENCE_ID)).resolves.toMatchObject({
        description: null,
      });
    });

    it('404s on an id the tenant cannot see', async () => {
      repository.findCadenceById.mockResolvedValue(null);

      await expect(service.getCadence(BUSINESS_ID, CADENCE_ID)).rejects.toThrow(
        new NotFoundException(`Cadence ${CADENCE_ID} not found`),
      );
    });
  });

  describe('updateCadence patches', () => {
    /** The column patch the service built from the DTO. */
    function patch(): Record<string, unknown> {
      return repository.updateCadence.mock.calls[0]![2] as Record<string, unknown>;
    }

    it('skips the write entirely when no scalar field changed', async () => {
      // An empty patch would be a pointless UPDATE that still bumps updated_at.
      await service.updateCadence(BUSINESS_ID, CADENCE_ID, {} as never);

      expect(repository.updateCadence).not.toHaveBeenCalled();
    });

    it('renames the cadence', async () => {
      await service.updateCadence(BUSINESS_ID, CADENCE_ID, { name: 'Renamed' } as never);

      expect(patch()).toEqual({ name: 'Renamed' });
    });

    it('clears the description when passed null', async () => {
      await service.updateCadence(BUSINESS_ID, CADENCE_ID, { description: null } as never);

      expect(patch()).toEqual({ description: null });
    });

    it('deactivates the cadence', async () => {
      await service.updateCadence(BUSINESS_ID, CADENCE_ID, { isActive: false } as never);

      expect(patch()).toEqual({ is_active: false });
    });

    it('writes every scalar field at once', async () => {
      await service.updateCadence(BUSINESS_ID, CADENCE_ID, {
        name: 'Renamed',
        description: 'New copy',
        isActive: true,
      } as never);

      expect(patch()).toEqual({
        name: 'Renamed',
        description: 'New copy',
        is_active: true,
      });
    });

    it('leaves the existing steps alone when the DTO omits them', async () => {
      // `steps: undefined` means "don't touch"; only an explicit list replaces.
      await service.updateCadence(BUSINESS_ID, CADENCE_ID, { name: 'Renamed' } as never);

      expect(repository.deleteStepsByCadence).not.toHaveBeenCalled();
      expect(repository.createSteps).not.toHaveBeenCalled();
    });

    it('replaces the step list with an empty one when passed []', async () => {
      await service.updateCadence(BUSINESS_ID, CADENCE_ID, { steps: [] } as never);

      expect(repository.deleteStepsByCadence).toHaveBeenCalledWith(BUSINESS_ID, CADENCE_ID);
      expect(repository.createSteps).toHaveBeenCalledWith([]);
    });

    it('defaults a step’s omitted stop signals to none', async () => {
      await service.updateCadence(BUSINESS_ID, CADENCE_ID, {
        steps: [{ templateId: TEMPLATE_ID, order: 0, dayOffset: 1 }],
      } as never);

      expect(repository.createSteps).toHaveBeenCalledWith([
        expect.objectContaining({ stopOn: [] }),
      ]);
    });

    it('writes steps in order regardless of the order they arrive in', async () => {
      // The engine indexes steps positionally, so a mis-sorted write would run
      // D7 before D1.
      await service.updateCadence(BUSINESS_ID, CADENCE_ID, {
        steps: [
          { templateId: TEMPLATE_ID, order: 2, dayOffset: 7, stopOn: ['REPLY'] },
          { templateId: TEMPLATE_ID, order: 0, dayOffset: 1, stopOn: ['REPLY'] },
          { templateId: TEMPLATE_ID, order: 1, dayOffset: 3, stopOn: ['REPLY'] },
        ],
      } as never);

      const written = repository.createSteps.mock.calls[0]![0] as { stepOrder: number }[];
      expect(written.map((s) => s.stepOrder)).toEqual([0, 1, 2]);
    });

    it('404s and writes nothing when the cadence is not visible', async () => {
      repository.findCadenceById.mockResolvedValue(null);

      await expect(
        service.updateCadence(BUSINESS_ID, CADENCE_ID, { name: 'x' } as never),
      ).rejects.toThrow(NotFoundException);
      expect(repository.updateCadence).not.toHaveBeenCalled();
    });
  });

  describe('deleteCadence', () => {
    it('soft-deletes after confirming the cadence belongs to the tenant', async () => {
      await service.deleteCadence(BUSINESS_ID, CADENCE_ID);

      expect(repository.findCadenceById).toHaveBeenCalledWith(BUSINESS_ID, CADENCE_ID);
      expect(repository.softDeleteCadence).toHaveBeenCalledWith(BUSINESS_ID, CADENCE_ID);
    });

    it('404s and writes nothing when the cadence is not visible', async () => {
      repository.findCadenceById.mockResolvedValue(null);

      await expect(service.deleteCadence(BUSINESS_ID, CADENCE_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.softDeleteCadence).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // Enrollments
  // ─────────────────────────────────────────────

  describe('listEnrollments', () => {
    it('passes both filters through to the repository', async () => {
      await service.listEnrollments(BUSINESS_ID, {
        leadId: LEAD_ID,
        status: 'ACTIVE',
      } as never);

      expect(repository.listEnrollments).toHaveBeenCalledWith(BUSINESS_ID, {
        leadId: LEAD_ID,
        status: 'ACTIVE',
      });
    });

    it('passes undefined filters through untouched', async () => {
      await service.listEnrollments(BUSINESS_ID, {} as never);

      expect(repository.listEnrollments).toHaveBeenCalledWith(BUSINESS_ID, {
        leadId: undefined,
        status: undefined,
      });
    });

    it('maps a running enrolment onto the API contract', async () => {
      repository.listEnrollments.mockResolvedValue([makeEnrollment()]);

      const [enrollment] = await service.listEnrollments(BUSINESS_ID, {} as never);

      expect(enrollment).toEqual({
        id: 'enr-1',
        leadId: LEAD_ID,
        cadenceId: CADENCE_ID,
        trigger: 'NO_RESPONSE',
        status: 'ACTIVE',
        currentStep: 1,
        nextRunAt: UPDATED_AT,
        stopReason: null,
        lastStepSentAt: CREATED_AT,
        startedAt: CREATED_AT,
        completedAt: null,
      });
    });

    it('maps a terminated enrolment, keeping its stop reason and completion stamp', async () => {
      repository.listEnrollments.mockResolvedValue([
        makeEnrollment({
          status: 'STOPPED',
          stop_reason: 'opted_out',
          next_run_at: null,
          completed_at: UPDATED_AT,
        }),
      ]);

      const [enrollment] = await service.listEnrollments(BUSINESS_ID, {} as never);

      expect(enrollment).toMatchObject({
        status: 'STOPPED',
        stopReason: 'opted_out',
        nextRunAt: null,
        completedAt: UPDATED_AT,
      });
    });

    it('returns an empty list for a tenant with no enrolments', async () => {
      await expect(service.listEnrollments(BUSINESS_ID, {} as never)).resolves.toEqual([]);
    });
  });
});
