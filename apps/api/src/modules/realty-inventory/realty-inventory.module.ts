import { Module } from '@nestjs/common';
import { RealtyInventoryController } from './realty-inventory.controller';
import { RealtyInventoryService } from './realty-inventory.service';
import { RealtyInventoryRepository } from './realty-inventory.repository';
import { RealtyLeadsModule } from '../realty-leads/realty-leads.module';

@Module({
  imports: [RealtyLeadsModule],
  controllers: [RealtyInventoryController],
  providers: [RealtyInventoryService, RealtyInventoryRepository],
  exports: [RealtyInventoryService],
})
export class RealtyInventoryModule {}
