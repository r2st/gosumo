import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { InvoiceService } from './invoice.service';
import { PaymentRepository } from './payment.repository';
import { RazorpayService } from './razorpay.service';
import { StripeService } from './stripe.service';
import { WebhookLogModule } from '../webhook-log/webhook-log.module';

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
  // WebhookLogModule supplies the dead-letter queue a failed gateway webhook
  // is parked in — without it a webhook that throws is lost, since
  // `webhook_events` has already deduped away every gateway redelivery.
  imports: [WebhookLogModule],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    InvoiceService,
    PaymentRepository,
    RazorpayService,
    StripeService,
  ],
  exports: [PaymentService, InvoiceService],
})
export class PaymentModule {}
