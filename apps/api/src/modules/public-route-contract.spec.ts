/**
 * Codebase-wide `@Public()` route ratchet.
 *
 * `JwtAuthGuard` is global (`APP_GUARD`), so every route in this API is
 * authenticated except the ones that opt out with `@Public()`. That decorator
 * is one line, it can be attached to a whole controller, and nothing about
 * adding it looks dangerous in review — which makes the set of routes reachable
 * without a token the single easiest thing in this codebase to grow by
 * accident.
 *
 * `controller-contract.spec.ts` already covers the five raw-body webhook
 * handlers. This file covers the rest of the surface, and closes the ratchet:
 * the set of public handlers must match `PUBLIC_ROUTES` **exactly**. A new
 * `@Public()` route fails this file until someone writes down how it
 * authenticates; a route that stops being public fails it too, so the
 * justifications cannot outlive the code they describe.
 *
 * Being on the list is not a waiver. Every entry names a `mechanism`, and each
 * mechanism carries a structural assertion checked against the handler's own
 * source:
 *
 *   - `hmac-signature`     — reads the raw body and a signature header, and
 *                            hands both to a verifier. Root rule #3.
 *   - `provider-challenge` — the GET half of a webhook handshake; answers only
 *                            when a configured verify token matches.
 *   - `shared-secret`      — compares a configured secret from a header.
 *   - `signed-oauth-state` — trusts `state` only after HMAC verification.
 *   - `provider-redirect`  — hands off to Passport; no tenant data is touched.
 *   - `credential-exchange`— the body carries the credential being checked;
 *                            this *is* the authentication endpoint.
 *   - `anonymous-by-design`— genuinely unauthenticated, and documented as such.
 *
 * The one invariant that applies to all of them regardless of mechanism is
 * asserted separately below: **a public route may not take `@TenantId()`**.
 * `TenantInterceptor` skips public routes, so the decorator would resolve to
 * `undefined` and every downstream query would silently lose its tenant filter.
 */

import * as fs from 'fs';
import * as path from 'path';

import { PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../common/interceptors/tenant.interceptor';

// ─────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────

type ControllerClass = new (...args: never[]) => object;

interface DiscoveredController {
  file: string;
  name: string;
  cls: ControllerClass;
  handlers: string[];
}

function findControllerFiles(root: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) findControllerFiles(full, out);
    else if (entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

function discoverControllers(): DiscoveredController[] {
  const modulesRoot = __dirname;
  const found: DiscoveredController[] = [];

  for (const file of findControllerFiles(modulesRoot)) {
    const mod = require(file) as Record<string, unknown>;

    for (const [name, exported] of Object.entries(mod)) {
      if (typeof exported !== 'function' || !name.endsWith('Controller')) continue;
      if (Reflect.getMetadata(PATH_METADATA, exported) === undefined) continue;

      const proto = exported.prototype as Record<string, unknown>;
      const handlers = Object.getOwnPropertyNames(proto).filter((m) => {
        if (m === 'constructor') return false;
        const fn = proto[m];
        return typeof fn === 'function' && Reflect.getMetadata(PATH_METADATA, fn) !== undefined;
      });

      if (handlers.length === 0) continue;
      found.push({ file, name, cls: exported as ControllerClass, handlers });
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

const CONTROLLERS = discoverControllers();

/** True when `@Public()` sits on the handler or on its controller. */
function isPublicHandler(controller: DiscoveredController, handler: string): boolean {
  const fn = (controller.cls.prototype as Record<string, unknown>)[handler];
  return (
    Reflect.getMetadata(IS_PUBLIC_KEY, fn as object) === true ||
    Reflect.getMetadata(IS_PUBLIC_KEY, controller.cls) === true
  );
}

const DISCOVERED_PUBLIC: string[] = CONTROLLERS.flatMap((c) =>
  c.handlers.filter((h) => isPublicHandler(c, h)).map((h) => `${c.name}.${h}`),
).sort();

// ─────────────────────────────────────────────
// Handler source extraction
// ─────────────────────────────────────────────

/**
 * The TypeScript source of one handler: its decorator block, its signature, and
 * its body.
 *
 * The mechanism assertions below are about things that live in the *decorators*
 * as much as the body — which header the signature arrives in, whether
 * `@TenantId()` is present — and parameter decorators are emitted by TypeScript
 * outside the method, so `fn.toString()` cannot see them. Reading the file is
 * the only way to judge the whole declaration.
 */
function handlerSource(file: string, handler: string): string {
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  const declIndex = lines.findIndex((line) =>
    new RegExp(`^\\s{2}(?:public\\s+|private\\s+)?(?:async\\s+)?${handler}\\s*\\(`).test(line),
  );
  if (declIndex === -1) {
    throw new Error(`Could not locate handler ${handler} in ${file}`);
  }

  // Walk back over the decorator/comment block that belongs to this handler.
  let start = declIndex;
  while (start > 0) {
    const prev = (lines[start - 1] ?? '').trim();
    if (prev === '') break;
    if (
      prev.startsWith('@') ||
      prev.startsWith('//') ||
      prev.startsWith('*') ||
      prev.startsWith('/*') ||
      // A decorator argument list wrapped onto its own lines.
      prev.startsWith(')') ||
      prev.endsWith(',') ||
      prev.endsWith('({') ||
      prev.endsWith('(')
    ) {
      start -= 1;
      continue;
    }
    break;
  }

  // Walk forward to the closing brace of the method body.
  let depth = 0;
  let seenBody = false;
  let end = declIndex;
  for (; end < lines.length; end += 1) {
    for (const ch of lines[end] ?? '') {
      if (ch === '{') {
        depth += 1;
        seenBody = true;
      } else if (ch === '}') depth -= 1;
    }
    if (seenBody && depth === 0) break;
  }

  return lines.slice(start, end + 1).join('\n');
}

// ─────────────────────────────────────────────
// The allowlist
// ─────────────────────────────────────────────

type Mechanism =
  | 'hmac-signature'
  | 'provider-challenge'
  | 'shared-secret'
  | 'signed-oauth-state'
  | 'provider-redirect'
  | 'credential-exchange'
  | 'anonymous-by-design';

interface PublicRoute {
  /** `Controller.handler`, matching `DISCOVERED_PUBLIC`. */
  handler: string;
  mechanism: Mechanism;
  /** How this route establishes who is calling, and why that is sufficient. */
  authenticates: string;
}

/**
 * Every route in this API reachable without a JWT.
 *
 * Adding an entry is a deliberate act: it says "this route is safe to expose to
 * the internet, and here is what stands in for the token". Removing `@Public()`
 * from a route means removing its entry.
 */
const PUBLIC_ROUTES: PublicRoute[] = [
  // ── Authentication endpoints ──────────────────────────────
  // These *are* the front door. They cannot require a token, because issuing
  // one is what they do. What makes them safe is that each either verifies a
  // credential the caller supplied, or discloses nothing on failure.
  {
    handler: 'AuthController.register',
    mechanism: 'credential-exchange',
    authenticates:
      'Creates a new business + owner from the request body. No existing tenant is read or written, so there is nothing to scope; duplicate-email handling lives in AuthService.',
  },
  {
    handler: 'AuthController.login',
    mechanism: 'credential-exchange',
    authenticates:
      'Verifies the bcrypt password hash for the supplied email and issues the JWT that every other route requires.',
  },
  {
    handler: 'AuthController.refresh',
    mechanism: 'credential-exchange',
    authenticates:
      'The refresh token in the body is itself the credential — looked up and validated server-side before a new access token is issued.',
  },
  {
    handler: 'AuthController.googleAuth',
    mechanism: 'provider-redirect',
    authenticates:
      'Passport intercepts the request and redirects to Google; the handler body never runs and touches no tenant data.',
  },
  {
    handler: 'AuthController.googleCallback',
    mechanism: 'provider-redirect',
    authenticates:
      'Passport validates the Google authorization code and populates request.user before the handler runs; the handler only mints tokens for that verified identity.',
  },
  {
    handler: 'AuthController.forgotPassword',
    mechanism: 'credential-exchange',
    authenticates:
      'Unauthenticated by necessity — the caller has lost their credential. Answers identically whether or not the email exists, so it discloses no account state.',
  },
  {
    handler: 'AuthController.resetPassword',
    mechanism: 'credential-exchange',
    authenticates:
      'The single-use reset token in the body is the credential; it is looked up, expiry-checked and consumed server-side.',
  },

  // ── Channel webhooks (class-level @Public on ChannelAdapterController) ──
  {
    handler: 'ChannelAdapterController.handleWhatsAppVerification',
    mechanism: 'provider-challenge',
    authenticates:
      "Meta's GET handshake. Echoes hub.challenge only when hub.verify_token matches the configured token, and 403s otherwise.",
  },
  {
    handler: 'ChannelAdapterController.handleWhatsAppWebhook',
    mechanism: 'hmac-signature',
    authenticates:
      'HMAC-SHA256 over the raw body against the app secret, compared with the x-hub-signature-256 header before anything is read from the payload.',
  },
  {
    handler: 'ChannelAdapterController.handleInstagramVerification',
    mechanism: 'provider-challenge',
    authenticates:
      "Meta's GET handshake for the Instagram app, same verify-token comparison as WhatsApp.",
  },
  {
    handler: 'ChannelAdapterController.handleInstagramWebhook',
    mechanism: 'hmac-signature',
    authenticates:
      'HMAC-SHA256 over the raw body against the Instagram app secret via the x-hub-signature-256 header.',
  },
  {
    handler: 'ChannelAdapterController.handleGenericWebhook',
    mechanism: 'hmac-signature',
    authenticates:
      'Delegates to the adapter registered for the :channel segment, which verifies that provider\'s signature over the raw body. Unknown channels are rejected before any processing.',
  },

  // ── Payment gateway webhooks ──────────────────────────────
  {
    handler: 'PaymentController.handleRazorpayWebhook',
    mechanism: 'hmac-signature',
    authenticates:
      'Forwards the raw body and x-razorpay-signature to PaymentService, which HMACs the body with the webhook secret and rejects a mismatch.',
  },
  {
    handler: 'PaymentController.handleStripeWebhook',
    mechanism: 'hmac-signature',
    authenticates:
      'Forwards the raw body and the stripe-signature header to PaymentService for signed-payload verification.',
  },
  {
    handler: 'RealtyEoiController.webhook',
    mechanism: 'hmac-signature',
    authenticates:
      'Razorpay payment_link.paid callback. Rejects a missing x-razorpay-signature outright, then HMAC-verifies the raw body in EoiService.',
  },

  // ── Realty ingestion webhooks ─────────────────────────────
  {
    handler: 'RealtyIngestionController.handleIvrCallback',
    mechanism: 'hmac-signature',
    authenticates:
      'RealtyIvrService.verifyIvrSignature HMACs the raw body against the IVR shared secret; an unverified call is logged and discarded (still 200, to avoid a provider retry storm).',
  },
  {
    handler: 'RealtyIngestionController.handleLeadgenVerification',
    mechanism: 'provider-challenge',
    authenticates:
      "Meta Leadgen's GET handshake — resolveMetaChallenge echoes the challenge only on a verify-token match, else 403.",
  },
  {
    handler: 'RealtyIngestionController.handleLeadgenWebhook',
    mechanism: 'hmac-signature',
    authenticates:
      'verifyMetaSignature HMACs the raw body against the app secret before any lead is ingested.',
  },
  {
    handler: 'RealtyIngestionController.handlePortalEmail',
    mechanism: 'shared-secret',
    authenticates:
      'Compares the x-portal-token header against REALTY_PORTAL_INGEST_TOKEN. With no token configured it fails closed in production (401) and only warns outside it.',
  },

  // ── OAuth callback ────────────────────────────────────────
  {
    handler: 'RealtySheetsController.callback',
    mechanism: 'signed-oauth-state',
    authenticates:
      'The browser arrives from Google with no session of ours. The tenant comes from the `state` parameter, which is an HMAC-signed, expiring token minted by the authenticated /connect route — never a raw businessId.',
  },

  // ── Deliberately anonymous ────────────────────────────────
  {
    handler: 'ChannelsController.getWebChatEmbed',
    mechanism: 'anonymous-by-design',
    authenticates:
      'Serves the web-chat embed snippet to arbitrary third-party websites, so it cannot require a token. The channelId is the only input and the service looks the tenant up from it; the response carries embed configuration only, never conversation or customer data.',
  },
];

const ALLOWLISTED = PUBLIC_ROUTES.map((r) => r.handler).sort();

function routeFor(handler: string): PublicRoute {
  const entry = PUBLIC_ROUTES.find((r) => r.handler === handler);
  if (!entry) throw new Error(`No allowlist entry for ${handler}`);
  return entry;
}

function sourceFor(handler: string): string {
  const [controllerName, handlerName] = handler.split('.') as [string, string];
  const controller = CONTROLLERS.find((c) => c.name === controllerName);
  if (!controller) throw new Error(`Controller ${controllerName} was not discovered`);
  return handlerSource(controller.file, handlerName);
}

// ─────────────────────────────────────────────
// The ratchet
// ─────────────────────────────────────────────

describe('Every unauthenticated route is on the allowlist', () => {
  it('discovers a public surface at all', () => {
    // Without this floor a broken walk would make every case below vacuous.
    expect(CONTROLLERS.length).toBeGreaterThan(30);
    expect(DISCOVERED_PUBLIC.length).toBeGreaterThan(15);
  });

  it('matches the allowlist exactly', () => {
    // The whole point of the file. A new @Public() route lands here with no
    // entry and fails; a route that stops being public leaves a stale entry
    // behind and also fails. Either way someone has to look.
    expect(DISCOVERED_PUBLIC).toEqual(ALLOWLISTED);
  });

  it('states an authentication mechanism for every entry', () => {
    for (const route of PUBLIC_ROUTES) {
      // A one-word justification is not a justification.
      expect(route.authenticates.length).toBeGreaterThan(40);
    }
  });

  it('has no duplicate entries', () => {
    expect(new Set(ALLOWLISTED).size).toBe(ALLOWLISTED.length);
  });
});

// ─────────────────────────────────────────────
// The invariant that holds regardless of mechanism
// ─────────────────────────────────────────────

describe('Public routes never take @TenantId()', () => {
  it.each(PUBLIC_ROUTES.map((r) => [r.handler] as const))(
    '%s resolves its tenant without the interceptor',
    (handler) => {
      const src = sourceFor(handler);

      // TenantInterceptor returns early for public routes, so `request.businessId`
      // is never set and `@TenantId()` resolves to undefined. A repository then
      // runs `where: { business_id: undefined }` — which Prisma drops from the
      // predicate entirely, turning a scoped read into a cross-tenant one.
      expect(src).not.toMatch(/@TenantId\(\)/);
    },
  );
});

// ─────────────────────────────────────────────
// Per-mechanism structural assertions
// ─────────────────────────────────────────────

const BY_MECHANISM = (m: Mechanism): string[] =>
  PUBLIC_ROUTES.filter((r) => r.mechanism === m).map((r) => r.handler);

describe('hmac-signature routes reach a verifier with the bytes the provider signed', () => {
  const CASES = BY_MECHANISM('hmac-signature');

  it('covers the payment and inbound-message webhooks', () => {
    // Root rule #3 applies to every inbound webhook; if this set shrinks,
    // a webhook has changed its story about how it authenticates.
    expect(CASES.length).toBeGreaterThanOrEqual(8);
  });

  /**
   * Two shapes are in use, and both are legitimate:
   *
   *   - *direct* — the handler names the provider's signature header and pulls
   *     `req.rawBody` itself, then hands both to a verifier
   *     (`PaymentController.handleRazorpayWebhook`, the realty webhooks).
   *   - *delegated* — the handler packages the whole request into a
   *     `RawRequest` via `buildRawRequest` and the channel adapter picks out
   *     whichever header its provider signs
   *     (`ChannelAdapterController.*`). Different providers sign different
   *     headers, so the route cannot name one.
   *
   * What must be true either way is that a verifier ends up holding the raw
   * bytes. `buildRawRequestThreadsTheRawBody` below pins the delegated half.
   */
  const isDelegated = (src: string): boolean => /buildRawRequest\(\s*req,/.test(src);

  it.each(CASES)('%s identifies the signature it is checking', (handler) => {
    const src = sourceFor(handler);
    if (isDelegated(src)) {
      // Forwards every header to the adapter, which selects its own.
      expect(src).toMatch(/@Headers\(\)\s*headers:\s*Record<string, string>/);
      return;
    }
    // The header name varies by provider (x-hub-signature-256, x-razorpay-
    // signature, stripe-signature, x-ivr-signature), so match the shape.
    expect(src).toMatch(/@Headers\(\s*['"][a-z0-9-]*signature[a-z0-9-]*['"]\s*\)/i);
  });

  it.each(CASES)('%s verifies against the raw body, not the parsed one', (handler) => {
    const src = sourceFor(handler);
    // HMAC over `JSON.stringify(req.body)` is not the bytes the provider
    // signed — key order and whitespace differ — so a parsed-body check either
    // fails constantly or, worse, is written to pass by not checking.
    expect(src).toMatch(/rawBody|buildRawRequest\(\s*req,/);
  });

  it('buildRawRequest threads the raw body through to the adapter', () => {
    // The delegated handlers above are only as good as this helper. If it ever
    // stopped carrying `rawBody`, every channel adapter would fall back to
    // whatever fail-closed path it has for a missing body — and the exemption
    // granted to those handlers would be hollow.
    const src = handlerSource(
      path.join(__dirname, 'channel-adapter', 'channel-adapter.controller.ts'),
      'buildRawRequest',
    );
    expect(src).toMatch(/rawBody\s*=\s*\(req as Request & \{ rawBody\?: Buffer \}\)\.rawBody/);
    expect(src).toMatch(/rawBody,/);
    // Header lookup in the adapters is lower-case; Express preserves the case
    // the client sent, so a signature header would go missing without this.
    expect(src).toMatch(/key\.toLowerCase\(\)/);
  });
});

/**
 * Every channel adapter reachable through the `@Public()` `POST /webhooks/:channel`
 * route must actually check something.
 *
 * `handleGenericWebhook` accepts any `ChannelType` and routes to that channel's
 * adapter, so the route's security is exactly the weakest adapter's
 * `validateWebhook`. Two of them — email and web chat — used to `return true`
 * on the reasoning that their traffic arrives by another path; the generic
 * route made that reasoning false and turned both into unauthenticated write
 * paths into any tenant's inbox.
 *
 * A source scan is the right tool here: the failure mode is a method that
 * *doesn't* check, and no amount of driving an adapter with good input reveals
 * an absent check.
 */
describe('Every channel adapter authenticates its webhook', () => {
  const ADAPTER_DIR = path.join(__dirname, 'channel-adapter', 'adapters');

  const ADAPTERS = fs
    .readdirSync(ADAPTER_DIR)
    .filter((f) => f.endsWith('.adapter.ts') && !f.endsWith('.spec.ts') && f !== 'base.adapter.ts');

  it('finds the adapters', () => {
    expect(ADAPTERS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(ADAPTERS)('%s does not accept every caller', (file) => {
    const src = handlerSource(path.join(ADAPTER_DIR, file), 'validateWebhook');

    // The exact shape that was the bug: a body that unconditionally returns
    // true. Anything reached only after a comparison is fine.
    expect(src.replace(/\s+/g, ' ')).not.toMatch(
      /validateWebhook\([^)]*\)\s*:\s*boolean\s*\{ return true; \}/,
    );
  });

  it.each(ADAPTERS)('%s fails closed when it cannot verify', (file) => {
    const src = handlerSource(path.join(ADAPTER_DIR, file), 'validateWebhook');

    // Either the adapter verifies inline (and uses the shared fail-closed
    // helper for the unconfigured case), or it delegates wholesale to
    // `verifySharedSecretSignature`, which does both.
    expect(src).toMatch(/allowUnverifiedWebhook|verifySharedSecretSignature/);
  });
});

describe('provider-challenge routes gate on the verify token', () => {
  const CASES = BY_MECHANISM('provider-challenge');

  it.each(CASES)('%s reads hub.verify_token before answering', (handler) => {
    const src = sourceFor(handler);
    expect(src).toMatch(/hub\.verify_token/);
    // The challenge must be echoed conditionally. A handler that returns
    // `hub.challenge` unconditionally hands anyone a verified webhook
    // subscription.
    expect(src).toMatch(/hub\.challenge/);
  });

  it.each(CASES)('%s can refuse', (handler) => {
    const src = sourceFor(handler);
    // FORBIDDEN / 403 on the failure path, either directly or via the service
    // returning null and the handler branching on it.
    expect(src).toMatch(/FORBIDDEN|403|null/);
  });
});

describe('shared-secret routes compare a configured secret', () => {
  const CASES = BY_MECHANISM('shared-secret');

  it.each(CASES)('%s reads its secret from config, not from a literal', (handler) => {
    const src = sourceFor(handler);
    expect(src).toMatch(/configService\.get/);
    // No secret is ever inlined; a hard-coded comparison string would be a
    // credential in the repository.
    expect(src).not.toMatch(/===\s*['"][A-Za-z0-9_-]{8,}['"]/);
  });

  it.each(CASES)('%s fails closed when the secret is unset', (handler) => {
    const src = sourceFor(handler);
    // `allowUnverifiedWebhook` is the shared fail-closed helper: it permits an
    // unverifiable request outside production only, and rejects in production.
    expect(src).toMatch(/allowUnverifiedWebhook/);
    expect(src).toMatch(/UnauthorizedException/);
  });
});

describe('signed-oauth-state routes never trust a raw state value', () => {
  const CASES = BY_MECHANISM('signed-oauth-state');

  it.each(CASES)('%s verifies state before using it as a tenant', (handler) => {
    const src = sourceFor(handler);
    // `state` is attacker-supplied on a public route. Using it directly as a
    // businessId makes the callback an unauthenticated write keyed by a value
    // anyone can type. `resolveOAuthState` is the verifying accessor — it
    // HMAC-checks and expiry-checks before returning a businessId.
    expect(src).toMatch(/resolveOAuthState|verifyOAuthState/);
    // The raw parameter must never be the tenant.
    expect(src).not.toMatch(/businessId\s*=\s*state\b/);
  });

  it.each(CASES)('%s rejects an unverifiable state', (handler) => {
    const src = sourceFor(handler);
    expect(src).toMatch(/UnauthorizedException|BadRequestException|throw/);
  });
});

describe('credential-exchange routes carry their credential in the body', () => {
  const CASES = BY_MECHANISM('credential-exchange');

  it.each(CASES)('%s takes a validated DTO or a named credential', (handler) => {
    const src = sourceFor(handler);
    // Either a class-validated DTO, or an explicitly named single field
    // (`@Body('refreshToken')`). What must not appear is an untyped body on an
    // unauthenticated route.
    expect(src).toMatch(/@Body\(\s*['"][a-zA-Z]+['"]\s*\)|@Body\(\)\s*\w+:\s*\w+Dto/);
  });
});

describe('anonymous-by-design routes are held to a short list', () => {
  it('has not grown', () => {
    const anonymous = BY_MECHANISM('anonymous-by-design');
    // Every other mechanism above proves something about the caller. These
    // prove nothing, so the only control left is that there are almost none of
    // them and each is argued individually in PUBLIC_ROUTES.
    expect(anonymous).toEqual(['ChannelsController.getWebChatEmbed']);
  });
});
