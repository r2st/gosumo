import { Injectable } from '@nestjs/common';
import { DataExportJobStatus, DataExportArchiveFormat } from '@gosumo/database';
import { Prisma } from '@prisma/client';
import type { data_export_jobs } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { EXPORT_SWEEP_BATCH } from './export-job.constants';

/** Fields set when an archive finishes building. */
export interface ArchiveCompletion {
  payload: Buffer;
  byteSize: number;
  checksum: string;
  sections: Prisma.InputJsonValue;
  truncated: Prisma.InputJsonValue;
}

/** A job row with its bytes deliberately left behind. */
export type ExportJobMeta = Omit<data_export_jobs, 'payload'>;

/**
 * A job row's non-payload columns.
 *
 * Named once and reused so that no listing path can accidentally select
 * `payload` — every archive is up to a few megabytes of one customer's personal
 * data, and pulling twenty of them out of Postgres to render a table of
 * timestamps is both the module's largest avoidable allocation and a needless
 * second copy of the disclosure in process memory.
 */
const META_SELECT = {
  id: true,
  business_id: true,
  client_id: true,
  status: true,
  format: true,
  token_hash: true,
  byte_size: true,
  checksum: true,
  sections: true,
  truncated: true,
  requested_by: true,
  requested_by_email: true,
  request_ip: true,
  correlation_id: true,
  error: true,
  download_count: true,
  downloaded_at: true,
  started_at: true,
  completed_at: true,
  expires_at: true,
  created_at: true,
  updated_at: true,
} as const;

/**
 * ExportJobRepository — every read and write against `data_export_jobs`.
 *
 * Two rules beyond the usual tenant scoping:
 *
 *  - **`payload` is selected only by `findPayload`.** Everything else returns
 *    `ExportJobMeta`. See `META_SELECT`.
 *  - **The token lookup is the one query without a `business_id`**, because the
 *    token *is* the scope: it is 256 bits of entropy that resolves to exactly
 *    one row, and the caller supplies it before any tenant context exists. It
 *    returns the row's `business_id` so the service can re-check it against the
 *    caller's tenant, which is what actually authorizes the download.
 */
@Injectable()
export class ExportJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: {
    businessId: string;
    clientId: string;
    format: DataExportArchiveFormat;
    tokenHash: string;
    expiresAt: Date;
    requestedBy?: string | null;
    requestedByEmail?: string | null;
    requestIp?: string | null;
    correlationId?: string | null;
  }): Promise<ExportJobMeta> {
    return this.prisma.data_export_jobs.create({
      data: {
        business_id: params.businessId,
        client_id: params.clientId,
        format: params.format,
        token_hash: params.tokenHash,
        expires_at: params.expiresAt,
        requested_by: params.requestedBy ?? null,
        requested_by_email: params.requestedByEmail ?? null,
        request_ip: params.requestIp ?? null,
        correlation_id: params.correlationId ?? null,
      },
      select: META_SELECT,
    });
  }

  async findById(businessId: string, id: string): Promise<ExportJobMeta | null> {
    return this.prisma.data_export_jobs.findFirst({
      where: { id, business_id: businessId },
      select: META_SELECT,
    });
  }

  /**
   * Resolve a job by its download token.
   *
   * Deliberately unscoped — see the class comment. The caller must compare the
   * returned `business_id` against its own tenant before serving anything.
   */
  async findByTokenHash(tokenHash: string): Promise<ExportJobMeta | null> {
    return this.prisma.data_export_jobs.findUnique({
      where: { token_hash: tokenHash },
      select: META_SELECT,
    });
  }

  /** The archive bytes for one job. The only query that reads `payload`. */
  async findPayload(businessId: string, id: string): Promise<Buffer | null> {
    const row = await this.prisma.data_export_jobs.findFirst({
      where: { id, business_id: businessId },
      select: { payload: true },
    });
    return row?.payload ? Buffer.from(row.payload) : null;
  }

  async list(
    businessId: string,
    params: { clientId?: string; status?: DataExportJobStatus; limit: number; offset: number },
  ): Promise<{ data: ExportJobMeta[]; total: number }> {
    const where: Prisma.data_export_jobsWhereInput = {
      business_id: businessId,
      ...(params.clientId ? { client_id: params.clientId } : {}),
      ...(params.status ? { status: params.status } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.data_export_jobs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: params.limit,
        skip: params.offset,
        select: META_SELECT,
      }),
      this.prisma.data_export_jobs.count({ where }),
    ]);
    return { data, total };
  }

  /** Live requests this tenant already holds — the concurrency bound's input. */
  async countActive(businessId: string): Promise<number> {
    return this.prisma.data_export_jobs.count({
      where: {
        business_id: businessId,
        status: { in: [DataExportJobStatus.PENDING, DataExportJobStatus.BUILDING] },
      },
    });
  }

  /**
   * Claim a PENDING job for building.
   *
   * Conditional on the row still being PENDING, and reporting whether it
   * actually changed anything. Two workers can hold the same job — Bull's
   * stall detection re-runs a job whose worker died, and the recovery sweep
   * re-enqueues one whose job was lost — and without the condition both would
   * build the same export and the second would overwrite the first's bytes
   * while the operator was downloading them. `updateMany` is what makes the
   * check and the write one statement; a read-then-write here is the same
   * check-then-act race the money paths have.
   */
  async claimForBuild(businessId: string, id: string): Promise<boolean> {
    const result = await this.prisma.data_export_jobs.updateMany({
      where: { id, business_id: businessId, status: DataExportJobStatus.PENDING },
      data: { status: DataExportJobStatus.BUILDING, started_at: new Date() },
    });
    return result.count > 0;
  }

  async completeBuild(
    businessId: string,
    id: string,
    completion: ArchiveCompletion,
  ): Promise<void> {
    await this.prisma.data_export_jobs.updateMany({
      where: { id, business_id: businessId, status: DataExportJobStatus.BUILDING },
      data: {
        status: DataExportJobStatus.READY,
        payload: completion.payload,
        byte_size: completion.byteSize,
        checksum: completion.checksum,
        sections: completion.sections,
        truncated: completion.truncated,
        completed_at: new Date(),
        error: null,
      },
    });
  }

  async failBuild(businessId: string, id: string, error: string): Promise<void> {
    await this.prisma.data_export_jobs.updateMany({
      where: {
        id,
        business_id: businessId,
        status: { in: [DataExportJobStatus.PENDING, DataExportJobStatus.BUILDING] },
      },
      data: { status: DataExportJobStatus.FAILED, error, completed_at: new Date() },
    });
  }

  /** Record a served download. Counter, not a boolean — repeat pulls matter. */
  async recordDownload(businessId: string, id: string): Promise<void> {
    await this.prisma.data_export_jobs.updateMany({
      where: { id, business_id: businessId },
      data: { download_count: { increment: 1 }, downloaded_at: new Date() },
    });
  }

  /**
   * READY archives past their TTL.
   *
   * Cross-tenant: expiry is time-based and starts without a business_id. It
   * returns only `{id, business_id}` so the sweep re-reads each row through the
   * scoped path, matching `NotificationRepository.findStuckGlobal`.
   */
  async findExpiredGlobal(now: Date): Promise<Array<{ id: string; business_id: string }>> {
    return this.prisma.data_export_jobs.findMany({
      where: { status: DataExportJobStatus.READY, expires_at: { lte: now } },
      select: { id: true, business_id: true },
      orderBy: { expires_at: 'asc' },
      take: EXPORT_SWEEP_BATCH,
    });
  }

  /**
   * Non-terminal jobs older than the stranding threshold — the ones whose build
   * job was lost between Postgres and Redis. Cross-tenant, same shape as above.
   */
  async findStuckGlobal(before: Date): Promise<Array<{ id: string; business_id: string }>> {
    return this.prisma.data_export_jobs.findMany({
      where: {
        status: { in: [DataExportJobStatus.PENDING, DataExportJobStatus.BUILDING] },
        created_at: { lte: before },
      },
      select: { id: true, business_id: true },
      orderBy: { created_at: 'asc' },
      take: EXPORT_SWEEP_BATCH,
    });
  }

  /**
   * Drop the bytes and mark the job expired.
   *
   * Conditional on READY so a job that was downloaded and re-requested, or one
   * the recovery sweep has since moved on, is not clobbered by a sweep that
   * read it a moment earlier.
   */
  async expire(businessId: string, id: string): Promise<boolean> {
    const result = await this.prisma.data_export_jobs.updateMany({
      where: { id, business_id: businessId, status: DataExportJobStatus.READY },
      data: { status: DataExportJobStatus.EXPIRED, payload: null },
    });
    return result.count > 0;
  }

  /** Reset a stranded BUILDING row so the re-enqueued job can claim it. */
  async releaseForRetry(businessId: string, id: string): Promise<boolean> {
    const result = await this.prisma.data_export_jobs.updateMany({
      where: {
        id,
        business_id: businessId,
        status: { in: [DataExportJobStatus.PENDING, DataExportJobStatus.BUILDING] },
      },
      data: { status: DataExportJobStatus.PENDING, started_at: null },
    });
    return result.count > 0;
  }
}
