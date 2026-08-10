/**
 * Types for the Settings → API Keys surface: tenant-owned third-party
 * credentials (payments, messaging, email) and GoSumo programmatic API keys.
 *
 * Secret values are write-only: the API never returns them. On read, a secret
 * field reports only whether it is `set` and its `last4` for display; the raw
 * value is sent only on save and immediately masked.
 */

export type IntegrationStatus = 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

export type IntegrationProvider = 'RAZORPAY' | 'STRIPE' | 'WHATSAPP' | 'SMS' | 'SMTP';

export interface IntegrationFieldState {
  /** A value is stored server-side for this field. */
  set: boolean;
  /** Present for non-secret fields (e.g. host, key id) — safe to echo back. */
  value?: string;
  /** Present for secret fields — last 4 chars for masked display. */
  last4?: string;
}

export interface IntegrationCredential {
  provider: IntegrationProvider;
  status: IntegrationStatus;
  configured: boolean;
  fields: Record<string, IntegrationFieldState>;
  lastTestedAt?: string;
  errorMessage?: string;
  updatedAt?: string;
}

/** Only the fields the operator filled are sent; blank secrets keep their stored value. */
export interface SaveIntegrationRequest {
  credentials: Record<string, string>;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
  latencyMs?: number;
}

// ── GoSumo programmatic API keys ────────────────────────────────────────────
export interface ApiKey {
  id: string;
  name: string;
  prefix: string; // e.g. "gs_a1b2c3d"
  last4: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
}

/**
 * Returned once on creation — `secret` is the full key, never retrievable again.
 *
 * `createdAt` / `lastUsedAt` are absent from the creation response, so they are
 * omitted rather than inherited: a caller reading `created.createdAt` would get
 * `undefined` at runtime while the type promised a string.
 */
export interface CreatedApiKey extends Omit<ApiKey, 'createdAt' | 'lastUsedAt'> {
  secret: string;
  message: string;
}
