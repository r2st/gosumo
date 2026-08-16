import { randomBytes } from 'node:crypto';
import { InjectQueue } from '@nestjs/bull';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Queue } from 'bull';
import { AuditAction, DataExportArchiveFormat, DataExportJobStatus } from '@gosumo/database';
import { Prisma } from '@prisma/client';
import { AuditLogService } from '../../common/services/audit-log.service';
import { DataExportRepository } from './data-export.repository';
import { DataExportService, ExportActor } from './data-export.service';
import { ExportJobMeta, ExportJobRepository } from './export-job.repository';
import {
  archiveFilename,
  inflateArchive,
  serializeArchive,
  sha256,
} from './export-archive.util';
import {
  BuildArchiveJobData,
  EXPORT_JOBS,
  EXPORT_LIST_MAX_LIMIT,
  EXPORT_QUEUE,
  EXPORT_STUCK_AFTER_MS,
  EXPORT_TTL_MS,
  MAX_CONCURRENT_EXPORT_JOBS_PER_TENANT,
} from './export-job.constants';

/** What the requester gets back — including the one and only copy of the token. */
export interface ArchiveRequestResult {
  jobId: string;
  status: DataExportJobStatus;
  format: DataExportArchiveFormat;
  expiresAt: Date;
  /**
   * Returned exactly once, at request time. Only its SHA-256 is stored, so this
   * cannot be recovered from the database or from a later read of the job.
   */
  downloadToken: string;
}

/** The archive bytes plus what the HTTP layer needs to serve them. */
export interface ArchiveDownload {
  body: Buffer;
  filename: string;
  contentType: string;
  byteSize: number;
  checksum: string | null;
}

/**
 * ExportJobService — asynchronous subject-access archives.
 *
 * The synchronous export builds the bundle inside the request. That is right
 * for a customer with a short history and wrong for the ones that actually
 * generate access requests: the export a regulator asks about is the four-year
 * account, and building it inline holds a worker for the whole assembly and
 * then hands the operator a JSON body their browser has to be talked into
 * saving. This splits the two halves — a request that returns immediately, and
 * a download of bytes built off the request path.
 *
 * **The download is authenticated, not a public link.** A token in a URL is the
 * usual shape for this and was deliberately not built: the bytes are one
 * person's entire commercial and conversational history, and a public route
 * would put that behind a string that lands in browser history, referrer
 * headers, and any chat app the operator pastes it into. The token exists as a
 * *second* factor — it binds the download to the party that requested it, so a
 * job id (which appears in listings and logs) is not on its own enough to pull
 * an archive, and it is checked against the caller's own tenant besides.
 */
@Injectable()
export class ExportJobService {
  private readonly logger = new Logger(ExportJobService.name);

  constructor(
    private readonly jobs: ExportJobRepository,
    private readonly exports: DataExportService,
    private readonly repository: DataExportRepository,
    private readonly audit: AuditLogService,
    @InjectQueue(EXPORT_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Request an archive. Returns as soon as the row exists; the build runs on
   * the queue.
   */
  async requestArchive(
    businessId: string,
    clientId: string,
    format: DataExportArchiveFormat,
    actor: ExportActor = {},
  ): Promise<ArchiveRequestResult> {
    const client = await this.repository.findClient(businessId, clientId);
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    const active = await this.jobs.countActive(businessId);
    if (active >= MAX_CONCURRENT_EXPORT_JOBS_PER_TENANT) {
      throw new BadRequestException(
        `This business already has ${active} export(s) building. ` +
          'Wait for them to finish before requesting another.',
      );
    }

    const token = randomBytes(32).toString('base64url');
    const job = await this.jobs.create({
      businessId,
      clientId,
      format,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
      requestedBy: actor.teamMemberId ?? null,
      requestedByEmail: actor.email ?? null,
      requestIp: actor.ipAddress ?? null,
      correlationId: actor.requestId ?? null,
    });

    // The row is written before the job is added, and the row's initial status
    // is PENDING — the state the recovery sweep looks for. So a failed
    // `queue.add` strands a row that the sweep will re-enqueue, rather than
    // losing the request. The opposite order would enqueue a job for a row that
    // does not exist yet.
    try {
      await this.enqueueBuild(businessId, job.id);
    } catch (err) {
      this.logger.error(
        `Export job ${job.id} was written but not enqueued; the recovery sweep ` +
          `will pick it up: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.audit.record({
      businessId,
      actorType: actor.teamMemberId ? 'TEAM_MEMBER' : 'API',
      actorId: actor.teamMemberId ?? null,
      actorEmail: actor.email ?? null,
      action: AuditAction.EXPORT,
      resourceType: 'client_data_export_job',
      resourceId: job.id,
      requestId: actor.requestId ?? null,
      ipAddress: actor.ipAddress ?? null,
      after: { clientId, format },
      description: `Requested a data export archive for client ${clientId}`,
    });

    return {
      jobId: job.id,
      status: job.status,
      format: job.format,
      expiresAt: job.expires_at,
      downloadToken: token,
    };
  }

  /**
   * Build one archive. Runs on the queue.
   *
   * Claims the row first and returns quietly if the claim fails — that means
   * another worker already has it, which happens whenever Bull re-runs a stalled
   * job or the recovery sweep re-enqueues one. Building it twice would overwrite
   * the first copy's bytes underneath a download in progress.
   */
  async buildArchive(businessId: string, jobId: string): Promise<void> {
    const claimed = await this.jobs.claimForBuild(businessId, jobId);
    if (!claimed) {
      this.logger.debug(`Export job ${jobId} was already claimed; skipping`);
      return;
    }

    const job = await this.jobs.findById(businessId, jobId);
    if (!job) {
      this.logger.warn(`Export job ${jobId} vanished after being claimed`);
      return;
    }

    try {
      const bundle = await this.exports.exportClient(businessId, job.client_id, {
        teamMemberId: job.requested_by,
        email: job.requested_by_email,
        requestId: job.correlation_id,
        ipAddress: job.request_ip,
      });

      const archive = serializeArchive(bundle, job.format);
      await this.jobs.completeBuild(businessId, jobId, {
        payload: archive.compressed,
        byteSize: archive.byteSize,
        checksum: archive.checksum,
        sections: JSON.parse(JSON.stringify(bundle.sections)) as Prisma.InputJsonValue,
        truncated: Object.entries(bundle.sections)
          .filter(([, meta]) => meta.truncated)
          .map(([name]) => name),
      });

      this.logger.log(
        `Built export archive ${jobId} for client ${job.client_id}: ` +
          `${archive.byteSize} B raw, ${archive.compressed.byteLength} B gzipped`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.jobs.failBuild(businessId, jobId, message);
      // Rethrown so Bull retries and `QueueTelemetryService` records it. The row
      // is already FAILED, so a retry that also fails changes nothing; a retry
      // that succeeds finds the row non-PENDING and no-ops, which is why the
      // recovery sweep — not Bull — is what actually re-runs a lost build.
      throw err;
    }
  }

  /**
   * Serve a built archive.
   *
   * Every check here is a separate 404/403 on purpose, and none of them
   * distinguishes "wrong token" from "no such job": a caller who can probe the
   * difference can enumerate which job ids exist.
   */
  async downloadArchive(
    businessId: string,
    jobId: string,
    token: string,
    actor: ExportActor = {},
  ): Promise<ArchiveDownload> {
    const job = await this.jobs.findByTokenHash(sha256(token));

    // The token resolved to a row, but it must be *this* tenant's row and *this*
    // job. Checked rather than trusted: `findByTokenHash` is the module's only
    // unscoped read.
    if (!job || job.business_id !== businessId || job.id !== jobId) {
      throw new NotFoundException('Export archive not found');
    }

    if (job.status === DataExportJobStatus.EXPIRED || job.expires_at.getTime() <= Date.now()) {
      throw new ForbiddenException('This export archive has expired. Request a new one.');
    }
    if (job.status !== DataExportJobStatus.READY) {
      throw new BadRequestException(
        `Export archive is not ready (status: ${job.status}).` +
          (job.error ? ' The build failed; request a new one.' : ''),
      );
    }

    const payload = await this.jobs.findPayload(businessId, jobId);
    if (!payload) {
      // READY with no bytes means the expiry sweep cleared them between the two
      // reads. Reported as expiry rather than as a 500, which is what it is.
      throw new ForbiddenException('This export archive has expired. Request a new one.');
    }

    await this.jobs.recordDownload(businessId, jobId);
    await this.audit.record({
      businessId,
      actorType: actor.teamMemberId ? 'TEAM_MEMBER' : 'API',
      actorId: actor.teamMemberId ?? null,
      actorEmail: actor.email ?? null,
      action: AuditAction.EXPORT,
      resourceType: 'client_data_export_archive',
      resourceId: jobId,
      requestId: actor.requestId ?? null,
      ipAddress: actor.ipAddress ?? null,
      after: { clientId: job.client_id, byteSize: job.byte_size },
      description: `Downloaded the data export archive for client ${job.client_id}`,
    });

    return {
      // Inflated here rather than served gzipped, because the response goes
      // through Caddy and a `Content-Encoding: gzip` we set ourselves would be
      // re-encoded or stripped depending on the client's Accept-Encoding. The
      // filename keeps its `.gz` meaning only in storage.
      body: inflateArchive(payload),
      filename: this.filenameFor(job),
      contentType:
        job.format === DataExportArchiveFormat.NDJSON
          ? 'application/x-ndjson'
          : 'application/json',
      byteSize: job.byte_size,
      checksum: job.checksum,
    };
  }

  async listArchives(
    businessId: string,
    params: {
      clientId?: string;
      status?: DataExportJobStatus;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ data: ExportJobMeta[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), EXPORT_LIST_MAX_LIMIT);
    const offset = Math.max(params.offset ?? 0, 0);
    const result = await this.jobs.list(businessId, {
      clientId: params.clientId,
      status: params.status,
      limit,
      offset,
    });
    return { ...result, limit, offset };
  }

  async getArchive(businessId: string, jobId: string): Promise<ExportJobMeta> {
    const job = await this.jobs.findById(businessId, jobId);
    if (!job) {
      throw new NotFoundException('Export archive not found');
    }
    return job;
  }

  // ─────────────────────────────────────────────
  // Sweeps
  // ─────────────────────────────────────────────

  /**
   * Drop the bytes of every archive past its TTL.
   *
   * The row survives — it is the audit trail of who exported what, which has to
   * outlive the data it describes.
   */
  async expireArchives(): Promise<{ expired: number }> {
    const due = await this.jobs.findExpiredGlobal(new Date());
    let expired = 0;
    for (const { id, business_id } of due) {
      if (await this.jobs.expire(business_id, id)) {
        expired += 1;
      }
    }
    if (expired > 0) {
      this.logger.log(`Expired ${expired} export archive(s)`);
    }
    return { expired };
  }

  /**
   * Re-enqueue builds that were written to Postgres but never reached Redis.
   *
   * Enqueues *before* resetting the status, for the same reason the notification
   * sweep does: resetting first and failing to enqueue re-creates the exact
   * stranding this is fixing.
   */
  async recoverStuck(): Promise<{ recovered: number }> {
    const cutoff = new Date(Date.now() - EXPORT_STUCK_AFTER_MS);
    const stuck = await this.jobs.findStuckGlobal(cutoff);
    let recovered = 0;

    for (const { id, business_id } of stuck) {
      // Re-read through the scoped path, which also re-checks that the row has
      // not gone terminal since the scan.
      const job = await this.jobs.findById(business_id, id);
      if (
        !job ||
        (job.status !== DataExportJobStatus.PENDING &&
          job.status !== DataExportJobStatus.BUILDING)
      ) {
        continue;
      }

      if (job.expires_at.getTime() <= Date.now()) {
        await this.jobs.failBuild(business_id, id, 'Expired before the archive was built');
        continue;
      }

      try {
        await this.enqueueBuild(business_id, id);
        await this.jobs.releaseForRetry(business_id, id);
        recovered += 1;
      } catch (err) {
        this.logger.warn(
          `Could not re-enqueue stranded export ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (recovered > 0) {
      this.logger.log(`Re-enqueued ${recovered} stranded export build(s)`);
    }
    return { recovered };
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  private async enqueueBuild(businessId: string, jobId: string): Promise<void> {
    const data: BuildArchiveJobData = { businessId, jobId };
    await this.queue.add(EXPORT_JOBS.BUILD, data, {
      // Keyed by the job row, so a re-enqueue from the recovery sweep collapses
      // onto the same Bull job rather than queueing a second build.
      jobId: `export-build:${jobId}`,
      removeOnComplete: true,
    });
  }

  /** Filename for a stored job, without re-reading the bundle it was built from. */
  private filenameFor(job: ExportJobMeta): string {
    return archiveFilename(job.client_id, job.completed_at ?? job.created_at, job.format);
  }
}
