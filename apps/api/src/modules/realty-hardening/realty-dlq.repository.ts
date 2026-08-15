import { Injectable } from '@nestjs/common';
import { Prisma, DeadLetterStatus } from '@prisma/client';
import type { realty_dead_letters } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

export interface CreateDeadLetterData {
  businessId: string;
  source: string;
  operation: string;
  payload: Prisma.InputJsonValue;
  errorMessage: string;
  errorStack?: string | null;
  attempts: number;
  correlationId?: string | null;
  leadId?: string | null;
  conversationId?: string | null;
}

export interface ListDeadLettersFilter {
  status?: DeadLetterStatus;
  source?: string;
  operation?: string;
  limit?: number;
}

/**
 * RealtyDlqRepository — all Prisma access for `realty_dead_letters`. Every query
 * is scoped by `business_id`. The table is append-mostly: only status/replay
 * bookkeeping columns are ever updated, never the captured payload.
 */
@Injectable()
export class RealtyDlqRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateDeadLetterData): Promise<realty_dead_letters> {
    return this.prisma.realty_dead_letters.create({
      data: {
        business_id: data.businessId,
        source: data.source,
        operation: data.operation,
        payload: data.payload,
        error_message: data.errorMessage,
        error_stack: data.errorStack ?? null,
        attempts: data.attempts,
        correlation_id: data.correlationId ?? null,
        lead_id: data.leadId ?? null,
        conversation_id: data.conversationId ?? null,
        status: DeadLetterStatus.PENDING,
      },
    });
  }

  async findById(businessId: string, id: string): Promise<realty_dead_letters | null> {
    return this.prisma.realty_dead_letters.findFirst({
      where: { id, business_id: businessId },
    });
  }

  async list(
    businessId: string,
    filter: ListDeadLettersFilter = {},
  ): Promise<realty_dead_letters[]> {
    const where: Prisma.realty_dead_lettersWhereInput = { business_id: businessId };
    if (filter.status) where.status = filter.status;
    if (filter.source) where.source = filter.source;
    if (filter.operation) where.operation = filter.operation;
    return this.prisma.realty_dead_letters.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: Math.min(filter.limit ?? 100, 500),
    });
  }

  async countByStatus(businessId: string, status: DeadLetterStatus): Promise<number> {
    return this.prisma.realty_dead_letters.count({
      where: { business_id: businessId, status },
    });
  }

  /** Global PENDING depth across all tenants — a soak-readiness signal. */
  async countPendingGlobal(): Promise<number> {
    return this.prisma.realty_dead_letters.count({
      where: { status: DeadLetterStatus.PENDING },
    });
  }

  /**
   * Take exclusive ownership of a PENDING dead letter so it can be replayed.
   *
   * An optimistic lock on `attempts`: the claim is the increment, and it only
   * lands if the row is still PENDING with the attempt count the caller read.
   * Two concurrent replays of the same entry therefore have exactly one winner
   * — without which both pass the status check and both run the handler, which
   * for a DLQ means executing the captured operation twice. These are the
   * operations least safe to double: a reminder that already went out, a push
   * that already reached a CRM.
   *
   * `attempts` is bumped before the handler runs rather than after it fails, so
   * a replay that takes the process down with it still counts. Otherwise the
   * entry returns as PENDING with its original count and is replayed forever.
   *
   * Returns true if this caller now owns the replay.
   */
  async claimForReplay(
    businessId: string,
    id: string,
    expectedAttempts: number,
  ): Promise<boolean> {
    const res = await this.prisma.realty_dead_letters.updateMany({
      where: {
        id,
        business_id: businessId,
        status: DeadLetterStatus.PENDING,
        attempts: expectedAttempts,
      },
      data: { attempts: expectedAttempts + 1 },
    });
    return res.count === 1;
  }

  async update(
    businessId: string,
    id: string,
    data: Prisma.realty_dead_lettersUpdateInput,
  ): Promise<realty_dead_letters> {
    return this.prisma.realty_dead_letters.update({
      where: { id, business_id: businessId },
      data,
    });
  }
}
