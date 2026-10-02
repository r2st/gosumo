import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  realty_message_templates,
  realty_cadences,
  realty_cadence_steps,
  realty_cadence_enrollments,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface CreateTemplateData {
  businessId: string;
  name: string;
  category: realty_message_templates['category'];
  language: string;
  body: string;
  variables?: string[];
  approvalStatus?: realty_message_templates['approval_status'];
}

export interface CreateCadenceData {
  businessId: string;
  name: string;
  description?: string | null;
  trigger: realty_cadences['trigger'];
  isActive?: boolean;
}

export interface CreateStepData {
  businessId: string;
  cadenceId: string;
  templateId: string;
  stepOrder: number;
  dayOffset: number;
  condition?: Prisma.InputJsonValue;
  stopOn: realty_cadence_steps['stop_on'];
}

export interface CreateEnrollmentData {
  businessId: string;
  cadenceId: string;
  leadId: string;
  trigger: realty_cadence_enrollments['trigger'];
  nextRunAt: Date | null;
}

export interface UpdateEnrollmentData {
  status?: realty_cadence_enrollments['status'];
  currentStep?: number;
  nextRunAt?: Date | null;
  stopReason?: string | null;
  lastStepSentAt?: Date | null;
  completedAt?: Date | null;
}

/** Step joined with its (approved-or-not) template — what the engine needs. */
export type StepWithTemplate = realty_cadence_steps & {
  template: realty_message_templates;
};

/**
 * RealtyCadenceRepository — all Prisma access for the cadence tables.
 * Every query is scoped by business_id; soft-deleted rows are excluded.
 */
@Injectable()
export class RealtyCadenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Templates ────────────────────────────────

  async createTemplate(data: CreateTemplateData): Promise<realty_message_templates> {
    return this.prisma.realty_message_templates.create({
      data: {
        business_id: data.businessId,
        name: data.name,
        category: data.category,
        language: data.language,
        body: data.body,
        variables: data.variables ?? [],
        approval_status: data.approvalStatus ?? 'PENDING',
        approved_at: data.approvalStatus === 'APPROVED' ? new Date() : null,
      },
    });
  }

  async findTemplateById(businessId: string, id: string): Promise<realty_message_templates | null> {
    return this.prisma.realty_message_templates.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async findTemplateByName(businessId: string, name: string): Promise<realty_message_templates | null> {
    return this.prisma.realty_message_templates.findFirst({
      where: { name, business_id: businessId, deleted_at: null },
    });
  }

  /** Resolve many templates by name — used by the idempotent seeder. */
  async findTemplatesByNames(
    businessId: string,
    names: string[],
  ): Promise<realty_message_templates[]> {
    if (names.length === 0) return [];
    return this.prisma.realty_message_templates.findMany({
      where: { name: { in: [...new Set(names)] }, business_id: businessId, deleted_at: null },
    });
  }

  /**
   * Resolve many templates at once.
   *
   * Cadence writes validate every referenced template before touching the
   * cadence row; doing that with findTemplateById per step cost one round trip
   * per step on a request that already knows the full id set upfront.
   */
  async findTemplatesByIds(
    businessId: string,
    ids: string[],
  ): Promise<realty_message_templates[]> {
    if (ids.length === 0) return [];
    return this.prisma.realty_message_templates.findMany({
      where: { id: { in: [...new Set(ids)] }, business_id: businessId, deleted_at: null },
    });
  }

  async listTemplates(
    businessId: string,
    filters: { category?: string; approvalStatus?: string } = {},
  ): Promise<realty_message_templates[]> {
    const where: Prisma.realty_message_templatesWhereInput = {
      business_id: businessId,
      deleted_at: null,
    };
    if (filters.category) where.category = filters.category as realty_message_templates['category'];
    if (filters.approvalStatus)
      where.approval_status = filters.approvalStatus as realty_message_templates['approval_status'];
    return this.prisma.realty_message_templates.findMany({ where, orderBy: { name: 'asc' }, take: 200 });
  }

  async updateTemplate(
    businessId: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<realty_message_templates> {
    return this.prisma.realty_message_templates.update({ where: { id, business_id: businessId }, data });
  }

  async softDeleteTemplate(businessId: string, id: string): Promise<realty_message_templates> {
    return this.prisma.realty_message_templates.update({
      where: { id, business_id: businessId },
      data: { deleted_at: new Date() },
    });
  }

  // ── Cadences ─────────────────────────────────

  async createCadence(data: CreateCadenceData): Promise<realty_cadences> {
    return this.prisma.realty_cadences.create({
      data: {
        business_id: data.businessId,
        name: data.name,
        description: data.description ?? null,
        trigger: data.trigger,
        is_active: data.isActive ?? true,
      },
    });
  }

  async findCadenceById(businessId: string, id: string): Promise<realty_cadences | null> {
    return this.prisma.realty_cadences.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async listCadences(businessId: string, filters: { trigger?: string } = {}): Promise<realty_cadences[]> {
    const where: Prisma.realty_cadencesWhereInput = { business_id: businessId, deleted_at: null };
    if (filters.trigger) where.trigger = filters.trigger as realty_cadences['trigger'];
    return this.prisma.realty_cadences.findMany({ where, orderBy: { created_at: 'asc' }, take: 200 });
  }

  /** The active cadence to enrol a lead into for a given trigger (first match). */
  async findActiveCadenceByTrigger(
    businessId: string,
    trigger: realty_cadences['trigger'],
  ): Promise<realty_cadences | null> {
    return this.prisma.realty_cadences.findFirst({
      where: { business_id: businessId, trigger, is_active: true, deleted_at: null },
      orderBy: { created_at: 'asc' },
    });
  }

  async updateCadence(businessId: string, id: string, data: Record<string, unknown>): Promise<realty_cadences> {
    return this.prisma.realty_cadences.update({ where: { id, business_id: businessId }, data });
  }

  async softDeleteCadence(businessId: string, id: string): Promise<realty_cadences> {
    return this.prisma.realty_cadences.update({ where: { id, business_id: businessId }, data: { deleted_at: new Date() } });
  }

  // ── Steps ────────────────────────────────────

  async createStep(data: CreateStepData): Promise<realty_cadence_steps> {
    return this.prisma.realty_cadence_steps.create({
      data: {
        business_id: data.businessId,
        cadence_id: data.cadenceId,
        template_id: data.templateId,
        step_order: data.stepOrder,
        day_offset: data.dayOffset,
        condition: data.condition ?? {},
        stop_on: data.stopOn,
      },
    });
  }

  /**
   * Insert a cadence's steps in one statement.
   *
   * `createMany` skips the per-row round trip that writing steps in a loop
   * incurred, and keeps a partially-written cadence from surviving a failure
   * halfway through the list.
   */
  async createSteps(steps: CreateStepData[]): Promise<void> {
    if (steps.length === 0) return;
    await this.prisma.realty_cadence_steps.createMany({
      data: steps.map((s) => ({
        business_id: s.businessId,
        cadence_id: s.cadenceId,
        template_id: s.templateId,
        step_order: s.stepOrder,
        day_offset: s.dayOffset,
        condition: s.condition ?? {},
        stop_on: s.stopOn,
      })),
    });
  }

  async listStepsByCadence(businessId: string, cadenceId: string): Promise<StepWithTemplate[]> {
    return this.prisma.realty_cadence_steps.findMany({
      where: { business_id: businessId, cadence_id: cadenceId, deleted_at: null },
      orderBy: { step_order: 'asc' },
      include: { template: true },
    });
  }

  /**
   * Steps for many cadences in one query, keyed by cadence id.
   *
   * `listCadences` assembles a response per cadence; fetching steps per cadence
   * meant the list endpoint issued one query per row it returned.
   */
  async listStepsByCadences(
    businessId: string,
    cadenceIds: string[],
  ): Promise<Map<string, StepWithTemplate[]>> {
    const grouped = new Map<string, StepWithTemplate[]>();
    if (cadenceIds.length === 0) return grouped;

    const steps = await this.prisma.realty_cadence_steps.findMany({
      where: { business_id: businessId, cadence_id: { in: cadenceIds }, deleted_at: null },
      orderBy: [{ cadence_id: 'asc' }, { step_order: 'asc' }],
      include: { template: true },
    });

    for (const step of steps) {
      const bucket = grouped.get(step.cadence_id);
      if (bucket) bucket.push(step);
      else grouped.set(step.cadence_id, [step]);
    }
    return grouped;
  }

  async deleteStepsByCadence(businessId: string, cadenceId: string): Promise<void> {
    await this.prisma.realty_cadence_steps.updateMany({
      where: { business_id: businessId, cadence_id: cadenceId, deleted_at: null },
      data: { deleted_at: new Date() },
    });
  }

  // ── Enrollments ──────────────────────────────

  async createEnrollment(data: CreateEnrollmentData): Promise<realty_cadence_enrollments> {
    return this.prisma.realty_cadence_enrollments.create({
      data: {
        business_id: data.businessId,
        cadence_id: data.cadenceId,
        lead_id: data.leadId,
        trigger: data.trigger,
        next_run_at: data.nextRunAt,
        status: 'ACTIVE',
        current_step: 0,
        started_at: new Date(),
      },
    });
  }

  async findEnrollmentById(businessId: string, id: string): Promise<realty_cadence_enrollments | null> {
    return this.prisma.realty_cadence_enrollments.findFirst({
      where: { id, business_id: businessId },
    });
  }

  async findActiveEnrollmentsForLead(
    businessId: string,
    leadId: string,
  ): Promise<realty_cadence_enrollments[]> {
    return this.prisma.realty_cadence_enrollments.findMany({
      where: { business_id: businessId, lead_id: leadId, status: 'ACTIVE' },
    });
  }

  /** Active enrollments whose next step is due (next_run_at ≤ now). */
  async findDueEnrollments(now: Date, businessId?: string): Promise<realty_cadence_enrollments[]> {
    return this.prisma.realty_cadence_enrollments.findMany({
      where: {
        ...(businessId ? { business_id: businessId } : {}),
        status: 'ACTIVE',
        next_run_at: { not: null, lte: now },
      },
      orderBy: { next_run_at: 'asc' },
      take: 500,
    });
  }

  async listEnrollments(
    businessId: string,
    filters: { leadId?: string; status?: string } = {},
  ): Promise<realty_cadence_enrollments[]> {
    const where: Prisma.realty_cadence_enrollmentsWhereInput = { business_id: businessId };
    if (filters.leadId) where.lead_id = filters.leadId;
    if (filters.status) where.status = filters.status as realty_cadence_enrollments['status'];
    return this.prisma.realty_cadence_enrollments.findMany({
      where,
      orderBy: { started_at: 'desc' },
      take: 200,
    });
  }

  async updateEnrollment(
    businessId: string,
    id: string,
    data: UpdateEnrollmentData,
  ): Promise<realty_cadence_enrollments> {
    const d: Record<string, unknown> = {};
    if (data.status !== undefined) d['status'] = data.status;
    if (data.currentStep !== undefined) d['current_step'] = data.currentStep;
    if (data.nextRunAt !== undefined) d['next_run_at'] = data.nextRunAt;
    if (data.stopReason !== undefined) d['stop_reason'] = data.stopReason;
    if (data.lastStepSentAt !== undefined) d['last_step_sent_at'] = data.lastStepSentAt;
    if (data.completedAt !== undefined) d['completed_at'] = data.completedAt;
    return this.prisma.realty_cadence_enrollments.update({ where: { id, business_id: businessId }, data: d });
  }

  async countActiveEnrollments(businessId: string): Promise<number> {
    return this.prisma.realty_cadence_enrollments.count({
      where: { business_id: businessId, status: 'ACTIVE' },
    });
  }
}
