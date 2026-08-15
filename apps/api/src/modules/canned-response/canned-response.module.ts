import { Module } from '@nestjs/common';
import { CannedResponseController } from './canned-response.controller';
import { CannedResponseService } from './canned-response.service';
import { CannedResponseRepository } from './canned-response.repository';

/**
 * CannedResponseModule — reusable pre-written replies for agents.
 */
@Module({
  controllers: [CannedResponseController],
  providers: [CannedResponseService, CannedResponseRepository],
  exports: [CannedResponseService],
})
export class CannedResponseModule {}
