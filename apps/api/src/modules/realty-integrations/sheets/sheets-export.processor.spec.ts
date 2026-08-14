import { Logger } from '@nestjs/common';
import { SheetsExportProcessor } from './sheets-export.processor';
import { SheetsExportService } from './sheets-export.service';
import {
  REALTY_INTEGRATIONS_QUEUE,
  REALTY_INTEGRATIONS_JOBS,
} from '../realty-integrations.constants';

const QUEUE_METADATA = 'bull:module_queue';
const PROCESS_METADATA = 'bull:module_queue_process';

describe('SheetsExportProcessor', () => {
  let exportService: { runNightlyExport: jest.Mock };
  let log: jest.SpyInstance;
  let processor: SheetsExportProcessor;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    exportService = {
      runNightlyExport: jest
        .fn()
        .mockResolvedValue({ businesses: 0, failures: 0 }),
    };
    processor = new SheetsExportProcessor(
      exportService as unknown as SheetsExportService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('queue wiring', () => {
    it('is registered against the realty-integrations queue', () => {
      expect(Reflect.getMetadata(QUEUE_METADATA, SheetsExportProcessor)).toEqual(
        expect.objectContaining({ name: REALTY_INTEGRATIONS_QUEUE }),
      );
    });

    it('binds handleNightlyExport to the nightly export job name', () => {
      // @Process stores its metadata on the handler function itself.
      expect(
        Reflect.getMetadata(
          PROCESS_METADATA,
          SheetsExportProcessor.prototype.handleNightlyExport,
        ),
      ).toEqual(
        expect.objectContaining({
          name: REALTY_INTEGRATIONS_JOBS.NIGHTLY_SHEETS_EXPORT,
        }),
      );
    });
  });

  describe('handleNightlyExport', () => {
    it('runs the sweep exactly once per job', async () => {
      await processor.handleNightlyExport();
      expect(exportService.runNightlyExport).toHaveBeenCalledTimes(1);
    });

    it('logs the business and failure counts the sweep reports', async () => {
      exportService.runNightlyExport.mockResolvedValueOnce({
        businesses: 7,
        failures: 2,
      });
      await processor.handleNightlyExport();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('7 business(es), 2 failure(s)'),
      );
    });

    it('completes normally when the sweep reports per-business failures', async () => {
      exportService.runNightlyExport.mockResolvedValueOnce({
        businesses: 3,
        failures: 3,
      });
      // Partial failures are already captured by the service; the job itself
      // must not throw, or Bull would re-export the businesses that succeeded.
      await expect(processor.handleNightlyExport()).resolves.toBeUndefined();
    });

    it('lets a sweep-level failure surface so Bull retries', async () => {
      exportService.runNightlyExport.mockRejectedValueOnce(
        new Error('sheets api down'),
      );
      await expect(processor.handleNightlyExport()).rejects.toThrow(
        'sheets api down',
      );
    });
  });
});
