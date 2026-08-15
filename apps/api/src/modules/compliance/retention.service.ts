import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { generateId, generateCorrelationId } from '@gosumo/shared';
import type { RealtyRetentionRunEvent } from '@gosumo/shared';
import { ComplianceRepository } from './compliance.repository';
import { ComplianceService } from './compliance.service';
import { DEFAULT_RETENTION_MONTHS, retentionCutoff } from './dpdpa.util';
import {
  RETENTION_LEAD_BATCH_SIZE,
  RETENTION_MAX_LEADS_PER_BUSINESS,
  RETENTION_RUN_BUDGET_MS,
} from './compliance.constants';

export interface RetentionRunResult {
  businessId: string;
  retentionMonths: number;
  cutoff: Date;
  leadsAnonymized: number;
  messagesAnonymized: number;
  /**
   * Media attachments past the window whose filename and CDN link were cleared.
   *
   * Counted separately from `messagesAnonymized` because they are different
   * erasures: a message loses its text, an attachment loses the sender's own
   * filename and the live link to the file.
   */
  attachmentsScrubbed: number;
  /**
   * Leads past the retention window that this run did not get to.
   *
   * The sweep is bounded three ways (page, per-business ceiling, run deadline),
   * so "finished" and "ran out of room" are different outcomes and a caller
   * cannot tell them apart from the counts alone — 5000 anonymized leads is
   * either a cleared backlog or a ceiling. This is the difference, and it is
   * the flag that says personal data past its window is still live.
   */
  leadsPending: boolean;
}

/** What a whole `runAll` did, including the businesses it never reached. */
export interface RetentionSweepSummary {
  results: RetentionRunResult[];
  /** Businesses skipped because the run's time budget ran out. */
  businessesSkipped: number;
  /** Businesses that finished with leads still over the window. */
  businessesPending: number;
}

/**
 * RetentionService — the scheduled DPDPA data-minimization sweep (business plan
 * §21). Runs weekly (BullMQ repeatable job): for each business it anonymizes
 * leads inactive past the retention window (default 24 months), scrubs sender
 * info on messages older than the window, and clears the filename and CDN link
 * on the media attached to them. Every anonymization is audited (via the shared
 * erasure path) and the run is recorded on the business's settings.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly repository: ComplianceRepository,
    private readonly compliance: ComplianceService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Run the retention sweep for one business.
   *
   * `deadline` is an epoch-ms instant the sweep will not erase past; it
   * defaults to this business getting the whole run budget, which is what a
   * direct/manual call wants. `runAll` passes a shared deadline instead so the
   * budget is spread across tenants rather than spent on the first one.
   */
  async runForBusiness(
    businessId: string,
    now: Date = new Date(),
    deadline: number = Date.now() + RETENTION_RUN_BUDGET_MS,
  ): Promise<RetentionRunResult> {
    const settings = await this.repository.findSettings(businessId);
    const retentionMonths = settings?.retention_months ?? DEFAULT_RETENTION_MONTHS;
    const cutoff = retentionCutoff(retentionMonths, now);

    // 1. Anonymize leads inactive past the retention window.
    //
    // Paged, because a single page was the whole sweep: the query takes 500
    // rows and the run stopped there, marked itself complete, and left every
    // lead past 500 live for another week — for as many weeks as the backlog
    // took to drain 500 at a time. Nothing said so; `last_retention_run_at`
    // was stamped either way, and that stamp is what the compliance screen
    // shows as evidence the window is being honoured.
    //
    // Paging terminates because erasing a lead writes `metadata.erased`, which
    // is exactly what `findInactiveLeads` excludes — so a page that erases
    // anything cannot return those rows again. The two ways it can fail to
    // erase anything are both handled below, since either would otherwise
    // re-fetch the same page forever.
    let leadsAnonymized = 0;
    let messagesAnonymized = 0;
    let leadsPending = false;
    // Leads that threw this run. Held so a single poison row is stepped over
    // rather than retried on every page — and so a page consisting only of
    // poison rows is recognised as no-progress instead of looping.
    const failed = new Set<string>();

    while (leadsAnonymized < RETENTION_MAX_LEADS_PER_BUSINESS) {
      if (Date.now() >= deadline) {
        leadsPending = true;
        break;
      }

      const page = await this.repository.findInactiveLeads(
        businessId,
        cutoff,
        RETENTION_LEAD_BATCH_SIZE,
      );
      if (page.length === 0) break;

      let erasedThisPage = 0;
      for (const lead of page) {
        // Already tried and threw — skip rather than fail the page again.
        if (failed.has(lead.id)) continue;
        try {
          const res = await this.compliance.eraseLead(
            businessId,
            lead,
            'RETENTION',
            now,
          );
          if (res.erased) {
            leadsAnonymized += 1;
            messagesAnonymized += res.messagesAnonymized;
            erasedThisPage += 1;
          } else {
            // Did not throw, but did not erase either — it will come back on
            // the next page, so record it as immovable for this run.
            failed.add(lead.id);
          }
        } catch (err) {
          // One lead must not cost the rest of the business's sweep. Before
          // this, a single row that consistently threw took the whole tenant
          // down with it, every week, with its backlog growing behind it.
          failed.add(lead.id);
          this.logger.error(
            `Retention: could not erase lead ${lead.id} for business ${businessId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        if (leadsAnonymized >= RETENTION_MAX_LEADS_PER_BUSINESS) break;
      }

      // Nothing moved: every row on this page is one we cannot erase, so the
      // next fetch returns the same page. Stop, and say work is outstanding.
      if (erasedThisPage === 0) {
        leadsPending = true;
        break;
      }
      // A short page is the end of the backlog — no need to ask again.
      if (page.length < RETENTION_LEAD_BATCH_SIZE) break;
      // A full page consumed up to the ceiling means there is very likely more.
      if (leadsAnonymized >= RETENTION_MAX_LEADS_PER_BUSINESS) leadsPending = true;
    }

    if (failed.size > 0) leadsPending = true;

    // 2. Anonymize sender info on any remaining old messages (belt-and-braces for
    //    conversations without a surviving lead link).
    messagesAnonymized += await this.repository.anonymizeOldMessages(businessId, cutoff);

    // 3. Scrub the media attached to those messages. Step 2 clears a message's
    //    text; for an image or document message the personal data is in the
    //    `file_uploads` row beside it — the sender's own filename and a live
    //    link to the file — so without this the sweep erases the caption and
    //    leaves the document.
    const attachmentsScrubbed = await this.repository.anonymizeOldFileUploads(businessId, cutoff);

    await this.repository.markRetentionRun(businessId, now);

    if (leadsAnonymized > 0 || messagesAnonymized > 0 || attachmentsScrubbed > 0) {
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
        `Retention sweep for business ${businessId}: ${leadsAnonymized} lead(s), ` +
          `${messagesAnonymized} message(s), ${attachmentsScrubbed} attachment(s) ` +
          `anonymized (>${retentionMonths}mo)`,
      );
    }

    if (leadsPending) {
      this.logger.warn(
        `Retention sweep for business ${businessId} stopped with leads still past ` +
          `the ${retentionMonths}-month window — ${leadsAnonymized} erased this run, ` +
          `more remain`,
      );
    }

    return {
      businessId,
      retentionMonths,
      cutoff,
      leadsAnonymized,
      messagesAnonymized,
      attachmentsScrubbed,
      leadsPending,
    };
  }

  /**
   * Run the sweep across every business with a compliance footprint.
   *
   * The businesses share one deadline. Spending it in order means a tenant late
   * in the list can be skipped entirely, which is why the count of skipped
   * tenants is returned and logged rather than left to be inferred from a
   * `results` array that is simply shorter than the input.
   */
  async runAll(now: Date = new Date()): Promise<RetentionSweepSummary> {
    const businessIds = await this.repository.listBusinessIdsWithLeads();
    const deadline = Date.now() + RETENTION_RUN_BUDGET_MS;
    const results: RetentionRunResult[] = [];
    let businessesSkipped = 0;

    for (const businessId of businessIds) {
      if (Date.now() >= deadline) {
        // Out of budget. Everything left is untouched this run; counting it is
        // the only thing that distinguishes "no leads to erase" from "never
        // looked". Which tenants land in the tail is not fixed — the id list
        // comes back from a `SELECT DISTINCT` with no ordering — so a run that
        // skips anybody is worth surfacing on its own rather than trusting the
        // next run to happen to cover them.
        businessesSkipped += 1;
        continue;
      }
      try {
        results.push(await this.runForBusiness(businessId, now, deadline));
      } catch (err) {
        this.logger.error(
          `Retention sweep failed for business ${businessId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const businessesPending = results.filter((r) => r.leadsPending).length;
    if (businessesSkipped > 0) {
      this.logger.warn(
        `Retention sweep ran out of time: ${businessesSkipped} business(es) not swept this run`,
      );
    }

    return { results, businessesSkipped, businessesPending };
  }
}
