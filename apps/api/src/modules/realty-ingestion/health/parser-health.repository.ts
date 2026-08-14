import { Injectable } from '@nestjs/common';
import { Prisma, RealtyParserHealthStatus } from '@prisma/client';
import type { realty_parser_health_checks } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma.service';

export interface CreateParserHealthData {
  portal: string;
  status: RealtyParserHealthStatus;
  sampleCount: number;
  passCount: number;
  failCount: number;
  emptyCount: number;
  details: Record<string, unknown>;
}

/**
 * ParserHealthRepository — Prisma access for the platform-ops parser-health log
 * (`realty_parser_health_checks`). NOT tenant-scoped: parsers are global code and
 * the table stores no tenant data, so there is no business_id filter here.
 */
@Injectable()
export class ParserHealthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(data: CreateParserHealthData): Promise<realty_parser_health_checks> {
    return this.prisma.realty_parser_health_checks.create({
      data: {
        portal: data.portal,
        status: data.status,
        sample_count: data.sampleCount,
        pass_count: data.passCount,
        fail_count: data.failCount,
        empty_count: data.emptyCount,
        details: data.details as Prisma.InputJsonValue,
      },
    });
  }

  async latest(portal: string): Promise<realty_parser_health_checks | null> {
    return this.prisma.realty_parser_health_checks.findFirst({
      where: { portal },
      orderBy: { checked_at: 'desc' },
    });
  }

  /**
   * The most recent check per portal.
   *
   * Raw, because Prisma's `distinct` is not `DISTINCT ON` — the two look alike
   * and behave nothing alike. Prisma sends an ordinary SELECT and de-duplicates
   * the result in Node, so this read returned every health check ever recorded,
   * each carrying its `details` JSONB of per-sample outcomes, to hand back one
   * row per portal. Weekly writes make that slow to bite rather than harmless:
   * the table has no retention sweep, so it only ever grows.
   *
   * `DISTINCT ON (portal)` with a matching ORDER BY walks the
   * `(portal, checked_at DESC)` index and stops at the first row of each
   * portal, which is the plan the previous comment claimed was already
   * happening.
   */
  async latestAll(): Promise<realty_parser_health_checks[]> {
    return this.prisma.$queryRaw<realty_parser_health_checks[]>`
      SELECT DISTINCT ON (portal) *
      FROM realty_parser_health_checks
      ORDER BY portal ASC, checked_at DESC
    `;
  }
}
