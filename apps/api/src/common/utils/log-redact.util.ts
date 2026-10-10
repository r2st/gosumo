/**
 * Masking for the personal data that ends up in log lines.
 *
 * Logs are the copy of your data with the weakest access controls in the
 * system: they are retained long after the row is gone, shipped to wherever
 * the journal is aggregated, and read by anyone debugging anything. So an
 * email address written into a log line has quietly become a second, sprawling
 * store of personal data — one that no retention sweep, no consent withdrawal,
 * and no erasure request touches.
 *
 * That matters here specifically. This app runs a DPDPA retention sweep over
 * `messages` and `clients`, and a customer who exercises erasure gets their
 * rows deleted while `Login: someone@example.com` and `IVR greeting to
 * +919876543210` stay in the journal indefinitely.
 *
 * These helpers keep the part an operator actually debugs with — the domain,
 * the last four digits, enough to correlate two lines about the same person —
 * and drop the part that identifies them. The rule of thumb: a log line should
 * let you follow a user through a request, not look them up.
 *
 * Nothing here is a substitute for the real identifier. Where an operator
 * genuinely needs to find the record, log the id (`user 4f3c…`, `businessId`)
 * — an internal handle that means nothing outside the database.
 */

/** What a fully-unusable value renders as, so a log line never reads `undefined`. */
const REDACTED = '[redacted]';

/**
 * `s****@example.com` — first character and domain kept.
 *
 * The domain survives on purpose: "twenty failed logins, all @somecorp.com" is
 * an operational signal, and it identifies an organisation rather than a
 * person. The local part is what names the individual, so all but its first
 * character goes.
 */
export function maskEmail(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return REDACTED;

  const at = value.lastIndexOf('@');
  // No `@` means this is not an address; masking it as one would imply a
  // structure that is not there, so it is treated as an opaque secret.
  if (at <= 0) return REDACTED;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (domain.length === 0) return REDACTED;

  // A single-character local part has nothing to mask beyond itself; it still
  // gets stars so the shape of the output never varies by input length in a
  // way that leaks it.
  return `${local[0]}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/**
 * `+9198****3210` — country/prefix and last four kept.
 *
 * Last four is the convention every support flow already uses to confirm "is
 * this the same number", and four digits of an Indian mobile is not a
 * reversible identifier on its own. Anything too short to mask meaningfully is
 * dropped entirely rather than half-shown.
 */
export function maskPhone(value: unknown): string {
  if (typeof value !== 'string') return REDACTED;

  const trimmed = value.trim();
  if (trimmed.length === 0) return REDACTED;

  // Count digits rather than characters: `+91 98765 43210` and `+919876543210`
  // are the same number and must mask identically.
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8) return REDACTED;

  const lead = trimmed.startsWith('+') ? '+' : '';
  return `${lead}${digits.slice(0, 4)}${'*'.repeat(Math.max(digits.length - 8, 1))}${digits.slice(-4)}`;
}

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'secret',
  'token',
  'refreshToken',
  'refresh_token',
  'accessToken',
  'access_token',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'creditCard',
  'credit_card',
  'ssn',
  'privateKey',
  'private_key',
]);

export function redactObject(
  obj: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 3) return { '[truncated]': true };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) {
      out[key] = REDACTED;
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactObject(value as Record<string, unknown>, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
}
