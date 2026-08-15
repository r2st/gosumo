/**
 * MigrationService unit tests (Phase 8). Repository, ingestion, inventory, and
 * the emitter are mocked. Covers dry-run (no writes), committed leads import,
 * committed inventory import, and the FAILED path.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MigrationStatus } from '@gosumo/shared';

import { MigrationService } from './migration.service';
import { RealtyPilotRepository } from './realty-pilot.repository';
import { RealtyIngestionService } from '../realty-ingestion/realty-ingestion.service';
import { RealtyInventoryService } from '../realty-inventory/realty-inventory.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const USER_ID = '00000000-0000-4000-a000-000000000070';

describe('MigrationService', () => {
  let service: MigrationService;
  let repository: jest.Mocked<RealtyPilotRepository>;
  let ingestion: jest.Mocked<RealtyIngestionService>;
  let inventory: jest.Mocked<RealtyInventoryService>;
  let emitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepo: Partial<Record<keyof RealtyPilotRepository, jest.Mock>> = {
      createMigrationRun: jest.fn().mockImplementation((d) =>
        Promise.resolve({
          id: 'run-1',
          kind: d.kind,
          status: d.status,
          dry_run: d.dryRun,
          total_rows: d.totalRows,
          created_count: d.createdCount,
          merged_count: d.mergedCount,
          skipped_count: d.skippedCount,
          error_count: d.errorCount,
          errors: d.errors,
          created_by: d.createdBy ?? null,
          created_at: new Date(),
        }),
      ),
    };
    const mockIngestion = { importCsv: jest.fn() };
    const mockInventory = { createProject: jest.fn(), createUnit: jest.fn() };
    const mockEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MigrationService,
        { provide: RealtyPilotRepository, useValue: mockRepo },
        { provide: RealtyIngestionService, useValue: mockIngestion },
        { provide: RealtyInventoryService, useValue: mockInventory },
        { provide: EventEmitter2, useValue: mockEmitter },
      ],
    }).compile();

    service = module.get(MigrationService);
    repository = module.get(RealtyPilotRepository) as jest.Mocked<RealtyPilotRepository>;
    ingestion = module.get(RealtyIngestionService) as jest.Mocked<RealtyIngestionService>;
    inventory = module.get(RealtyInventoryService) as jest.Mocked<RealtyInventoryService>;
    emitter = module.get(EventEmitter2) as jest.Mocked<EventEmitter2>;
    jest.clearAllMocks();
  });

  describe('importLeads', () => {
    it('dry-run validates without calling the ingestion importer', async () => {
      const run = await service.importLeads(
        BUSINESS_ID,
        { rows: [{ phone: '9876543210' }, { phone: 'not-a-phone' }], dryRun: true },
        USER_ID,
      );
      expect(ingestion.importCsv).not.toHaveBeenCalled();
      expect(run.status).toBe(MigrationStatus.VALIDATED);
      expect(run.created).toBe(1); // one valid phone
      expect(run.skipped).toBe(1); // one invalid
      expect(repository.createMigrationRun).toHaveBeenCalled();
    });

    it('commit delegates to ingestion and records a COMMITTED run + event', async () => {
      ingestion.importCsv.mockResolvedValue({ total: 3, created: 2, merged: 1, skipped: 0, failed: 0, errors: [] });
      const run = await service.importLeads(BUSINESS_ID, { rows: [{ phone: '9876543210' }] });
      expect(ingestion.importCsv).toHaveBeenCalledWith(BUSINESS_ID, { rows: [{ phone: '9876543210' }] });
      expect(run.status).toBe(MigrationStatus.COMMITTED);
      expect(run.merged).toBe(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.migration.completed',
        expect.objectContaining({ status: MigrationStatus.COMMITTED, merged: 1 }),
      );
    });

    /**
     * `importCsv` reports two kinds of non-landing row apart — `skipped` for one
     * it rejected, `failed` for one whose write threw — because the ingestion
     * webhooks need that distinction to decide what is worth dead-lettering. A
     * migration run has a single "did not land" counter, so both belong in it.
     * Recording only `skipped` would file a run whose rows all hit a database
     * blip as having skipped nothing, and the audit history is the only place
     * an operator would look.
     */
    it('counts rows that errored, not just rows that were rejected', async () => {
      ingestion.importCsv.mockResolvedValue({
        total: 4,
        created: 1,
        merged: 0,
        skipped: 1,
        failed: 2,
        errors: [
          { row: 2, reason: 'invalid phone' },
          { row: 3, reason: 'db down' },
          { row: 4, reason: 'db down' },
        ],
      });

      const run = await service.importLeads(BUSINESS_ID, { rows: [{ phone: '9876543210' }] });

      expect(run.skipped).toBe(3);
      // The count and the reasons have to agree — an operator reading one
      // against the other is exactly how a silent loss gets noticed.
      expect(run.errors).toHaveLength(3);
    });

    it('records a FAILED run when the importer throws', async () => {
      ingestion.importCsv.mockRejectedValue(new Error('db down'));
      const run = await service.importLeads(BUSINESS_ID, { rows: [{ phone: '9876543210' }] });
      expect(run.status).toBe(MigrationStatus.FAILED);
      expect(run.errors[0]!.reason).toMatch(/db down/);
    });

    /**
     * `importCsv` collects per-row failures into `errors` and returns normally,
     * so "it resolved" is not "it imported". A run that touched no lead is a
     * failed run — the inventory path already says so, and filing it as
     * COMMITTED leaves the operator with an audit row claiming a migration
     * that moved nothing.
     */
    it('records FAILED when every row was rejected', async () => {
      ingestion.importCsv.mockResolvedValue({
        total: 3,
        created: 0,
        merged: 0,
        skipped: 3,
        failed: 0,
        errors: [
          { row: 1, reason: 'invalid phone' },
          { row: 2, reason: 'invalid phone' },
          { row: 3, reason: 'invalid phone' },
        ],
      });
      const run = await service.importLeads(BUSINESS_ID, {
        rows: [{ phone: 'x' }, { phone: 'y' }, { phone: 'z' }],
      });
      expect(run.status).toBe(MigrationStatus.FAILED);
      expect(run.created).toBe(0);
      expect(run.skipped).toBe(3);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.migration.completed',
        expect.objectContaining({ status: MigrationStatus.FAILED }),
      );
    });

    it('still records COMMITTED when a single row merged and the rest failed', async () => {
      // Partial success is a real import: one buyer's history now exists.
      ingestion.importCsv.mockResolvedValue({
        total: 3,
        created: 0,
        merged: 1,
        skipped: 2,
        failed: 0,
        errors: [{ row: 2, reason: 'invalid phone' }, { row: 3, reason: 'invalid phone' }],
      });
      const run = await service.importLeads(BUSINESS_ID, {
        rows: [{ phone: '9876543210' }, { phone: 'y' }, { phone: 'z' }],
      });
      expect(run.status).toBe(MigrationStatus.COMMITTED);
    });

    it('records COMMITTED for an empty file rather than calling it a failure', async () => {
      // Nothing to import is not a failed import; only a run that had rows and
      // moved none of them is.
      ingestion.importCsv.mockResolvedValue({ total: 0, created: 0, merged: 0, skipped: 0, failed: 0, errors: [] });
      const run = await service.importLeads(BUSINESS_ID, { rows: [] });
      expect(run.status).toBe(MigrationStatus.COMMITTED);
    });
  });

  describe('importInventory', () => {
    it('dry-run counts projects + units without writing', async () => {
      const run = await service.importInventory(
        BUSINESS_ID,
        {
          rows: [
            { projectName: 'Skyline', locality: 'Baner', config: '2BHK', allInPrice: '85L' },
            { projectName: 'Skyline', locality: 'Baner', config: '3BHK', allInPrice: '1.1Cr' },
          ],
          dryRun: true,
        },
        USER_ID,
      );
      expect(inventory.createProject).not.toHaveBeenCalled();
      expect(run.status).toBe(MigrationStatus.VALIDATED);
      expect(run.created).toBe(3); // 1 project + 2 units
    });

    it('commit creates projects then their units', async () => {
      inventory.createProject.mockResolvedValue({ id: 'proj-1' } as never);
      inventory.createUnit.mockResolvedValue({ id: 'unit-1' } as never);
      const run = await service.importInventory(BUSINESS_ID, {
        rows: [
          { projectName: 'Skyline', locality: 'Baner', config: '2BHK', allInPrice: '85L' },
          { projectName: 'Skyline', locality: 'Baner', config: '3BHK', allInPrice: '1.1Cr' },
        ],
      });
      expect(inventory.createProject).toHaveBeenCalledTimes(1);
      expect(inventory.createUnit).toHaveBeenCalledTimes(2);
      expect(inventory.createUnit).toHaveBeenCalledWith(
        BUSINESS_ID,
        'proj-1',
        expect.objectContaining({ config: '2BHK' }),
      );
      expect(run.status).toBe(MigrationStatus.COMMITTED);
      expect(run.created).toBe(3);
    });

    it('captures a per-project failure as a skipped row without aborting', async () => {
      inventory.createProject
        .mockResolvedValueOnce({ id: 'proj-1' } as never)
        .mockRejectedValueOnce(new Error('bad project'));
      inventory.createUnit.mockResolvedValue({ id: 'unit-1' } as never);
      const run = await service.importInventory(BUSINESS_ID, {
        rows: [
          { projectName: 'Skyline', locality: 'Baner', config: '2BHK', allInPrice: '85L' },
          { projectName: 'Riverside', locality: 'Wakad', config: '2BHK', allInPrice: '70L' },
        ],
      });
      expect(run.created).toBe(2); // proj-1 + its unit
      expect(run.errors.some((e) => /bad project/.test(e.reason))).toBe(true);
    });

    it('records FAILED when every project in the file failed to commit', async () => {
      // Partial success stays COMMITTED (above); total failure must not, or
      // the import history shows a green run that imported nothing.
      inventory.createProject.mockRejectedValue(new Error('db down'));

      const run = await service.importInventory(BUSINESS_ID, {
        rows: [{ projectName: 'Skyline', locality: 'Baner', config: '2BHK', allInPrice: '85L' }],
      });

      expect(run.status).toBe(MigrationStatus.FAILED);
      expect(run.created).toBe(0);
    });

    it('captures a per-unit failure without losing the project that succeeded', async () => {
      inventory.createProject.mockResolvedValue({ id: 'proj-1' } as never);
      inventory.createUnit.mockRejectedValue(new Error('bad unit'));

      const run = await service.importInventory(BUSINESS_ID, {
        rows: [{ projectName: 'Skyline', locality: 'Baner', config: '2BHK', allInPrice: '85L' }],
      });

      // The project landed, so the run committed even though its unit did not.
      expect(run.status).toBe(MigrationStatus.COMMITTED);
      expect(run.created).toBe(1);
      expect(run.errors.some((e) => /bad unit/.test(e.reason))).toBe(true);
    });

    it('reports a non-Error thrown by the inventory service as its string form', async () => {
      inventory.createProject.mockRejectedValue('connection reset');

      const run = await service.importInventory(BUSINESS_ID, {
        rows: [{ projectName: 'Skyline', locality: 'Baner', config: '2BHK', allInPrice: '85L' }],
      });

      // Not "undefined" — the reason is what the operator reads in the history.
      expect(run.errors[0]?.reason).toContain('connection reset');
    });

    /**
     * A file whose every row failed validation never reaches the commit loop,
     * so `projects.length` is 0 and the run is recorded COMMITTED — created 0,
     * skipped N. That reads as success in the import history for what is
     * really a rejected file, and it is the one case the FAILED branch above
     * deliberately excludes (`createdCount === 0 && projects.length > 0`).
     *
     * Pinned rather than changed: which status an all-invalid file deserves is
     * a product call, not a test's.
     */
    it('records an all-invalid file as COMMITTED with nothing created', async () => {
      const run = await service.importInventory(BUSINESS_ID, {
        rows: [{ projectName: '', locality: '', config: '', allInPrice: '' }],
      });

      expect(run.created).toBe(0);
      expect(run.status).toBe(MigrationStatus.COMMITTED);
      expect(run.errors.length).toBeGreaterThan(0);
      expect(inventory.createProject).not.toHaveBeenCalled();
    });
  });

  describe('history', () => {
    const row = {
      id: 'run-1',
      kind: 'INVENTORY',
      status: 'COMMITTED',
      dry_run: false,
      total_rows: 4,
      created_count: 3,
      merged_count: 0,
      skipped_count: 1,
      errors: [{ row: 2, reason: 'no locality' }],
      created_by: USER_ID,
      created_at: new Date('2026-07-04T00:00:00Z'),
    };

    it('maps a stored run onto the DTO', async () => {
      repository.findMigrationRun = jest.fn().mockResolvedValue(row);

      await expect(service.getRun(BUSINESS_ID, 'run-1')).resolves.toEqual({
        id: 'run-1',
        kind: 'INVENTORY',
        status: 'COMMITTED',
        dryRun: false,
        total: 4,
        created: 3,
        merged: 0,
        skipped: 1,
        errors: [{ row: 2, reason: 'no locality' }],
        createdBy: USER_ID,
        createdAt: new Date('2026-07-04T00:00:00Z'),
      });
    });

    it('returns null for a run this tenant cannot see', async () => {
      repository.findMigrationRun = jest.fn().mockResolvedValue(null);

      await expect(service.getRun(BUSINESS_ID, 'run-1')).resolves.toBeNull();
    });

    it('renders a run whose errors column is null as an empty list', async () => {
      // The DTO's `errors` is read directly by the console; a null there
      // would throw on `.length` rather than render an empty history.
      repository.findMigrationRun = jest.fn().mockResolvedValue({ ...row, errors: null });

      const run = await service.getRun(BUSINESS_ID, 'run-1');

      expect(run?.errors).toEqual([]);
    });

    it('maps every run in the list and passes the filter through', async () => {
      repository.listMigrationRuns = jest
        .fn()
        .mockResolvedValue([row, { ...row, id: 'run-2', status: 'FAILED' }]);

      const runs = await service.listRuns(BUSINESS_ID, { kind: 'INVENTORY' });

      expect(repository.listMigrationRuns).toHaveBeenCalledWith(BUSINESS_ID, {
        kind: 'INVENTORY',
      });
      expect(runs.map((r) => r.id)).toEqual(['run-1', 'run-2']);
      expect(runs[1]?.status).toBe('FAILED');
      expect(runs[0]).not.toHaveProperty('total_rows');
    });

    it('returns an empty history rather than null', async () => {
      repository.listMigrationRuns = jest.fn().mockResolvedValue([]);

      await expect(service.listRuns(BUSINESS_ID, {})).resolves.toEqual([]);
    });
  });
});
