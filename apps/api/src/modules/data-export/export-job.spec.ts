import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataExportArchiveFormat, DataExportJobStatus } from '@gosumo/database';
import { ExportJobService } from './export-job.service';
import type { ExportJobMeta, ExportJobRepository } from './export-job.repository';
import type { DataExportRepository } from './data-export.repository';
import type { DataExportBundle, DataExportService } from './data-export.service';
import type { AuditLogService } from '../../common/services/audit-log.service';
import { serializeArchive, sha256 } from './export-archive.util';
import {
  EXPORT_STUCK_AFTER_MS,
  MAX_CONCURRENT_EXPORT_JOBS_PER_TENANT,
} from './export-job.constants';

const BUNDLE: DataExportBundle = {
  formatVersion: '1.0',
  generatedAt: '2026-08-15T10:00:00.000Z',
  businessId: 'b1',
  subject: {
    clientId: 'client-1',
    name: 'Asha',
    email: 'asha@example.in',
    phone: '+919876543210',
    firstSeenAt: new Date('2025-01-01T00:00:00Z'),
  },
  disclosure: { withheldFields: [], aiDecisionsExcluded: 0, truncated: true, notes: [] },
  sections: {
    messages: { included: 5, total: 40, truncated: true },
    orders: { included: 1, total: 1, truncated: false },
  },
  data: {
    profile: { name: 'Asha' },
    channelIdentities: [],
    conversations: [],
    messages: [{ id: 'm1' }],
    orders: [],
    payments: [],
    bookings: [],
    notifications: [],
    consents: [],
  },
};

function job(overrides: Partial<ExportJobMeta> = {}): ExportJobMeta {
  return {
    id: 'job-1',
    business_id: 'b1',
    client_id: 'client-1',
    status: DataExportJobStatus.READY,
    format: DataExportArchiveFormat.JSON,
    token_hash: sha256('tok'),
    byte_size: 120,
    checksum: 'abc',
    sections: {},
    truncated: [],
    requested_by: 'tm-1',
    requested_by_email: 'ops@biz.in',
    request_ip: '1.2.3.4',
    correlation_id: 'corr-1',
    error: null,
    download_count: 0,
    downloaded_at: null,
    started_at: null,
    completed_at: new Date('2026-08-15T10:00:00Z'),
    expires_at: new Date(Date.now() + 60_000),
    created_at: new Date('2026-08-15T09:59:00Z'),
    updated_at: new Date('2026-08-15T10:00:00Z'),
    ...overrides,
  } as ExportJobMeta;
}

function makeHarness(opts: { client?: unknown } = {}) {
  const jobs = {
    create: jest.fn().mockImplementation(async (p) => job({ id: 'job-new', ...p })),
    findById: jest.fn().mockResolvedValue(job()),
    findByTokenHash: jest.fn().mockResolvedValue(job()),
    findPayload: jest
      .fn()
      .mockResolvedValue(
        serializeArchive(BUNDLE, DataExportArchiveFormat.JSON).compressed,
      ),
    list: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    countActive: jest.fn().mockResolvedValue(0),
    claimForBuild: jest.fn().mockResolvedValue(true),
    completeBuild: jest.fn().mockResolvedValue(undefined),
    failBuild: jest.fn().mockResolvedValue(undefined),
    recordDownload: jest.fn().mockResolvedValue(undefined),
    findExpiredGlobal: jest.fn().mockResolvedValue([]),
    findStuckGlobal: jest.fn().mockResolvedValue([]),
    expire: jest.fn().mockResolvedValue(true),
    releaseForRetry: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<ExportJobRepository>;

  const exports = {
    exportClient: jest.fn().mockResolvedValue(BUNDLE),
  } as unknown as jest.Mocked<DataExportService>;

  const repository = {
    findClient: jest
      .fn()
      .mockResolvedValue('client' in opts ? opts.client : { id: 'client-1' }),
  } as unknown as jest.Mocked<DataExportRepository>;

  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<
    AuditLogService
  >;

  const queue = { add: jest.fn().mockResolvedValue(undefined) };

  const service = new ExportJobService(
    jobs,
    exports,
    repository,
    audit,
    queue as never,
  );

  return { service, jobs, exports, repository, audit, queue };
}

describe('ExportJobService', () => {
  describe('requestArchive', () => {
    it('404s for a client that does not belong to this tenant', async () => {
      const { service } = makeHarness({ client: null });
      await expect(
        service.requestArchive('b1', 'other-tenant-client', DataExportArchiveFormat.JSON),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns the token once and stores only its hash', async () => {
      const { service, jobs } = makeHarness();

      const result = await service.requestArchive(
        'b1',
        'client-1',
        DataExportArchiveFormat.JSON,
      );

      expect(result.downloadToken).toBeTruthy();
      const created = jobs.create.mock.calls[0]![0]!;
      expect(created.tokenHash).toBe(sha256(result.downloadToken));
      // The raw token must never appear in anything written to the row.
      expect(JSON.stringify(created)).not.toContain(result.downloadToken);
    });

    it('refuses once the tenant is at its concurrent-build ceiling', async () => {
      const { service, jobs } = makeHarness();
      jobs.countActive.mockResolvedValue(MAX_CONCURRENT_EXPORT_JOBS_PER_TENANT);

      await expect(
        service.requestArchive('b1', 'client-1', DataExportArchiveFormat.JSON),
      ).rejects.toThrow(BadRequestException);
      expect(jobs.create).not.toHaveBeenCalled();
    });

    it('writes the row before enqueuing, so a Redis failure strands nothing', async () => {
      const { service, jobs, queue } = makeHarness();
      queue.add.mockRejectedValue(new Error('redis down'));

      // The request still succeeds: the row is PENDING, which is exactly what
      // the recovery sweep looks for.
      const result = await service.requestArchive(
        'b1',
        'client-1',
        DataExportArchiveFormat.JSON,
      );

      expect(result.jobId).toBeTruthy();
      expect(jobs.create).toHaveBeenCalled();
    });

    it('audits the request', async () => {
      const { service, audit } = makeHarness();
      await service.requestArchive('b1', 'client-1', DataExportArchiveFormat.NDJSON, {
        teamMemberId: 'tm-1',
        email: 'ops@biz.in',
      });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: 'b1',
          resourceType: 'client_data_export_job',
          actorId: 'tm-1',
        }),
      );
    });
  });

  describe('buildArchive', () => {
    it('builds, compresses and completes', async () => {
      const { service, jobs } = makeHarness();
      await service.buildArchive('b1', 'job-1');

      expect(jobs.completeBuild).toHaveBeenCalledTimes(1);
      const completion = jobs.completeBuild.mock.calls[0]![2]!;
      expect(completion.payload.byteLength).toBeGreaterThan(0);
      expect(completion.checksum).toHaveLength(64);
      expect(completion.byteSize).toBeGreaterThan(0);
    });

    it('records which sections were truncated', async () => {
      const { service, jobs } = makeHarness();
      await service.buildArchive('b1', 'job-1');

      expect(jobs.completeBuild.mock.calls[0]![2]!.truncated).toEqual(['messages']);
    });

    it('does nothing when another worker already claimed the job', async () => {
      // Bull re-runs a stalled job and the recovery sweep re-enqueues one, so two
      // workers holding the same job is normal. Building twice would overwrite
      // the first copy's bytes underneath a download in progress.
      const { service, jobs, exports } = makeHarness();
      jobs.claimForBuild.mockResolvedValue(false);

      await service.buildArchive('b1', 'job-1');

      expect(exports.exportClient).not.toHaveBeenCalled();
      expect(jobs.completeBuild).not.toHaveBeenCalled();
    });

    it('marks the row FAILED and rethrows when assembly fails', async () => {
      const { service, jobs, exports } = makeHarness();
      exports.exportClient.mockRejectedValue(new Error('db exploded'));

      await expect(service.buildArchive('b1', 'job-1')).rejects.toThrow('db exploded');
      expect(jobs.failBuild).toHaveBeenCalledWith('b1', 'job-1', 'db exploded');
    });

    it('attributes the build to the original requester, not the worker', async () => {
      const { service, exports } = makeHarness();
      await service.buildArchive('b1', 'job-1');

      expect(exports.exportClient).toHaveBeenCalledWith(
        'b1',
        'client-1',
        expect.objectContaining({ teamMemberId: 'tm-1', email: 'ops@biz.in' }),
      );
    });
  });

  describe('downloadArchive', () => {
    it('serves the inflated archive with its checksum', async () => {
      const { service } = makeHarness();
      const result = await service.downloadArchive('b1', 'job-1', 'tok');

      expect(JSON.parse(result.body.toString('utf8')).businessId).toBe('b1');
      expect(result.contentType).toBe('application/json');
      expect(result.filename).toContain('client-1');
    });

    it('404s on a token that does not match', async () => {
      const { service, jobs } = makeHarness();
      jobs.findByTokenHash.mockResolvedValue(null);

      await expect(service.downloadArchive('b1', 'job-1', 'wrong')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s when the token resolves to another tenant’s archive', async () => {
      // findByTokenHash is the module's only unscoped read; this is the check
      // that makes that safe.
      const { service, jobs } = makeHarness();
      jobs.findByTokenHash.mockResolvedValue(job({ business_id: 'other-biz' }));

      await expect(service.downloadArchive('b1', 'job-1', 'tok')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s when the token is valid but names a different job', async () => {
      const { service, jobs } = makeHarness();
      jobs.findByTokenHash.mockResolvedValue(job({ id: 'job-2' }));

      await expect(service.downloadArchive('b1', 'job-1', 'tok')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses an archive past its TTL even if the sweep has not run', async () => {
      const { service, jobs } = makeHarness();
      jobs.findByTokenHash.mockResolvedValue(
        job({ expires_at: new Date(Date.now() - 1000) }),
      );

      await expect(service.downloadArchive('b1', 'job-1', 'tok')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('reports a not-yet-built archive as a 400, not an empty file', async () => {
      const { service, jobs } = makeHarness();
      jobs.findByTokenHash.mockResolvedValue(job({ status: DataExportJobStatus.BUILDING }));

      await expect(service.downloadArchive('b1', 'job-1', 'tok')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('treats READY-with-no-bytes as expiry rather than a 500', async () => {
      // The sweep can clear the payload between the metadata read and the bytes.
      const { service, jobs } = makeHarness();
      jobs.findPayload.mockResolvedValue(null);

      await expect(service.downloadArchive('b1', 'job-1', 'tok')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('counts and audits every download', async () => {
      const { service, jobs, audit } = makeHarness();
      await service.downloadArchive('b1', 'job-1', 'tok', { teamMemberId: 'tm-2' });

      expect(jobs.recordDownload).toHaveBeenCalledWith('b1', 'job-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ resourceType: 'client_data_export_archive' }),
      );
    });
  });

  describe('expireArchives', () => {
    it('drops the bytes of every archive past its TTL', async () => {
      const { service, jobs } = makeHarness();
      jobs.findExpiredGlobal.mockResolvedValue([
        { id: 'j1', business_id: 'b1' },
        { id: 'j2', business_id: 'b2' },
      ]);

      const result = await service.expireArchives();

      expect(result.expired).toBe(2);
      expect(jobs.expire).toHaveBeenCalledWith('b1', 'j1');
      expect(jobs.expire).toHaveBeenCalledWith('b2', 'j2');
    });

    it('does not count a row another sweep already expired', async () => {
      const { service, jobs } = makeHarness();
      jobs.findExpiredGlobal.mockResolvedValue([{ id: 'j1', business_id: 'b1' }]);
      jobs.expire.mockResolvedValue(false);

      expect((await service.expireArchives()).expired).toBe(0);
    });
  });

  describe('recoverStuck', () => {
    it('re-enqueues a stranded build before resetting its status', async () => {
      const { service, jobs, queue } = makeHarness();
      jobs.findStuckGlobal.mockResolvedValue([{ id: 'j1', business_id: 'b1' }]);
      jobs.findById.mockResolvedValue(job({ status: DataExportJobStatus.PENDING }));

      const order: string[] = [];
      queue.add.mockImplementation(async () => {
        order.push('enqueue');
      });
      jobs.releaseForRetry.mockImplementation(async () => {
        order.push('release');
        return true;
      });

      const result = await service.recoverStuck();

      expect(result.recovered).toBe(1);
      // The other order re-creates the exact stranding this is fixing.
      expect(order).toEqual(['enqueue', 'release']);
    });

    it('skips a row that has gone terminal since the scan', async () => {
      const { service, jobs, queue } = makeHarness();
      jobs.findStuckGlobal.mockResolvedValue([{ id: 'j1', business_id: 'b1' }]);
      jobs.findById.mockResolvedValue(job({ status: DataExportJobStatus.READY }));

      expect((await service.recoverStuck()).recovered).toBe(0);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('fails out a stranded job whose TTL already passed rather than building it', async () => {
      const { service, jobs } = makeHarness();
      jobs.findStuckGlobal.mockResolvedValue([{ id: 'j1', business_id: 'b1' }]);
      jobs.findById.mockResolvedValue(
        job({
          status: DataExportJobStatus.PENDING,
          expires_at: new Date(Date.now() - 1000),
        }),
      );

      expect((await service.recoverStuck()).recovered).toBe(0);
      expect(jobs.failBuild).toHaveBeenCalledWith(
        'b1',
        'j1',
        'Expired before the archive was built',
      );
    });

    it('looks back past the stranding threshold, not from now', async () => {
      const { service, jobs } = makeHarness();
      const before = Date.now();
      await service.recoverStuck();

      const cutoff = jobs.findStuckGlobal.mock.calls[0]![0]! as Date;
      expect(cutoff.getTime()).toBeLessThanOrEqual(before - EXPORT_STUCK_AFTER_MS + 1000);
    });
  });

  describe('listArchives', () => {
    it('clamps the page size', async () => {
      const { service, jobs } = makeHarness();
      await service.listArchives('b1', { limit: 5000 });

      expect(jobs.list.mock.calls[0]![1]!.limit).toBe(100);
    });

    it('never returns archive bytes in a listing', async () => {
      const { service, jobs } = makeHarness();
      jobs.list.mockResolvedValue({ data: [job()], total: 1 });

      const result = await service.listArchives('b1');
      expect(result.data[0]).not.toHaveProperty('payload');
    });
  });

  describe('getArchive', () => {
    it('404s for another tenant’s job id', async () => {
      const { service, jobs } = makeHarness();
      jobs.findById.mockResolvedValue(null);

      await expect(service.getArchive('b1', 'job-x')).rejects.toThrow(NotFoundException);
    });
  });
});
