import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Module({
  controllers: [],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
