import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { RealtyDlqProcessor, DlqReplayJobData } from './realty-dlq.processor';
import { RealtyDlqService } from './realty-dlq.service';
import { REALTY_DLQ_QUEUE, REALTY_DLQ_JOBS } from './realty-hardening.constants';

const QUEUE_METADATA = 'bull:module_queue';
const PROCESS_METADATA = 'bull:module_queue_process';

const job = (data: DlqReplayJobData): Job<DlqReplayJobData> =>
  ({ data }) as Job<DlqReplayJobData>;

describe('RealtyDlqProcessor', () => {
  let dlq: { replay: jest.Mock };
  let processor: RealtyDlqProcessor;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    dlq = { replay: jest.fn().mockResolvedValue(undefined) };
    processor = new RealtyDlqProcessor(dlq as unknown as RealtyDlqService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('queue wiring', () => {
    it('is registered against the realty DLQ queue', () => {
      expect(Reflect.getMetadata(QUEUE_METADATA, RealtyDlqProcessor)).toEqual(
        expect.objectContaining({ name: REALTY_DLQ_QUEUE }),
      );
    });

    it('binds handleReplay to the replay job name', () => {
      // @Process stores its metadata on the handler function itself.
      expect(
        Reflect.getMetadata(
          PROCESS_METADATA,
          RealtyDlqProcessor.prototype.handleReplay,
        ),
      ).toEqual(expect.objectContaining({ name: REALTY_DLQ_JOBS.REPLAY }));
    });
  });

  describe('handleReplay', () => {
    const data: DlqReplayJobData = {
      businessId: 'biz-1',
      deadLetterId: 'dl-1',
    };

    it('replays the dead letter under the tenant on the job', async () => {
      await processor.handleReplay(job(data));
      expect(dlq.replay).toHaveBeenCalledWith('biz-1', 'dl-1');
    });

    it('scopes the replay to the job’s tenant, not a remembered one', async () => {
      await processor.handleReplay(job(data));
      await processor.handleReplay(
        job({ businessId: 'biz-2', deadLetterId: 'dl-2' }),
      );
      expect(dlq.replay).toHaveBeenNthCalledWith(1, 'biz-1', 'dl-1');
      expect(dlq.replay).toHaveBeenNthCalledWith(2, 'biz-2', 'dl-2');
    });

    it('lets a failed replay surface so Bull retries and the service can auto-discard', async () => {
      dlq.replay.mockRejectedValueOnce(new Error('replayer threw'));
      await expect(processor.handleReplay(job(data))).rejects.toThrow(
        'replayer threw',
      );
    });

    it('resolves with nothing on a successful replay', async () => {
      await expect(processor.handleReplay(job(data))).resolves.toBeUndefined();
    });
  });
});
