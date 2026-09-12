import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ChannelType,
  MessageContentType,
  LeadSource,
  generateCorrelationId,
} from '@gosumo/shared';
import type { MessageReceivedEvent, OutboundMessage } from '@gosumo/shared';
import { ContextLoaderService } from '../pipeline/context-loader.service';
import { ChannelAdapterService } from '../../channel-adapter/channel-adapter.service';
import { isOptOutMessage } from '../../realty-leads/opt-out-keywords.util';
import { RealtyLeadsService, LeadResponseDto } from '../../realty-leads/realty-leads.service';
import { RealtyBrokerService } from '../../realty-broker/realty-broker.service';
import { RealtyTenantService } from './realty-tenant.service';
import { RealtyAiService, RealtyDecision } from './realty-ai.service';
import { ConversationLockService } from '../../../common/services/conversation-lock.service';

/**
 * RealtyMessageBridgeService — the event bridge that hands inbound buyer
 * messages to the grounded realty AI loop.
 *
 * Every channel normalizes an inbound message to a `message.received` event. The
 * generic `AiEngineService` also listens, but early-returns for realty tenants
 * (see its `handleMessageReceived`), so exactly ONE pipeline owns each message:
 *   - realty tenant  → this bridge → {@link RealtyAiService.processTurn}
 *   - everyone else  → the generic ai-engine
 *
 * For a realty tenant this bridge:
 *   1. resolves the buyer's message text (the event carries no content),
 *   2. finds/creates the lead by E.164 phone (one buyer, one history),
 *   3. runs the grounded turn (BLTC extraction · inventory grounding · realty
 *      hard rules · confidence routing · language mirroring),
 *   4. delivers the outcome by confidence band — AUTO auto-sends via the channel
 *      adapter (subject to the autonomy dial), DRAFT/GUIDED queue a human draft,
 *      ESCALATE sends nothing and leaves it for a human.
 *
 * The bridge never throws to the emitter: any failure is logged and swallowed so
 * one bad message can never wedge the event bus.
 */
@Injectable()
export class RealtyMessageBridgeService {
  private readonly logger = new Logger(RealtyMessageBridgeService.name);

  constructor(
    private readonly tenants: RealtyTenantService,
    private readonly contextLoader: ContextLoaderService,
    private readonly leads: RealtyLeadsService,
    private readonly realtyAi: RealtyAiService,
    private readonly broker: RealtyBrokerService,
    private readonly channelAdapter: ChannelAdapterService,
    private readonly locks: ConversationLockService,
  ) {}

  @OnEvent('message.received')
  async handleMessageReceived(event: MessageReceivedEvent): Promise<void> {
    // Only realty tenants; the generic ai-engine handles the rest.
    if (!(await this.tenants.isRealtyTenant(event.businessId))) return;

    if (!event.conversationId || !event.messageId) {
      this.logger.debug(
        `Skipping realty turn ${event.messageId || '(no id)'}: conversation not yet resolved`,
      );
      return;
    }

    const traceId = event.correlationId ?? generateCorrelationId();
    try {
      // One turn at a time per conversation, in arrival order. `emit` does not
      // await listeners, so two messages a second apart otherwise run this
      // whole route concurrently: both read the same BLTC profile, each merges
      // only its own message, and the second write drops the first's facts —
      // the buyer states a budget and is asked for it again. The replies also
      // race, so the answer to the second message can land first.
      await this.locks.runExclusive(
        ConversationLockService.conversationKey(event.businessId, event.conversationId),
        () => this.route(event, traceId),
      );
    } catch (err) {
      this.logger.error(
        `[${traceId}] Realty bridge failed for message ${event.messageId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ─────────────────────────────────────────────
  // Routing
  // ─────────────────────────────────────────────

  private async route(event: MessageReceivedEvent, traceId: string): Promise<void> {
    // 1) Load the buyer's message text — the event carries only ids.
    const ctx = await this.contextLoader.load(
      event.businessId,
      event.conversationId,
      event.messageId,
    );

    // Never process our own outbound echoes.
    if (ctx.triggerMessage && ctx.triggerMessage.direction !== 'INBOUND') {
      this.logger.debug(`[${traceId}] Skipping non-inbound message ${event.messageId}`);
      return;
    }

    const messageText = ctx.messageText?.trim();
    if (!messageText) {
      // No text to reason over (e.g. a bare media message before transcription).
      this.logger.debug(`[${traceId}] Skipping realty turn — empty message text`);
      return;
    }

    // 2) Resolve the lead by E.164 phone (find-or-create, race-safe).
    //
    // `senderPhone`, not `senderExternalId` — the comment above has always said
    // E.164, but the raw channel id was what got passed: a WhatsApp `wa_id`
    // carries no `+`, so this created a *second* lead for a buyer already
    // ingested from a portal as `+91…`, splitting one person's history in two.
    // The raw id is still the right thing to reply *to* — see `send` below.
    if (!event.senderPhone) {
      this.logger.debug(
        `[${traceId}] No phone identity on a ${event.channel} message — skipping realty turn`,
      );
      return;
    }
    const lead = await this.leads.ensureLeadByPhone(event.businessId, event.senderPhone, {
      conversationId: event.conversationId,
      clientId: event.clientId,
      source: LeadSource.CTWA,
    });
    if (!lead) {
      this.logger.warn(
        `[${traceId}] Could not resolve a lead for "${event.senderExternalId}" — skipping realty turn`,
      );
      return;
    }

    // 2b) "Reply STOP to opt out" — the DPDPA notice promises it, so honour it
    //     before the AI gets a say. Whole-message match only (see the util);
    //     the lead's opt_out flag is what every downstream guard reads, and
    //     nothing is sent back: an opted-out number gets no automated message,
    //     confirmation included.
    if (isOptOutMessage(messageText)) {
      await this.leads.setOptOut(event.businessId, lead.id, 'buyer_reply');
      this.logger.log(`[${traceId}] Lead ${lead.id} opted out by reply — realty turn suppressed`);
      return;
    }

    // 3) Run the grounded realty turn. Language mirroring is handled inside the
    //    loop via the lead's languagePref (falls back to auto-detecting the
    //    buyer's own language — Hindi/Hinglish/English).
    const decision = await this.realtyAi.processTurn(event.businessId, {
      leadId: lead.id,
      messageText,
      conversationId: event.conversationId,
      serviceWindowOpen: true,
      correlationId: traceId,
    });

    // 4) Deliver by confidence band.
    await this.dispatch(event, lead, decision, traceId);
  }

  // ─────────────────────────────────────────────
  // Delivery
  // ─────────────────────────────────────────────

  private async dispatch(
    event: MessageReceivedEvent,
    lead: LeadResponseDto,
    decision: RealtyDecision,
    traceId: string,
  ): Promise<void> {
    const score = decision.confidence.finalScore;

    // AUTO band (≥90) — auto-send, but only if the autonomy dial permits it
    // right now (kill switch off · not SUGGEST mode · no active human takeover).
    if (decision.routeMode === 'AUTO' && decision.responseText) {
      const autonomy = await this.broker.evaluateAutonomy(
        event.businessId,
        score,
        event.conversationId,
      );
      if (autonomy.autoSend) {
        await this.send(event, decision.responseText, traceId);
        this.logger.log(
          `[${traceId}] Realty AUTO reply sent to lead ${lead.id} (confidence ${score})`,
        );
        return;
      }
      // Dial vetoed the send — fall back to a human draft so nothing is lost.
      this.logger.log(
        `[${traceId}] AUTO reply withheld (${autonomy.reason}) — queuing draft for lead ${lead.id}`,
      );
      await this.draft(event, lead, decision, traceId);
      return;
    }

    // DRAFT (70–89) / GUIDED (50–69) — queue for human review.
    if (decision.routeMode === 'DRAFT' || decision.routeMode === 'GUIDED') {
      await this.draft(event, lead, decision, traceId);
      return;
    }

    // ESCALATE (<50, hard-rule block, opt-out, jailbreak) — send nothing; a human
    // takes over. Hot-lead alerting rides the realty-leads/broker event paths.
    this.logger.log(
      `[${traceId}] Realty turn escalated for lead ${lead.id} — no auto-send (${
        decision.escalationReason ?? 'low confidence'
      })`,
    );
  }

  /** Send an AI reply back to the buyer on the originating channel. */
  private async send(event: MessageReceivedEvent, text: string, traceId: string): Promise<void> {
    const outbound: OutboundMessage = {
      channelAccountId: event.channelAccountId,
      recipientExternalId: event.senderExternalId,
      content: { type: MessageContentType.TEXT, text },
      correlationId: traceId,
    };
    await this.channelAdapter.sendMessage(
      event.channel as ChannelType,
      outbound,
      event.businessId,
      traceId,
    );
  }

  /** Queue an AI draft for broker review (70–89 draft / 50–69 guided bands). */
  private async draft(
    event: MessageReceivedEvent,
    lead: LeadResponseDto,
    decision: RealtyDecision,
    traceId: string,
  ): Promise<void> {
    if (!decision.responseText) {
      this.logger.log(
        `[${traceId}] No draftable response for lead ${lead.id} (${decision.routeMode}) — escalating instead`,
      );
      return;
    }
    await this.broker.createApproval(event.businessId, {
      leadId: lead.id,
      conversationId: event.conversationId,
      draftText: decision.responseText,
      confidence: decision.confidence.finalScore,
      intent: decision.intent,
    });
    this.logger.log(
      `[${traceId}] Realty draft queued for lead ${lead.id} (${decision.routeMode}, confidence ${decision.confidence.finalScore})`,
    );
  }
}
