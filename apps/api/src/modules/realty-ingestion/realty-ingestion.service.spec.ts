/**
 * RealtyIngestion service unit tests.
 *
 * Coverage:
 *  1. Meta Leadgen — ingests candidates with a phone, skips phone-less ones,
 *     tags source META_LEAD_AD + form/ad attribution
 *  2. Portal email — parses + ingests, carries portal as sub_source
 *  3. CSV import — created/merged/skipped counting, error rows preserved
 *  4. CTWA — builds a CTWA candidate and ingests
 *  5. Signature — verifyMetaSignature accepts a correct HMAC, rejects a bad one
 *
 * RealtyLeadsService.ingestLead and ConfigService are mocked; the parsers run
 * for real (they are pure).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { LeadSource } from '@gosumo/shared';

import { RealtyIngestionService } from './realty-ingestion.service';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const APP_SECRET = 'test-app-secret';

describe('RealtyIngestionService', () => {
  let service: RealtyIngestionService;
  let leadsService: { ingestLead: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    leadsService = {
      ingestLead: jest.fn().mockResolvedValue({ leadId: 'lead_1', merged: false }),
    };
    config = {
      get: jest.fn((key: string, def?: string) => {
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

    service = module.get(RealtyIngestionService);
  });

  // ── Meta Leadgen ─────────────────────────────

  describe('ingestMetaLeadgen', () => {
    it('ingests candidates with a phone and tags Meta attribution', async () => {
      const payload = {
        entry: [
          {
            id: 'page_1',
            changes: [
              {
                field: 'leadgen',
                value: {
                  leadgen_id: 'lg_1',
                  form_id: 'form_9',
                  field_data: [
                    { name: 'phone', values: ['9876543210'] },
                    { name: 'full_name', values: ['Rahul'] },
                  ],
                },
              },
            ],
          },
        ],
      };
      const summary = await service.ingestMetaLeadgen(BUSINESS_ID, payload);

      expect(leadsService.ingestLead).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          whatsappPhone: '9876543210',
          source: LeadSource.META_LEAD_AD,
          subSource: 'form_9',
          name: 'Rahul',
        }),
      );
      expect(summary).toMatchObject({ total: 1, created: 1, merged: 0, skipped: 0 });
    });

    it('skips a leadgen change with no inline phone', async () => {
      const payload = {
        entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'lg_x' } }] }],
      };
      const summary = await service.ingestMetaLeadgen(BUSINESS_ID, payload);
      expect(leadsService.ingestLead).not.toHaveBeenCalled();
      expect(summary.skipped).toBe(1);
      expect(summary.errors[0]!.reason).toContain('lg_x');
    });
  });

  // ── Portal email ─────────────────────────────

  describe('ingestPortalEmail', () => {
    it('parses and ingests, carrying the portal as sub_source', async () => {
      leadsService.ingestLead.mockResolvedValue({ leadId: 'lead_2', merged: true });
      const result = await service.ingestPortalEmail(BUSINESS_ID, {
        from: 'noreply@99acres.com',
        subject: 'New enquiry',
        text: 'Name: Priya\nPhone: 9876543210\nProperty: Lakeside 3BHK',
      });
      expect(leadsService.ingestLead).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ source: LeadSource.PORTAL, subSource: '99ACRES', name: 'Priya' }),
      );
      expect(result).toMatchObject({ leadId: 'lead_2', merged: true, portal: '99ACRES' });
    });

    it('returns null for an unparseable email', async () => {
      const result = await service.ingestPortalEmail(BUSINESS_ID, {
        from: 'x@99acres.com',
        text: 'no phone here',
      });
      expect(result).toBeNull();
      expect(leadsService.ingestLead).not.toHaveBeenCalled();
    });
  });

  // ── CSV import ───────────────────────────────

  describe('importCsv', () => {
    it('counts created/merged and preserves invalid-row errors', async () => {
      leadsService.ingestLead
        .mockResolvedValueOnce({ leadId: 'l1', merged: false })
        .mockResolvedValueOnce({ leadId: 'l2', merged: true });

      const summary = await service.importCsv(BUSINESS_ID, {
        rows: [
          { phone: '9876543210', name: 'A' },
          { phone: 'not-a-phone' },
          { phone: '09811122233', name: 'B' },
        ],
      });

      expect(summary.total).toBe(3);
      expect(summary.created).toBe(1);
      expect(summary.merged).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(summary.errors).toEqual([{ row: 2, reason: 'Invalid phone: "not-a-phone"' }]);
      expect(leadsService.ingestLead).toHaveBeenCalledTimes(2);
    });
  });

  // ── CTWA ─────────────────────────────────────

  describe('ingestCtwa', () => {
    it('builds a CTWA candidate from the referral and ingests', async () => {
      await service.ingestCtwa(BUSINESS_ID, {
        phone: '9876543210',
        name: 'Sunil',
        referral: { headline: '2BHK launch', source_url: 'https://ad/xyz' },
      });
      expect(leadsService.ingestLead).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          source: LeadSource.CTWA,
          subSource: '2BHK launch',
          listingRef: 'https://ad/xyz',
        }),
      );
    });
  });

  // ── Signature verification ───────────────────

  describe('verifyMetaSignature', () => {
    it('accepts a correct HMAC and rejects a tampered one', () => {
      const body = Buffer.from(JSON.stringify({ hello: 'world' }));
      const good = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
      expect(service.verifyMetaSignature(body, good)).toBe(true);
      expect(service.verifyMetaSignature(body, 'sha256=deadbeef')).toBe(false);
      expect(service.verifyMetaSignature(body, undefined)).toBe(false);
    });
  });
});
