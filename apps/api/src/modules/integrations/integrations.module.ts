import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { ApiKeysController } from './api-keys.controller';
import { PrismaService } from '../../common/services/prisma.service';

@Module({
  controllers: [IntegrationsController, ApiKeysController],
  providers: [PrismaService],
})
export class IntegrationsModule {}
