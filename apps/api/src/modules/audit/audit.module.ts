import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';

/**
 * AuditModule — the read API over `audit_logs`.
 *
 * Reads only. The writer (`AuditLogService`) lives in `common/services` because
 * every module needs it; splitting the reader out here keeps the query surface,
 * its filters and its role gate in one place rather than spread across whichever
 * module happened to need a listing.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditRepository],
  exports: [AuditService],
})
export class AuditModule {}
