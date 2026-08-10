import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import type {
  realty_message_templates,
  realty_cadences,
  realty_cadence_steps,
  realty_cadence_enrollments,
} from '@prisma/client';
import { RealtyCadenceRepository } from './realty-cadence.repository';
import type { StepWithTemplate } from './realty-cadence.repository';
import { DEFAULT_TEMPLATES, DEFAULT_CADENCES } from './default-templates';
import {
  CreateTemplateDto,
  UpdateTemplateDto,
  SetTemplateApprovalDto,
  ListTemplatesQueryDto,
  CreateCadenceDto,
  UpdateCadenceDto,
  ListCadencesQueryDto,
  ListEnrollmentsQueryDto,
} from './dto';

// ─────────────────────────────────────────────
// Response DTOs
// ─────────────────────────────────────────────

export interface TemplateResponseDto {
  id: string;
  name: string;
  category: string;
  language: string;
  body: string;
  variables: string[];
  approvalStatus: string;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CadenceStepResponseDto {
  id: string;
  order: number;
  dayOffset: number;
  templateId: string;
  templateName: string;
  stopOn: string[];
}

export interface CadenceResponseDto {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  isActive: boolean;
  steps: CadenceStepResponseDto[];
  createdAt: Date;
  updatedAt: Date;
}

export interface EnrollmentResponseDto {
  id: string;
  leadId: string;
  cadenceId: string;
  trigger: string;
  status: string;
  currentStep: number;
  nextRunAt: Date | null;
  stopReason: string | null;
  lastStepSentAt: Date | null;
  startedAt: Date;
  completedAt: Date | null;
}

/**
 * RealtyCadenceService — the management surface for the follow-up engine: the
 * WhatsApp template registry and the declarative cadence definitions. Runtime
 * enrolment/execution lives in CadenceEngineService.
 */
@Injectable()
export class RealtyCadenceService {
  private readonly logger = new Logger(RealtyCadenceService.name);

  constructor(private readonly repository: RealtyCadenceRepository) {}

  // ── Seeding ──────────────────────────────────

  /**
   * Install the pre-built templates (English + Hindi) and 3 default cadences for
   * a tenant. Idempotent: templates/cadences that already exist (by name) are skipped.
   */
  async seedDefaults(businessId: string): Promise<{ templates: number; cadences: number }> {
    let templateCount = 0;
    const byName = new Map<string, string>();

    // One lookup for the whole default set instead of one per template.
    const existingTemplates = await this.repository.findTemplatesByNames(
      businessId,
      DEFAULT_TEMPLATES.map((t) => t.name),
    );
    for (const t of existingTemplates) byName.set(t.name, t.id);

    for (const t of DEFAULT_TEMPLATES) {
      if (byName.has(t.name)) continue;
      const created = await this.repository.createTemplate({
        businessId,
        name: t.name,
        category: t.category as realty_message_templates['category'],
        language: t.language,
        body: t.body,
        variables: t.variables,
        // Seeded templates ship APPROVED so cadences work on day one.
        approvalStatus: 'APPROVED',
      });
      byName.set(t.name, created.id);
      templateCount++;
    }

    let cadenceCount = 0;
    const existingCadences = await this.repository.listCadences(businessId);
    const existingNames = new Set(existingCadences.map((c) => c.name));
    for (const c of DEFAULT_CADENCES) {
      if (existingNames.has(c.name)) continue;
      const cadence = await this.repository.createCadence({
        businessId,
        name: c.name,
        description: c.description,
        trigger: c.trigger as realty_cadences['trigger'],
        isActive: true,
      });
      await this.repository.createSteps(
        c.steps.flatMap((step) => {
          const templateId = byName.get(step.templateName);
          return templateId
            ? [
                {
                  businessId,
                  cadenceId: cadence.id,
                  templateId,
                  stepOrder: step.order,
                  dayOffset: step.dayOffset,
                  stopOn: step.stopOn as realty_cadence_steps['stop_on'],
                },
              ]
            : [];
        }),
      );
      cadenceCount++;
    }

    this.logger.log(
      `Seeded ${templateCount} templates + ${cadenceCount} cadences for business ${businessId}`,
    );
    return { templates: templateCount, cadences: cadenceCount };
  }

  // ── Templates ────────────────────────────────

  async createTemplate(businessId: string, dto: CreateTemplateDto): Promise<TemplateResponseDto> {
    const existing = await this.repository.findTemplateByName(businessId, dto.name);
    if (existing) throw new ConflictException(`A template named "${dto.name}" already exists`);
    const template = await this.repository.createTemplate({
      businessId,
      name: dto.name,
      category: dto.category as realty_message_templates['category'],
      language: dto.language,
      body: dto.body,
      variables: dto.variables,
    });
    return this.mapTemplate(template);
  }

  async listTemplates(businessId: string, query: ListTemplatesQueryDto): Promise<TemplateResponseDto[]> {
    const templates = await this.repository.listTemplates(businessId, {
      category: query.category,
      approvalStatus: query.approvalStatus,
    });
    return templates.map((t) => this.mapTemplate(t));
  }

  async getTemplate(businessId: string, id: string): Promise<TemplateResponseDto> {
    return this.mapTemplate(await this.mustFindTemplate(businessId, id));
  }

  async updateTemplate(
    businessId: string,
    id: string,
    dto: UpdateTemplateDto,
  ): Promise<TemplateResponseDto> {
    await this.mustFindTemplate(businessId, id);
    const d: Record<string, unknown> = {};
    if (dto.name !== undefined) d['name'] = dto.name;
    if (dto.category !== undefined) d['category'] = dto.category;
    if (dto.language !== undefined) d['language'] = dto.language;
    if (dto.body !== undefined) d['body'] = dto.body;
    if (dto.variables !== undefined) d['variables'] = dto.variables;
    // Any content change re-opens approval — a changed template is unverified.
    if (dto.body !== undefined || dto.category !== undefined) {
      d['approval_status'] = 'PENDING';
      d['approved_at'] = null;
    }
    return this.mapTemplate(await this.repository.updateTemplate(businessId, id, d));
  }

  async setTemplateApproval(
    businessId: string,
    id: string,
    dto: SetTemplateApprovalDto,
  ): Promise<TemplateResponseDto> {
    await this.mustFindTemplate(businessId, id);
    const updated = await this.repository.updateTemplate(businessId, id, {
      approval_status: dto.approvalStatus,
      approved_at: dto.approvalStatus === 'APPROVED' ? new Date() : null,
    });
    return this.mapTemplate(updated);
  }

  async deleteTemplate(businessId: string, id: string): Promise<void> {
    await this.mustFindTemplate(businessId, id);
    await this.repository.softDeleteTemplate(businessId, id);
  }

  // ── Cadences ─────────────────────────────────

  async createCadence(businessId: string, dto: CreateCadenceDto): Promise<CadenceResponseDto> {
    // Every referenced template must exist and belong to the tenant.
    await this.assertTemplatesExist(businessId, dto.steps);
    const cadence = await this.repository.createCadence({
      businessId,
      name: dto.name,
      description: dto.description,
      trigger: dto.trigger as realty_cadences['trigger'],
      isActive: dto.isActive ?? true,
    });
    await this.writeSteps(businessId, cadence.id, dto.steps);
    return this.getCadence(businessId, cadence.id);
  }

  async listCadences(businessId: string, query: ListCadencesQueryDto): Promise<CadenceResponseDto[]> {
    const cadences = await this.repository.listCadences(businessId, { trigger: query.trigger });
    // Two queries regardless of how many cadences come back, rather than one
    // per cadence.
    const stepsByCadence = await this.repository.listStepsByCadences(
      businessId,
      cadences.map((c) => c.id),
    );
    return cadences.map((c) => this.buildCadence(c, stepsByCadence.get(c.id) ?? []));
  }

  async getCadence(businessId: string, id: string): Promise<CadenceResponseDto> {
    const cadence = await this.mustFindCadence(businessId, id);
    return this.assembleCadence(businessId, cadence);
  }

  async updateCadence(
    businessId: string,
    id: string,
    dto: UpdateCadenceDto,
  ): Promise<CadenceResponseDto> {
    await this.mustFindCadence(businessId, id);
    const d: Record<string, unknown> = {};
    if (dto.name !== undefined) d['name'] = dto.name;
    if (dto.description !== undefined) d['description'] = dto.description;
    if (dto.isActive !== undefined) d['is_active'] = dto.isActive;
    if (Object.keys(d).length) await this.repository.updateCadence(businessId, id, d);

    if (dto.steps !== undefined) {
      await this.assertTemplatesExist(businessId, dto.steps);
      await this.repository.deleteStepsByCadence(businessId, id);
      await this.writeSteps(businessId, id, dto.steps);
    }
    return this.getCadence(businessId, id);
  }

  async deleteCadence(businessId: string, id: string): Promise<void> {
    await this.mustFindCadence(businessId, id);
    await this.repository.softDeleteCadence(businessId, id);
  }

  // ── Enrollments (read-only surface) ──────────

  async listEnrollments(
    businessId: string,
    query: ListEnrollmentsQueryDto,
  ): Promise<EnrollmentResponseDto[]> {
    const rows = await this.repository.listEnrollments(businessId, {
      leadId: query.leadId,
      status: query.status,
    });
    return rows.map((e) => this.mapEnrollment(e));
  }

  // ── Helpers ──────────────────────────────────

  private async writeSteps(
    businessId: string,
    cadenceId: string,
    steps: CreateCadenceDto['steps'],
  ): Promise<void> {
    const ordered = [...steps].sort((a, b) => a.order - b.order);
    await this.repository.createSteps(
      ordered.map((step) => ({
        businessId,
        cadenceId,
        templateId: step.templateId,
        stepOrder: step.order,
        dayOffset: step.dayOffset,
        stopOn: (step.stopOn ?? []) as realty_cadence_steps['stop_on'],
      })),
    );
  }

  private async assembleCadence(
    businessId: string,
    cadence: realty_cadences,
  ): Promise<CadenceResponseDto> {
    const steps = await this.repository.listStepsByCadence(businessId, cadence.id);
    return this.buildCadence(cadence, steps);
  }

  /** Shape a cadence + its already-loaded steps into the response DTO. */
  private buildCadence(
    cadence: realty_cadences,
    steps: StepWithTemplate[],
  ): CadenceResponseDto {
    return {
      id: cadence.id,
      name: cadence.name,
      description: cadence.description,
      trigger: cadence.trigger,
      isActive: cadence.is_active,
      steps: steps.map((s) => this.mapStep(s)),
      createdAt: cadence.created_at,
      updatedAt: cadence.updated_at,
    };
  }

  /**
   * Reject the write unless every referenced template exists for this tenant.
   * One query for the whole step list; the first missing id is reported so the
   * message matches the per-step check this replaced.
   */
  private async assertTemplatesExist(
    businessId: string,
    steps: { templateId: string }[],
  ): Promise<void> {
    const ids = steps.map((s) => s.templateId);
    const found = await this.repository.findTemplatesByIds(businessId, ids);
    const known = new Set(found.map((t) => t.id));
    const missing = ids.find((id) => !known.has(id));
    if (missing) throw new NotFoundException(`Template ${missing} not found`);
  }

  private async mustFindTemplate(businessId: string, id: string): Promise<realty_message_templates> {
    const t = await this.repository.findTemplateById(businessId, id);
    if (!t) throw new NotFoundException(`Template ${id} not found`);
    return t;
  }

  private async mustFindCadence(businessId: string, id: string): Promise<realty_cadences> {
    const c = await this.repository.findCadenceById(businessId, id);
    if (!c) throw new NotFoundException(`Cadence ${id} not found`);
    return c;
  }

  private mapTemplate(t: realty_message_templates): TemplateResponseDto {
    return {
      id: t.id,
      name: t.name,
      category: t.category,
      language: t.language,
      body: t.body,
      variables: t.variables ?? [],
      approvalStatus: t.approval_status,
      approvedAt: t.approved_at,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    };
  }

  private mapStep(s: StepWithTemplate): CadenceStepResponseDto {
    return {
      id: s.id,
      order: s.step_order,
      dayOffset: s.day_offset,
      templateId: s.template_id,
      templateName: s.template.name,
      stopOn: s.stop_on ?? [],
    };
  }

  private mapEnrollment(e: realty_cadence_enrollments): EnrollmentResponseDto {
    return {
      id: e.id,
      leadId: e.lead_id,
      cadenceId: e.cadence_id,
      trigger: e.trigger,
      status: e.status,
      currentStep: e.current_step,
      nextRunAt: e.next_run_at,
      stopReason: e.stop_reason,
      lastStepSentAt: e.last_step_sent_at,
      startedAt: e.started_at,
      completedAt: e.completed_at,
    };
  }
}
