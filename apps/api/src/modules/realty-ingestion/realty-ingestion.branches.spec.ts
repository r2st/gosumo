/**
 * RealtyIngestionService — branch coverage for the webhook gate and the
 * per-row error accounting.
 *
 * `realty-ingestion.service.spec.ts` covers the happy path of each source.
 * The branches left over are the ones that decide whether an unauthenticated
 * write reaches a tenant's pipeline, and whether a partly-bad import is
 * reported honestly:
 *
 *  - **`verifyMetaSignature`.** A missing app secret is a *configuration*
 *    fault: skipped loudly outside production, rejected inside it. A missing
 *    or wrong signature is an *authentication* failure and is always rejected.
 *    The length pre-check before `timingSafeEqual` matters too — that function
 *    throws on unequal-length buffers, so a short forged header would turn a
 *    rejection into a 500.
 *  - **`resolveMetaChallenge`.** The realty-specific verify token wins, with
 *    the WhatsApp one as fallback; a wrong or absent token must return null
 *    rather than echoing the challenge back.
 *  - **`ingestOne`'s catch.** Ingestion must never throw out of a webhook, so
 *    a failing row is counted as skipped with its reason recorded — and the
 *    rows after it still run.
 *
 * RealtyLeadsService and ConfigService are mocked; the parsers run for real.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { LeadSource, RealtyPortal } from '@gosumo/shared';

import { RealtyIngestionService } from './realty-ingestion.service';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const APP_SECRET = 'test-app-secret';

/** Build the service with a config stub, optionally in production mode. */
async function buildService(
  overrides: Record<string, string> = {},
): Promise<{ service: RealtyIngestionService; leadsService: { ingestLead: jest.Mock } }> {
  const leadsService = {
    ingestLead: jest.fn().mockResolvedValue({ leadId: 'lead_1', merged: false }),
  };
  const config = {
    get: jest.fn((key: string, def?: string) => {
      if (key in overrides) return overrides[key];
      if (key === 'whatsapp.appSecret') return APP_SECRET;
      if (key === 'whatsapp.verifyToken') return 'verify-tok';
      return def ?? '';
    }),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RealtyIngestionService,
      { provide: RealtyLeadsService, useValue: leadsService },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();

  return { service: module.get(RealtyIngestionService), leadsService };
}

function sign(body: Buffer, secret = APP_SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('RealtyIngestionService (branches)', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────
  // verifyMetaSignature
  // ─────────────────────────────────────────────

  describe('verifyMetaSignature', () => {
    const body = Buffer.from('{"object":"page"}');

    it('accepts a correctly signed body', async () => {
      const { service } = await buildService();

      expect(service.verifyMetaSignature(body, sign(body))).toBe(true);
    });

    it('rejects a body signed with the wrong secret', async () => {
      const { service } = await buildService();

      expect(service.verifyMetaSignature(body, sign(body, 'wrong-secret'))).toBe(false);
    });

    it('rejects a request with no signature header', async () => {
      const { service } = await buildService();

      expect(service.verifyMetaSignature(body, undefined)).toBe(false);
    });

    it('rejects a request with no raw body to verify', async () => {
      // Without the original bytes there is nothing to check against.
      const { service } = await buildService();

      expect(service.verifyMetaSignature(undefined, sign(body))).toBe(false);
    });

    it('rejects a short forged signature without throwing', async () => {
      // timingSafeEqual throws on unequal lengths — the length guard is what
      // keeps a forged header a 401 rather than a 500.
      const { service } = await buildService();

      expect(() => service.verifyMetaSignature(body, 'sha256=deadbeef')).not.toThrow();
      expect(service.verifyMetaSignature(body, 'sha256=deadbeef')).toBe(false);
    });

    it('skips verification loudly outside production when no secret is configured', async () => {
      const { service } = await buildService({ 'whatsapp.appSecret': '' });

      expect(service.verifyMetaSignature(body, undefined)).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('WHATSAPP_APP_SECRET is not set'),
      );
    });

    it('rejects in production when no secret is configured', async () => {
      // A missing env var must not turn the leadgen webhook into an open
      // write path into a tenant's pipeline.
      const { service } = await buildService({
        'whatsapp.appSecret': '',
        'app.env': 'production',
      });

      expect(service.verifyMetaSignature(body, sign(body))).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Refusing to accept'));
    });
  });

  // ─────────────────────────────────────────────
  // resolveMetaChallenge
  // ─────────────────────────────────────────────

  describe('resolveMetaChallenge', () => {
    it('echoes the challenge on a token match', async () => {
      const { service } = await buildService();

      expect(service.resolveMetaChallenge('subscribe', 'verify-tok', 'chal-1')).toBe('chal-1');
    });

    it('prefers the realty-specific verify token over the WhatsApp one', async () => {
      const { service } = await buildService({ 'realty.metaLeadgenVerifyToken': 'realty-tok' });

      expect(service.resolveMetaChallenge('subscribe', 'realty-tok', 'chal-1')).toBe('chal-1');
      // The WhatsApp token is only the fallback — it must not also be accepted.
      expect(service.resolveMetaChallenge('subscribe', 'verify-tok', 'chal-1')).toBeNull();
    });

    it('falls back to the WhatsApp verify token when the realty one is unset', async () => {
      const { service } = await buildService({ 'realty.metaLeadgenVerifyToken': '' });

      expect(service.resolveMetaChallenge('subscribe', 'verify-tok', 'chal-1')).toBe('chal-1');
    });

    it('returns null for the wrong mode', async () => {
      const { service } = await buildService();

      expect(service.resolveMetaChallenge('unsubscribe', 'verify-tok', 'chal-1')).toBeNull();
    });

    it('returns null for a wrong token', async () => {
      const { service } = await buildService();

      expect(service.resolveMetaChallenge('subscribe', 'nope', 'chal-1')).toBeNull();
    });

    it('returns null when no token is supplied', async () => {
      const { service } = await buildService();

      expect(service.resolveMetaChallenge('subscribe', undefined, 'chal-1')).toBeNull();
    });

    it('returns an empty string when the token matches but no challenge was sent', async () => {
      // Matching with nothing to echo is still a successful verification.
      const { service } = await buildService();

      expect(service.resolveMetaChallenge('subscribe', 'verify-tok', undefined)).toBe('');
    });
  });

  // ─────────────────────────────────────────────
  // ingestOne error accounting
  // ─────────────────────────────────────────────

  describe('per-row failure handling', () => {
    it('counts a failing CSV row as skipped and keeps importing the rest', async () => {
      const { service, leadsService } = await buildService();
      leadsService.ingestLead
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce({ leadId: 'lead_2', merged: false });

      const summary = await service.importCsv(BUSINESS_ID, {
        rows: [
          { phone: '+919876543210', name: 'Rahul' },
          { phone: '+919876543211', name: 'Priya' },
        ],
      } as never);

      // `failed`, not `skipped`: the row was well-formed and the write broke,
      // so it is retryable. A row with no usable phone is the `skipped` case,
      // and conflating the two is what let a transient failure read as a
      // deliberate rejection.
      expect(summary).toMatchObject({ total: 2, created: 1, failed: 1, skipped: 0 });
      expect(summary.errors).toContainEqual({ row: 1, reason: 'db down' });
    });

    it('stringifies a non-Error rejection into the row reason', async () => {
      const { service, leadsService } = await buildService();
      leadsService.ingestLead.mockRejectedValue('socket hang up');

      const summary = await service.importCsv(BUSINESS_ID, {
        rows: [{ phone: '+919876543210' }],
      } as never);

      expect(summary.errors).toContainEqual({ row: 1, reason: 'socket hang up' });
    });

    it('counts a merged row separately from a created one', async () => {
      const { service, leadsService } = await buildService();
      leadsService.ingestLead
        .mockResolvedValueOnce({ leadId: 'lead_1', merged: true })
        .mockResolvedValueOnce({ leadId: 'lead_2', merged: false });

      const summary = await service.importCsv(BUSINESS_ID, {
        rows: [{ phone: '+919876543210' }, { phone: '+919876543211' }],
      } as never);

      expect(summary).toMatchObject({ total: 2, merged: 1, created: 1, skipped: 0 });
    });

    it('defaults a row with no source to the CSV source', async () => {
      const { service, leadsService } = await buildService();

      await service.importCsv(BUSINESS_ID, {
        rows: [{ phone: '+919876543210' }],
      } as never);

      expect(leadsService.ingestLead).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ source: LeadSource.CSV }),
      );
    });

    it('keeps a row’s own source when the CSV declares one', async () => {
      const { service, leadsService } = await buildService();

      await service.importCsv(BUSINESS_ID, {
        rows: [{ phone: '+919876543210', source: LeadSource.PORTAL }],
      } as never);

      expect(leadsService.ingestLead).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ source: LeadSource.PORTAL }),
      );
    });

    it('reports an empty import as all-zero rather than failing', async () => {
      const { service } = await buildService();

      await expect(
        service.importCsv(BUSINESS_ID, { rows: [] } as never),
      ).resolves.toEqual({ total: 0, created: 0, merged: 0, skipped: 0, failed: 0, errors: [] });
    });
  });

  // ─────────────────────────────────────────────
  // Meta Leadgen accounting
  // ─────────────────────────────────────────────

  describe('ingestMetaLeadgen accounting', () => {
    it('reports an unrecognised payload as an empty summary, not a throw', async () => {
      // Webhooks must ack fast — a malformed body is a no-op, not a 500.
      const { service } = await buildService();

      await expect(service.ingestMetaLeadgen(BUSINESS_ID, { junk: true })).resolves.toEqual({
        total: 0,
        created: 0,
        merged: 0,
        skipped: 0,
        failed: 0,
        errors: [],
      });
    });

    it('names the leadgen id when a candidate has no inline phone', async () => {
      const { service } = await buildService();

      const summary = await service.ingestMetaLeadgen(BUSINESS_ID, {
        object: 'page',
        entry: [
          {
            changes: [
              { field: 'leadgen', value: { leadgen_id: 'lg-99', form_id: 'f-1' } },
            ],
          },
        ],
      });

      expect(summary.skipped).toBe(1);
      expect(summary.errors[0]!.reason).toContain('lg-99');
    });

    it('falls back to a placeholder when even the leadgen id is missing', async () => {
      // The row still has to be reportable — an undefined in the message would
      // read as a bug rather than a Meta payload we could not attribute.
      const { service } = await buildService();

      const summary = await service.ingestMetaLeadgen(BUSINESS_ID, {
        object: 'page',
        entry: [{ changes: [{ field: 'leadgen', value: { form_id: 'f-1' } }] }],
      });

      expect(summary.errors[0]!.reason).toContain('leadgen ?');
    });

    it('attributes to the form id when one is present', async () => {
      const { service, leadsService } = await buildService();

      await service.ingestMetaLeadgen(BUSINESS_ID, {
        object: 'page',
        entry: [
          {
            changes: [
              {
                field: 'leadgen',
                value: {
                  leadgen_id: 'lg-1',
                  form_id: 'f-1',
                  ad_id: 'a-1',
                  field_data: [{ name: 'phone_number', values: ['+919876543210'] }],
                },
              },
            ],
          },
        ],
      });

      expect(leadsService.ingestLead).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ source: LeadSource.META_LEAD_AD, subSource: 'f-1' }),
      );
    });

    it('falls back to the ad id when the form id is absent', async () => {
      const { service, leadsService } = await buildService();

      await service.ingestMetaLeadgen(BUSINESS_ID, {
        object: 'page',
        entry: [
          {
            changes: [
              {
                field: 'leadgen',
                value: {
                  leadgen_id: 'lg-1',
                  ad_id: 'a-1',
                  field_data: [{ name: 'phone_number', values: ['+919876543210'] }],
                },
              },
            ],
          },
        ],
      });

      expect(leadsService.ingestLead).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ subSource: 'a-1' }),
      );
    });
  });

  // ─────────────────────────────────────────────
  // Portal email
  // ─────────────────────────────────────────────

  describe('ingestPortalEmail', () => {
    it('omits sub_source when the portal could not be identified', async () => {
      // Attributing an enquiry to the literal portal "UNKNOWN" would pollute
      // source-ROI reporting with a bogus channel.
      const { service, leadsService } = await buildService();

      const result = await service.ingestPortalEmail(BUSINESS_ID, {
        from: 'someone@example.com',
        subject: 'Property enquiry',
        text: 'Name: Rahul\nPhone: +919876543210',
      } as never);

      expect(result).toMatchObject({ portal: RealtyPortal.UNKNOWN });
      expect(leadsService.ingestLead).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ source: LeadSource.PORTAL, subSource: undefined }),
      );
    });

    it('returns null and warns when the email carries no phone', async () => {
      const { service, leadsService } = await buildService();

      const result = await service.ingestPortalEmail(BUSINESS_ID, {
        from: 'noreply@99acres.com',
        subject: 'Enquiry',
        text: 'No contact details here',
      } as never);

      expect(result).toBeNull();
      expect(leadsService.ingestLead).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('99acres.com'));
    });

    it('names the sender as unknown in the warning when `from` is absent', async () => {
      const { service } = await buildService();

      await service.ingestPortalEmail(BUSINESS_ID, { text: 'nothing' } as never);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"?"'));
    });
  });

  // ─────────────────────────────────────────────
  // CTWA
  // ─────────────────────────────────────────────

  describe('ingestCtwa', () => {
    it('returns null without ingesting when the referral is unusable', async () => {
      const { service, leadsService } = await buildService();

      await expect(
        service.ingestCtwa(BUSINESS_ID, { phone: '', referral: {} } as never),
      ).resolves.toBeNull();
      expect(leadsService.ingestLead).not.toHaveBeenCalled();
    });

    it('reports a merged CTWA ingest', async () => {
      const { service, leadsService } = await buildService();
      leadsService.ingestLead.mockResolvedValue({ leadId: 'lead_1', merged: true });

      const result = await service.ingestCtwa(BUSINESS_ID, {
        phone: '+919876543210',
        name: 'Rahul',
        referral: { source_url: 'https://example.com/2bhk', headline: 'New 2BHK' },
      } as never);

      expect(result).toMatchObject({ leadId: 'lead_1', merged: true });
    });
  });
});
