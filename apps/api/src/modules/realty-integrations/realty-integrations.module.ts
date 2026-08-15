import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { RealtyLeadsModule } from '../realty-leads/realty-leads.module';
import { RealtyInventoryModule } from '../realty-inventory/realty-inventory.module';
import { BillingModule } from '../billing/billing.module';
import { RazorpayService } from '../payment/razorpay.service';

import { RealtyIntegrationsRepository } from './realty-integrations.repository';
import {
  REALTY_INTEGRATIONS_QUEUE,
  REALTY_INTEGRATIONS_JOBS,
  NIGHTLY_SHEETS_EXPORT_JOB_ID,
  NIGHTLY_SHEETS_EXPORT_CRON,
} from './realty-integrations.constants';

// Google Sheets export
import { GoogleSheetsClient, GOOGLE_SHEETS_CLIENT } from './sheets/google-sheets.client';
import { SheetsExportService } from './sheets/sheets-export.service';
import { SheetsExportProcessor } from './sheets/sheets-export.processor';
import { RealtySheetsController } from './sheets/realty-sheets.controller';

// CRM push
import { SellDoAdapter } from './crm/selldo.adapter';
import { LeadSquaredAdapter } from './crm/leadsquared.adapter';
import { PrivyrAdapter } from './crm/privyr.adapter';
import { CrmPushService } from './crm/crm-push.service';
import { RealtyCrmController } from './crm/realty-crm.controller';

// EOI payments
import { EoiService } from './eoi/eoi.service';
import { RealtyEoiController } from './eoi/eoi.controller';

/**
 * RealtyIntegrationsModule (GoSumo Realty — Phase 5) — the outbound-integration
 * surface:
 *
 *  1. Google Sheets export — one-click + nightly scheduled export of leads +
 *     inventory to a business's connected sheet (BullMQ repeatable job).
 *  2. CRM push — pushes leads to Sell.Do / LeadSquared / Privyr on
 *     create/qualify/stage-change (Developer-tier "CRM sync" feature).
 *  3. Razorpay EOI (टोकन) payments — broker-approved payment links for qualified
 *     leads, with paid → stage advance.
 *
 * Owns `realty_integration_connections` + `realty_eoi_requests`. Provides its own
 * RazorpayService instance (stateless, config-driven) and a GoogleSheetsClient
 * bound to the {@link GOOGLE_SHEETS_CLIENT} token so tests can inject a fake.
 */
@Module({
  imports: [
    RealtyLeadsModule,
    RealtyInventoryModule,
    BillingModule,
    BullModule.registerQueue({ name: REALTY_INTEGRATIONS_QUEUE }),
  ],
  controllers: [RealtySheetsController, RealtyCrmController, RealtyEoiController],
  providers: [
    RealtyIntegrationsRepository,
    RazorpayService,
    // Sheets
    { provide: GOOGLE_SHEETS_CLIENT, useClass: GoogleSheetsClient },
    SheetsExportService,
    SheetsExportProcessor,
    // CRM
    SellDoAdapter,
    LeadSquaredAdapter,
    PrivyrAdapter,
    CrmPushService,
    // EOI
    EoiService,
  ],
  exports: [SheetsExportService, CrmPushService, EoiService],
})
export class RealtyIntegrationsModule implements OnModuleInit {
  private readonly logger = new Logger(RealtyIntegrationsModule.name);

  constructor(
    @InjectQueue(REALTY_INTEGRATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Register the nightly Google Sheets export as a BullMQ repeatable job. Uses a
   * stable jobId and clears any prior repeatable with a different schedule first,
   * so a redeploy never accumulates duplicate schedules. Redis being unavailable
   * (tests/CI) must never block boot.
   */
  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.queue.getRepeatableJobs();
      await Promise.all(
        existing
          .filter(
            (job) =>
              job.id === NIGHTLY_SHEETS_EXPORT_JOB_ID &&
              job.cron !== NIGHTLY_SHEETS_EXPORT_CRON,
          )
          .map((job) => this.queue.removeRepeatableByKey(job.key)),
      );
      await this.queue.add(
        REALTY_INTEGRATIONS_JOBS.NIGHTLY_SHEETS_EXPORT,
        {},
        {
          jobId: NIGHTLY_SHEETS_EXPORT_JOB_ID,
          repeat: { cron: NIGHTLY_SHEETS_EXPORT_CRON },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      this.logger.log(
        `Scheduled nightly Google Sheets export (${NIGHTLY_SHEETS_EXPORT_CRON})`,
      );
    } catch (err) {
      this.logger.warn(
        `Could not schedule nightly Sheets export: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
