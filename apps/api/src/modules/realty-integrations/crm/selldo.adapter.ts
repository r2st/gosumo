import { Injectable, Logger } from '@nestjs/common';
import { RealtyIntegrationProvider } from '@prisma/client';
import {
  CrmAdapter,
  CrmLead,
  CrmPushReason,
  CrmPushResult,
  paiseToRupees,
} from './crm-adapter.interface';
import { postJson } from './crm-http';

interface SellDoConfig {
  /** Sell.Do API key (per-account). */
  apiKey?: string;
  /** Override base URL (defaults to the Sell.Do public API host). */
  baseUrl?: string;
}

/**
 * SellDoAdapter — pushes leads into Sell.Do, the most widely used Indian
 * real-estate CRM. Sell.Do's Leads API accepts a flat lead payload keyed by an
 * account API key. Budget/localities map to Sell.Do's requirement fields; the
 * push reason and BLTC snapshot are attached as a note.
 */
@Injectable()
export class SellDoAdapter extends CrmAdapter {
  readonly provider = RealtyIntegrationProvider.SELLDO;
  private readonly logger = new Logger(SellDoAdapter.name);
  private readonly defaultBaseUrl = 'https://app.sell.do/api/leads/create';

  buildPayload(lead: CrmLead, reason: CrmPushReason): Record<string, unknown> {
    const budgetMin = paiseToRupees(lead.budgetMinPaise);
    const budgetMax = paiseToRupees(lead.budgetMaxPaise);
    return {
      lead: {
        name: lead.name ?? 'GoSumo Lead',
        phone: lead.phone,
        alternate_phone: lead.altPhone ?? undefined,
        email: lead.email ?? undefined,
        // Sell.Do attribution
        source: 'GoSumo',
        sub_source: lead.source,
        campaign: lead.subSource ?? undefined,
        // Requirement (BLTC)
        requirement_type: lead.config ?? undefined,
        preferred_locations: lead.localities.join(', ') || undefined,
        budget_min: budgetMin,
        budget_max: budgetMax,
        possession_in_months: lead.timelineMonths ?? undefined,
        purpose: lead.purpose ?? undefined,
        funding: lead.financing ?? undefined,
        // State
        stage: lead.stage,
        temperature: lead.temperature,
        score: lead.qualScore,
        note: `GoSumo sync (${reason}) — ${lead.listingRef ?? 'no listing'} · score ${lead.qualScore}`,
        external_id: lead.leadId,
      },
    };
  }

  async push(
    config: Record<string, unknown>,
    lead: CrmLead,
    reason: CrmPushReason,
  ): Promise<CrmPushResult> {
    const cfg = config as SellDoConfig;
    if (!cfg.apiKey) {
      return { ok: false, error: 'Sell.Do apiKey missing' };
    }
    const url = cfg.baseUrl ?? this.defaultBaseUrl;
    try {
      const res = await postJson(url, this.buildPayload(lead, reason), {
        'X-Api-Key': cfg.apiKey,
      });
      if (!res.ok) {
        return { ok: false, error: `Sell.Do responded ${res.status}` };
      }
      const body = (res.body ?? {}) as { id?: string; lead_id?: string };
      return { ok: true, externalId: body.id ?? body.lead_id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Sell.Do push failed for lead ${lead.leadId}: ${message}`);
      return { ok: false, error: message };
    }
  }

  async verify(config: Record<string, unknown>): Promise<CrmPushResult> {
    const cfg = config as SellDoConfig;
    return cfg.apiKey
      ? { ok: true }
      : { ok: false, error: 'Sell.Do apiKey missing' };
  }
}
