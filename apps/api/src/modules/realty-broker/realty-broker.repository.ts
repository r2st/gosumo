import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  realty_approvals,
  realty_account_settings,
  realty_broker_alerts,
  realty_conversation_control,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface CreateApprovalData {
  businessId: string;
  leadId: string;
  conversationId?: string | null;
  draftText: string;
  confidence: number;
  intent?: string | null;
}

export interface CreateAlertData {
  businessId: string;
  type: realty_broker_alerts['type'];
  leadId?: string | null;
  title: string;
  body?: string | null;
  payload?: Prisma.InputJsonValue;
}

/**
 * RealtyBrokerRepository — all Prisma access for the broker-surface tables
 * (approvals, account settings, alerts, conversation control). Every query is
 * scoped by business_id; soft-deleted rows are excluded where applicable.
 */
@Injectable()
export class RealtyBrokerRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Approvals ────────────────────────────────

  async createApproval(data: CreateApprovalData): Promise<realty_approvals> {
    return this.prisma.realty_approvals.create({
      data: {
        business_id: data.businessId,
        lead_id: data.leadId,
        conversation_id: data.conversationId ?? null,
        draft_text: data.draftText,
        confidence: data.confidence,
        intent: data.intent ?? null,
        status: 'PENDING',
      },
    });
  }

  async findApprovalById(businessId: string, id: string): Promise<realty_approvals | null> {
    return this.prisma.realty_approvals.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async listApprovals(
    businessId: string,
    filters: { status?: string; leadId?: string } = {},
  ): Promise<realty_approvals[]> {
    const where: Prisma.realty_approvalsWhereInput = { business_id: businessId, deleted_at: null };
    if (filters.status) where.status = filters.status as realty_approvals['status'];
    if (filters.leadId) where.lead_id = filters.leadId;
    return this.prisma.realty_approvals.findMany({
      where,
      orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
      take: 200,
    });
  }

  async updateApproval(
    businessId: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<realty_approvals> {
    return this.prisma.realty_approvals.update({ where: { id }, data });
  }

  async countApprovals(businessId: string, status: string): Promise<number> {
    return this.prisma.realty_approvals.count({
      where: { business_id: businessId, status: status as realty_approvals['status'], deleted_at: null },
    });
  }

  // ── Account settings ─────────────────────────

  async findSettings(businessId: string): Promise<realty_account_settings | null> {
    return this.prisma.realty_account_settings.findUnique({ where: { business_id: businessId } });
  }

  async createSettings(businessId: string): Promise<realty_account_settings> {
    return this.prisma.realty_account_settings.create({ data: { business_id: businessId } });
  }

  async updateSettings(
    businessId: string,
    data: Record<string, unknown>,
  ): Promise<realty_account_settings> {
    return this.prisma.realty_account_settings.update({
      where: { business_id: businessId },
      data,
    });
  }

  // ── Alerts ───────────────────────────────────

  async createAlert(data: CreateAlertData): Promise<realty_broker_alerts> {
    return this.prisma.realty_broker_alerts.create({
      data: {
        business_id: data.businessId,
        type: data.type,
        lead_id: data.leadId ?? null,
        title: data.title,
        body: data.body ?? null,
        payload: data.payload ?? {},
      },
    });
  }

  async listAlerts(
    businessId: string,
    filters: { unreadOnly?: boolean; type?: string } = {},
  ): Promise<realty_broker_alerts[]> {
    const where: Prisma.realty_broker_alertsWhereInput = { business_id: businessId };
    if (filters.unreadOnly) where.is_read = false;
    if (filters.type) where.type = filters.type as realty_broker_alerts['type'];
    return this.prisma.realty_broker_alerts.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  async findAlertById(businessId: string, id: string): Promise<realty_broker_alerts | null> {
    return this.prisma.realty_broker_alerts.findFirst({ where: { id, business_id: businessId } });
  }

  async markAlertRead(businessId: string, id: string): Promise<realty_broker_alerts> {
    return this.prisma.realty_broker_alerts.update({
      where: { id },
      data: { is_read: true, read_at: new Date() },
    });
  }

  async markAllAlertsRead(businessId: string): Promise<number> {
    const res = await this.prisma.realty_broker_alerts.updateMany({
      where: { business_id: businessId, is_read: false },
      data: { is_read: true, read_at: new Date() },
    });
    return res.count;
  }

  async countUnreadAlerts(businessId: string): Promise<number> {
    return this.prisma.realty_broker_alerts.count({
      where: { business_id: businessId, is_read: false },
    });
  }

  // ── Conversation control (takeover) ──────────

  async findControl(
    businessId: string,
    conversationId: string,
  ): Promise<realty_conversation_control | null> {
    return this.prisma.realty_conversation_control.findFirst({
      where: { business_id: businessId, conversation_id: conversationId },
    });
  }

  async upsertControl(
    businessId: string,
    conversationId: string,
    data: {
      owner: realty_conversation_control['owner'];
      leadId?: string | null;
      takenOverBy?: string | null;
      takenOverAt?: Date | null;
      releasedAt?: Date | null;
    },
  ): Promise<realty_conversation_control> {
    return this.prisma.realty_conversation_control.upsert({
      where: { business_id_conversation_id: { business_id: businessId, conversation_id: conversationId } },
      create: {
        business_id: businessId,
        conversation_id: conversationId,
        lead_id: data.leadId ?? null,
        owner: data.owner,
        taken_over_by: data.takenOverBy ?? null,
        taken_over_at: data.takenOverAt ?? null,
        released_at: data.releasedAt ?? null,
      },
      update: {
        owner: data.owner,
        ...(data.leadId !== undefined ? { lead_id: data.leadId } : {}),
        taken_over_by: data.takenOverBy ?? null,
        taken_over_at: data.takenOverAt ?? null,
        released_at: data.releasedAt ?? null,
      },
    });
  }

  async countControlByOwner(businessId: string): Promise<{ ai: number; human: number }> {
    const rows = await this.prisma.realty_conversation_control.groupBy({
      by: ['owner'],
      where: { business_id: businessId },
      _count: { _all: true },
    });
    let ai = 0;
    let human = 0;
    for (const r of rows) {
      if (r.owner === 'AI') ai = r._count._all;
      else if (r.owner === 'HUMAN') human = r._count._all;
    }
    return { ai, human };
  }
}
