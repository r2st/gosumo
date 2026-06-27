import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { InvoiceService } from './invoice.service';
import { PaymentRepository } from './payment.repository';
import { RazorpayService } from './razorpay.service';
import { StripeService } from './stripe.service';

/**
 * PaymentModule
 *
 * Owns all money movement: payment links (Razorpay for India, Stripe for
 * international), COD confirmation, refunds, invoices, webhook ingestion, and
 * gateway reconciliation.
 *
 * Exports PaymentService and InvoiceService for synchronous reads by the
 * order module; cross-module side effects flow through domain events.
 */
@Module({
  controllers: [PaymentController],
  providers: [
    PaymentService,
    InvoiceService,
    PaymentRepository,
    RazorpayService,
    StripeService,
    PrismaService,
  ],
  exports: [PaymentService, InvoiceService],
})
export class PaymentModule {}
