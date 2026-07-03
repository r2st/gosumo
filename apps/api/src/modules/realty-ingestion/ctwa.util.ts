/**
 * Click-to-WhatsApp (CTWA) context attachment (pure, unit-tested).
 *
 * When a buyer taps a WhatsApp ad, Meta attaches a `referral` object to the
 * first inbound message describing the originating ad (source_url, source_id,
 * headline, ctwa_clid, body). This turns that referral into a normalized lead
 * candidate so the ad's listing/campaign is captured as attribution the moment
 * the conversation starts (blueprint §15).
 */

import type { LeadIngestCandidate } from '@gosumo/shared';
import { LeadSource } from '@gosumo/shared';

/** The `referral` block Meta sends on a CTWA-originated WhatsApp message. */
export interface WhatsAppReferral {
  source_url?: string;
  source_id?: string;
  source_type?: string;
  headline?: string;
  body?: string;
  ctwa_clid?: string;
  media_type?: string;
}

export interface CtwaInput {
  /** Sender WhatsApp phone (E.164 normalized downstream). */
  phone: string;
  name?: string;
  referral?: WhatsAppReferral;
  conversationId?: string;
  clientId?: string;
}

/**
 * Build a CTWA lead candidate. Returns null without a phone. When no referral
 * is present it still produces a CTWA candidate (a plain click-to-chat), just
 * without ad attribution — `sub_source`/`listing_ref` stay undefined.
 */
export function parseCtwaReferral(input: CtwaInput): LeadIngestCandidate | null {
  if (!input.phone) return null;

  const ref = input.referral;
  const subSource = ref?.headline || ref?.source_id || ref?.source_type || undefined;
  // Prefer the ad's landing URL, else the click id, as the listing reference.
  const listingRef = ref?.source_url || ref?.ctwa_clid || undefined;

  return {
    whatsappPhone: input.phone,
    source: LeadSource.CTWA,
    subSource,
    listingRef,
    name: input.name,
    conversationId: input.conversationId,
    clientId: input.clientId,
    raw: ref ? { referral: ref } : undefined,
  };
}
