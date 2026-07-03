import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { realty_no_ship_incidents } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  NoShipKind,
} from '@gosumo/shared';
import type {
  RealtyAiTurnCompletedEvent,
  RealtyNoShipIncidentEvent,
} from '@gosumo/shared';
import { RealtyPilotRepository } from './realty-pilot.repository';
import { RecordNoShipDto } from './dto';

export interface NoShipIncidentDto {
  id: string;
  kind: string;
  leadId: string | null;
  conversationId: string | null;
  detail: string;
  source: string;
  createdAt: Date;
}

/**
 * Maps a realty guardrail violation code to its no-ship kind. Only the codes
 * that correspond to a §24 no-ship condition are mapped; advisory codes
 * (negotiation, financial advice) are handled by escalation, not the ledger.
 */
const GUARDRAIL_TO_NO_SHIP: Record<string, NoShipKind> = {
  unverified_price: NoShipKind.UNVERIFIED_PRICE,
  stale_availability: NoShipKind.STALE_AVAILABILITY,
  opted_out_recipient: NoShipKind.OPTED_OUT_SEND,
  rera_claim_unverified: NoShipKind.RERA_CLAIM,
  possession_claim_unverified: NoShipKind.RERA_CLAIM,
  cross_buyer_disclosure: NoShipKind.CROSS_BUYER,
};

/**
 * NoShipService — owns the append-only no-ship incident ledger (Phase 8).
 *
 * A "no-ship" incident is a §24 violation that reached (or would have reached) a
 * buyer: a price absent from a verified sheet, availability affirmed for a
 * SOLD/HOLD/UNVERIFIED unit, a send to an opted-out number, a RERA claim beyond
 * the sheet, or a cross-buyer disclosure. In a healthy system the guardrails
 * block these upstream (forcing ESCALATE), so this ledger stays empty — its
 * presence is what the launch gate hard-fails on. This service also watches the
 * AI loop and records a regression if a BLOCK-severity violation ever
 * co-occurred with an actual autonomous send (routeMode AUTO).
 */
@Injectable()
export class NoShipService {
  private readonly logger = new Logger(NoShipService.name);

  constructor(
    private readonly repository: RealtyPilotRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Record a no-ship incident explicitly (QA / soak-drill / cross-module report). */
  async recordIncident(
    businessId: string,
    input: {
      kind: NoShipKind;
      detail: string;
      source: string;
      leadId?: string | null;
      conversationId?: string | null;
    },
  ): Promise<NoShipIncidentDto> {
    const incident = await this.repository.createNoShipIncident({
      businessId,
      kind: input.kind as realty_no_ship_incidents['kind'],
      leadId: input.leadId,
      conversationId: input.conversationId,
      detail: input.detail,
      source: input.source,
    });
    const evt: RealtyNoShipIncidentEvent = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      type: 'realty.no_ship.incident',
      incidentId: incident.id,
      kind: input.kind,
      leadId: input.leadId ?? undefined,
      source: input.source,
    };
    this.eventEmitter.emit('realty.no_ship.incident', evt);
    this.logger.warn(
      `No-ship incident recorded for ${businessId}: ${input.kind} (${input.source})`,
    );
    return this.map(incident);
  }

  async recordFromDto(businessId: string, dto: RecordNoShipDto): Promise<NoShipIncidentDto> {
    return this.recordIncident(businessId, {
      kind: dto.kind,
      detail: dto.detail,
      source: dto.source ?? 'manual',
      leadId: dto.leadId,
      conversationId: dto.conversationId,
    });
  }

  async count(businessId: string, since?: Date): Promise<number> {
    return this.repository.countNoShipIncidents(businessId, since);
  }

  async countByKind(businessId: string, since?: Date): Promise<Record<string, number>> {
    return this.repository.countNoShipByKind(businessId, since);
  }

  async list(businessId: string): Promise<NoShipIncidentDto[]> {
    const rows = await this.repository.listNoShipIncidents(businessId);
    return rows.map((r) => this.map(r));
  }

  /**
   * Regression watch: a BLOCK-severity guardrail violation that shipped as an
   * autonomous AUTO send is a no-ship incident. Guardrails normally force
   * ESCALATE, so this never fires in a healthy run — it catches a regression.
   */
  @OnEvent('realty.ai.turn_completed')
  async onTurnCompleted(event: RealtyAiTurnCompletedEvent): Promise<void> {
    if (event.routeMode !== 'AUTO') return;
    const blocking = event.blockingViolations ?? [];
    if (blocking.length === 0) return;

    for (const code of blocking) {
      const kind = GUARDRAIL_TO_NO_SHIP[code];
      if (!kind) continue;
      try {
        await this.recordIncident(event.businessId, {
          kind,
          detail: `Auto-sent turn violated guardrail "${code}" (intent ${event.intent})`,
          source: 'realty-ai:auto_send',
          leadId: event.leadId,
          conversationId: event.conversationId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to record no-ship regression for ${event.leadId}: ${message}`);
      }
    }
  }

  private map(r: realty_no_ship_incidents): NoShipIncidentDto {
    return {
      id: r.id,
      kind: r.kind,
      leadId: r.lead_id,
      conversationId: r.conversation_id,
      detail: r.detail,
      source: r.source,
      createdAt: r.created_at,
    };
  }
}
