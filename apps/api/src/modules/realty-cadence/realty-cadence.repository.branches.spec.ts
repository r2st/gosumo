/**
 * RealtyCadenceRepository — CRUD and filter-branch coverage.
 *
 * The sibling `realty-cadence.repository.spec.ts` covers the batched readers
 * that replaced the per-row loops. This file covers everything else, where the
 * branches live in three recurring shapes:
 *
 *   - **Defaulting on insert** — `approval_status`, `is_active`, `condition`
 *     and `variables` all have a "caller omitted it" fallback. A wrong default
 *     ships an unapproved template as approved, or a disabled cadence as live.
 *   - **Optional filters** — list queries drop a clause when the filter is
 *     absent; emitting `undefined` instead would match nothing.
 *   - **Sparse patches** — `updateEnrollment` maps a partial DTO onto column
 *     names one field at a time, and a `null` (clear it) must survive where an
 *     `undefined` (leave it) must not.
 *
 * Tenant scoping and soft-delete exclusion are asserted on every query.
 *
 * PrismaService is mocked — assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';

import { RealtyCadenceRepository } from './realty-cadence.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const TEMPLATE_ID = '00000000-0000-4000-c000-000000000001';
const CADENCE_ID = '00000000-0000-4000-b000-000000000001';
const LEAD_ID = '00000000-0000-4000-d000-000000000001';
const ENROLLMENT_ID = '00000000-0000-4000-e000-000000000001';

describe('RealtyCadenceRepository (CRUD + filters)', () => {
  let repository: RealtyCadenceRepository;
  let prisma: {
    realty_message_templates: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    realty_cadences: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    realty_cadence_steps: {
      create: jest.Mock;
      createMany: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
    realty_cadence_enrollments: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      realty_message_templates: {
        create: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
      },
      realty_cadences: {
        create: jest.fn().mockResolvedValue({ id: CADENCE_ID }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: CADENCE_ID }),
      },
      realty_cadence_steps: {
        create: jest.fn().mockResolvedValue({ id: 'step-1' }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      realty_cadence_enrollments: {
        create: jest.fn().mockResolvedValue({ id: ENROLLMENT_ID }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: ENROLLMENT_ID }),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RealtyCadenceRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get<RealtyCadenceRepository>(RealtyCadenceRepository);
  });

  // ─────────────────────────────────────────────
  // Templates
  // ─────────────────────────────────────────────

  describe('createTemplate', () => {
    const base = {
      businessId: BUSINESS_ID,
      name: 'welcome_en',
      category: 'UTILITY' as const,
      language: 'en',
      body: 'Hi {{1}}',
    };

    it('defaults an unspecified approval status to PENDING with no approval stamp', async () => {
      // A template must never arrive pre-approved by omission — WhatsApp
      // compliance keys off approval_status.
      await repository.createTemplate(base);

      expect(prisma.realty_message_templates.create.mock.calls[0]![0].data).toMatchObject({
        approval_status: 'PENDING',
        approved_at: null,
      });
    });

    it('stamps approved_at when created already APPROVED', async () => {
      // The seeder ships defaults APPROVED so cadences work on day one.
      await repository.createTemplate({ ...base, approvalStatus: 'APPROVED' });

      const data = prisma.realty_message_templates.create.mock.calls[0]![0].data;
      expect(data.approval_status).toBe('APPROVED');
      expect(data.approved_at).toBeInstanceOf(Date);
    });

    it('leaves approved_at null for an explicitly REJECTED template', async () => {
      await repository.createTemplate({ ...base, approvalStatus: 'REJECTED' });

      expect(prisma.realty_message_templates.create.mock.calls[0]![0].data).toMatchObject({
        approval_status: 'REJECTED',
        approved_at: null,
      });
    });

    it('defaults the variable list to empty rather than null', async () => {
      await repository.createTemplate(base);

      expect(prisma.realty_message_templates.create.mock.calls[0]![0].data.variables).toEqual([]);
    });

    it('keeps a supplied variable list', async () => {
      await repository.createTemplate({ ...base, variables: ['name', 'project'] });

      expect(prisma.realty_message_templates.create.mock.calls[0]![0].data.variables).toEqual([
        'name',
        'project',
      ]);
    });

    it('scopes the insert to the tenant', async () => {
      await repository.createTemplate(base);

      expect(prisma.realty_message_templates.create.mock.calls[0]![0].data).toMatchObject({
        business_id: BUSINESS_ID,
        name: 'welcome_en',
        category: 'UTILITY',
        language: 'en',
        body: 'Hi {{1}}',
      });
    });
  });

  describe('template reads', () => {
    it('finds by id within the tenant, excluding soft-deleted rows', async () => {
      await repository.findTemplateById(BUSINESS_ID, TEMPLATE_ID);

      expect(prisma.realty_message_templates.findFirst).toHaveBeenCalledWith({
        where: { id: TEMPLATE_ID, business_id: BUSINESS_ID, deleted_at: null },
      });
    });

    it('finds by name within the tenant (the uniqueness check)', async () => {
      await repository.findTemplateByName(BUSINESS_ID, 'welcome_en');

      expect(prisma.realty_message_templates.findFirst).toHaveBeenCalledWith({
        where: { name: 'welcome_en', business_id: BUSINESS_ID, deleted_at: null },
      });
    });

    it('returns null when the name is unused', async () => {
      await expect(repository.findTemplateByName(BUSINESS_ID, 'nope')).resolves.toBeNull();
    });
  });

  describe('listTemplates', () => {
    it('lists a tenant’s live templates alphabetically when unfiltered', async () => {
      await repository.listTemplates(BUSINESS_ID);

      expect(prisma.realty_message_templates.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, deleted_at: null },
        orderBy: { name: 'asc' },
      });
    });

    it('filters by category alone', async () => {
      await repository.listTemplates(BUSINESS_ID, { category: 'MARKETING' });

      const where = prisma.realty_message_templates.findMany.mock.calls[0]![0].where;
      expect(where).toMatchObject({ category: 'MARKETING' });
      expect(where).not.toHaveProperty('approval_status');
    });

    it('filters by approval status alone', async () => {
      await repository.listTemplates(BUSINESS_ID, { approvalStatus: 'APPROVED' });

      const where = prisma.realty_message_templates.findMany.mock.calls[0]![0].where;
      expect(where).toMatchObject({ approval_status: 'APPROVED' });
      expect(where).not.toHaveProperty('category');
    });

    it('combines both filters', async () => {
      await repository.listTemplates(BUSINESS_ID, {
        category: 'UTILITY',
        approvalStatus: 'PENDING',
      });

      expect(prisma.realty_message_templates.findMany.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
        category: 'UTILITY',
        approval_status: 'PENDING',
      });
    });

    it('ignores empty filter strings', async () => {
      await repository.listTemplates(BUSINESS_ID, { category: '', approvalStatus: '' });

      expect(prisma.realty_message_templates.findMany.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
    });
  });

  describe('template writes', () => {
    it('scopes an update to the tenant', async () => {
      await repository.updateTemplate(BUSINESS_ID, TEMPLATE_ID, { body: 'new' });

      expect(prisma.realty_message_templates.update).toHaveBeenCalledWith({
        where: { id: TEMPLATE_ID, business_id: BUSINESS_ID },
        data: { body: 'new' },
      });
    });

    it('soft-deletes by stamping deleted_at rather than removing the row', async () => {
      await repository.softDeleteTemplate(BUSINESS_ID, TEMPLATE_ID);

      const call = prisma.realty_message_templates.update.mock.calls[0]![0];
      expect(call.where).toEqual({ id: TEMPLATE_ID, business_id: BUSINESS_ID });
      expect(call.data.deleted_at).toBeInstanceOf(Date);
    });
  });

  // ─────────────────────────────────────────────
  // Cadences
  // ─────────────────────────────────────────────

  describe('createCadence', () => {
    const base = {
      businessId: BUSINESS_ID,
      name: 'No-response chase',
      trigger: 'NO_RESPONSE' as const,
    };

    it('defaults a new cadence to active', async () => {
      await repository.createCadence(base);

      expect(prisma.realty_cadences.create.mock.calls[0]![0].data).toMatchObject({
        business_id: BUSINESS_ID,
        name: 'No-response chase',
        trigger: 'NO_RESPONSE',
        is_active: true,
      });
    });

    it('honours an explicit inactive flag', async () => {
      await repository.createCadence({ ...base, isActive: false });

      expect(prisma.realty_cadences.create.mock.calls[0]![0].data.is_active).toBe(false);
    });

    it('defaults a missing description to null', async () => {
      await repository.createCadence(base);

      expect(prisma.realty_cadences.create.mock.calls[0]![0].data.description).toBeNull();
    });

    it('keeps a supplied description', async () => {
      await repository.createCadence({ ...base, description: 'D1/D3/D7' });

      expect(prisma.realty_cadences.create.mock.calls[0]![0].data.description).toBe('D1/D3/D7');
    });

    it('normalises an explicit null description', async () => {
      await repository.createCadence({ ...base, description: null });

      expect(prisma.realty_cadences.create.mock.calls[0]![0].data.description).toBeNull();
    });
  });

  describe('cadence reads', () => {
    it('finds by id within the tenant, excluding soft-deleted rows', async () => {
      await repository.findCadenceById(BUSINESS_ID, CADENCE_ID);

      expect(prisma.realty_cadences.findFirst).toHaveBeenCalledWith({
        where: { id: CADENCE_ID, business_id: BUSINESS_ID, deleted_at: null },
      });
    });

    it('lists a tenant’s live cadences oldest first when unfiltered', async () => {
      await repository.listCadences(BUSINESS_ID);

      expect(prisma.realty_cadences.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, deleted_at: null },
        orderBy: { created_at: 'asc' },
      });
    });

    it('filters the list by trigger', async () => {
      await repository.listCadences(BUSINESS_ID, { trigger: 'POST_VISIT' });

      expect(prisma.realty_cadences.findMany.mock.calls[0]![0].where).toMatchObject({
        trigger: 'POST_VISIT',
      });
    });

    it('ignores an empty trigger filter', async () => {
      await repository.listCadences(BUSINESS_ID, { trigger: '' });

      expect(prisma.realty_cadences.findMany.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
    });

    it('resolves the trigger’s enrolment target as the oldest active cadence', async () => {
      // "First match" has to be deterministic — two active cadences on one
      // trigger must always enrol into the same one.
      await repository.findActiveCadenceByTrigger(BUSINESS_ID, 'DORMANT');

      expect(prisma.realty_cadences.findFirst).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          trigger: 'DORMANT',
          is_active: true,
          deleted_at: null,
        },
        orderBy: { created_at: 'asc' },
      });
    });

    it('returns null when no active cadence serves the trigger', async () => {
      await expect(
        repository.findActiveCadenceByTrigger(BUSINESS_ID, 'DORMANT'),
      ).resolves.toBeNull();
    });
  });

  describe('cadence writes', () => {
    it('scopes an update to the tenant', async () => {
      await repository.updateCadence(BUSINESS_ID, CADENCE_ID, { is_active: false });

      expect(prisma.realty_cadences.update).toHaveBeenCalledWith({
        where: { id: CADENCE_ID, business_id: BUSINESS_ID },
        data: { is_active: false },
      });
    });

    it('soft-deletes by stamping deleted_at', async () => {
      await repository.softDeleteCadence(BUSINESS_ID, CADENCE_ID);

      const call = prisma.realty_cadences.update.mock.calls[0]![0];
      expect(call.where).toEqual({ id: CADENCE_ID, business_id: BUSINESS_ID });
      expect(call.data.deleted_at).toBeInstanceOf(Date);
    });
  });

  // ─────────────────────────────────────────────
  // Steps
  // ─────────────────────────────────────────────

  describe('createStep', () => {
    const base = {
      businessId: BUSINESS_ID,
      cadenceId: CADENCE_ID,
      templateId: TEMPLATE_ID,
      stepOrder: 0,
      dayOffset: 1,
      stopOn: ['REPLY'] as never,
    };

    it('defaults an absent condition to an empty guard', async () => {
      // The engine reads `condition ?? {}` as "always run"; a null column would
      // work but an explicit {} keeps the JSON shape uniform.
      await repository.createStep(base);

      expect(prisma.realty_cadence_steps.create.mock.calls[0]![0].data).toMatchObject({
        business_id: BUSINESS_ID,
        cadence_id: CADENCE_ID,
        template_id: TEMPLATE_ID,
        step_order: 0,
        day_offset: 1,
        condition: {},
        stop_on: ['REPLY'],
      });
    });

    it('keeps a supplied condition', async () => {
      await repository.createStep({ ...base, condition: { stageIn: ['NEW'] } });

      expect(prisma.realty_cadence_steps.create.mock.calls[0]![0].data.condition).toEqual({
        stageIn: ['NEW'],
      });
    });
  });

  describe('createSteps', () => {
    it('issues no query for an empty step list', async () => {
      await repository.createSteps([]);

      expect(prisma.realty_cadence_steps.createMany).not.toHaveBeenCalled();
    });

    it('defaults each step’s absent condition to an empty guard', async () => {
      await repository.createSteps([
        {
          businessId: BUSINESS_ID,
          cadenceId: CADENCE_ID,
          templateId: TEMPLATE_ID,
          stepOrder: 0,
          dayOffset: 1,
          stopOn: [] as never,
        },
        {
          businessId: BUSINESS_ID,
          cadenceId: CADENCE_ID,
          templateId: TEMPLATE_ID,
          stepOrder: 1,
          dayOffset: 3,
          condition: { stageIn: ['NEW'] },
          stopOn: [] as never,
        },
      ]);

      const rows = prisma.realty_cadence_steps.createMany.mock.calls[0]![0].data;
      expect(rows).toHaveLength(2);
      expect(rows[0].condition).toEqual({});
      expect(rows[1].condition).toEqual({ stageIn: ['NEW'] });
    });
  });

  describe('step reads and deletes', () => {
    it('lists a cadence’s live steps in order with their templates joined', async () => {
      await repository.listStepsByCadence(BUSINESS_ID, CADENCE_ID);

      expect(prisma.realty_cadence_steps.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, cadence_id: CADENCE_ID, deleted_at: null },
        orderBy: { step_order: 'asc' },
        include: { template: true },
      });
    });

    it('soft-deletes a cadence’s steps in one statement', async () => {
      await repository.deleteStepsByCadence(BUSINESS_ID, CADENCE_ID);

      const call = prisma.realty_cadence_steps.updateMany.mock.calls[0]![0];
      expect(call.where).toEqual({
        business_id: BUSINESS_ID,
        cadence_id: CADENCE_ID,
        deleted_at: null,
      });
      expect(call.data.deleted_at).toBeInstanceOf(Date);
    });
  });

  // ─────────────────────────────────────────────
  // Enrollments
  // ─────────────────────────────────────────────

  describe('createEnrollment', () => {
    it('starts an enrolment ACTIVE at step 0 with a start stamp', async () => {
      const nextRunAt = new Date('2026-04-02T09:00:00Z');

      await repository.createEnrollment({
        businessId: BUSINESS_ID,
        cadenceId: CADENCE_ID,
        leadId: LEAD_ID,
        trigger: 'NO_RESPONSE' as never,
        nextRunAt,
      });

      const data = prisma.realty_cadence_enrollments.create.mock.calls[0]![0].data;
      expect(data).toMatchObject({
        business_id: BUSINESS_ID,
        cadence_id: CADENCE_ID,
        lead_id: LEAD_ID,
        trigger: 'NO_RESPONSE',
        next_run_at: nextRunAt,
        status: 'ACTIVE',
        current_step: 0,
      });
      expect(data.started_at).toBeInstanceOf(Date);
    });

    it('accepts a null next run (nothing scheduled yet)', async () => {
      await repository.createEnrollment({
        businessId: BUSINESS_ID,
        cadenceId: CADENCE_ID,
        leadId: LEAD_ID,
        trigger: 'NO_RESPONSE' as never,
        nextRunAt: null,
      });

      expect(
        prisma.realty_cadence_enrollments.create.mock.calls[0]![0].data.next_run_at,
      ).toBeNull();
    });
  });

  describe('enrollment reads', () => {
    it('finds by id within the tenant', async () => {
      await repository.findEnrollmentById(BUSINESS_ID, ENROLLMENT_ID);

      // Enrollments are terminal, never soft-deleted — no deleted_at clause.
      expect(prisma.realty_cadence_enrollments.findFirst).toHaveBeenCalledWith({
        where: { id: ENROLLMENT_ID, business_id: BUSINESS_ID },
      });
    });

    it('finds a lead’s active enrolments within the tenant', async () => {
      await repository.findActiveEnrollmentsForLead(BUSINESS_ID, LEAD_ID);

      expect(prisma.realty_cadence_enrollments.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, lead_id: LEAD_ID, status: 'ACTIVE' },
      });
    });

    it('counts a tenant’s active enrolments', async () => {
      prisma.realty_cadence_enrollments.count.mockResolvedValue(4);

      await expect(repository.countActiveEnrollments(BUSINESS_ID)).resolves.toBe(4);
      expect(prisma.realty_cadence_enrollments.count).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, status: 'ACTIVE' },
      });
    });
  });

  describe('findDueEnrollments', () => {
    const now = new Date('2026-04-02T09:00:00Z');

    it('sweeps every tenant when no business is given (the scheduler tick)', async () => {
      await repository.findDueEnrollments(now);

      const call = prisma.realty_cadence_enrollments.findMany.mock.calls[0]![0];
      expect(call.where).toEqual({
        status: 'ACTIVE',
        next_run_at: { not: null, lte: now },
      });
      expect(call.where).not.toHaveProperty('business_id');
    });

    it('narrows to one tenant when a business is given (the manual run)', async () => {
      await repository.findDueEnrollments(now, BUSINESS_ID);

      expect(prisma.realty_cadence_enrollments.findMany.mock.calls[0]![0].where).toMatchObject({
        business_id: BUSINESS_ID,
      });
    });

    it('takes the oldest-due first and caps the batch', async () => {
      // An unbounded tick would pull the whole backlog into one job.
      await repository.findDueEnrollments(now);

      expect(prisma.realty_cadence_enrollments.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { next_run_at: 'asc' }, take: 500 }),
      );
    });
  });

  describe('listEnrollments', () => {
    it('lists a tenant’s enrolments newest first, capped', async () => {
      await repository.listEnrollments(BUSINESS_ID);

      expect(prisma.realty_cadence_enrollments.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID },
        orderBy: { started_at: 'desc' },
        take: 200,
      });
    });

    it('filters by lead alone', async () => {
      await repository.listEnrollments(BUSINESS_ID, { leadId: LEAD_ID });

      const where = prisma.realty_cadence_enrollments.findMany.mock.calls[0]![0].where;
      expect(where).toMatchObject({ lead_id: LEAD_ID });
      expect(where).not.toHaveProperty('status');
    });

    it('filters by status alone', async () => {
      await repository.listEnrollments(BUSINESS_ID, { status: 'STOPPED' });

      const where = prisma.realty_cadence_enrollments.findMany.mock.calls[0]![0].where;
      expect(where).toMatchObject({ status: 'STOPPED' });
      expect(where).not.toHaveProperty('lead_id');
    });

    it('combines both filters', async () => {
      await repository.listEnrollments(BUSINESS_ID, { leadId: LEAD_ID, status: 'ACTIVE' });

      expect(prisma.realty_cadence_enrollments.findMany.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
        lead_id: LEAD_ID,
        status: 'ACTIVE',
      });
    });

    it('ignores empty filter strings', async () => {
      await repository.listEnrollments(BUSINESS_ID, { leadId: '', status: '' });

      expect(prisma.realty_cadence_enrollments.findMany.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
      });
    });
  });

  describe('updateEnrollment', () => {
    /** The column patch the repository built from the DTO. */
    function patch(): Record<string, unknown> {
      return prisma.realty_cadence_enrollments.update.mock.calls[0]![0].data;
    }

    it('sends an empty patch when the DTO is empty', async () => {
      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, {});

      expect(patch()).toEqual({});
    });

    it('scopes the write to the tenant', async () => {
      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, { currentStep: 1 });

      expect(prisma.realty_cadence_enrollments.update.mock.calls[0]![0].where).toEqual({
        id: ENROLLMENT_ID,
        business_id: BUSINESS_ID,
      });
    });

    it('maps status onto its column', async () => {
      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, { status: 'STOPPED' as never });

      expect(patch()).toEqual({ status: 'STOPPED' });
    });

    it('keeps a zero current step rather than dropping it', async () => {
      // `current_step: 0` is the first step, not "unset".
      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, { currentStep: 0 });

      expect(patch()).toEqual({ current_step: 0 });
    });

    it('clears next_run_at when passed null', async () => {
      // Terminating an enrolment must unschedule it, or the tick re-picks it up.
      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, { nextRunAt: null });

      expect(patch()).toEqual({ next_run_at: null });
    });

    it('sets next_run_at when passed a date', async () => {
      const nextRunAt = new Date('2026-04-05T09:00:00Z');

      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, { nextRunAt });

      expect(patch()).toEqual({ next_run_at: nextRunAt });
    });

    it('maps the stop reason, including an explicit clear', async () => {
      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, { stopReason: 'opted_out' });
      expect(patch()).toEqual({ stop_reason: 'opted_out' });

      prisma.realty_cadence_enrollments.update.mockClear();
      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, { stopReason: null });
      expect(patch()).toEqual({ stop_reason: null });
    });

    it('maps the last-sent stamp, including an explicit clear', async () => {
      const lastStepSentAt = new Date('2026-04-03T09:00:00Z');

      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, { lastStepSentAt });
      expect(patch()).toEqual({ last_step_sent_at: lastStepSentAt });

      prisma.realty_cadence_enrollments.update.mockClear();
      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, { lastStepSentAt: null });
      expect(patch()).toEqual({ last_step_sent_at: null });
    });

    it('maps the completion stamp, including an explicit clear', async () => {
      const completedAt = new Date('2026-04-09T09:00:00Z');

      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, { completedAt });
      expect(patch()).toEqual({ completed_at: completedAt });

      prisma.realty_cadence_enrollments.update.mockClear();
      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, { completedAt: null });
      expect(patch()).toEqual({ completed_at: null });
    });

    it('maps every field at once — the terminal write the engine emits', async () => {
      const now = new Date('2026-04-09T09:00:00Z');

      await repository.updateEnrollment(BUSINESS_ID, ENROLLMENT_ID, {
        status: 'COMPLETED' as never,
        currentStep: 3,
        nextRunAt: null,
        stopReason: null,
        lastStepSentAt: now,
        completedAt: now,
      });

      expect(patch()).toEqual({
        status: 'COMPLETED',
        current_step: 3,
        next_run_at: null,
        stop_reason: null,
        last_step_sent_at: now,
        completed_at: now,
      });
    });
  });
});
