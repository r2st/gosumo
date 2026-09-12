import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/services/audit-log.service';
import { IntegrationsController } from './integrations.controller';
import { ApiKeysController } from './api-keys.controller';

@Module({
  controllers: [IntegrationsController, ApiKeysController],
  providers: [AuditLogService],
})
export class IntegrationsModule {}
