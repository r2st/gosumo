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

interface LeadSquaredConfig {
  /** LeadSquared access key. */
  accessKey?: string;
  /** LeadSquared secret key. */
  secretKey?: string;
  /** Regional API host, e.g. api-in21.leadsquared.com (India DC). */
  host?: string;
}

/**
 * LeadSquaredAdapter — pushes leads into LeadSquared via the Lead.Capture
 * endpoint. LeadSquared authenticates by accessKey+secretKey query params and
 * takes an array of {Attribute, Value} pairs. Their India data centre host is
 * configurable (`host`, default `api-in21.leadsquared.com`).
 */
@Injectable()
export class LeadSquaredAdapter extends CrmAdapter {
  readonly provider = RealtyIntegrationProvider.LEADSQUARED;
  private readonly logger = new Logger(LeadSquaredAdapter.name);
  private readonly defaultHost = 'api-in21.leadsquared.com';

  buildPayload(lead: CrmLead, reason: CrmPushReason): Record<string, unknown> {
    const attrs: Array<{ Attribute: string; Value: string }> = [];
    const add = (attribute: string, value: string | number | null | undefined): void => {
      if (value === null || value === undefined || value === '') return;
      attrs.push({ Attribute: attribute, Value: String(value) });
    };
    const [firstName, ...rest] = (lead.name ?? 'DoAide Desk Lead').split(' ');
    add('FirstName', firstName);
    add('LastName', rest.join(' ') || undefined);
    add('Phone', lead.phone);
    add('Mobile', lead.altPhone ?? undefined);
    add('EmailAddress', lead.email ?? undefined);
    add('Source', 'DoAide Desk');
    add('SearchBy', lead.source);
    add('mx_Budget_Min', paiseToRupees(lead.budgetMinPaise));
    add('mx_Budget_Max', paiseToRupees(lead.budgetMaxPaise));
    add('mx_Preferred_Locality', lead.localities.join(', ') || undefined);
    add('mx_Configuration', lead.config ?? undefined);
    add('mx_Timeline_Months', lead.timelineMonths ?? undefined);
    add('mx_Purpose', lead.purpose ?? undefined);
    add('mx_Financing', lead.financing ?? undefined);
    add('mx_Lead_Stage', lead.stage);
    add('mx_Temperature', lead.temperature);
    add('Score', lead.qualScore);
    add('mx_GoSumo_Lead_Id', lead.leadId);
    add('mx_Sync_Reason', reason);
    // LeadSquared Lead.Capture takes a raw array of attribute/value pairs.
    return { attributes: attrs };
  }

  async push(
    config: Record<string, unknown>,
    lead: CrmLead,
    reason: CrmPushReason,
  ): Promise<CrmPushResult> {
    const cfg = config as LeadSquaredConfig;
    if (!cfg.accessKey || !cfg.secretKey) {
      return { ok: false, error: 'LeadSquared accessKey/secretKey missing' };
    }
    const host = cfg.host ?? this.defaultHost;
    const url = `https://${host}/v2/LeadManagement.svc/Lead.Capture?accessKey=${encodeURIComponent(
      cfg.accessKey,
    )}&secretKey=${encodeURIComponent(cfg.secretKey)}`;
    const payload = this.buildPayload(lead, reason);
    try {
      // Lead.Capture wants the bare attribute array as the request body.
      const res = await postJson(url, payload.attributes);
      if (!res.ok) {
        return { ok: false, error: `LeadSquared responded ${res.status}` };
      }
      const body = (res.body ?? {}) as { Status?: string; Message?: { Id?: string } };
      if (body.Status && body.Status !== 'Success') {
        return { ok: false, error: `LeadSquared status ${body.Status}` };
      }
      return { ok: true, externalId: body.Message?.Id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`LeadSquared push failed for lead ${lead.leadId}: ${message}`);
      return { ok: false, error: message };
    }
  }

  async verify(config: Record<string, unknown>): Promise<CrmPushResult> {
    const cfg = config as LeadSquaredConfig;
    return cfg.accessKey && cfg.secretKey
      ? { ok: true }
      : { ok: false, error: 'LeadSquared accessKey/secretKey missing' };
  }
}
