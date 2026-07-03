import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { generateId, generateCorrelationId } from '@gosumo/shared';
import type { RealtyRetentionRunEvent } from '@gosumo/shared';
import { ComplianceRepository } from './compliance.repository';
import { ComplianceService } from './compliance.service';
import { DEFAULT_RETENTION_MONTHS, retentionCutoff } from './dpdpa.util';

export interface RetentionRunResult {
  businessId: string;
  retentionMonths: number;
  cutoff: Date;
  leadsAnonymized: number;
  messagesAnonymized: number;
}

/**
 * RetentionService — the scheduled DPDPA data-minimization sweep (business plan
 * §21). Runs weekly (BullMQ repeatable job): for each business it anonymizes
 * leads inactive past the retention window (default 24 months) and scrubs sender
 * info on messages older than the window. Every anonymization is audited (via the
 * shared erasure path) and the run is recorded on the business's settings.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly repository: ComplianceRepository,
    private readonly compliance: ComplianceService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Run the retention sweep for one business. */
  async runForBusiness(
    businessId: string,
    now: Date = new Date(),
  ): Promise<RetentionRunResult> {
    const settings = await this.repository.findSettings(businessId);
    const retentionMonths = settings?.retention_months ?? DEFAULT_RETENTION_MONTHS;
    const cutoff = retentionCutoff(retentionMonths, now);

    // 1. Anonymize leads inactive past the retention window.
    const inactive = await this.repository.findInactiveLeads(businessId, cutoff);
    let leadsAnonymized = 0;
    let messagesAnonymized = 0;
    for (const lead of inactive) {
      const res = await this.compliance.eraseLead(businessId, lead, 'RETENTION', now);
      if (res.erased) {
        leadsAnonymized += 1;
        messagesAnonymized += res.messagesAnonymized;
      }
    }

    // 2. Anonymize sender info on any remaining old messages (belt-and-braces for
    //    conversations without a surviving lead link).
    messagesAnonymized += await this.repository.anonymizeOldMessages(businessId, cutoff);

    await this.repository.markRetentionRun(businessId, now);

    if (leadsAnonymized > 0 || messagesAnonymized > 0) {
      const event: RealtyRetentionRunEvent = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: generateCorrelationId(),
        type: 'realty.retention.run',
        leadsAnonymized,
        messagesAnonymized,
        retentionMonths,
      };
      this.eventEmitter.emit('realty.retention.run', event);
      this.logger.log(
        `Retention sweep for business ${businessId}: ${leadsAnonymized} lead(s), ${messagesAnonymized} message(s) anonymized (>${retentionMonths}mo)`,
      );
    }

    return { businessId, retentionMonths, cutoff, leadsAnonymized, messagesAnonymized };
  }

  /** Run the sweep across every business with a compliance footprint. */
  async runAll(now: Date = new Date()): Promise<RetentionRunResult[]> {
    const businessIds = await this.repository.listBusinessIdsWithLeads();
    const results: RetentionRunResult[] = [];
    for (const businessId of businessIds) {
      try {
        results.push(await this.runForBusiness(businessId, now));
      } catch (err) {
        this.logger.error(
          `Retention sweep failed for business ${businessId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return results;
  }
}
