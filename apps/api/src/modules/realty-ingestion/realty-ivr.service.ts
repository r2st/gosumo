import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  ChannelType,
  MessageContentType,
  LeadSource,
  normalizeIndianPhone,
} from '@gosumo/shared';
import type { OutboundMessage } from '@gosumo/shared';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { ChannelAdapterService } from '../channel-adapter/channel-adapter.service';
import { PrismaService } from '../../common/services/prisma.service';
import {
  allowUnverifiedWebhook,
  isProductionEnv,
} from '../../common/utils/webhook-verification.util';
import { IvrDedupTracker } from './ivr/ivr-dedup.util';
import type { NormalizedIvrCall } from './ivr/ivr-callback.parser';
import type { IvrCallbackResult } from './dto';
import { WebhookDlqService } from '../webhook-log/webhook-dlq.service';
import { maskPhone } from '../../common/utils/log-redact.util';
import {
  REALTY_INGEST_EVENT_TYPES,
  REALTY_INGEST_SOURCES,
  ingestDeliveryId,
} from './realty-ingestion.constants';

const DEFAULT_GREETING =
  'Hi! 👋 Thanks for the missed call — this is our team. Tell us the area, budget, and ' +
  'configuration you have in mind and we’ll share matching options right away.';

/**
 * RealtyIvrService — the missed-call → WhatsApp bridge (blueprint §5.1).
 *
 * A missed call to the business's IVR/DID number is the buyer raising a hand. We
 * capture (or merge) the caller as an `IVR` lead on the E.164 phone, then answer
 * instantly on WhatsApp with a greeting so the AI conversation starts before the
 * buyer cools off. Repeated rings inside a 5-minute window greet only once.
 *
 * Stateless like the rest of `realty-ingestion` — the only in-process state is
 * the short-lived dedup tracker.
 */
@Injectable()
export class RealtyIvrService implements OnModuleInit {
  private readonly logger = new Logger(RealtyIvrService.name);
  private readonly dedup = new IvrDedupTracker();
  private readonly isProduction: boolean;

  constructor(
    private readonly leadsService: RealtyLeadsService,
    private readonly channelAdapter: ChannelAdapterService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    /** Optional for the same reason as in `RealtyIngestionService`. */
    @Optional() private readonly webhookDlq?: WebhookDlqService,
  ) {
    this.isProduction = isProductionEnv(this.configService);
  }

  /**
   * Teach the webhook DLQ how to re-run a failed missed-call callback.
   *
   * Replay re-runs the whole callback, greeting included. That is deliberate:
   * `ingestLead` merges on the phone so the lead cannot duplicate, and the
   * greeting is the entire point of the flow — a buyer who rang and heard
   * nothing back is the failure being fixed. The dedup window suppresses the
   * greeting on the first retry (30s) if the original send did land.
   */
  onModuleInit(): void {
    if (!this.webhookDlq) return;

    this.webhookDlq.registerReplayer(REALTY_INGEST_SOURCES.IVR, async (payload) => {
      const stored = payload as { businessId?: string; call?: NormalizedIvrCall };
      if (!stored?.businessId || !stored.call) {
        throw new Error('Dead-lettered IVR callback is missing its tenant or call');
      }
      await this.processIvrCallback(stored.businessId, stored.call);
    });
  }

  /**
   * Process a missed call, parking it for retry if the ingest threw.
   *
   * The webhook answers 200 regardless (the provider must not retry-storm),
   * which is precisely why the failure needs somewhere to go: before this, an
   * IVR callback that hit a database blip was logged and dropped, and the
   * buyer who rang the number got no WhatsApp reply and never became a lead.
   */
  async handleIvrDelivery(
    businessId: string,
    call: NormalizedIvrCall,
    headers: Record<string, unknown> = {},
  ): Promise<IvrCallbackResult | null> {
    try {
      return await this.processIvrCallback(businessId, call);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);

      if (!this.webhookDlq) {
        this.logger.error(
          `IVR callback for ${businessId} failed and no webhook DLQ is wired — ` +
            `the missed call is lost: ${reason}`,
        );
        return null;
      }

      try {
        await this.webhookDlq.capture(
          {
            businessId,
            source: REALTY_INGEST_SOURCES.IVR,
            eventType: REALTY_INGEST_EVENT_TYPES[REALTY_INGEST_SOURCES.IVR],
            // Hashed over the normalized call rather than the raw body: the two
            // carry the same delivery, and the normalized form is what replay
            // actually re-runs.
            externalId: ingestDeliveryId(REALTY_INGEST_SOURCES.IVR, call),
            payload: { businessId, call } as unknown as Record<string, unknown>,
            headers,
          },
          err,
        );
      } catch (captureErr) {
        // See `RealtyIngestionService.captureIngestFailure` — a DLQ failure
        // must not escape onto a path that has to answer 200.
        this.logger.error(
          `CRITICAL: could not dead-letter IVR callback for ${businessId} ` +
            `(original failure: ${reason}): ` +
            `${captureErr instanceof Error ? captureErr.message : String(captureErr)}`,
        );
      }
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // Signature verification (root rule #3)
  // ─────────────────────────────────────────────

  /**
   * Verify the HMAC-SHA256 signature an IVR provider posts in `x-ivr-signature`
   * against `IVR_WEBHOOK_SECRET`. Tolerates an optional `sha256=` prefix.
   *
   * A missing secret is a configuration failure, not a signature failure, so it
   * follows the shared fail-closed rule: skipped (loudly) outside production,
   * rejected in production — one unset env var must not turn this endpoint into
   * an unauthenticated lead-injection path.
   */
  verifyIvrSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): boolean {
    const secret = this.configService.get<string>('realty.ivrWebhookSecret', '');
    if (!secret) {
      return allowUnverifiedWebhook(
        this.logger,
        this.isProduction,
        'IVR_WEBHOOK_SECRET is not set',
      );
    }
    if (!rawBody || !signatureHeader) return false;

    const provided = signatureHeader.startsWith('sha256=')
      ? signatureHeader.slice('sha256='.length)
      : signatureHeader;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ─────────────────────────────────────────────
  // Processing
  // ─────────────────────────────────────────────

  /**
   * Process one missed call: capture/merge the IVR lead and (unless de-duped)
   * fire the instant WhatsApp greeting. Never throws for an unusable phone —
   * a webhook must ack fast — it just reports what happened.
   */
  async processIvrCallback(
    businessId: string,
    call: NormalizedIvrCall,
  ): Promise<IvrCallbackResult | null> {
    const phone = normalizeIndianPhone(call.phone);
    if (!phone) {
      this.logger.warn(`IVR callback for ${businessId} had an unusable phone: "${maskPhone(call.phone)}"`);
      return null;
    }

    const result = await this.leadsService.ingestLead(businessId, {
      whatsappPhone: phone,
      source: LeadSource.IVR,
      subSource: call.campaignId,
      raw: {
        provider: call.provider,
        calledNumber: call.calledNumber,
        callTime: call.callTime,
        payload: call.raw,
      },
    });

    // De-dup the greeting on a burst of rings; the lead ingest above is always
    // safe to repeat (it merges), only the outbound send needs suppressing.
    const shouldGreet = this.dedup.shouldTrigger(businessId, phone);
    let whatsappTriggered = false;
    if (shouldGreet) {
      whatsappTriggered = await this.sendGreeting(businessId, phone, call);
    } else {
      this.logger.debug(`IVR greeting suppressed for ${maskPhone(phone)} (repeat within window)`);
    }

    this.logger.log(
      `IVR missed call → lead ${result.leadId} (${result.merged ? 'merged' : 'created'}); ` +
        `greeting ${whatsappTriggered ? 'sent' : shouldGreet ? 'not sent' : 'de-duped'}`,
    );

    return {
      leadId: result.leadId,
      merged: result.merged,
      whatsappTriggered,
      deduped: !shouldGreet,
    };
  }

  // ─────────────────────────────────────────────
  // Outbound greeting
  // ─────────────────────────────────────────────

  /** Resolve the business's active WhatsApp account and send the greeting. */
  private async sendGreeting(
    businessId: string,
    phone: string,
    call: NormalizedIvrCall,
  ): Promise<boolean> {
    const account = await this.prisma.channel_accounts.findFirst({
      where: { business_id: businessId, channel: ChannelType.WHATSAPP, is_active: true, deleted_at: null },
    });
    if (!account) {
      this.logger.warn(
        `No active WhatsApp channel account for business ${businessId} — cannot send IVR greeting`,
      );
      return false;
    }

    const message: OutboundMessage = {
      channelAccountId: account.id,
      // Meta expects the recipient without the leading '+'.
      recipientExternalId: phone.replace(/^\+/, ''),
      content: { type: MessageContentType.TEXT, text: this.greetingText(call) },
    };

    try {
      const send = await this.channelAdapter.sendMessage(ChannelType.WHATSAPP, message, businessId);
      if (!send.success) {
        this.logger.warn(`IVR greeting to ${maskPhone(phone)} failed: ${send.error ?? 'unknown error'}`);
      }
      return send.success;
    } catch (err) {
      this.logger.error(
        `IVR greeting dispatch error for ${phone}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** Build the greeting, folding in campaign/DID context when we have it. */
  private greetingText(call: NormalizedIvrCall): string {
    const base = this.configService.get<string>('realty.ivrGreeting', '') || DEFAULT_GREETING;
    if (call.campaignId) {
      return `${base}\n\n(Ref: ${call.campaignId})`;
    }
    return base;
  }
}
