/**
 * Property-portal enquiry email parser (pure, unit-tested).
 *
 * 99acres, MagicBricks and Housing.com forward buyer enquiries as templated
 * emails. This parser detects the portal from the sender/subject and extracts
 * the buyer's name, phone, email, and the property/listing they enquired about
 * using label + regex patterns tolerant of each portal's layout.
 *
 * No I/O — just the raw email fields → a normalized candidate (or null).
 */

import { RealtyPortal } from '@gosumo/shared';

export interface PortalEmailInput {
  from?: string;
  subject?: string;
  /** Plain-text body (preferred). HTML is stripped if that's all we get. */
  text?: string;
  html?: string;
}

export interface PortalEmailCandidate {
  portal: RealtyPortal;
  name?: string;
  phone?: string;
  email?: string;
  listingRef?: string;
  raw: Record<string, unknown>;
}

const PORTAL_DOMAINS: Array<{ portal: RealtyPortal; match: RegExp }> = [
  { portal: RealtyPortal.NINETYNINE_ACRES, match: /99acres/i },
  { portal: RealtyPortal.MAGICBRICKS, match: /magicbricks/i },
  { portal: RealtyPortal.HOUSING, match: /housing\.com|housing/i },
];

/** Indian 10-digit mobile, optionally with +91/0 prefix and separators. */
const PHONE_RE = /(?:\+?91[\s-]?|0)?([6-9]\d{4}[\s-]?\d{5})/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

// Label patterns tried in order; first hit wins. Tolerant of ":" / "-" and case.
const NAME_LABELS = [/name\s*[:-]\s*([^\n\r]+)/i, /from\s*[:-]\s*([A-Za-z][^\n\r<]+)/i];
const PHONE_LABELS = [/(?:phone|mobile|contact)\s*(?:no\.?|number)?\s*[:-]\s*([^\n\r]+)/i];
const EMAIL_LABELS = [/e-?mail\s*(?:id)?\s*[:-]\s*([^\n\r]+)/i];
const LISTING_LABELS = [
  /(?:property|project|listing|regarding|enquiry for|interested in)\s*[:-]\s*([^\n\r]+)/i,
];

function detectPortal(input: PortalEmailInput): RealtyPortal {
  const haystack = `${input.from ?? ''} ${input.subject ?? ''}`;
  for (const { portal, match } of PORTAL_DOMAINS) {
    if (match.test(haystack)) return portal;
  }
  return RealtyPortal.UNKNOWN;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ');
}

function firstLabelMatch(body: string, labels: RegExp[]): string | undefined {
  for (const re of labels) {
    const m = body.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return undefined;
}

/**
 * Parse a portal enquiry email. Returns null when no phone can be recovered
 * (a lead with no reachable contact is useless). Attribution is always set —
 * an unrecognised template still ingests as `PORTAL` / `UNKNOWN`.
 */
export function parsePortalEmail(input: PortalEmailInput): PortalEmailCandidate | null {
  const portal = detectPortal(input);
  const body = input.text?.trim() || (input.html ? stripHtml(input.html) : '');
  if (!body) return null;

  // Phone: prefer a labelled value, else the first phone-shaped token in body.
  let phone = firstLabelMatch(body, PHONE_LABELS);
  if (phone) {
    const m = phone.match(PHONE_RE);
    phone = m ? m[0] : phone;
  } else {
    const m = body.match(PHONE_RE);
    phone = m ? m[0] : undefined;
  }
  if (!phone) return null;

  let email = firstLabelMatch(body, EMAIL_LABELS);
  if (email) {
    const m = email.match(EMAIL_RE);
    email = m ? m[0] : undefined;
  } else {
    const m = body.match(EMAIL_RE);
    email = m ? m[0] : undefined;
  }

  const name = firstLabelMatch(body, NAME_LABELS);
  const listingRef =
    firstLabelMatch(body, LISTING_LABELS) ??
    (input.subject ? input.subject.trim() : undefined);

  return {
    portal,
    name,
    phone,
    email,
    listingRef,
    raw: { from: input.from, subject: input.subject },
  };
}
