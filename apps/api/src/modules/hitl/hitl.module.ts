import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { HitlController } from './hitl.controller';
import { HitlService } from './hitl.service';
import { HitlRepository } from './hitl.repository';

@Module({
  controllers: [HitlController],
  providers: [HitlService, HitlRepository, PrismaService],
  exports: [HitlService],
})
export class HitlModule {}
