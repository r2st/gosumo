/**
 * MigrationService unit tests (Phase 8). Repository, ingestion, inventory, and
 * the emitter are mocked. Covers dry-run (no writes), committed leads import,
 * committed inventory import, and the FAILED path.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MigrationKind, MigrationStatus } from '@gosumo/shared';

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
      ingestion.importCsv.mockResolvedValue({ total: 3, created: 2, merged: 1, skipped: 0, errors: [] });
      const run = await service.importLeads(BUSINESS_ID, { rows: [{ phone: '9876543210' }] });
      expect(ingestion.importCsv).toHaveBeenCalledWith(BUSINESS_ID, { rows: [{ phone: '9876543210' }] });
      expect(run.status).toBe(MigrationStatus.COMMITTED);
      expect(run.merged).toBe(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.migration.completed',
        expect.objectContaining({ status: MigrationStatus.COMMITTED, merged: 1 }),
      );
    });

    it('records a FAILED run when the importer throws', async () => {
      ingestion.importCsv.mockRejectedValue(new Error('db down'));
      const run = await service.importLeads(BUSINESS_ID, { rows: [{ phone: '9876543210' }] });
      expect(run.status).toBe(MigrationStatus.FAILED);
      expect(run.errors[0]!.reason).toMatch(/db down/);
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
  });
});
