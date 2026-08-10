import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { SheetsExportService } from './sheets-export.service';
import {
  REALTY_INTEGRATIONS_QUEUE,
  REALTY_INTEGRATIONS_JOBS,
} from '../realty-integrations.constants';

/**
 * SheetsExportProcessor — consumes the nightly Google Sheets export job off the
 * `realty-integrations` queue. Holds no logic; delegates to
 * {@link SheetsExportService.runNightlyExport} so the same path is exercised by
 * unit tests and a manual trigger.
 */
@Processor(REALTY_INTEGRATIONS_QUEUE)
export class SheetsExportProcessor {
  private readonly logger = new Logger(SheetsExportProcessor.name);

  constructor(private readonly exportService: SheetsExportService) {}

  @Process(REALTY_INTEGRATIONS_JOBS.NIGHTLY_SHEETS_EXPORT)
  async handleNightlyExport(): Promise<void> {
    this.logger.log('Running nightly Google Sheets export sweep');
    const { businesses, failures } = await this.exportService.runNightlyExport();
    this.logger.log(
      `Nightly Sheets export finished: ${businesses} business(es), ${failures} failure(s)`,
    );
  }
}
