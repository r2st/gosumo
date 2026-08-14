import { Logger } from '@nestjs/common';
import { ParserHealthProcessor } from './parser-health.processor';
import { ParserHealthService } from './parser-health.service';
import { PARSER_HEALTH_QUEUE, PARSER_HEALTH_JOBS } from './parser-health.constants';

const QUEUE_METADATA = 'bull:module_queue';
const PROCESS_METADATA = 'bull:module_queue_process';

const report = (status: string): { status: string } => ({ status });

describe('ParserHealthProcessor', () => {
  let health: { runCheck: jest.Mock };
  let log: jest.SpyInstance;
  let processor: ParserHealthProcessor;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    health = { runCheck: jest.fn().mockResolvedValue([]) };
    processor = new ParserHealthProcessor(
      health as unknown as ParserHealthService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('queue wiring', () => {
    it('is registered against the parser-health queue', () => {
      expect(Reflect.getMetadata(QUEUE_METADATA, ParserHealthProcessor)).toEqual(
        expect.objectContaining({ name: PARSER_HEALTH_QUEUE }),
      );
    });

    it('binds handleWeeklyCheck to the weekly-check job name', () => {
      // @Process stores its metadata on the handler function itself.
      expect(
        Reflect.getMetadata(
          PROCESS_METADATA,
          ParserHealthProcessor.prototype.handleWeeklyCheck,
        ),
      ).toEqual(
        expect.objectContaining({ name: PARSER_HEALTH_JOBS.WEEKLY_CHECK }),
      );
    });
  });

  describe('handleWeeklyCheck', () => {
    it('runs the check against the built-in sample set', async () => {
      await processor.handleWeeklyCheck();
      expect(health.runCheck).toHaveBeenCalledTimes(1);
      // No argument — the service falls back to PARSER_SAMPLES.
      expect(health.runCheck).toHaveBeenCalledWith();
    });

    it('counts every non-HEALTHY portal as degraded in the summary log', async () => {
      health.runCheck.mockResolvedValueOnce([
        report('HEALTHY'),
        report('DEGRADED'),
        report('FAILED'),
        report('HEALTHY'),
      ]);
      await processor.handleWeeklyCheck();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('4 portal(s), 2 degraded/failed'),
      );
    });

    it('reports zero degraded when every portal is healthy', async () => {
      health.runCheck.mockResolvedValueOnce([report('HEALTHY'), report('HEALTHY')]);
      await processor.handleWeeklyCheck();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('2 portal(s), 0 degraded/failed'),
      );
    });

    it('handles an empty report set without dividing by anything', async () => {
      await expect(processor.handleWeeklyCheck()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('0 portal(s), 0 degraded/failed'),
      );
    });

    it('lets a service failure surface so Bull retries the probe', async () => {
      health.runCheck.mockRejectedValueOnce(new Error('samples missing'));
      await expect(processor.handleWeeklyCheck()).rejects.toThrow(
        'samples missing',
      );
    });
  });
});
