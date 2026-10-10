import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { canned_responses } from '@prisma/client';
import { CannedResponseApprovalStatus } from '@gosumo/database';
import { ChannelType, generateId, generateCorrelationId } from '@gosumo/shared';
import type { CannedResponseUsedEvent } from '@gosumo/shared';
import { CannedResponseRepository } from './canned-response.repository';
import {
  RenderedTemplate,
  TemplateVariableSpec,
  reconcileVariables,
  renderTemplate,
} from './template-variables.util';
import {
  CreateCannedResponseDto,
  UpdateCannedResponseDto,
  ListCannedResponsesQueryDto,
  CannedResponseDto,
  PaginatedCannedResponsesDto,
} from './dto';

/**
 * CannedResponseService — reusable, pre-written replies agents can insert
 * into a conversation, triggered by a slash-command style shortcut.
 */
@Injectable()
export class CannedResponseService {
  constructor(
    private readonly repository: CannedResponseRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(
    businessId: string,
    dto: CreateCannedResponseDto,
    createdBy?: string,
  ): Promise<CannedResponseDto> {
    const shortcut = dto.shortcut.toLowerCase();
    const existing = await this.repository.findByShortcut(businessId, shortcut);
    if (existing) {
      throw new ConflictException(`A canned response with shortcut "${shortcut}" already exists`);
    }

    // Derived from the body, never taken from the caller wholesale — see
    // `reconcileVariables`. A new response starts as a DRAFT (the column
    // default), so it cannot be inserted into a conversation until reviewed.
    const variables = reconcileVariables(dto.content, dto.variables);
    const data = { ...dto, shortcut, createdBy, variables };

    // Deleting a canned response is a soft delete, but the `(business_id,
    // shortcut)` unique index still counts the deleted row — so re-creating a
    // shortcut that was deleted would fail the insert and surface as "already
    // exists" for a response the operator cannot see anywhere. Reuse the freed
    // shortcut by reviving that row as the new response instead.
    const deleted = await this.repository.findDeletedByShortcut(businessId, shortcut);
    if (deleted) {
      const revived = await this.repository.restore(businessId, deleted.id, data);
      return this.toDto(revived);
    }

    try {
      const created = await this.repository.create(businessId, data);
      return this.toDto(created);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`A canned response with shortcut "${shortcut}" already exists`);
      }
      throw err;
    }
  }

  async list(businessId: string, query: ListCannedResponsesQueryDto): Promise<PaginatedCannedResponsesDto> {
    const result = await this.repository.findMany(businessId, query);
    return {
      data: result.data.map((r) => this.toDto(r)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  async get(businessId: string, id: string): Promise<CannedResponseDto> {
    const entity = await this.getEntity(businessId, id);
    return this.toDto(entity);
  }

  async getByShortcut(businessId: string, shortcut: string): Promise<CannedResponseDto> {
    const entity = await this.repository.findByShortcut(businessId, shortcut.toLowerCase());
    if (!entity) {
      throw new NotFoundException('Canned response not found');
    }
    return this.toDto(entity);
  }

  /**
   * Update a response.
   *
   * **Editing the body withdraws an existing approval.** Without that rule the
   * review is a one-time rubber stamp on an id rather than on a message: get a
   * harmless template approved, then edit it into anything at all, and it keeps
   * shipping to customers with an approver's name on it. Only a content change
   * does this — renaming a response or recategorizing it does not change what
   * gets sent, and forcing a re-review for those would train reviewers to
   * approve without reading.
   */
  async update(
    businessId: string,
    id: string,
    dto: UpdateCannedResponseDto,
  ): Promise<CannedResponseDto> {
    const existing = await this.getEntity(businessId, id);

    // `variables` is pulled out of the spread: what reaches the column is always
    // the reconciled list, never the caller's array as sent.
    const { variables: declared, ...rest } = dto;
    const contentChanged = dto.content !== undefined && dto.content !== existing.content;
    const nextContent = dto.content ?? existing.content;
    const variablesChanged = dto.content !== undefined || declared !== undefined;

    const updated = await this.repository.update(businessId, id, {
      ...rest,
      ...(variablesChanged
        ? {
            variables: reconcileVariables(
              nextContent,
              declared ?? this.variablesOf(existing),
            ),
          }
        : {}),
      ...(contentChanged && existing.approval_status === CannedResponseApprovalStatus.APPROVED
        ? {
            approvalStatus: CannedResponseApprovalStatus.DRAFT,
            reviewedBy: null,
            reviewedAt: null,
            reviewNote: 'Approval withdrawn automatically: the content was edited',
          }
        : {}),
    });

    return this.toDto(updated);
  }

  // ─────────────────────────────────────────────
  // Approval workflow
  // ─────────────────────────────────────────────

  /**
   * Submit a draft for review. Valid from DRAFT or REJECTED — a rejection is
   * feedback to act on, not a dead end.
   */
  async submitForApproval(
    businessId: string,
    id: string,
    actorId?: string,
  ): Promise<CannedResponseDto> {
    const entity = await this.getEntity(businessId, id);
    this.requireStatus(entity, [
      CannedResponseApprovalStatus.DRAFT,
      CannedResponseApprovalStatus.REJECTED,
    ]);

    const updated = await this.repository.update(businessId, id, {
      approvalStatus: CannedResponseApprovalStatus.PENDING,
      submittedBy: actorId ?? null,
      submittedAt: new Date(),
      // Cleared so the reviewer's screen does not show the previous
      // rejection's note beside a resubmission that answered it.
      reviewNote: null,
      reviewedBy: null,
      reviewedAt: null,
    });

    this.emitApproval('canned_response.submitted', businessId, id, actorId);
    return this.toDto(updated);
  }

  /**
   * Approve a pending response, making it usable.
   *
   * A manager approving their own submission is permitted. Most GoSumo tenants
   * are small businesses with exactly one manager, and a rule that needs two
   * would mean those businesses could never approve anything — so the control
   * this endpoint actually provides is the record of who approved what, which
   * `reviewed_by` carries either way.
   */
  async approve(
    businessId: string,
    id: string,
    actorId?: string,
    note?: string,
  ): Promise<CannedResponseDto> {
    const entity = await this.getEntity(businessId, id);
    this.requireStatus(entity, [CannedResponseApprovalStatus.PENDING]);

    const updated = await this.repository.update(businessId, id, {
      approvalStatus: CannedResponseApprovalStatus.APPROVED,
      reviewedBy: actorId ?? null,
      reviewedAt: new Date(),
      reviewNote: note ?? null,
    });

    this.emitApproval('canned_response.approved', businessId, id, actorId);
    return this.toDto(updated);
  }

  /** Reject a pending response with a note the author can act on. */
  async reject(
    businessId: string,
    id: string,
    note: string,
    actorId?: string,
  ): Promise<CannedResponseDto> {
    const entity = await this.getEntity(businessId, id);
    this.requireStatus(entity, [CannedResponseApprovalStatus.PENDING]);
    if (!note?.trim()) {
      // A rejection with no reason is one the author cannot act on, so it comes
      // straight back as an identical resubmission.
      throw new BadRequestException('A rejection must carry a note explaining why');
    }

    const updated = await this.repository.update(businessId, id, {
      approvalStatus: CannedResponseApprovalStatus.REJECTED,
      reviewedBy: actorId ?? null,
      reviewedAt: new Date(),
      reviewNote: note.trim(),
    });

    this.emitApproval('canned_response.rejected', businessId, id, actorId);
    return this.toDto(updated);
  }

  // ─────────────────────────────────────────────
  // Variables
  // ─────────────────────────────────────────────

  /**
   * Render a response with the agent's values, ready to insert.
   *
   * Refuses when a required variable has no value. The alternative — render it
   * blank and let the agent notice — produces `"your refund of  has been
   * processed"`, which is a sentence nobody wrote and which reads to the
   * customer as a number the business declined to state.
   */
  async render(
    businessId: string,
    id: string,
    values: Record<string, string> = {},
    options: { allowUnapproved?: boolean } = {},
  ): Promise<RenderedTemplate & { id: string; shortcut: string }> {
    const entity = await this.getEntity(businessId, id);
    if (
      !options.allowUnapproved &&
      entity.approval_status !== CannedResponseApprovalStatus.APPROVED
    ) {
      throw new BadRequestException(
        `Canned response "${entity.shortcut}" is ${entity.approval_status} and cannot be used ` +
          'until it is approved',
      );
    }

    const result = renderTemplate(entity.content, values, this.variablesOf(entity));
    if (result.missingRequired.length > 0) {
      throw new BadRequestException(
        `Missing required variable(s): ${result.missingRequired.join(', ')}`,
      );
    }
    return { ...result, id: entity.id, shortcut: entity.shortcut };
  }

  /**
   * Render without the approval gate or the missing-variable refusal, for the
   * author's own preview. Reports what would be missing instead of throwing —
   * previewing a half-written template is the normal case while writing one.
   */
  async preview(
    businessId: string,
    id: string,
    values: Record<string, string> = {},
  ): Promise<RenderedTemplate> {
    const entity = await this.getEntity(businessId, id);
    return renderTemplate(entity.content, values, this.variablesOf(entity));
  }

  async delete(businessId: string, id: string): Promise<void> {
    await this.getEntity(businessId, id);
    await this.repository.softDelete(businessId, id);
  }

  async recordUsage(
    businessId: string,
    id: string,
    conversationId?: string,
    usedBy?: string,
  ): Promise<CannedResponseDto> {
    const entity = await this.getEntity(businessId, id);
    // The gate lives here as well as in `render` because this is the call that
    // records a response as having been *sent*. A client that renders its own
    // body from `content` and then reports usage would otherwise route around
    // the approval workflow entirely.
    if (entity.approval_status !== CannedResponseApprovalStatus.APPROVED) {
      throw new BadRequestException(
        `Canned response "${entity.shortcut}" is ${entity.approval_status} and cannot be used ` +
          'until it is approved',
      );
    }
    const updated = await this.repository.incrementUsage(businessId, id);

    const event: CannedResponseUsedEvent = {
      id: generateId(),
      type: 'canned_response.used',
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      cannedResponseId: id,
      conversationId,
      usedBy,
    };
    this.eventEmitter.emit('canned_response.used', event);

    return this.toDto(updated);
  }

  private async getEntity(businessId: string, id: string): Promise<canned_responses> {
    const entity = await this.repository.findById(businessId, id);
    if (!entity) {
      throw new NotFoundException('Canned response not found');
    }
    return entity;
  }

  /** Guard a workflow transition, naming both the current and the allowed states. */
  private requireStatus(
    entity: canned_responses,
    allowed: CannedResponseApprovalStatus[],
  ): void {
    if (!allowed.includes(entity.approval_status)) {
      throw new BadRequestException(
        `Canned response is ${entity.approval_status}; this action requires it to be ` +
          allowed.join(' or '),
      );
    }
  }

  /** Read the stored variable specs back out of the JSONB column. */
  private variablesOf(entity: canned_responses): TemplateVariableSpec[] {
    return Array.isArray(entity.variables)
      ? (entity.variables as unknown as TemplateVariableSpec[])
      : [];
  }

  private emitApproval(
    type: string,
    businessId: string,
    cannedResponseId: string,
    actorId?: string,
  ): void {
    this.eventEmitter.emit(type, {
      id: generateId(),
      type,
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      cannedResponseId,
      actorId: actorId ?? null,
    });
  }

  private toDto(r: canned_responses): CannedResponseDto {
    return {
      id: r.id,
      title: r.title,
      shortcut: r.shortcut,
      content: r.content,
      category: r.category,
      channel: r.channel as ChannelType | null,
      tags: r.tags,
      isActive: r.is_active,
      usageCount: r.usage_count,
      createdBy: r.created_by,
      variables: this.variablesOf(r),
      approvalStatus: r.approval_status,
      submittedBy: r.submitted_by,
      submittedAt: r.submitted_at?.toISOString() ?? null,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at?.toISOString() ?? null,
      reviewNote: r.review_note,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }
}
