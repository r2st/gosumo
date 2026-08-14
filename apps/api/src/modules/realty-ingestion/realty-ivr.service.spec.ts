/**
 * RealtyIvrService unit tests.
 *
 * Coverage:
 *  1. Signature — verifyIvrSignature accepts a correct HMAC, rejects a bad one,
 *     and skips (allows) when no secret is configured.
 *  2. Missed call → IVR lead ingest (source=IVR, campaign as sub_source) + an
 *     instant WhatsApp greeting to the caller.
 *  3. Dedup — a repeat call inside 5 minutes ingests but does NOT re-greet.
 *  4. No WhatsApp account — lead still ingested, greeting reported as not sent.
 *  5. Unusable phone — returns null, nothing sent.
 *
 * RealtyLeadsService, ChannelAdapterService, PrismaService and ConfigService are
 * mocked; the parser/dedup run for real.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { ChannelType, LeadSource, MessageContentType } from '@gosumo/shared';

import { RealtyIvrService } from './realty-ivr.service';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { ChannelAdapterService } from '../channel-adapter/channel-adapter.service';
import { PrismaService } from '../../common/services/prisma.service';
import { parseIvrCallback } from './ivr/ivr-callback.parser';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const IVR_SECRET = 'test-ivr-secret';

describe('RealtyIvrService', () => {
  let service: RealtyIvrService;
  let leads: { ingestLead: jest.Mock };
  let channel: { sendMessage: jest.Mock };
  let prisma: { channel_accounts: { findFirst: jest.Mock } };

  beforeEach(async () => {
    leads = { ingestLead: jest.fn().mockResolvedValue({ leadId: 'lead_1', merged: false }) };
    channel = { sendMessage: jest.fn().mockResolvedValue({ success: true, externalMessageId: 'wamid.1' }) };
    prisma = {
      channel_accounts: {
        findFirst: jest.fn().mockResolvedValue({ id: 'acc_1', business_id: BUSINESS_ID }),
      },
    };
    const config = {
      get: jest.fn((key: string, def?: string) => {
        if (key === 'realty.ivrWebhookSecret') return IVR_SECRET;
        return def ?? '';
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyIvrService,
        { provide: RealtyLeadsService, useValue: leads },
        { provide: ChannelAdapterService, useValue: channel },
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(RealtyIvrService);
  });

  // ── Signature ────────────────────────────────

  describe('verifyIvrSignature', () => {
    it('accepts a correct HMAC (with and without the sha256= prefix)', () => {
      const body = Buffer.from(JSON.stringify({ CallFrom: '9876543210' }));
      const hex = crypto.createHmac('sha256', IVR_SECRET).update(body).digest('hex');
      expect(service.verifyIvrSignature(body, hex)).toBe(true);
      expect(service.verifyIvrSignature(body, `sha256=${hex}`)).toBe(true);
    });

    it('rejects a tampered or missing signature', () => {
      const body = Buffer.from('{}');
      expect(service.verifyIvrSignature(body, 'sha256=deadbeef')).toBe(false);
      expect(service.verifyIvrSignature(body, undefined)).toBe(false);
      expect(service.verifyIvrSignature(undefined, 'sha256=deadbeef')).toBe(false);
    });

    it('skips verification when no secret is configured', async () => {
      const config = { get: jest.fn((_k: string, def?: string) => def ?? '') };
      const mod = await Test.createTestingModule({
        providers: [
          RealtyIvrService,
          { provide: RealtyLeadsService, useValue: leads },
          { provide: ChannelAdapterService, useValue: channel },
          { provide: PrismaService, useValue: prisma },
          { provide: ConfigService, useValue: config },
        ],
      }).compile();
      expect(mod.get(RealtyIvrService).verifyIvrSignature(undefined, undefined)).toBe(true);
    });
  });

  // ── Processing ───────────────────────────────

  it('ingests an IVR lead and sends the instant WhatsApp greeting', async () => {
    const call = parseIvrCallback({ CallFrom: '09876543210', CampaignId: 'launch' })!;
    const result = await service.processIvrCallback(BUSINESS_ID, call);

    expect(leads.ingestLead).toHaveBeenCalledWith(
      BUSINESS_ID,
      expect.objectContaining({
        whatsappPhone: '+919876543210',
        source: LeadSource.IVR,
        subSource: 'launch',
      }),
    );
    expect(channel.sendMessage).toHaveBeenCalledWith(
      ChannelType.WHATSAPP,
      expect.objectContaining({
        channelAccountId: 'acc_1',
        recipientExternalId: '919876543210',
        content: expect.objectContaining({ type: MessageContentType.TEXT }),
      }),
      BUSINESS_ID,
    );
    expect(result).toEqual({
      leadId: 'lead_1',
      merged: false,
      whatsappTriggered: true,
      deduped: false,
    });
  });

  it('de-dups the greeting for a repeat call within the window', async () => {
    const call = parseIvrCallback({ phone: '9876543210' })!;
    await service.processIvrCallback(BUSINESS_ID, call);
    const second = await service.processIvrCallback(BUSINESS_ID, call);

    // Both rings ingest (merge), but only the first greets.
    expect(leads.ingestLead).toHaveBeenCalledTimes(2);
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ whatsappTriggered: false, deduped: true });
  });

  it('still ingests when the business has no WhatsApp account', async () => {
    prisma.channel_accounts.findFirst.mockResolvedValue(null);
    const call = parseIvrCallback({ phone: '9876543210' })!;
    const result = await service.processIvrCallback(BUSINESS_ID, call);

    expect(leads.ingestLead).toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ whatsappTriggered: false });
  });

  it('returns null and sends nothing for an unusable phone', async () => {
    const result = await service.processIvrCallback(BUSINESS_ID, {
      phone: 'garbage',
      provider: 'generic',
      raw: {},
    });
    expect(result).toBeNull();
    expect(leads.ingestLead).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  /**
   * A greeting that does not go out must not lose the lead.
   *
   * The capture and the greeting are two independent things that can fail
   * apart: a missed call is a real buyer whether or not WhatsApp accepted the
   * outbound message. Only the "no WhatsApp account" arm of that was covered;
   * these are the two ways a send that was actually attempted can fail.
   */
  describe('a greeting that fails to send', () => {
    it('keeps the captured lead when the adapter reports failure', async () => {
      channel.sendMessage.mockResolvedValue({ success: false, error: 'recipient not on WhatsApp' });
      const call = parseIvrCallback({ phone: '9876543210' })!;

      const result = await service.processIvrCallback(BUSINESS_ID, call);

      expect(leads.ingestLead).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        leadId: 'lead_1',
        merged: false,
        // Reported honestly: the lead is in, the greeting is not.
        whatsappTriggered: false,
        // The send was attempted, so this is a failure and not a de-dup.
        deduped: false,
      });
    });

    it('tolerates an adapter that reports failure without saying why', async () => {
      channel.sendMessage.mockResolvedValue({ success: false });
      const call = parseIvrCallback({ phone: '9876543210' })!;

      await expect(service.processIvrCallback(BUSINESS_ID, call)).resolves.toMatchObject({
        leadId: 'lead_1',
        whatsappTriggered: false,
      });
    });

    it.each([
      ['an Error', new Error('Meta 500')],
      ['a non-Error rejection', 'socket hang up'],
    ])('swallows %s thrown by the adapter and still reports the lead', async (_label, thrown) => {
      channel.sendMessage.mockRejectedValue(thrown);
      const call = parseIvrCallback({ phone: '9876543210' })!;

      // A webhook has to ack fast; a dispatch failure cannot propagate out of
      // the handler and turn into a provider retry storm.
      await expect(service.processIvrCallback(BUSINESS_ID, call)).resolves.toEqual({
        leadId: 'lead_1',
        merged: false,
        whatsappTriggered: false,
        deduped: false,
      });
    });
  });

  it('reports a merged lead as merged rather than created', async () => {
    leads.ingestLead.mockResolvedValue({ leadId: 'lead_9', merged: true });
    const call = parseIvrCallback({ phone: '9876543210' })!;

    await expect(service.processIvrCallback(BUSINESS_ID, call)).resolves.toMatchObject({
      leadId: 'lead_9',
      merged: true,
    });
  });
});
