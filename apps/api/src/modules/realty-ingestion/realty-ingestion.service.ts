import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import type { LeadIngestCandidate, LeadIngestResult } from '@gosumo/shared';
import { LeadSource, RealtyPortal } from '@gosumo/shared';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import {
  allowUnverifiedWebhook,
  isProductionEnv,
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
export class RealtyIngestionService {
  private readonly logger = new Logger(RealtyIngestionService.name);
  private readonly isProduction: boolean;

  constructor(
    private readonly leadsService: RealtyLeadsService,
    private readonly configService: ConfigService,
  ) {
    this.isProduction = isProductionEnv(this.configService);
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
    if (mode === 'subscribe' && verifyToken && verifyToken === expected) {
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
      summary.skipped++;
      summary.errors.push({
        row: rowNumber,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private emptySummary(total: number): IngestSummaryDto {
    return { total, created: 0, merged: 0, skipped: 0, errors: [] };
  }
}
