import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { realty_leads } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface CreateLeadData {
  businessId: string;
  whatsappPhone: string;
  source: realty_leads['source'];
  name?: string | null;
  email?: string | null;
  altPhone?: string | null;
  languagePref?: string;
  subSource?: string | null;
  listingRef?: string | null;
  assignedAgentId?: string | null;
  conversationId?: string | null;
  clientId?: string | null;
}

/** Persisted lead field updates. All optional; only provided fields are written. */
export interface UpdateLeadData {
  name?: string | null;
  email?: string | null;
  altPhone?: string | null;
  languagePref?: string;
  assignedAgentId?: string | null;
  conversationId?: string | null;
  clientId?: string | null;
  budgetMin?: Prisma.Decimal | null;
  budgetMax?: Prisma.Decimal | null;
  localities?: string[];
  timelineMonths?: number | null;
  config?: string | null;
  purpose?: realty_leads['purpose'];
  financing?: realty_leads['financing'];
  qualScore?: number;
  temperature?: realty_leads['temperature'];
  stage?: realty_leads['stage'];
  matchedUnitIds?: string[];
  extractedFacts?: Prisma.InputJsonValue;
  objections?: Prisma.InputJsonValue;
  promises?: Prisma.InputJsonValue;
  optOut?: boolean;
  consentLog?: Prisma.InputJsonValue;
  shareConsent?: boolean;
  exchangeStatus?: realty_leads['exchange_status'];
  cadenceId?: string | null;
  cadenceStep?: number;
  nextFollowupAt?: Date | null;
  lastActivityAt?: Date | null;
  metadata?: Prisma.InputJsonValue;
}

export interface LeadListFilters {
  stage?: string;
  temperature?: string;
  source?: string;
  assignedAgentId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedLeads {
  data: realty_leads[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * RealtyLeadsRepository — all Prisma queries for the realty_leads table.
 * Every query is scoped by business_id; soft-deleted rows are excluded.
 */
@Injectable()
export class RealtyLeadsRepository {
  private readonly logger = new Logger(RealtyLeadsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateLeadData): Promise<realty_leads> {
    return this.prisma.realty_leads.create({
      data: {
        business_id: data.businessId,
        whatsapp_phone: data.whatsappPhone,
        source: data.source,
        name: data.name ?? null,
        email: data.email ?? null,
        alt_phone: data.altPhone ?? null,
        language_pref: data.languagePref ?? 'hinglish',
        sub_source: data.subSource ?? null,
        listing_ref: data.listingRef ?? null,
        assigned_agent_id: data.assignedAgentId ?? null,
        conversation_id: data.conversationId ?? null,
        client_id: data.clientId ?? null,
        last_activity_at: new Date(),
      },
    });
  }

  async findById(businessId: string, leadId: string): Promise<realty_leads | null> {
    return this.prisma.realty_leads.findFirst({
      where: { id: leadId, business_id: businessId, deleted_at: null },
    });
  }

  async findByPhone(
    businessId: string,
    whatsappPhone: string,
  ): Promise<realty_leads | null> {
    return this.prisma.realty_leads.findFirst({
      where: { business_id: businessId, whatsapp_phone: whatsappPhone, deleted_at: null },
    });
  }

  async update(
    businessId: string,
    leadId: string,
    data: UpdateLeadData,
  ): Promise<realty_leads> {
    const d: Record<string, unknown> = {};
    if (data.name !== undefined) d['name'] = data.name;
    if (data.email !== undefined) d['email'] = data.email;
    if (data.altPhone !== undefined) d['alt_phone'] = data.altPhone;
    if (data.languagePref !== undefined) d['language_pref'] = data.languagePref;
    if (data.assignedAgentId !== undefined) d['assigned_agent_id'] = data.assignedAgentId;
    if (data.conversationId !== undefined) d['conversation_id'] = data.conversationId;
    if (data.clientId !== undefined) d['client_id'] = data.clientId;
    if (data.budgetMin !== undefined) d['budget_min'] = data.budgetMin;
    if (data.budgetMax !== undefined) d['budget_max'] = data.budgetMax;
    if (data.localities !== undefined) d['localities'] = data.localities;
    if (data.timelineMonths !== undefined) d['timeline_months'] = data.timelineMonths;
    if (data.config !== undefined) d['config'] = data.config;
    if (data.purpose !== undefined) d['purpose'] = data.purpose;
    if (data.financing !== undefined) d['financing'] = data.financing;
    if (data.qualScore !== undefined) d['qual_score'] = data.qualScore;
    if (data.temperature !== undefined) d['temperature'] = data.temperature;
    if (data.stage !== undefined) d['stage'] = data.stage;
    if (data.matchedUnitIds !== undefined) d['matched_unit_ids'] = data.matchedUnitIds;
    if (data.extractedFacts !== undefined) d['extracted_facts'] = data.extractedFacts;
    if (data.objections !== undefined) d['objections'] = data.objections;
    if (data.promises !== undefined) d['promises'] = data.promises;
    if (data.optOut !== undefined) d['opt_out'] = data.optOut;
    if (data.consentLog !== undefined) d['consent_log'] = data.consentLog;
    if (data.shareConsent !== undefined) d['share_consent'] = data.shareConsent;
    if (data.exchangeStatus !== undefined) d['exchange_status'] = data.exchangeStatus;
    if (data.cadenceId !== undefined) d['cadence_id'] = data.cadenceId;
    if (data.cadenceStep !== undefined) d['cadence_step'] = data.cadenceStep;
    if (data.nextFollowupAt !== undefined) d['next_followup_at'] = data.nextFollowupAt;
    if (data.lastActivityAt !== undefined) d['last_activity_at'] = data.lastActivityAt;
    if (data.metadata !== undefined) d['metadata'] = data.metadata;

    return this.prisma.realty_leads.update({ where: { id: leadId, business_id: businessId }, data: d });
  }

  async softDelete(businessId: string, leadId: string): Promise<realty_leads> {
    return this.prisma.realty_leads.update({
      where: { id: leadId, business_id: businessId },
      data: { deleted_at: new Date() },
    });
  }

  async list(businessId: string, filters: LeadListFilters): Promise<PaginatedLeads> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.realty_leadsWhereInput = {
      business_id: businessId,
      deleted_at: null,
    };
    if (filters.stage) where.stage = filters.stage as realty_leads['stage'];
    if (filters.temperature) where.temperature = filters.temperature as realty_leads['temperature'];
    if (filters.source) where.source = filters.source as realty_leads['source'];
    if (filters.assignedAgentId) where.assigned_agent_id = filters.assignedAgentId;
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { whatsapp_phone: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.realty_leads.findMany({
        where,
        orderBy: [{ qual_score: 'desc' }, { last_activity_at: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.realty_leads.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** Count of active leads grouped by pipeline stage — powers the board. */
  async countByStage(businessId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.realty_leads.groupBy({
      by: ['stage'],
      where: { business_id: businessId, deleted_at: null },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.stage] = r._count._all;
    return out;
  }
}
