import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { RealtyDlqService } from './realty-dlq.service';
import { REALTY_DLQ_QUEUE, REALTY_DLQ_JOBS } from './realty-hardening.constants';

export interface DlqReplayJobData {
  businessId: string;
  deadLetterId: string;
}

/**
 * RealtyDlqProcessor — drains async DLQ replay jobs enqueued by an operator
 * (or a scheduled auto-recovery sweep). Delegates to {@link RealtyDlqService}
 * so the same replay path is exercised by unit tests. A replay that throws is
 * left for Bull's own retry/backoff (configured globally) and, once exhausted,
 * the entry is auto-discarded by the service after `DLQ_MAX_REPLAYS`.
 */
@Processor(REALTY_DLQ_QUEUE)
export class RealtyDlqProcessor {
  private readonly logger = new Logger(RealtyDlqProcessor.name);

  constructor(private readonly dlq: RealtyDlqService) {}

  @Process(REALTY_DLQ_JOBS.REPLAY)
  async handleReplay(job: Job<DlqReplayJobData>): Promise<void> {
    const { businessId, deadLetterId } = job.data;
    this.logger.debug(`Replaying dead letter ${deadLetterId} for business ${businessId}`);
    await this.dlq.replay(businessId, deadLetterId);
  }
}
