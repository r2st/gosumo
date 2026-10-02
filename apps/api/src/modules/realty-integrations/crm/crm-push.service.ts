import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { RealtyIntegrationProvider } from '@prisma/client';
import type { realty_integration_connections } from '@prisma/client';
import { generateId, generateCorrelationId } from '@gosumo/shared';
import type {
  RealtyLeadCreatedEvent,
  RealtyLeadQualifiedEvent,
  RealtyLeadStageChangedEvent,
} from '@gosumo/shared';
import { RealtyLeadsService } from '../../realty-leads/realty-leads.service';
import { BillingService } from '../../billing/billing.service';
import { RealtyIntegrationsRepository } from '../realty-integrations.repository';
import { CRM_PROVIDERS } from '../realty-integrations.constants';
import {
  CrmAdapter,
  CrmPushReason,
  CrmPushResult,
  toCrmLead,
} from './crm-adapter.interface';
import { SellDoAdapter } from './selldo.adapter';
import { LeadSquaredAdapter } from './leadsquared.adapter';
import { PrivyrAdapter } from './privyr.adapter';
import type {
  RealtyCrmPushedEvent,
  RealtyCrmPushFailedEvent,
  RealtyIntegrationConnectedEvent,
  RealtyIntegrationDisconnectedEvent,
} from '../realty-integrations.events';

export interface CrmConnectionStatus {
  provider: RealtyIntegrationProvider;
  status: string;
  externalRef: string | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  pushedCount: number;
}

/**
 * CrmPushService — pushes leads into the connected Indian CRM(s) (Sell.Do,
 * LeadSquared, Privyr) on create / qualify / stage-change, and on demand. CRM
 * sync is a Developer-tier feature (business plan §9), so every push path first
 * checks {@link BillingService.canUseCrmSync}. Connection credentials live in the
 * integration connection's `config` (never surfaced on read DTOs).
 */
@Injectable()
export class CrmPushService {
  private readonly logger = new Logger(CrmPushService.name);
  private readonly adapters: Map<RealtyIntegrationProvider, CrmAdapter>;

  constructor(
    private readonly repository: RealtyIntegrationsRepository,
    private readonly leadsService: RealtyLeadsService,
    private readonly billing: BillingService,
    private readonly eventEmitter: EventEmitter2,
    selldo: SellDoAdapter,
    leadsquared: LeadSquaredAdapter,
    privyr: PrivyrAdapter,
  ) {
    this.adapters = new Map([
      [selldo.provider, selldo as CrmAdapter],
      [leadsquared.provider, leadsquared as CrmAdapter],
      [privyr.provider, privyr as CrmAdapter],
    ]);
  }

  // ── Connection management ────────────────────

  async connect(
    businessId: string,
    provider: RealtyIntegrationProvider,
    config: Record<string, unknown>,
  ): Promise<CrmConnectionStatus> {
    const adapter = this.mustAdapter(provider);
    const verify = await adapter.verify(config);
    if (!verify.ok) {
      throw new BadRequestException(verify.error ?? 'Invalid CRM credentials');
    }
    const conn = await this.repository.upsertConnection(businessId, provider, {
      status: 'CONNECTED',
      config,
      lastError: null,
    });
    this.emit<RealtyIntegrationConnectedEvent>('realty.integration.connected', {
      ...this.base(businessId),
      type: 'realty.integration.connected',
      provider,
      connectionId: conn.id,
    });
    this.logger.log(`CRM ${provider} connected for business ${businessId}`);
    return this.toStatus(conn);
  }

  async disconnect(
    businessId: string,
    provider: RealtyIntegrationProvider,
  ): Promise<void> {
    const conn = await this.repository.findConnection(businessId, provider);
    await this.repository.softDeleteConnection(businessId, provider);
    if (conn) {
      this.emit<RealtyIntegrationDisconnectedEvent>('realty.integration.disconnected', {
        ...this.base(businessId),
        type: 'realty.integration.disconnected',
        provider,
        connectionId: conn.id,
      });
    }
  }

  async listConnections(businessId: string): Promise<CrmConnectionStatus[]> {
    const conns = await this.repository.listConnections(businessId);
    return conns
      .filter((c) => CRM_PROVIDERS.includes(c.provider))
      .map((c) => this.toStatus(c));
  }

  async testConnection(
    businessId: string,
    provider: RealtyIntegrationProvider,
  ): Promise<CrmPushResult> {
    const conn = await this.repository.findConnection(businessId, provider);
    if (!conn) return { ok: false, error: 'Not connected' };
    return this.mustAdapter(provider).verify(this.readConfig(conn));
  }

  // ── Push paths ───────────────────────────────

  /**
   * Push one lead to all of a business's connected CRMs (or a single provider).
   * The single source of truth for CRM writes — used by the event listeners and
   * the manual resync endpoint. No-op (returns empty) when the plan lacks CRM
   * sync or the business has no CRM connected.
   */
  async pushLead(
    businessId: string,
    leadId: string,
    reason: CrmPushReason,
    onlyProvider?: RealtyIntegrationProvider,
  ): Promise<CrmPushResult[]> {
    if (!(await this.billing.canUseCrmSync(businessId))) {
      this.logger.debug(`CRM sync skipped for ${businessId} — plan does not include it`);
      return [];
    }
    const connections = (await this.repository.listConnections(businessId)).filter(
      (c) =>
        c.status === 'CONNECTED' &&
        CRM_PROVIDERS.includes(c.provider) &&
        (!onlyProvider || c.provider === onlyProvider),
    );
    if (connections.length === 0) return [];

    const lead = await this.leadsService.getLead(businessId, leadId);
    const crmLead = toCrmLead(lead);
    const results: CrmPushResult[] = [];

    for (const conn of connections) {
      const adapter = this.adapters.get(conn.provider);
      if (!adapter) continue;
      const result = await adapter.push(this.readConfig(conn), crmLead, reason);
      results.push(result);
      await this.repository.recordSync(
        businessId,
        conn.id,
        result.ok ? null : result.error ?? 'push failed',
        result.ok ? 1 : 0,
      );

      if (result.ok) {
        this.emit<RealtyCrmPushedEvent>('realty.crm.pushed', {
          ...this.base(businessId),
          type: 'realty.crm.pushed',
          provider: conn.provider,
          leadId,
          externalId: result.externalId,
          reason,
        });
      } else {
        this.emit<RealtyCrmPushFailedEvent>('realty.crm.push_failed', {
          ...this.base(businessId),
          type: 'realty.crm.push_failed',
          provider: conn.provider,
          leadId,
          reason,
          error: result.error ?? 'unknown',
        });
        this.logger.warn(
          `CRM ${conn.provider} push failed for lead ${leadId} (business ${businessId}): ${result.error}`,
        );
      }
    }
    return results;
  }

  // ── Event listeners (lead lifecycle → CRM) ───

  @OnEvent('realty.lead.created')
  async onLeadCreated(event: RealtyLeadCreatedEvent): Promise<void> {
    await this.safePush(event.businessId, event.leadId, 'created');
  }

  @OnEvent('realty.lead.qualified')
  async onLeadQualified(event: RealtyLeadQualifiedEvent): Promise<void> {
    await this.safePush(event.businessId, event.leadId, 'updated');
  }

  @OnEvent('realty.lead.stage_changed')
  async onLeadStageChanged(event: RealtyLeadStageChangedEvent): Promise<void> {
    await this.safePush(event.businessId, event.leadId, 'stage_changed');
  }

  /** Event-path wrapper: a CRM error must never break lead processing. */
  private async safePush(
    businessId: string,
    leadId: string,
    reason: CrmPushReason,
  ): Promise<void> {
    try {
      await this.pushLead(businessId, leadId, reason);
    } catch (err) {
      this.logger.error(
        `CRM push (${reason}) failed for lead ${leadId} (business ${businessId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── Helpers ──────────────────────────────────

  private mustAdapter(provider: RealtyIntegrationProvider): CrmAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new BadRequestException(`Unsupported CRM provider: ${provider}`);
    }
    return adapter;
  }

  private readConfig(conn: realty_integration_connections): Record<string, unknown> {
    return (conn.config ?? {}) as Record<string, unknown>;
  }

  private toStatus(conn: realty_integration_connections): CrmConnectionStatus {
    return {
      provider: conn.provider,
      status: conn.status,
      externalRef: conn.external_ref,
      lastSyncAt: conn.last_sync_at,
      lastError: conn.last_error,
      pushedCount: conn.pushed_count,
    };
  }

  private base(businessId: string) {
    return {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
    };
  }

  private emit<T>(name: string, payload: T): void {
    this.eventEmitter.emit(name, payload);
  }
}
