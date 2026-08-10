/**
 * Minimal JSON HTTP helper shared by the CRM adapters. Uses global `fetch`
 * (Node 20+) — no SDK dependency, consistent with the Razorpay/Stripe services.
 * Never throws on non-2xx; the caller inspects `ok`.
 */
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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
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
