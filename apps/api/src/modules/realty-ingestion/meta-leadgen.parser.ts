/**
 * Meta Leadgen webhook parser (pure, unit-tested).
 *
 * Facebook/Instagram Lead Ads deliver a `leadgen` change on the page webhook.
 * The authoritative field data is normally fetched from the Graph API by
 * `leadgen_id`; many setups (and Meta's own test tool) also inline a
 * `field_data` array on the change value. This parser reads the inline
 * `field_data` when present and always surfaces the `leadgen_id` reference so
 * the caller can Graph-fetch later if the phone is missing.
 *
 * No I/O here — just payload → normalized candidates.
 */

export interface MetaLeadgenCandidate {
  /** Raw phone as provided by Meta (normalized to E.164 downstream). */
  phone?: string;
  name?: string;
  email?: string;
  /** Meta identifiers, retained for attribution + later Graph fetch. */
  leadgenId?: string;
  formId?: string;
  adId?: string;
  pageId?: string;
  /** The listing/project the ad pointed at (from a custom form field). */
  listingRef?: string;
  createdTime?: string;
  /** The raw change value, kept as provenance. */
  raw: Record<string, unknown>;
}

interface FieldDatum {
  name?: string;
  values?: string[];
}

// Common Meta field names (and typical custom-question labels) per slot.
const PHONE_KEYS = ['phone_number', 'phone', 'mobile', 'contact_number', 'mobile_number'];
const NAME_KEYS = ['full_name', 'name', 'first_name', 'your_name'];
const EMAIL_KEYS = ['email', 'email_address', 'work_email'];
const LISTING_KEYS = ['project', 'property', 'listing', 'project_name', 'which_project', 'interested_in'];

function firstValue(field: FieldDatum): string | undefined {
  const v = field.values;
  return Array.isArray(v) && v.length > 0 ? String(v[0]).trim() : undefined;
}

function matchKey(name: string | undefined, keys: string[]): boolean {
  if (!name) return false;
  const norm = name.toLowerCase().replace(/[\s-]+/g, '_');
  return keys.some((k) => norm === k || norm.includes(k));
}

function extractFromFieldData(fieldData: FieldDatum[]): Pick<
  MetaLeadgenCandidate,
  'phone' | 'name' | 'email' | 'listingRef'
> {
  const out: Pick<MetaLeadgenCandidate, 'phone' | 'name' | 'email' | 'listingRef'> = {};
  for (const field of fieldData) {
    const value = firstValue(field);
    if (!value) continue;
    if (!out.phone && matchKey(field.name, PHONE_KEYS)) out.phone = value;
    else if (!out.email && matchKey(field.name, EMAIL_KEYS)) out.email = value;
    else if (!out.name && matchKey(field.name, NAME_KEYS)) out.name = value;
    else if (!out.listingRef && matchKey(field.name, LISTING_KEYS)) out.listingRef = value;
  }
  return out;
}

/**
 * Parse a Meta Leadgen webhook payload into one candidate per leadgen change.
 * Returns an empty array for non-leadgen or malformed payloads (never throws).
 */
export function parseMetaLeadgen(payload: unknown): MetaLeadgenCandidate[] {
  const body = payload as { object?: string; entry?: unknown[] };
  if (!body || !Array.isArray(body.entry)) return [];

  const candidates: MetaLeadgenCandidate[] = [];
  for (const entryRaw of body.entry) {
    const entry = entryRaw as { id?: string; changes?: unknown[] };
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const changeRaw of changes) {
      const change = changeRaw as { field?: string; value?: Record<string, unknown> };
      if (change.field !== 'leadgen' || !change.value) continue;

      const value = change.value;
      const fieldData = Array.isArray(value['field_data'])
        ? (value['field_data'] as FieldDatum[])
        : [];
      const extracted = extractFromFieldData(fieldData);

      candidates.push({
        ...extracted,
        leadgenId: asString(value['leadgen_id']),
        formId: asString(value['form_id']),
        adId: asString(value['ad_id']) ?? asString(value['adgroup_id']),
        pageId: asString(value['page_id']) ?? entry.id,
        createdTime: asString(value['created_time']),
        raw: value,
      });
    }
  }
  return candidates;
}

function asString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return String(v);
}
