import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { canned_responses } from '@prisma/client';
import { ChannelType, generateId, generateCorrelationId } from '@gosumo/shared';
import type { CannedResponseUsedEvent } from '@gosumo/shared';
import { CannedResponseRepository } from './canned-response.repository';
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

    const data = { ...dto, shortcut, createdBy };

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
      throw new NotFoundException(`Canned response "${shortcut}" not found`);
    }
    return this.toDto(entity);
  }

  async update(businessId: string, id: string, dto: UpdateCannedResponseDto): Promise<CannedResponseDto> {
    await this.getEntity(businessId, id);
    const updated = await this.repository.update(businessId, id, dto);
    return this.toDto(updated);
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
    await this.getEntity(businessId, id);
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
      throw new NotFoundException(`Canned response ${id} not found`);
    }
    return entity;
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
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }
}
