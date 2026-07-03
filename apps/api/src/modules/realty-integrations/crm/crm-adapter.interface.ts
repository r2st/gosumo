import { RealtyIntegrationProvider } from '@prisma/client';
import type { LeadResponseDto } from '../../realty-leads/realty-leads.service';

/**
 * A CRM-agnostic view of a realty lead. Each adapter maps this into its
 * provider's field schema. Money is carried as integer paise (converted to
 * rupees inside the adapter, since Indian CRMs expect rupee amounts).
 */
export interface CrmLead {
  leadId: string;
  name: string | null;
  phone: string;
  altPhone: string | null;
  email: string | null;
  source: string;
  subSource: string | null;
  listingRef: string | null;
  budgetMinPaise: number | null;
  budgetMaxPaise: number | null;
  localities: string[];
  config: string | null;
  timelineMonths: number | null;
  purpose: string | null;
  financing: string | null;
  stage: string;
  temperature: string;
  qualScore: number;
}

/** Why a lead is being pushed — carried into CRM notes/activity. */
export type CrmPushReason = 'created' | 'updated' | 'stage_changed' | 'manual';

export interface CrmPushResult {
  ok: boolean;
  /** The id the CRM assigned to the lead, when it returns one. */
  externalId?: string;
  /** Human-readable error when `ok` is false. */
  error?: string;
}

/** Normalize a full lead DTO into the CRM-agnostic shape. */
export function toCrmLead(lead: LeadResponseDto): CrmLead {
  return {
    leadId: lead.id,
    name: lead.name,
    phone: lead.whatsappPhone,
    altPhone: lead.altPhone,
    email: lead.email,
    source: lead.source,
    subSource: lead.subSource,
    listingRef: lead.listingRef,
    budgetMinPaise: lead.bltc.budgetMinPaise,
    budgetMaxPaise: lead.bltc.budgetMaxPaise,
    localities: lead.bltc.localities ?? [],
    config: lead.bltc.config,
    timelineMonths: lead.bltc.timelineMonths,
    purpose: lead.bltc.purpose ?? null,
    financing: lead.bltc.financing ?? null,
    stage: lead.stage,
    temperature: lead.temperature,
    qualScore: lead.qualScore,
  };
}

/** Paise → rupees number, for CRMs that expect a rupee amount. */
export function paiseToRupees(paise: number | null | undefined): number | undefined {
  if (paise === null || paise === undefined) return undefined;
  return Math.round(paise) / 100;
}

/**
 * The contract every Indian-CRM adapter implements. `provider` keys the adapter
 * in the registry; `buildPayload` is pure (no I/O, unit-tested); `push` performs
 * the HTTP call; `verify` sanity-checks credentials for the settings UI.
 */
export abstract class CrmAdapter {
  abstract readonly provider: RealtyIntegrationProvider;

  /** Map a normalized lead into the provider's request body (pure). */
  abstract buildPayload(lead: CrmLead, reason: CrmPushReason): Record<string, unknown>;

  /** Push a lead into the CRM. Must never throw — failures are returned. */
  abstract push(
    config: Record<string, unknown>,
    lead: CrmLead,
    reason: CrmPushReason,
  ): Promise<CrmPushResult>;

  /** Validate that `config` carries usable credentials (cheap, no lead write). */
  abstract verify(config: Record<string, unknown>): Promise<CrmPushResult>;
}
