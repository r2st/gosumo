import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { ApiKeysController } from './api-keys.controller';

@Module({
  controllers: [IntegrationsController, ApiKeysController],
})
export class IntegrationsModule {}
