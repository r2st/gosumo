/**
 * Minimal JSON HTTP helper shared by the CRM adapters. No SDK dependency,
 * consistent with the Razorpay/Stripe services. Never throws on non-2xx; the
 * caller inspects `ok`.
 *
 * These URLs are the least trustworthy in the platform: the destination is a
 * tenant-configured webhook on a host GoSumo does not run, reached from a
 * BullMQ worker. A host that accepts the connection and then stalls would hold
 * a concurrency slot indefinitely, so the deadline is not optional here.
 */
import { fetchWithTimeout } from '../../../common/utils/http-timeout.util';

export interface JsonHttpResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonHttpResponse> {
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    { service: 'CRM webhook' },
  );
  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { ok: res.ok, status: res.status, body: parsed };
}
