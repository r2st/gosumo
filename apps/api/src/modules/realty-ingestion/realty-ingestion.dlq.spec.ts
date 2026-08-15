/**
 * Lead-ingestion webhooks: what happens to a delivery that fails.
 *
 * All three `@Public()` ingestion webhooks answer 200 unconditionally, because
 * a non-200 puts Meta and the IVR providers into a retry storm against an
 * endpoint that is already failing. That convention is right, and it used to
 * come with a hole underneath it: the handler caught the error, logged it, and
 * returned 200 — so the provider never retried, nothing was recorded anywhere
 * an operator would look, and a lead the business had *paid Facebook for* was
 * gone. The parallel gap on the portal webhook lost a 99acres enquiry, and on
 * the IVR webhook lost a buyer who had literally just rung the number.
 *
 * The Meta path had a second, quieter version of the same bug: `ingestMetaLeadgen`
 * catches per-candidate failures into a summary rather than throwing, and the
 * handler discarded that summary. So a batch where two of three leads hit a
 * database blip reported total success — no throw, no log, no record.
 *
 * These tests pin the fix: a failed delivery is captured to
 * `webhook_dead_letters` with everything a replay needs, a *permanently*
 * unusable one is not (it would retry forever), and the webhook still answers
 * 200 in every case.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

import { RealtyIngestionService } from './realty-ingestion.service';
import { RealtyIvrService } from './realty-ivr.service';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { ChannelAdapterService } from '../channel-adapter/channel-adapter.service';
import { PrismaService } from '../../common/services/prisma.service';
import { WebhookDlqService } from '../webhook-log/webhook-dlq.service';
import {
  REALTY_INGEST_EVENT_TYPES,
  REALTY_INGEST_SOURCES,
  ingestDeliveryId,
} from './realty-ingestion.constants';
import type { NormalizedIvrCall } from './ivr/ivr-callback.parser';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

/** A Meta Leadgen body carrying `count` leads with inline phones. */
function leadgenBody(count: number): Record<string, unknown> {
  return {
    object: 'page',
    entry: [
      {
        changes: Array.from({ length: count }, (_, i) => ({
          field: 'leadgen',
          value: {
            leadgen_id: `lg-${i + 1}`,
            form_id: 'f-1',
            field_data: [{ name: 'phone_number', values: [`+91987654321${i}`] }],
          },
        })),
      },
    ],
  };
}

/** A leadgen body whose lead has no inline phone — permanently unusable. */
function leadgenBodyWithoutPhone(): Record<string, unknown> {
  return {
    object: 'page',
    entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'lg-99', form_id: 'f-1' } }] }],
  };
}

const IVR_CALL: NormalizedIvrCall = {
  phone: '+919876543210',
  calledNumber: '+918000000000',
  provider: 'exotel',
  raw: { CallFrom: '+919876543210' },
};

interface Harness {
  ingestion: RealtyIngestionService;
  ivr: RealtyIvrService;
  ingestLead: jest.Mock;
  capture: jest.Mock;
  registerReplayer: jest.Mock;
  /** Replayers the services registered, keyed by DLQ source. */
  replayers: Map<string, (payload: Record<string, unknown>) => Promise<void>>;
}

/**
 * Build both ingestion services against a stubbed DLQ.
 *
 * `withDlq: false` builds them with the DLQ absent, which is the shape every
 * pre-existing unit suite constructs and the one a partially-wired deployment
 * would have.
 */
async function buildHarness(withDlq = true): Promise<Harness> {
  const ingestLead = jest.fn().mockResolvedValue({ leadId: 'lead_1', merged: false });
  const capture = jest.fn().mockResolvedValue({ id: 'dl-1' });
  const replayers = new Map<string, (payload: Record<string, unknown>) => Promise<void>>();
  const registerReplayer = jest.fn((source: string, handler: never) => {
    replayers.set(source, handler);
  });

  const config = {
    get: jest.fn((_key: string, def?: string) => def ?? ''),
  };

  const providers: NonNullable<Parameters<typeof Test.createTestingModule>[0]['providers']> = [
    RealtyIngestionService,
    RealtyIvrService,
    { provide: RealtyLeadsService, useValue: { ingestLead } },
    { provide: ConfigService, useValue: config },
    {
      provide: ChannelAdapterService,
      useValue: { sendMessage: jest.fn().mockResolvedValue({ success: true }) },
    },
    {
      provide: PrismaService,
      useValue: { channel_accounts: { findFirst: jest.fn().mockResolvedValue({ id: 'ca-1' }) } },
    },
  ];

  if (withDlq) {
    providers.push({
      provide: WebhookDlqService,
      useValue: { capture, registerReplayer },
    });
  }

  const module: TestingModule = await Test.createTestingModule({ providers }).compile();

  const ingestion = module.get(RealtyIngestionService);
  const ivr = module.get(RealtyIvrService);
  // `Test.createTestingModule().compile()` does not run lifecycle hooks; call
  // them the way Nest would at boot so the replayer registry is populated.
  ingestion.onModuleInit();
  ivr.onModuleInit();

  return { ingestion, ivr, ingestLead, capture, registerReplayer, replayers };
}

describe('realty lead ingestion — dead-lettering failed deliveries', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  // ─────────────────────────────────────────────
  // Meta Leadgen
  // ─────────────────────────────────────────────

  describe('Meta Leadgen', () => {
    /**
     * The headline regression. `ingestMetaLeadgen` does not throw when one
     * candidate fails — it records the reason in a summary — so a wrapper that
     * only watched for exceptions would still lose the lead silently.
     */
    it('captures a batch where an individual candidate failed', async () => {
      const h = await buildHarness();
      h.ingestLead
        .mockRejectedValueOnce(new Error('db connection reset'))
        .mockResolvedValueOnce({ leadId: 'lead_2', merged: false });

      const summary = await h.ingestion.handleMetaLeadgenDelivery(BUSINESS_ID, leadgenBody(2));

      expect(summary.failed).toBe(1);
      expect(summary.created).toBe(1);
      expect(h.capture).toHaveBeenCalledTimes(1);

      const [delivery, error] = h.capture.mock.calls[0]!;
      expect(delivery.source).toBe(REALTY_INGEST_SOURCES.META_LEADGEN);
      expect(delivery.businessId).toBe(BUSINESS_ID);
      expect((error as Error).message).toContain('db connection reset');
    });

    it('captures when the whole batch throws', async () => {
      const h = await buildHarness();
      // A parser-level explosion rather than a per-candidate one.
      jest
        .spyOn(h.ingestion, 'ingestMetaLeadgen')
        .mockRejectedValue(new Error('leadgen parser blew up'));

      const summary = await h.ingestion.handleMetaLeadgenDelivery(BUSINESS_ID, leadgenBody(1));

      expect(h.capture).toHaveBeenCalledTimes(1);
      // The caller still gets a summary rather than an exception — the webhook
      // handler above it has no catch of its own any more.
      expect(summary.failed).toBe(1);
    });

    /**
     * A lead with no inline phone needs a Graph fetch we do not perform. It is
     * not a transient failure and retrying the identical body six times would
     * only fill the queue and the operator's list with noise.
     */
    it('does not capture a candidate that is permanently unusable', async () => {
      const h = await buildHarness();

      const summary = await h.ingestion.handleMetaLeadgenDelivery(
        BUSINESS_ID,
        leadgenBodyWithoutPhone(),
      );

      expect(summary.skipped).toBe(1);
      expect(summary.failed).toBe(0);
      expect(h.capture).not.toHaveBeenCalled();
    });

    it('does not capture a fully successful batch', async () => {
      const h = await buildHarness();

      const summary = await h.ingestion.handleMetaLeadgenDelivery(BUSINESS_ID, leadgenBody(2));

      expect(summary.created).toBe(2);
      expect(h.capture).not.toHaveBeenCalled();
    });

    /**
     * The tenant arrives on the request as `x-business-id` and is gone by the
     * time a retry runs minutes later, so it has to be stored *in* the payload.
     * Without it the replayer has a body it cannot attribute to anyone.
     */
    it('stores the tenant alongside the body so a replay can attribute it', async () => {
      const h = await buildHarness();
      h.ingestLead.mockRejectedValue(new Error('db down'));
      const body = leadgenBody(1);

      await h.ingestion.handleMetaLeadgenDelivery(BUSINESS_ID, body);

      const [delivery] = h.capture.mock.calls[0]!;
      expect(delivery.payload).toEqual({ businessId: BUSINESS_ID, body });
      expect(delivery.eventType).toBe(
        REALTY_INGEST_EVENT_TYPES[REALTY_INGEST_SOURCES.META_LEADGEN],
      );
    });
  });

  // ─────────────────────────────────────────────
  // Portal enquiry email
  // ─────────────────────────────────────────────

  describe('portal enquiry email', () => {
    const dto = {
      from: 'leads@99acres.com',
      subject: 'New enquiry',
      text: 'Name: Rahul\nPhone: +919876543210\nProperty: PRJ-1',
    };

    it('captures an enquiry whose write failed', async () => {
      const h = await buildHarness();
      h.ingestLead.mockRejectedValue(new Error('lead table is gone'));

      await expect(
        h.ingestion.handlePortalEmailDelivery(BUSINESS_ID, dto),
      ).resolves.toBeNull();

      expect(h.capture).toHaveBeenCalledTimes(1);
      expect(h.capture.mock.calls[0]![0].source).toBe(REALTY_INGEST_SOURCES.PORTAL_EMAIL);
    });

    /**
     * An email the parser cannot read has no phone in it, and will not grow one
     * on the fourth attempt. Template drift is caught by `parser-health`
     * against known-good samples — not by retrying a body forever.
     */
    it('does not capture an unparseable enquiry', async () => {
      const h = await buildHarness();

      await expect(
        h.ingestion.handlePortalEmailDelivery(BUSINESS_ID, {
          from: 'noreply@example.com',
          text: 'nothing useful in here',
        }),
      ).resolves.toBeNull();

      expect(h.capture).not.toHaveBeenCalled();
    });

    it('does not capture a successful enquiry', async () => {
      const h = await buildHarness();

      await h.ingestion.handlePortalEmailDelivery(BUSINESS_ID, dto);

      expect(h.capture).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // IVR missed call
  // ─────────────────────────────────────────────

  describe('IVR missed call', () => {
    it('captures a callback whose ingest threw', async () => {
      const h = await buildHarness();
      h.ingestLead.mockRejectedValue(new Error('lock timeout'));

      await expect(h.ivr.handleIvrDelivery(BUSINESS_ID, IVR_CALL)).resolves.toBeNull();

      expect(h.capture).toHaveBeenCalledTimes(1);
      const [delivery, error] = h.capture.mock.calls[0]!;
      expect(delivery.source).toBe(REALTY_INGEST_SOURCES.IVR);
      expect(delivery.payload).toEqual({ businessId: BUSINESS_ID, call: IVR_CALL });
      expect((error as Error).message).toContain('lock timeout');
    });

    it('does not capture a callback that succeeded', async () => {
      const h = await buildHarness();

      await h.ivr.handleIvrDelivery(BUSINESS_ID, IVR_CALL);

      expect(h.capture).not.toHaveBeenCalled();
    });

    /**
     * `processIvrCallback` returns null (rather than throwing) for a phone it
     * cannot normalize. Nothing about that improves on a retry.
     */
    it('does not capture an unusable caller phone', async () => {
      const h = await buildHarness();

      await expect(
        h.ivr.handleIvrDelivery(BUSINESS_ID, { ...IVR_CALL, phone: 'not-a-number' }),
      ).resolves.toBeNull();

      expect(h.capture).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // The webhook must survive the recovery path itself
  // ─────────────────────────────────────────────

  describe('capture never breaks the webhook', () => {
    /**
     * Capture runs inside a catch on a path that must answer 200. If a DLQ
     * outage propagated, the provider would get a 500 and retry into an
     * endpoint that is already failing — the exact storm the 200 convention
     * exists to prevent.
     */
    it('swallows a DLQ that is itself failing', async () => {
      const h = await buildHarness();
      const error = jest.spyOn(Logger.prototype, 'error');
      h.ingestLead.mockRejectedValue(new Error('db down'));
      h.capture.mockRejectedValue(new Error('dead letter table unreachable'));

      await expect(
        h.ingestion.handleMetaLeadgenDelivery(BUSINESS_ID, leadgenBody(1)),
      ).resolves.toMatchObject({ failed: 1 });

      // The one thing left to do is say so at a level that pages someone.
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('could not dead-letter'),
      );
    });

    it('swallows a failing DLQ on the IVR path too', async () => {
      const h = await buildHarness();
      h.ingestLead.mockRejectedValue(new Error('db down'));
      h.capture.mockRejectedValue(new Error('dead letter table unreachable'));

      await expect(h.ivr.handleIvrDelivery(BUSINESS_ID, IVR_CALL)).resolves.toBeNull();
    });

    it('reports loudly and does not throw when no DLQ is wired at all', async () => {
      const h = await buildHarness(false);
      const error = jest.spyOn(Logger.prototype, 'error');
      h.ingestLead.mockRejectedValue(new Error('db down'));

      await expect(
        h.ingestion.handleMetaLeadgenDelivery(BUSINESS_ID, leadgenBody(1)),
      ).resolves.toMatchObject({ failed: 1 });
      await expect(h.ivr.handleIvrDelivery(BUSINESS_ID, IVR_CALL)).resolves.toBeNull();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('no webhook DLQ is wired'));
    });
  });

  // ─────────────────────────────────────────────
  // Delivery ids
  // ─────────────────────────────────────────────

  describe('delivery ids', () => {
    /**
     * `webhook_dead_letters` is unique on `(source, external_id)` and `capture`
     * upserts on it. A body-derived id therefore has to be stable for one
     * delivery — otherwise a provider redelivery stacks a second recovery row
     * beside the first and an operator replays the same lead twice.
     */
    it('is stable for the same body', () => {
      const body = leadgenBody(2);
      expect(ingestDeliveryId(REALTY_INGEST_SOURCES.META_LEADGEN, body)).toBe(
        ingestDeliveryId(REALTY_INGEST_SOURCES.META_LEADGEN, body),
      );
    });

    it('differs across different bodies', () => {
      expect(ingestDeliveryId(REALTY_INGEST_SOURCES.META_LEADGEN, leadgenBody(1))).not.toBe(
        ingestDeliveryId(REALTY_INGEST_SOURCES.META_LEADGEN, leadgenBody(2)),
      );
    });

    /**
     * Two sources that happened to carry an identical body must not collide on
     * one row — the unique key is `(source, external_id)`, but the replayer
     * registry is keyed on `source` alone, so a collision would hand a portal
     * email to the IVR replayer.
     */
    it('is namespaced by source', () => {
      const body = { same: 'body' };
      expect(ingestDeliveryId(REALTY_INGEST_SOURCES.IVR, body)).not.toBe(
        ingestDeliveryId(REALTY_INGEST_SOURCES.PORTAL_EMAIL, body),
      );
      expect(ingestDeliveryId(REALTY_INGEST_SOURCES.IVR, body)).toContain('realty_ivr');
    });

    it('fits the external_id column', () => {
      const id = ingestDeliveryId(REALTY_INGEST_SOURCES.META_LEADGEN, leadgenBody(50));
      expect(id.length).toBeLessThanOrEqual(255);
    });

    it('survives a body it cannot serialize rather than throwing inside a catch', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => ingestDeliveryId(REALTY_INGEST_SOURCES.IVR, circular)).not.toThrow();
    });
  });

  // ─────────────────────────────────────────────
  // Replay
  // ─────────────────────────────────────────────

  describe('replay', () => {
    it('registers a replayer for every ingestion source', async () => {
      const h = await buildHarness();

      expect([...h.replayers.keys()].sort()).toEqual(
        [
          REALTY_INGEST_SOURCES.IVR,
          REALTY_INGEST_SOURCES.META_LEADGEN,
          REALTY_INGEST_SOURCES.PORTAL_EMAIL,
        ].sort(),
      );
    });

    /**
     * A source with no replayer is worse than no capture: `runRetry` fails the
     * attempt on every try and the entry marches to DISCARDED while looking
     * like it is being retried.
     */
    it('re-ingests a captured leadgen batch', async () => {
      const h = await buildHarness();
      const replay = h.replayers.get(REALTY_INGEST_SOURCES.META_LEADGEN)!;

      await replay({ businessId: BUSINESS_ID, body: leadgenBody(1) });

      expect(h.ingestLead).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ whatsappPhone: '+919876543210' }),
      );
    });

    /**
     * The replayer's return value is what decides the entry's fate: resolving
     * marks it REPLAYED and stops all further retries. A replay whose leads
     * failed again must therefore throw, or the recovery row closes itself
     * while the lead is still lost.
     */
    it('throws when a replayed candidate is still failing', async () => {
      const h = await buildHarness();
      h.ingestLead.mockRejectedValue(new Error('still down'));
      const replay = h.replayers.get(REALTY_INGEST_SOURCES.META_LEADGEN)!;

      await expect(replay({ businessId: BUSINESS_ID, body: leadgenBody(1) })).rejects.toThrow(
        /still down/,
      );
    });

    it('re-ingests a captured portal enquiry', async () => {
      const h = await buildHarness();
      const replay = h.replayers.get(REALTY_INGEST_SOURCES.PORTAL_EMAIL)!;

      await replay({
        businessId: BUSINESS_ID,
        body: { from: 'leads@99acres.com', text: 'Phone: +919876543210' },
      });

      expect(h.ingestLead).toHaveBeenCalledTimes(1);
    });

    it('re-runs a captured IVR callback', async () => {
      const h = await buildHarness();
      const replay = h.replayers.get(REALTY_INGEST_SOURCES.IVR)!;

      await replay({ businessId: BUSINESS_ID, call: IVR_CALL });

      expect(h.ingestLead).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ whatsappPhone: '+919876543210' }),
      );
    });

    /**
     * Every replayer refuses a payload with no tenant. Ingesting into a guessed
     * or empty business would write one tenant's lead into another's pipeline —
     * far worse than leaving the entry parked for a human.
     */
    it.each([
      [REALTY_INGEST_SOURCES.META_LEADGEN, { body: {} }],
      [REALTY_INGEST_SOURCES.PORTAL_EMAIL, { body: {} }],
      [REALTY_INGEST_SOURCES.IVR, { call: IVR_CALL }],
    ])('%s replayer refuses a payload with no tenant', async (source, payload) => {
      const h = await buildHarness();
      const replay = h.replayers.get(source)!;

      await expect(replay(payload as Record<string, unknown>)).rejects.toThrow(/missing its/);
      expect(h.ingestLead).not.toHaveBeenCalled();
    });
  });
});
