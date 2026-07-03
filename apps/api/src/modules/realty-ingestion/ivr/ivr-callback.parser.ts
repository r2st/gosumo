/**
 * IVR missed-call webhook parsing (pure, unit-tested).
 *
 * Indian IVR providers (Exotel, Knowlarity, and the many white-label MyOperator
 * clones) each POST a different payload shape for a missed call. This module
 * normalizes the three common formats — plus a generic canonical shape — into a
 * single `NormalizedIvrCall` so the service layer never sees provider quirks.
 *
 * We only care about a *missed* call (caller phone + the DID/virtual number they
 * dialled): a missed call is the buyer raising their hand, and the flow answers
 * it with an instant WhatsApp greeting (blueprint §5.1).
 */

/** Canonical, provider-agnostic missed-call notification. */
export interface NormalizedIvrCall {
  /** The caller's phone, any format — normalized to E.164 downstream. */
  phone: string;
  /** The business's virtual/DID number that was dialled (attribution). */
  calledNumber?: string;
  /** ISO-8601 call time when the provider supplies one. */
  callTime?: string;
  /** Campaign / call-flow id, used as the lead sub_source. */
  campaignId?: string;
  /** Detected provider slug for provenance. */
  provider: IvrProvider;
  /** The raw payload, retained on the lead's ingest history. */
  raw: Record<string, unknown>;
}

export type IvrProvider = 'exotel' | 'knowlarity' | 'generic';

const str = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  return undefined;
};

/**
 * Parse a raw IVR webhook body into a `NormalizedIvrCall`. Returns null when no
 * caller phone can be found (nothing actionable). Provider detection is by the
 * signature fields each vendor uses, falling back to the generic shape.
 */
export function parseIvrCallback(body: unknown): NormalizedIvrCall | null {
  if (!body || typeof body !== 'object') return null;
  const p = body as Record<string, unknown>;

  // ── Exotel: CallFrom / CallTo / DateCreated / CallSid, and a `Direction` /
  //    `Status` of no-answer for a missed call. Field names are PascalCase.
  if ('CallFrom' in p || 'CallSid' in p) {
    const phone = str(p['CallFrom']);
    if (!phone) return null;
    return {
      phone,
      calledNumber: str(p['CallTo']) ?? str(p['To']),
      callTime: normalizeTime(str(p['DateCreated']) ?? str(p['StartTime'])),
      campaignId: str(p['CampaignId']) ?? str(p['CallSid']),
      provider: 'exotel',
      raw: p,
    };
  }

  // ── Knowlarity: caller_id / called_number / start_time / uuid (snake_case).
  if ('caller_id' in p || 'called_number' in p) {
    const phone = str(p['caller_id']);
    if (!phone) return null;
    return {
      phone,
      calledNumber: str(p['called_number']),
      callTime: normalizeTime(str(p['start_time'])),
      campaignId: str(p['campaign_name']) ?? str(p['uuid']),
      provider: 'knowlarity',
      raw: p,
    };
  }

  // ── Generic / canonical: { phone, calledNumber, callTime, campaignId }.
  const phone = str(p['phone']) ?? str(p['from']) ?? str(p['caller']);
  if (!phone) return null;
  return {
    phone,
    calledNumber: str(p['calledNumber']) ?? str(p['to']),
    callTime: normalizeTime(str(p['callTime'])),
    campaignId: str(p['campaignId']),
    provider: 'generic',
    raw: p,
  };
}

/**
 * Coerce a provider timestamp to an ISO-8601 string when parseable; otherwise
 * drop it (we never fabricate a call time). Providers send either ISO or
 * `YYYY-MM-DD HH:mm:ss` local strings.
 */
function normalizeTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}
