import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';

@Module({
  controllers: [],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
