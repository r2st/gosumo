import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { realty_migration_runs } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  MigrationKind,
  MigrationStatus,
  ProjectStatus,
  UnitAvailability,
} from '@gosumo/shared';
import type {
  MigrationSummary,
  MigrationRowError,
  RealtyMigrationCompletedEvent,
} from '@gosumo/shared';
import { RealtyPilotRepository } from './realty-pilot.repository';
import { RealtyIngestionService } from '../realty-ingestion/realty-ingestion.service';
import { RealtyInventoryService } from '../realty-inventory/realty-inventory.service';
import { normalizeCsvRows } from '../realty-ingestion/csv-import.util';
import type { RawCsvRow } from '../realty-ingestion/csv-import.util';
import { normalizeInventoryRows } from './inventory-import.util';
import { ImportLeadsDto, ImportInventoryDto } from './dto';

export interface MigrationRunDto extends MigrationSummary {
  id: string;
  createdBy: string | null;
  createdAt: Date;
}

/**
 * MigrationService — pilot-firm data migration tooling (Phase 8, blueprint §22).
 *
 * Imports a pilot broker's existing book of business: leads/contacts (reusing
 * the ingestion module's E.164 identity-merge) and inventory (projects + units,
 * via the inventory module). Every run is validated first; a `dryRun` reports
 * what WOULD happen and writes nothing. Each run is recorded to
 * `realty_migration_runs` for an auditable import history.
 */
@Injectable()
export class MigrationService {
  private readonly logger = new Logger(MigrationService.name);

  constructor(
    private readonly repository: RealtyPilotRepository,
    private readonly ingestionService: RealtyIngestionService,
    private readonly inventoryService: RealtyInventoryService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Leads / contacts ─────────────────────────

  async importLeads(
    businessId: string,
    dto: ImportLeadsDto,
    createdBy?: string,
  ): Promise<MigrationRunDto> {
    const kind = dto.kind ?? MigrationKind.LEADS;
    const dryRun = dto.dryRun ?? false;
    const rows = dto.rows as RawCsvRow[];

    let summary: MigrationSummary;
    let status: MigrationStatus;

    if (dryRun) {
      const { valid, errors } = normalizeCsvRows(rows);
      summary = {
        kind,
        status: MigrationStatus.VALIDATED,
        dryRun: true,
        total: rows.length,
        created: valid.length, // upper bound — merges are only known on commit
        merged: 0,
        skipped: errors.length,
        errors,
      };
      status = MigrationStatus.VALIDATED;
    } else {
      try {
        const result = await this.ingestionService.importCsv(businessId, { rows: dto.rows });
        summary = {
          kind,
          status: MigrationStatus.COMMITTED,
          dryRun: false,
          total: result.total,
          created: result.created,
          merged: result.merged,
          skipped: result.skipped,
          errors: result.errors,
        };
        status = MigrationStatus.COMMITTED;
      } catch (err) {
        summary = this.failedSummary(kind, rows.length, err);
        status = MigrationStatus.FAILED;
      }
    }

    return this.recordRun(businessId, kind, status, summary, createdBy);
  }

  // ── Inventory ────────────────────────────────

  async importInventory(
    businessId: string,
    dto: ImportInventoryDto,
    createdBy?: string,
  ): Promise<MigrationRunDto> {
    const dryRun = dto.dryRun ?? false;
    const { projects, errors } = normalizeInventoryRows(dto.rows);
    const unitCount = projects.reduce((sum, p) => sum + p.units.length, 0);

    if (dryRun) {
      const summary: MigrationSummary = {
        kind: MigrationKind.INVENTORY,
        status: MigrationStatus.VALIDATED,
        dryRun: true,
        total: dto.rows.length,
        created: projects.length + unitCount,
        merged: 0,
        skipped: errors.length,
        errors,
      };
      return this.recordRun(businessId, MigrationKind.INVENTORY, MigrationStatus.VALIDATED, summary, createdBy);
    }

    const commitErrors: MigrationRowError[] = [...errors];
    let createdCount = 0;

    for (let i = 0; i < projects.length; i++) {
      const project = projects[i]!;
      try {
        const created = await this.inventoryService.createProject(businessId, {
          name: project.name,
          locality: project.locality,
          developer: project.developer,
          reraNumber: project.reraNumber,
          possessionDate: project.possessionDate,
          status: project.status as ProjectStatus | undefined,
          priceBandMinPaise: project.priceBandMinPaise,
          priceBandMaxPaise: project.priceBandMaxPaise,
        });
        createdCount++;

        for (const unit of project.units) {
          try {
            await this.inventoryService.createUnit(businessId, created.id, {
              config: unit.config,
              allInPricePaise: unit.allInPricePaise,
              carpetSqft: unit.carpetSqft,
              floor: unit.floor,
              facing: unit.facing,
              availability: unit.availability as UnitAvailability | undefined,
            });
            createdCount++;
          } catch (err) {
            commitErrors.push({
              row: i + 1,
              reason: `Unit "${unit.config}" of "${project.name}" failed: ${this.msg(err)}`,
            });
          }
        }
      } catch (err) {
        commitErrors.push({ row: i + 1, reason: `Project "${project.name}" failed: ${this.msg(err)}` });
      }
    }

    const status =
      createdCount === 0 && projects.length > 0 ? MigrationStatus.FAILED : MigrationStatus.COMMITTED;
    const summary: MigrationSummary = {
      kind: MigrationKind.INVENTORY,
      status,
      dryRun: false,
      total: dto.rows.length,
      created: createdCount,
      merged: 0,
      skipped: commitErrors.length,
      errors: commitErrors,
    };
    return this.recordRun(businessId, MigrationKind.INVENTORY, status, summary, createdBy);
  }

  // ── History ──────────────────────────────────

  async getRun(businessId: string, id: string): Promise<MigrationRunDto | null> {
    const run = await this.repository.findMigrationRun(businessId, id);
    return run ? this.map(run) : null;
  }

  async listRuns(businessId: string, filters: { kind?: string }): Promise<MigrationRunDto[]> {
    const runs = await this.repository.listMigrationRuns(businessId, filters);
    return runs.map((r) => this.map(r));
  }

  // ── Helpers ──────────────────────────────────

  private async recordRun(
    businessId: string,
    kind: MigrationKind,
    status: MigrationStatus,
    summary: MigrationSummary,
    createdBy?: string,
  ): Promise<MigrationRunDto> {
    const run = await this.repository.createMigrationRun({
      businessId,
      kind: kind as realty_migration_runs['kind'],
      status: status as realty_migration_runs['status'],
      dryRun: summary.dryRun,
      totalRows: summary.total,
      createdCount: summary.created,
      mergedCount: summary.merged,
      skippedCount: summary.skipped,
      errorCount: summary.errors.length,
      errors: summary.errors as unknown as Prisma.InputJsonValue,
      summary: { kind, status, dryRun: summary.dryRun } as Prisma.InputJsonValue,
      createdBy,
    });

    const event: RealtyMigrationCompletedEvent = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      type: 'realty.migration.completed',
      runId: run.id,
      kind,
      status,
      dryRun: summary.dryRun,
      created: summary.created,
      merged: summary.merged,
      skipped: summary.skipped,
    };
    this.eventEmitter.emit('realty.migration.completed', event);

    this.logger.log(
      `Migration ${kind} (${status}${summary.dryRun ? ', dry-run' : ''}) for ${businessId}: ` +
        `${summary.created} created, ${summary.merged} merged, ${summary.skipped} skipped`,
    );
    return this.map(run);
  }

  private failedSummary(kind: MigrationKind, total: number, err: unknown): MigrationSummary {
    return {
      kind,
      status: MigrationStatus.FAILED,
      dryRun: false,
      total,
      created: 0,
      merged: 0,
      skipped: total,
      errors: [{ row: 0, reason: `Import failed: ${this.msg(err)}` }],
    };
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private map(run: realty_migration_runs): MigrationRunDto {
    return {
      id: run.id,
      kind: run.kind,
      status: run.status,
      dryRun: run.dry_run,
      total: run.total_rows,
      created: run.created_count,
      merged: run.merged_count,
      skipped: run.skipped_count,
      errors: (run.errors ?? []) as unknown as MigrationRowError[],
      createdBy: run.created_by,
      createdAt: run.created_at,
    };
  }
}
