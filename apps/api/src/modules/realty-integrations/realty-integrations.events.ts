import type { BaseEvent } from '@gosumo/shared';
import type { RealtyIntegrationProvider, RealtyEoiStatus } from '@prisma/client';

/**
 * Domain events emitted by the realty-integrations module. Kept local to the
 * module (not in @gosumo/shared) — they are internal-facing integration signals,
 * consumed by analytics/notifications listeners, not part of the messaging spine.
 */

// ── Integration connection lifecycle ─────────────

export interface RealtyIntegrationConnectedEvent extends BaseEvent {
  readonly type: 'realty.integration.connected';
  provider: RealtyIntegrationProvider;
  connectionId: string;
}

export interface RealtyIntegrationDisconnectedEvent extends BaseEvent {
  readonly type: 'realty.integration.disconnected';
  provider: RealtyIntegrationProvider;
  connectionId: string;
}

// ── Google Sheets export ─────────────────────────

export interface RealtySheetsExportedEvent extends BaseEvent {
  readonly type: 'realty.sheets.exported';
  connectionId: string;
  spreadsheetId: string;
  leadsExported: number;
  unitsExported: number;
  /** Whether this run was the scheduled nightly sweep vs an on-demand export. */
  scheduled: boolean;
}

// ── CRM push ─────────────────────────────────────

export interface RealtyCrmPushedEvent extends BaseEvent {
  readonly type: 'realty.crm.pushed';
  provider: RealtyIntegrationProvider;
  leadId: string;
  /** The id the CRM assigned to the pushed lead, when it returns one. */
  externalId?: string;
  /** What triggered the push: 'created' | 'updated' | 'stage_changed' | 'manual'. */
  reason: string;
}

export interface RealtyCrmPushFailedEvent extends BaseEvent {
  readonly type: 'realty.crm.push_failed';
  provider: RealtyIntegrationProvider;
  leadId: string;
  reason: string;
  error: string;
}

// ── EOI (Expression of Interest / टोकन) payment flow ──

export interface RealtyEoiRequestedEvent extends BaseEvent {
  readonly type: 'realty.eoi.requested';
  eoiId: string;
  leadId: string;
  amountPaise: number;
}

export interface RealtyEoiApprovedEvent extends BaseEvent {
  readonly type: 'realty.eoi.approved';
  eoiId: string;
  leadId: string;
  paymentLinkId: string;
  paymentLinkUrl: string;
}

export interface RealtyEoiRejectedEvent extends BaseEvent {
  readonly type: 'realty.eoi.rejected';
  eoiId: string;
  leadId: string;
  reason: string;
}

export interface RealtyEoiStatusChangedEvent extends BaseEvent {
  readonly type: 'realty.eoi.status_changed';
  eoiId: string;
  leadId: string;
  fromStatus: RealtyEoiStatus;
  toStatus: RealtyEoiStatus;
}

export interface RealtyEoiPaidEvent extends BaseEvent {
  readonly type: 'realty.eoi.paid';
  eoiId: string;
  leadId: string;
  amountPaise: number;
  gatewayPaymentId?: string;
}
