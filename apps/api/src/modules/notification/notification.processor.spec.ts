import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { NotificationProcessor } from './notification.processor';
import { NotificationService } from './notification.service';
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_JOBS,
  DispatchJobData,
  BatchJobData,
} from './notification.constants';

/**
 * The processor is pure wiring, so the tests assert two things: the Bull
 * decorators bind each handler to the queue/job name the service enqueues
 * against (a rename on either side silently strands the jobs), and each
 * handler forwards the job payload to the service unchanged.
 */
const QUEUE_METADATA = 'bull:module_queue';
const PROCESS_METADATA = 'bull:module_queue_process';

const job = <T>(data: T): Job<T> => ({ data }) as Job<T>;

describe('NotificationProcessor', () => {
  let service: {
    processDispatch: jest.Mock;
    processBatch: jest.Mock;
  };
  let processor: NotificationProcessor;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    service = {
      processDispatch: jest.fn().mockResolvedValue(undefined),
      processBatch: jest.fn().mockResolvedValue(undefined),
    };
    processor = new NotificationProcessor(
      service as unknown as NotificationService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('queue wiring', () => {
    it('is registered against the notifications queue', () => {
      expect(Reflect.getMetadata(QUEUE_METADATA, NotificationProcessor)).toEqual(
        expect.objectContaining({ name: NOTIFICATION_QUEUE }),
      );
    });

    it('binds handleDispatch to the dispatch job name', () => {
      // @Process stores its metadata on the handler function itself.
      expect(
        Reflect.getMetadata(
          PROCESS_METADATA,
          NotificationProcessor.prototype.handleDispatch,
        ),
      ).toEqual(expect.objectContaining({ name: NOTIFICATION_JOBS.DISPATCH }));
    });

    it('binds handleBatch to the batch job name', () => {
      expect(
        Reflect.getMetadata(
          PROCESS_METADATA,
          NotificationProcessor.prototype.handleBatch,
        ),
      ).toEqual(expect.objectContaining({ name: NOTIFICATION_JOBS.BATCH }));
    });
  });

  describe('handleDispatch', () => {
    const data: DispatchJobData = {
      businessId: 'biz-1',
      notificationId: 'ntf-1',
    };

    it('dispatches the notification under the tenant on the job', async () => {
      await processor.handleDispatch(job(data));
      expect(service.processDispatch).toHaveBeenCalledWith('biz-1', 'ntf-1');
      expect(service.processBatch).not.toHaveBeenCalled();
    });

    it('lets a service failure surface so Bull retries the job', async () => {
      service.processDispatch.mockRejectedValueOnce(new Error('provider 500'));
      await expect(processor.handleDispatch(job(data))).rejects.toThrow(
        'provider 500',
      );
    });

    it('resolves with nothing on success', async () => {
      await expect(
        processor.handleDispatch(job(data)),
      ).resolves.toBeUndefined();
    });
  });

  describe('handleBatch', () => {
    const data: BatchJobData = {
      businessId: 'biz-1',
      batchId: 'batch-1',
      notificationIds: ['ntf-1', 'ntf-2', 'ntf-3'],
    };

    it('hands the whole chunk to the service in one call', async () => {
      await processor.handleBatch(job(data));
      expect(service.processBatch).toHaveBeenCalledTimes(1);
      expect(service.processBatch).toHaveBeenCalledWith('biz-1', [
        'ntf-1',
        'ntf-2',
        'ntf-3',
      ]);
    });

    it('handles an empty chunk without touching the length in the log path', async () => {
      await processor.handleBatch(job({ ...data, notificationIds: [] }));
      expect(service.processBatch).toHaveBeenCalledWith('biz-1', []);
    });

    it('lets a service failure surface so Bull retries the job', async () => {
      service.processBatch.mockRejectedValueOnce(new Error('rate limited'));
      await expect(processor.handleBatch(job(data))).rejects.toThrow(
        'rate limited',
      );
    });
  });
});
