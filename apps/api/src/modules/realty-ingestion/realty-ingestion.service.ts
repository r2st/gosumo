import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import type { LeadIngestCandidate, LeadIngestResult } from '@gosumo/shared';
import { LeadSource, RealtyPortal } from '@gosumo/shared';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { WebhookDlqService } from '../webhook-log/webhook-dlq.service';
import {
  REALTY_INGEST_EVENT_TYPES,
  REALTY_INGEST_SOURCES,
  ingestDeliveryId,
} from './realty-ingestion.constants';
import {
  allowUnverifiedWebhook,
  isProductionEnv,
  secretsMatch,
} from '../../common/utils/webhook-verification.util';
import { parseMetaLeadgen } from './meta-leadgen.parser';
import { parsePortalEmail } from './portal-email.parser';
import { parseCtwaReferral } from './ctwa.util';
import { normalizeCsvRows } from './csv-import.util';
import type { RawCsvRow } from './csv-import.util';
import {
  CsvImportDto,
  PortalEmailDto,
  CtwaContextDto,
  IngestSummaryDto,
} from './dto';

/**
 * RealtyIngestionService — the front door for every external lead source
 * (blueprint §15). It parses source-specific payloads (Meta Leadgen webhook,
 * portal enquiry emails, CSV imports, CTWA referrals) into normalized
 * `LeadIngestCandidate`s and hands them to `RealtyLeadsService.ingestLead`,
 * which owns the E.164 identity-merge and emits `realty.lead.ingested`.
 *
 * This module is deliberately stateless — it owns no table; all attribution
 * lands on the lead itself. Source ROI is derivable from `lead.source`,
 * `sub_source`, `listing_ref`, and the `ingestHistory` provenance trail.
 */
@Injectable()
export class RealtyIngestionService implements OnModuleInit {
  private readonly logger = new Logger(RealtyIngestionService.name);
  private readonly isProduction: boolean;

  constructor(
    private readonly leadsService: RealtyLeadsService,
    private readonly configService: ConfigService,
    /**
     * Optional so the unit suites that construct this service directly need not
     * stand up a queue-backed DLQ. Wired in production by
     * `RealtyIngestionModule`; absent, a failed ingest is logged at ERROR and
     * lost — which is exactly the behaviour this replaces, so an unwired
     * deployment is no worse off and a wired one recovers.
     */
    @Optional() private readonly webhookDlq?: WebhookDlqService,
  ) {
    this.isProduction = isProductionEnv(this.configService);
  }

  /**
   * Teach the webhook DLQ how to re-run a failed lead delivery.
   *
   * Like the channel-adapter and payment replayers these skip signature
   * verification — the raw bytes it needs are not stored, and the payload only
   * reached the DLQ because its signature already passed.
   *
   * Replay is safe to repeat because `ingestLead` merges on the E.164 phone:
   * re-running a delivery whose second lead failed re-merges the first rather
   * than duplicating it.
   */
  onModuleInit(): void {
    if (!this.webhookDlq) return;

    this.webhookDlq.registerReplayer(REALTY_INGEST_SOURCES.META_LEADGEN, async (payload) => {
      const stored = payload as { businessId?: string; body?: unknown };
      if (!stored?.businessId) {
        throw new Error('Dead-lettered Meta Leadgen delivery is missing its tenant');
      }
      const summary = await this.ingestMetaLeadgen(stored.businessId, stored.body);
      if (summary.failed > 0) {
        // Throwing is what keeps the entry PENDING for the next backoff. A
        // replay that silently returns having lost the same leads again would
        // mark the entry REPLAYED and close the only remaining recovery path.
        throw new Error(
          `${summary.failed} of ${summary.total} leadgen candidate(s) still failing: ` +
            this.describeErrors(summary),
        );
      }
    });

    this.webhookDlq.registerReplayer(REALTY_INGEST_SOURCES.PORTAL_EMAIL, async (payload) => {
      const stored = payload as { businessId?: string; body?: PortalEmailDto };
      if (!stored?.businessId || !stored.body) {
        throw new Error('Dead-lettered portal email is missing its tenant or body');
      }
      await this.ingestPortalEmail(stored.businessId, stored.body);
    });
  }

  // ════════════════════════════════════════════
  // Meta Leadgen (Facebook / Instagram Lead Ads)
  // ════════════════════════════════════════════

  /** Verify the X-Hub-Signature-256 HMAC on a Meta webhook (root rule #3). */
  verifyMetaSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): boolean {
    const appSecret = this.configService.get<string>('whatsapp.appSecret', '');
    if (!appSecret) {
      // No secret configured — cannot verify. Skipped (loudly) outside
      // production; rejected in production, where an unverified lead webhook is
      // an open write path into a tenant's pipeline.
      return allowUnverifiedWebhook(
        this.logger,
        this.isProduction,
        'WHATSAPP_APP_SECRET is not set',
      );
    }
    if (!rawBody || !signatureHeader) return false;

    const expected =
      'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** Meta GET verification challenge — echoes hub.challenge on a token match. */
  resolveMetaChallenge(
    mode: string | undefined,
    verifyToken: string | undefined,
    challenge: string | undefined,
  ): string | null {
    const expected =
      this.configService.get<string>('realty.metaLeadgenVerifyToken', '') ||
      this.configService.get<string>('whatsapp.verifyToken', '');
    if (mode === 'subscribe' && secretsMatch(verifyToken, expected)) {
      return challenge ?? '';
    }
    return null;
  }

  /**
   * Parse a Meta Leadgen webhook and ingest every lead it contains. Candidates
   * without a phone (field data not inlined — needs a Graph fetch) are skipped
   * and counted. Always resolves; never throws (webhooks must ack fast).
   */
  async ingestMetaLeadgen(businessId: string, payload: unknown): Promise<IngestSummaryDto> {
    const candidates = parseMetaLeadgen(payload);
    const summary = this.emptySummary(candidates.length);

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      if (!c.phone) {
        summary.skipped++;
        summary.errors.push({ row: i + 1, reason: `leadgen ${c.leadgenId ?? '?'}: no inline phone` });
        continue;
      }
      await this.ingestOne(
        businessId,
        {
          whatsappPhone: c.phone,
          source: LeadSource.META_LEAD_AD,
          subSource: c.formId ?? c.adId,
          listingRef: c.listingRef,
          name: c.name,
          email: c.email,
          raw: c.raw,
        },
        i + 1,
        summary,
      );
    }
    this.logger.log(
      `Meta Leadgen ingest for ${businessId}: ${summary.created} created, ${summary.merged} merged, ${summary.skipped} skipped`,
    );
    return summary;
  }

  // ════════════════════════════════════════════
  // Portal enquiry email
  // ════════════════════════════════════════════

  /** Parse a portal enquiry email and ingest it. Returns null if unparseable. */
  async ingestPortalEmail(
    businessId: string,
    dto: PortalEmailDto,
  ): Promise<(LeadIngestResult & { portal: RealtyPortal }) | null> {
    const parsed = parsePortalEmail(dto);
    if (!parsed || !parsed.phone) {
      this.logger.warn(`Portal email from "${dto.from ?? '?'}" could not be parsed (no phone)`);
      return null;
    }
    const result = await this.leadsService.ingestLead(businessId, {
      whatsappPhone: parsed.phone,
      source: LeadSource.PORTAL,
      subSource: parsed.portal === RealtyPortal.UNKNOWN ? undefined : parsed.portal,
      listingRef: parsed.listingRef,
      name: parsed.name,
      email: parsed.email,
      raw: parsed.raw,
    });
    this.logger.log(
      `Portal (${parsed.portal}) ingest → lead ${result.leadId} (${result.merged ? 'merged' : 'created'})`,
    );
    return { ...result, portal: parsed.portal };
  }

  // ════════════════════════════════════════════
  // Webhook delivery wrappers (DLQ-backed)
  // ════════════════════════════════════════════

  /**
   * Ingest a Meta Leadgen delivery, parking anything that failed.
   *
   * The webhook answers 200 either way — Meta retries a non-200 and we would
   * rather not have it do that — but a 200 used to be the end of the story:
   * the handler logged the error and returned, and a lead the business paid
   * Facebook for was gone with no record and nothing to replay. That is the
   * whole reason this wrapper exists.
   *
   * Two distinct failure shapes reach the DLQ:
   *   - the parse or the whole batch threw, and
   *   - individual candidates threw while others succeeded (`summary.failed`),
   *     which is the more common one and the one that looked like success.
   *
   * A `skipped` candidate is *not* dead-lettered: no inline phone means the
   * lead needs a Graph fetch we do not do, and retrying the same body forever
   * would only fill the queue.
   */
  async handleMetaLeadgenDelivery(
    businessId: string,
    payload: unknown,
    headers: Record<string, unknown> = {},
  ): Promise<IngestSummaryDto> {
    let summary: IngestSummaryDto;
    try {
      summary = await this.ingestMetaLeadgen(businessId, payload);
    } catch (err) {
      await this.captureIngestFailure(
        REALTY_INGEST_SOURCES.META_LEADGEN,
        businessId,
        payload,
        headers,
        err,
      );
      return { ...this.emptySummary(0), failed: 1 };
    }

    if (summary.failed > 0) {
      await this.captureIngestFailure(
        REALTY_INGEST_SOURCES.META_LEADGEN,
        businessId,
        payload,
        headers,
        new Error(
          `${summary.failed} of ${summary.total} leadgen candidate(s) failed: ` +
            this.describeErrors(summary),
        ),
      );
    }
    return summary;
  }

  /**
   * Ingest a portal enquiry email, parking it if the write failed.
   *
   * An unparseable email returns null and is *not* dead-lettered — the parser
   * found no phone in the body, and it will not find one on the fourth retry
   * either. `parser-health` is what catches that class of problem, by noticing
   * template drift against known-good samples rather than by retrying.
   */
  async handlePortalEmailDelivery(
    businessId: string,
    dto: PortalEmailDto,
    headers: Record<string, unknown> = {},
  ): Promise<(LeadIngestResult & { portal: RealtyPortal }) | null> {
    try {
      return await this.ingestPortalEmail(businessId, dto);
    } catch (err) {
      await this.captureIngestFailure(
        REALTY_INGEST_SOURCES.PORTAL_EMAIL,
        businessId,
        dto,
        headers,
        err,
      );
      return null;
    }
  }

  /**
   * Park a failed lead delivery for retry on our own schedule.
   *
   * Never throws: this runs inside a catch on a webhook path, and a DLQ
   * failure must not change what the provider sees. `WebhookDlqService.capture`
   * already swallows its own persistence errors; the guard here is for the
   * unwired case, where saying so loudly is all that is left.
   */
  private async captureIngestFailure(
    source: (typeof REALTY_INGEST_SOURCES)[keyof typeof REALTY_INGEST_SOURCES],
    businessId: string,
    body: unknown,
    headers: Record<string, unknown>,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);

    if (!this.webhookDlq) {
      this.logger.error(
        `${source} delivery for ${businessId} failed and no webhook DLQ is wired — ` +
          `the lead(s) are lost: ${reason}`,
      );
      return;
    }

    try {
      await this.webhookDlq.capture(
        {
          businessId,
          source,
          eventType: REALTY_INGEST_EVENT_TYPES[source],
          externalId: ingestDeliveryId(source, body),
          // Stored with the tenant alongside it: the replayer runs long after
          // the request is gone, and `x-business-id` lives only on that request.
          payload: { businessId, body } as Record<string, unknown>,
          headers,
        },
        error,
      );
    } catch (captureErr) {
      // `capture` swallows its own persistence errors, so reaching here means
      // something further out failed — a listener on the CAPTURED event, or an
      // unavailable DLQ. Letting it escape would turn a lost lead into a 500
      // the provider retries into an endpoint that is already failing.
      this.logger.error(
        `CRITICAL: could not dead-letter ${source} delivery for ${businessId} ` +
          `(original failure: ${reason}): ` +
          `${captureErr instanceof Error ? captureErr.message : String(captureErr)}`,
      );
    }
  }

  // ════════════════════════════════════════════
  // CSV bulk import
  // ════════════════════════════════════════════

  /**
   * Import parsed CSV rows with E.164 identity merge. Duplicate phones (in the
   * file or already in the DB) merge into one lead. Returns a per-row summary.
   */
  async importCsv(businessId: string, dto: CsvImportDto): Promise<IngestSummaryDto> {
    const rows: RawCsvRow[] = dto.rows;
    const { valid, errors } = normalizeCsvRows(rows);
    const summary = this.emptySummary(rows.length);
    summary.errors.push(...errors);
    summary.skipped += errors.length;

    // Offset valid rows back to their original row numbers for error reporting.
    let validIdx = 0;
    for (let rowNumber = 1; rowNumber <= rows.length; rowNumber++) {
      const isError = errors.some((e) => e.row === rowNumber);
      if (isError) continue;
      const row = valid[validIdx++]!;
      await this.ingestOne(
        businessId,
        {
          whatsappPhone: row.phone,
          // `normalizeCsvRows` already defaults a blank source column to CSV,
          // so `row.source` is always populated by the time it reaches here.
          source: row.source as LeadSource,
          subSource: row.subSource,
          listingRef: row.listingRef,
          name: row.name,
          email: row.email,
        },
        rowNumber,
        summary,
      );
    }
    this.logger.log(
      `CSV import for ${businessId}: ${summary.created} created, ${summary.merged} merged, ${summary.skipped} skipped`,
    );
    return summary;
  }

  // ════════════════════════════════════════════
  // CTWA (Click-to-WhatsApp) context attachment
  // ════════════════════════════════════════════

  /** Attach CTWA ad context to a (new or existing) lead. */
  async ingestCtwa(businessId: string, dto: CtwaContextDto): Promise<LeadIngestResult | null> {
    const candidate = parseCtwaReferral({
      phone: dto.phone,
      name: dto.name,
      referral: dto.referral,
      conversationId: dto.conversationId,
      clientId: dto.clientId,
    });
    if (!candidate) return null;
    const result = await this.leadsService.ingestLead(businessId, candidate);
    this.logger.log(
      `CTWA ingest → lead ${result.leadId} (${result.merged ? 'merged' : 'created'})`,
    );
    return result;
  }

  // ════════════════════════════════════════════
  // Helpers
  // ════════════════════════════════════════════

  /** Ingest one candidate, updating the summary counters (never throws). */
  private async ingestOne(
    businessId: string,
    candidate: LeadIngestCandidate,
    rowNumber: number,
    summary: IngestSummaryDto,
  ): Promise<void> {
    try {
      const result = await this.leadsService.ingestLead(businessId, candidate);
      if (result.merged) summary.merged++;
      else summary.created++;
    } catch (err) {
      // `failed`, not `skipped`: this candidate was well-formed and the write
      // is what broke, so it is retryable and a webhook caller needs to know
      // to dead-letter it. Counting it as "skipped" alongside a row with no
      // phone number is what let a real lead disappear behind a 200.
      summary.failed++;
      summary.errors.push({
        row: rowNumber,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private emptySummary(total: number): IngestSummaryDto {
    return { total, created: 0, merged: 0, skipped: 0, failed: 0, errors: [] };
  }

  /** The first few error reasons, for a dead letter's `error_message`. */
  private describeErrors(summary: IngestSummaryDto): string {
    const shown = summary.errors.slice(0, 3).map((e) => `row ${e.row}: ${e.reason}`);
    const extra = summary.errors.length - shown.length;
    return shown.join('; ') + (extra > 0 ? ` (+${extra} more)` : '');
  }
}
