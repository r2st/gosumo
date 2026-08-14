import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { clients, segments } from '@prisma/client';
import { generateId, generateCorrelationId } from '@gosumo/shared';
import type { ContactTaggedEvent } from '@gosumo/shared';
import { ContactRepository, ContactListFilters, SegmentFilter } from './contact.repository';
import {
  ContactResponseDto,
  PaginatedContactsDto,
  ListContactsQueryDto,
  UpdateContactDto,
  CreateSegmentDto,
  UpdateSegmentDto,
  SegmentResponseDto,
  SegmentFilterDto,
} from './dto';

const MAX_TAG_LENGTH = 50;

/**
 * How many segment member-counts to evaluate at once in `listSegments`.
 *
 * Segments are dynamic, so a count is a live `clients` scan per stored filter —
 * there is no membership table to join and no way to fold arbitrary predicates
 * into one query. Fanning every segment out at once let a tenant with dozens of
 * segments open dozens of simultaneous connections on a pool that is shared
 * platform-wide. Four at a time keeps the endpoint fast without that spike.
 */
const SEGMENT_COUNT_CONCURRENCY = 4;

/**
 * ContactService — contact management and segmentation.
 *
 * "Contacts" are the existing `clients` table; this module adds tagging and
 * saved dynamic segments on top of the client records other modules already
 * own. It never creates clients itself (channel-adapter/client-intelligence
 * do that on first inbound message) — only reads and annotates them.
 */
@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(
    private readonly repository: ContactRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ───────────────────────────────────────────────────────────────────
  // Contacts
  // ───────────────────────────────────────────────────────────────────

  async listContacts(businessId: string, query: ListContactsQueryDto): Promise<PaginatedContactsDto> {
    const filters: ContactListFilters = {
      search: query.search,
      tags: query.tags,
      channel: query.channel,
      minLtv: query.minLtv,
      maxChurnRisk: query.maxChurnRisk,
      minEngagement: query.minEngagement,
      hasOrders: query.hasOrders,
      page: query.page,
      limit: query.limit,
    };

    const result = await this.repository.findMany(businessId, filters);
    return {
      data: result.data.map((c) => this.toContactDto(c)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  async getContact(businessId: string, id: string): Promise<ContactResponseDto> {
    const contact = await this.repository.findById(businessId, id);
    if (!contact) {
      throw new NotFoundException(`Contact ${id} not found`);
    }
    return this.toContactDto(contact);
  }

  async updateContact(businessId: string, id: string, dto: UpdateContactDto): Promise<ContactResponseDto> {
    await this.getContact(businessId, id); // 404 guard
    try {
      const updated = await this.repository.update(businessId, id, dto);
      return this.toContactDto(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Another contact already has this email or phone number');
      }
      throw err;
    }
  }

  async addTags(businessId: string, id: string, tags: string[]): Promise<ContactResponseDto> {
    const contact = await this.getContactEntity(businessId, id);
    const normalized = this.normalizeTags(tags);
    const merged = Array.from(new Set([...contact.tags, ...normalized]));
    const updated = await this.repository.setTags(businessId, id, merged);
    this.emitTagged(businessId, id, merged);
    return this.toContactDto(updated);
  }

  async removeTags(businessId: string, id: string, tags: string[]): Promise<ContactResponseDto> {
    const contact = await this.getContactEntity(businessId, id);
    const normalized = new Set(this.normalizeTags(tags));
    const remaining = contact.tags.filter((t) => !normalized.has(t));
    const updated = await this.repository.setTags(businessId, id, remaining);
    this.emitTagged(businessId, id, remaining);
    return this.toContactDto(updated);
  }

  private normalizeTags(tags: string[]): string[] {
    return Array.from(
      new Set(
        tags
          .map((t) => t.trim().toLowerCase().slice(0, MAX_TAG_LENGTH))
          .filter((t) => t.length > 0),
      ),
    );
  }

  private emitTagged(businessId: string, contactId: string, tags: string[]): void {
    const event: ContactTaggedEvent = {
      id: generateId(),
      type: 'contact.tagged',
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      contactId,
      tags,
    };
    this.eventEmitter.emit('contact.tagged', event);
  }

  private async getContactEntity(businessId: string, id: string): Promise<clients> {
    const contact = await this.repository.findById(businessId, id);
    if (!contact) {
      throw new NotFoundException(`Contact ${id} not found`);
    }
    return contact;
  }

  // ───────────────────────────────────────────────────────────────────
  // Segments
  // ───────────────────────────────────────────────────────────────────

  async createSegment(businessId: string, dto: CreateSegmentDto): Promise<SegmentResponseDto> {
    const existing = await this.repository.findSegmentByName(businessId, dto.name);
    if (existing) {
      throw new ConflictException(`A segment named "${dto.name}" already exists`);
    }

    const segment = await this.repository.createSegment(businessId, {
      name: dto.name,
      description: dto.description,
      filter: dto.filter as SegmentFilter,
      isActive: dto.isActive,
    });
    return this.toSegmentDto(businessId, segment);
  }

  async listSegments(businessId: string): Promise<SegmentResponseDto[]> {
    const segments = await this.repository.findSegments(businessId);

    // Segments that store the same filter resolve to the same count, so they
    // share one query; the rest are evaluated in bounded batches.
    const countByFilter = new Map<string, number>();
    const filterByKey = new Map(segments.map((s) => [this.filterKey(s), s.filter]));
    const pending = [...filterByKey.keys()];

    for (let i = 0; i < pending.length; i += SEGMENT_COUNT_CONCURRENCY) {
      const batch = pending.slice(i, i + SEGMENT_COUNT_CONCURRENCY);
      const counts = await Promise.all(
        batch.map((key) =>
          this.repository.countBySegmentFilter(
            businessId,
            filterByKey.get(key) as unknown as SegmentFilter,
          ),
        ),
      );
      batch.forEach((key, idx) => countByFilter.set(key, counts[idx] as number));
    }

    return segments.map((s) =>
      this.toSegmentDtoWithCount(s, countByFilter.get(this.filterKey(s)) ?? 0),
    );
  }

  /** Stable identity for a stored segment filter, used to collapse duplicates. */
  private filterKey(segment: segments): string {
    return JSON.stringify(segment.filter ?? null);
  }

  async getSegment(businessId: string, id: string): Promise<SegmentResponseDto> {
    const segment = await this.getSegmentEntity(businessId, id);
    return this.toSegmentDto(businessId, segment);
  }

  async updateSegment(businessId: string, id: string, dto: UpdateSegmentDto): Promise<SegmentResponseDto> {
    await this.getSegmentEntity(businessId, id);

    if (dto.name) {
      const existing = await this.repository.findSegmentByName(businessId, dto.name);
      if (existing && existing.id !== id) {
        throw new ConflictException(`A segment named "${dto.name}" already exists`);
      }
    }

    const updated = await this.repository.updateSegment(businessId, id, {
      name: dto.name,
      description: dto.description,
      filter: dto.filter as SegmentFilter | undefined,
      isActive: dto.isActive,
    });
    return this.toSegmentDto(businessId, updated);
  }

  async deleteSegment(businessId: string, id: string): Promise<void> {
    await this.getSegmentEntity(businessId, id);
    await this.repository.softDeleteSegment(businessId, id);
  }

  async getSegmentMembers(
    businessId: string,
    id: string,
    page: number,
    limit: number,
  ): Promise<PaginatedContactsDto> {
    const segment = await this.getSegmentEntity(businessId, id);
    const filter = segment.filter as unknown as SegmentFilter;
    const result = await this.repository.findBySegmentFilter(businessId, filter, page, limit);
    return {
      data: result.data.map((c) => this.toContactDto(c)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  private async getSegmentEntity(businessId: string, id: string): Promise<segments> {
    const segment = await this.repository.findSegmentById(businessId, id);
    if (!segment) {
      throw new NotFoundException(`Segment ${id} not found`);
    }
    return segment;
  }

  // ───────────────────────────────────────────────────────────────────
  // Mappers
  // ───────────────────────────────────────────────────────────────────

  private toContactDto(c: clients): ContactResponseDto {
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      avatarUrl: c.avatar_url,
      tags: c.tags,
      ltvScore: c.ltv_score?.toNumber() ?? null,
      churnRisk: c.churn_risk?.toNumber() ?? null,
      engagementScore: c.engagement_score?.toNumber() ?? null,
      totalOrders: c.total_orders,
      totalSpentPaise: Math.round(c.total_spent.toNumber() * 100),
      lastInteractionAt: c.last_interaction_at?.toISOString() ?? null,
      firstSeenAt: c.first_seen_at.toISOString(),
      createdAt: c.created_at.toISOString(),
    };
  }

  private async toSegmentDto(businessId: string, s: segments): Promise<SegmentResponseDto> {
    const memberCount = await this.repository.countBySegmentFilter(
      businessId,
      s.filter as unknown as SegmentFilter,
    );
    return this.toSegmentDtoWithCount(s, memberCount);
  }

  /** Shape a segment row once its member count is already known. */
  private toSegmentDtoWithCount(s: segments, memberCount: number): SegmentResponseDto {
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      filter: s.filter as unknown as SegmentFilterDto,
      isActive: s.is_active,
      memberCount,
      createdAt: s.created_at.toISOString(),
      updatedAt: s.updated_at.toISOString(),
    };
  }
}
