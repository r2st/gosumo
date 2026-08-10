import { Module } from '@nestjs/common';
import { CannedResponseController } from './canned-response.controller';
import { CannedResponseService } from './canned-response.service';
import { CannedResponseRepository } from './canned-response.repository';
import { PrismaService } from '../../common/services/prisma.service';

/**
 * CannedResponseModule — reusable pre-written replies for agents.
 */
@Module({
  controllers: [CannedResponseController],
  providers: [CannedResponseService, CannedResponseRepository, PrismaService],
  exports: [CannedResponseService],
})
export class CannedResponseModule {}
