import { Module } from '@nestjs/common';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';
import { DataExportRepository } from './data-export.repository';
import { AuditLogService } from '../../common/services/audit-log.service';

/**
 * DataExportModule — subject-access exports for a customer (DPDPA §11,
 * GDPR Art. 15).
 *
 * Reads across eight modules' tables, which is the one place the repository
 * rule bends: going through each owning service would mean nine round trips
 * and nine chances for a scope to be implied rather than stated, for a read
 * that is the worst possible place to get tenant isolation wrong. The reads
 * live in `DataExportRepository`, they are all `findMany`, and every one names
 * `business_id` — see that file's header.
 *
 * `AuditLogService` is provided locally, as `conversation` and `tenant` do: it
 * is a stateless writer over the globally-provided `PrismaService`.
 */
@Module({
  controllers: [DataExportController],
  providers: [DataExportService, DataExportRepository, AuditLogService],
  exports: [DataExportService],
})
export class DataExportModule {}
