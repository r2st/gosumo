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

  async latestAll(): Promise<realty_parser_health_checks[]> {
    // One most-recent row per portal (Postgres DISTINCT ON via orderBy).
    return this.prisma.realty_parser_health_checks.findMany({
      distinct: ['portal'],
      orderBy: [{ portal: 'asc' }, { checked_at: 'desc' }],
    });
  }
}
