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

interface PrivyrConfig {
  /**
   * The per-user Privyr inbound webhook URL. Privyr (a WhatsApp-first CRM popular
   * with Indian brokers) ingests leads by POSTing a flat JSON body to a unique
   * "Instant Leads" webhook the broker copies from their Privyr app.
   */
  webhookUrl?: string;
}

/**
 * PrivyrAdapter — pushes leads into Privyr via its Instant-Leads inbound
 * webhook. Privyr expects a flat contact-shaped JSON body; a `remarks` field
 * carries the BLTC snapshot the broker sees on their phone.
 */
@Injectable()
export class PrivyrAdapter extends CrmAdapter {
  readonly provider = RealtyIntegrationProvider.PRIVYR;
  private readonly logger = new Logger(PrivyrAdapter.name);

  buildPayload(lead: CrmLead, reason: CrmPushReason): Record<string, unknown> {
    const budgetMin = paiseToRupees(lead.budgetMinPaise);
    const budgetMax = paiseToRupees(lead.budgetMaxPaise);
    const budget =
      budgetMin || budgetMax
        ? `₹${budgetMin ?? '?'}–₹${budgetMax ?? '?'}`
        : 'Not set';
    const remarks = [
      `Source: ${lead.source}`,
      `Stage: ${lead.stage} (${lead.temperature}, score ${lead.qualScore})`,
      `Budget: ${budget}`,
      lead.config ? `Config: ${lead.config}` : null,
      lead.localities.length ? `Localities: ${lead.localities.join(', ')}` : null,
      lead.timelineMonths ? `Timeline: ${lead.timelineMonths} months` : null,
      lead.listingRef ? `Listing: ${lead.listingRef}` : null,
      `DoAide Desk sync: ${reason}`,
    ]
      .filter(Boolean)
      .join('\n');
    return {
      name: lead.name ?? 'DoAide Desk Lead',
      phone_number: lead.phone,
      email: lead.email ?? undefined,
      source: 'DoAide Desk',
      remarks,
      external_id: lead.leadId,
    };
  }

  async push(
    config: Record<string, unknown>,
    lead: CrmLead,
    reason: CrmPushReason,
  ): Promise<CrmPushResult> {
    const cfg = config as PrivyrConfig;
    if (!cfg.webhookUrl) {
      return { ok: false, error: 'Privyr webhookUrl missing' };
    }
    try {
      const res = await postJson(cfg.webhookUrl, this.buildPayload(lead, reason));
      if (!res.ok) {
        return { ok: false, error: `Privyr responded ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Privyr push failed for lead ${lead.leadId}: ${message}`);
      return { ok: false, error: message };
    }
  }

  async verify(config: Record<string, unknown>): Promise<CrmPushResult> {
    const cfg = config as PrivyrConfig;
    if (!cfg.webhookUrl) {
      return { ok: false, error: 'Privyr webhookUrl missing' };
    }
    // A bare structural check — Privyr webhook URLs are https and Privyr-hosted.
    return /^https:\/\//.test(cfg.webhookUrl)
      ? { ok: true }
      : { ok: false, error: 'Privyr webhookUrl must be https' };
  }
}
