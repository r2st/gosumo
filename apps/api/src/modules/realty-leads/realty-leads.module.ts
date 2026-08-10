import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtyLeadsController } from './realty-leads.controller';
import { RealtyLeadsService } from './realty-leads.service';
import { RealtyLeadsRepository } from './realty-leads.repository';

@Module({
  controllers: [RealtyLeadsController],
  providers: [RealtyLeadsService, RealtyLeadsRepository, PrismaService],
  exports: [RealtyLeadsService],
})
export class RealtyLeadsModule {}
