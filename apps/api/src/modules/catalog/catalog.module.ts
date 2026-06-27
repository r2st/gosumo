import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { CatalogRepository } from './catalog.repository';

@Module({
  controllers: [CatalogController],
  providers: [CatalogService, CatalogRepository, PrismaService],
  exports: [CatalogService],
})
export class CatalogModule {}
