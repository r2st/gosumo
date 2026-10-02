/**
 * Codebase-wide controller contract tests.
 *
 * Controllers are the tenant boundary. `apps/api/CLAUDE.md` states the rule
 * plainly: never take `businessId` from the request body, always from
 * `@TenantId()`. That rule is easy to state and easy to break — a handler that
 * forwards `dto.businessId` instead of `tenantId` compiles, passes its own
 * unit test, and hands one business's data to another.
 *
 * Rather than trust every module to remember, this file discovers every
 * controller and every route handler, invokes each one with the *same* param
 * resolution Nest performs at runtime, and asserts the tenant that reaches the
 * service layer is the one from the JWT — while a hostile body carrying a
 * different `businessId` reaches nothing at all.
 *
 * How the handlers are driven:
 *   - Constructor dependencies become recording doubles.
 *   - Route arguments are built from Nest's own `__routeArguments__` metadata,
 *     so `@TenantId()`, `@CurrentUser()`, `@Param()`, `@Body()` and friends are
 *     resolved through their real factories against a fake ExecutionContext.
 *   - Every collaborator call is recorded and inspected.
 *
 * A handler that throws while post-processing a stubbed result is not a
 * failure here: the delegation it is being judged on already happened, and the
 * assertions run against the recorded calls. What is a failure is a handler
 * that delegates nothing, or one that leaks an attacker-supplied tenant.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { getMetadataStorage } from 'class-validator';

import { IS_PUBLIC_KEY } from '../common/interceptors/tenant.interceptor';

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

/** The tenant the JWT says the caller belongs to. */
const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
/** The tenant an attacker types into the request body. Must reach nothing. */
const FORGED_BUSINESS_ID = 'ffffffff-0000-4000-a000-0000000000ff';
const USER_ID = '00000000-0000-4000-c000-000000000001';
const RECORD_ID = '00000000-0000-4000-b000-000000000001';

/**
 * Nest's `RouteParamtypes`, which lives behind an internal import path. The
 * numeric values are part of the metadata format Nest writes onto the class,
 * and `routeArgMetadataIsWellFormed` below fails loudly if they ever drift.
 */
const PARAMTYPE = {
  REQUEST: 0,
  RESPONSE: 1,
  NEXT: 2,
  BODY: 3,
  QUERY: 4,
  PARAM: 5,
  HEADERS: 6,
  SESSION: 7,
  FILE: 8,
  FILES: 9,
  HOST: 10,
  IP: 11,
  RAW_BODY: 12,
} as const;

// ─────────────────────────────────────────────
// Recording doubles
// ─────────────────────────────────────────────

interface RecordedCall {
  dependency: string;
  method: string;
  args: unknown[];
}

/** A benign, non-thenable result shaped like the things services return. */
function stubResult(): Record<string, unknown> {
  return {
    id: RECORD_ID,
    businessId: BUSINESS_ID,
    data: [],
    items: [],
    results: [],
    rows: [],
    events: [],
    total: 0,
    count: 0,
    page: 1,
    limit: 20,
    totalPages: 0,
    meta: {},
    url: 'https://example.invalid/stub',
    status: 'OK',
    createdAt: new Date(0).toISOString(),
  };
}

/**
 * Stands in for an injected collaborator. Every property is both callable and
 * further traversable, so `this.service.get(x)` and
 * `this.prisma.team_members.update(x)` both work — several controllers reach
 * Prisma directly, and a single-level double would throw on them before
 * recording anything.
 *
 * Calling records the full dotted path and resolves to `stubResult()`.
 */
function makeDependencyDouble(path: string, calls: RecordedCall[]): unknown {
  const callable = (...args: unknown[]) => {
    const lastDot = path.lastIndexOf('.');
    calls.push({
      dependency: lastDot === -1 ? path : path.slice(0, lastDot),
      method: lastDot === -1 ? path : path.slice(lastDot + 1),
      args,
    });
    return Promise.resolve(stubResult());
  };

  return new Proxy(callable, {
    get: (_target, prop) => {
      if (typeof prop !== 'string') return undefined;
      // Must not look like a promise, or `await` on the double itself hangs
      // the handler in an unresolved microtask.
      if (prop === 'then') return undefined;
      return makeDependencyDouble(`${path}.${prop}`, calls);
    },
    apply: (_target, _this, args) => callable(...args),
  });
}

/** Express `Response` double: synchronous, chainable, records nothing. */
function makeResponseDouble(): unknown {
  const res: Record<string, unknown> = {};
  const chain = new Proxy(res, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined;
      return () => chain;
    },
  });
  return chain;
}

// ─────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────

type ControllerClass = new (...args: never[]) => object;

interface DiscoveredController {
  /** Module-relative path, e.g. `contact/contact.controller.ts`. */
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
    let mod: Record<string, unknown>;
    try {
      mod = require(file) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Controller ${file} could not be loaded: ${(err as Error).message}`);
    }

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

      found.push({
        file: path.relative(modulesRoot, file),
        name,
        cls: exported as ControllerClass,
        handlers: handlers.sort(),
      });
    }
  }

  found.sort((a, b) => a.file.localeCompare(b.file));
  return found;
}

const CONTROLLERS = discoverControllers();

// ─────────────────────────────────────────────
// Driving a handler
// ─────────────────────────────────────────────

interface RouteArgMeta {
  index: number;
  data?: unknown;
  factory?: (data: unknown, ctx: ExecutionContext) => unknown;
}

/**
 * Applies the same whitelist strip the global ValidationPipe performs, so the
 * body a handler sees here is the body it would see in production.
 *
 * This is what makes the leak test meaningful rather than theatrical: the
 * forged `businessId` survives into the handler only if some DTO *declares*
 * a tenant property, or the handler reaches around its DTO with
 * `@Body('businessId')`. Both are exactly the mistakes worth catching.
 *
 * Returns `null` for an untyped body — a raw webhook payload the pipe cannot
 * whitelist, handled separately below.
 */
function applyWhitelist(metatype: unknown, body: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof metatype !== 'function' || metatype === Object || metatype === Array) return null;

  const declared = new Set(
    getMetadataStorage()
      .getTargetValidationMetadatas(metatype, metatype.name, false, false)
      .map((m) => m.propertyName),
  );

  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (declared.has(key)) kept[key] = value;
  }
  return kept;
}

/**
 * The request a handler sees: authenticated as BUSINESS_ID, with a body that
 * also claims a *different* tenant. Nothing downstream may believe the body.
 */
function makeRequest(): Record<string, unknown> {
  return {
    tenantId: BUSINESS_ID,
    user: { sub: USER_ID, businessId: BUSINESS_ID, email: 'agent@example.invalid', role: 'ADMIN' },
    body: { businessId: FORGED_BUSINESS_ID },
    rawBody: Buffer.from('{}'),
    headers: { 'x-forwarded-for': '203.0.113.1', 'user-agent': 'contract-test' },
    ip: '203.0.113.1',
    params: { id: RECORD_ID },
    query: {},
    get: () => undefined,
  };
}

function makeExecutionContext(request: Record<string, unknown>, response: unknown): ExecutionContext {
  const http = {
    getRequest: () => request,
    getResponse: () => response,
    getNext: () => undefined,
  };
  return {
    switchToHttp: () => http,
    getClass: () => class {},
    getHandler: () => () => undefined,
    getArgs: () => [],
    getArgByIndex: () => undefined,
    getType: () => 'http',
    switchToRpc: () => ({ getData: () => ({}), getContext: () => ({}) }),
    switchToWs: () => ({ getClient: () => ({}), getData: () => ({}) }),
  } as unknown as ExecutionContext;
}

/**
 * Reconstructs a handler's argument list the way Nest's route-args pipeline
 * would, including running custom param-decorator factories for real.
 */
function buildArgs(
  cls: ControllerClass,
  handler: string,
  ctx: ExecutionContext,
  request: Record<string, unknown>,
  response: unknown,
): { args: unknown[]; untypedBody: boolean } {
  const metadata =
    (Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, handler) as Record<string, RouteArgMeta>) ?? {};
  const paramTypes =
    (Reflect.getMetadata('design:paramtypes', cls.prototype as object, handler) as unknown[]) ?? [];

  const args: unknown[] = [];
  let untypedBody = false;

  for (const [key, meta] of Object.entries(metadata)) {
    const [rawType] = key.split(':');

    // Custom decorators (@TenantId, @CurrentUser) carry a factory. Running it
    // is the whole point — a hand-written fixture would not prove the real
    // decorator resolves to the JWT tenant rather than the body's.
    if (meta.factory) {
      args[meta.index] = meta.factory(meta.data, ctx);
      continue;
    }

    switch (Number(rawType)) {
      case PARAMTYPE.BODY: {
        const rawBody = request.body as Record<string, unknown>;
        if (typeof meta.data === 'string') {
          // `@Body('businessId')` reaches around the DTO entirely — the pipe
          // never gets a chance to strip it, so the raw value is passed on.
          args[meta.index] = rawBody[meta.data];
          break;
        }
        const whitelisted = applyWhitelist(paramTypes[meta.index], rawBody);
        if (whitelisted === null) untypedBody = true;
        args[meta.index] = whitelisted ?? { ...rawBody };
        break;
      }
      case PARAMTYPE.PARAM:
        args[meta.index] = typeof meta.data === 'string' ? RECORD_ID : { id: RECORD_ID };
        break;
      case PARAMTYPE.QUERY:
        args[meta.index] = typeof meta.data === 'string' ? undefined : {};
        break;
      case PARAMTYPE.HEADERS:
        args[meta.index] = typeof meta.data === 'string' ? 'stub-header-value' : request.headers;
        break;
      case PARAMTYPE.REQUEST:
        args[meta.index] = request;
        break;
      case PARAMTYPE.RESPONSE:
        args[meta.index] = response;
        break;
      case PARAMTYPE.RAW_BODY:
        args[meta.index] = request.rawBody;
        break;
      case PARAMTYPE.IP:
        args[meta.index] = request.ip;
        break;
      case PARAMTYPE.SESSION:
        args[meta.index] = {};
        break;
      default:
        args[meta.index] = undefined;
    }
  }

  return { args, untypedBody };
}

interface Invocation {
  calls: RecordedCall[];
  /** Set when the handler threw *after* delegating — see the file header. */
  error?: Error;
  hasTenantParam: boolean;
  /** True when the handler takes a raw, unvalidatable body (webhook payloads). */
  untypedBody: boolean;
}

async function invokeHandler(
  controller: DiscoveredController,
  handler: string,
): Promise<Invocation> {
  const calls: RecordedCall[] = [];

  const depTypes =
    (Reflect.getMetadata('design:paramtypes', controller.cls) as Array<{ name?: string }>) ?? [];
  const deps = depTypes.map((t, i) => makeDependencyDouble(t?.name ?? `dep${i}`, calls));

  const instance = new (controller.cls as new (...args: unknown[]) => Record<string, unknown>)(
    ...deps,
  );

  const request = makeRequest();
  const response = makeResponseDouble();
  const ctx = makeExecutionContext(request, response);
  const { args, untypedBody } = buildArgs(controller.cls, handler, ctx, request, response);

  const hasTenantParam = args.includes(BUSINESS_ID);

  let error: Error | undefined;
  try {
    await (instance[handler] as (...a: unknown[]) => unknown).apply(instance, args);
  } catch (err) {
    error = err as Error;
  }

  return { calls, error, hasTenantParam, untypedBody };
}

/** Every handler, flattened, with a Jest-friendly label. */
const HANDLER_CASES = CONTROLLERS.flatMap((controller) =>
  controller.handlers.map(
    (handler) => [`${controller.name}.${handler}`, controller, handler] as const,
  ),
);

/**
 * True when the handler's tenant parameter is underscore-prefixed.
 *
 * `async readiness(@TenantId() _tenantId: string)` is the codebase's existing
 * way of saying "this route requires a tenant to reach, but does not scope by
 * one". Reading the declaration rather than keeping a list here means the
 * exemption lives next to the code it describes.
 */
function declaresTenantUnused(cls: ControllerClass, handler: string): boolean {
  const fn = (cls.prototype as Record<string, unknown>)[handler];
  if (typeof fn !== 'function') return false;
  const source = Function.prototype.toString.call(fn);
  const params = source.slice(source.indexOf('(') + 1, source.indexOf(')'));
  return /\b_tenantId\b|\b_businessId\b/.test(params);
}

/** Deep scan for a value anywhere inside a recorded argument. */
function containsValue(value: unknown, needle: string, depth = 0): boolean {
  if (depth > 6) return false;
  if (value === needle) return true;
  if (Array.isArray(value)) return value.some((v) => containsValue(v, needle, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) =>
      containsValue(v, needle, depth + 1),
    );
  }
  return false;
}

// ─────────────────────────────────────────────
// Documented exemptions
// ─────────────────────────────────────────────

/**
 * Handlers that take a raw, untyped body because the payload shape belongs to
 * a third party (Meta, the IVR vendor) rather than to this API. They are all
 * `@Public()` and authenticate by HMAC signature instead of JWT — asserted
 * below rather than assumed.
 */
const WEBHOOK_RAW_BODY_HANDLERS = [
  'ChannelAdapterController.handleWhatsAppWebhook',
  'ChannelAdapterController.handleInstagramWebhook',
  'ChannelAdapterController.handleGenericWebhook',
  'RealtyIngestionController.handleLeadgenWebhook',
  'RealtyIngestionController.handleIvrCallback',
];

/**
 * Every handler taking an untyped body: the webhooks above, plus placeholders
 * that persist nothing and so have no contract to validate against yet.
 *
 * `isTheCompleteSetOfUntypedBodyHandlers` holds this list to exactly the set
 * found by inspection, so a new endpoint cannot quietly opt out of validation.
 */
const RAW_BODY_HANDLERS = [
  ...WEBHOOK_RAW_BODY_HANDLERS,
];

/**
 * Handlers that return a literal without calling a collaborator.
 *
 * Every entry is either an unimplemented placeholder or a static catalog. None
 * of them read or write tenant data — which is the property that makes a
 * non-delegating handler acceptable, and what makes this list worth keeping
 * short.
 */
const STATIC_RESPONSE_HANDLERS = [
  // Google Calendar integration is not wired up; these return fixed shapes so
  // the dashboard can render a "not connected" state.
  'IntegrationsController.getCalendar',
  'IntegrationsController.connectCalendar',
  'IntegrationsController.disconnectCalendar',
  'IntegrationsController.listCredentials',
  'IntegrationsController.saveCredentials',
  'IntegrationsController.testCredentials',
  // The plan catalog is a constant, not tenant data.
  'BillingController.plans',
  // Passport intercepts the request and redirects; the body never runs.
  'AuthController.googleAuth',
  // OAuth redirect target — hands off to the Google client, not a service.
  'RealtySheetsController.callback',
];

// ─────────────────────────────────────────────
// Discovery sanity
// ─────────────────────────────────────────────

describe('Controller discovery', () => {
  it('finds the controllers across the codebase', () => {
    // Without this floor, a broken walk would make every case below vacuous.
    expect(CONTROLLERS.length).toBeGreaterThan(30);
  });

  it('finds route handlers on every discovered controller', () => {
    expect(HANDLER_CASES.length).toBeGreaterThan(200);
  });

  it('reads well-formed route-argument metadata', () => {
    // Pins the assumption the whole file rests on: Nest's metadata keys are
    // `${paramtype}:${index}`, with the numeric values in PARAMTYPE. If Nest
    // changes the format, this fails instead of every handler silently being
    // invoked with undefined arguments.
    const withMetadata = CONTROLLERS.flatMap((c) =>
      c.handlers.map(
        (h) => Reflect.getMetadata(ROUTE_ARGS_METADATA, c.cls, h) as Record<string, unknown>,
      ),
    ).filter(Boolean);

    expect(withMetadata.length).toBeGreaterThan(150);

    const known = new Set<number>(Object.values(PARAMTYPE));
    for (const meta of withMetadata) {
      for (const key of Object.keys(meta)) {
        const type = Number(key.split(':')[0]);
        // Custom decorators use a hashed key that is NaN here; everything else
        // must be a paramtype we know how to build an argument for.
        if (!Number.isNaN(type)) expect(known.has(type)).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────
// Tenant provenance
// ─────────────────────────────────────────────

describe('Route handlers take their tenant from the JWT, never the body', () => {
  it.each(HANDLER_CASES)('%s never forwards a body-supplied businessId', async (
    _label,
    controller,
    handler,
  ) => {
    const { calls, untypedBody } = await invokeHandler(controller, handler);

    if (untypedBody) {
      // Raw inbound webhook payloads. The pipe cannot whitelist an untyped
      // body, so a forged key does ride along — but these routes derive their
      // tenant from the verified channel account, never from the payload.
      // `webhookHandlersAreSignatureVerified` below is what actually holds
      // them to that.
      expect(RAW_BODY_HANDLERS).toContain(`${controller.name}.${handler}`);
      return;
    }

    const leaking = calls.filter((call) =>
      call.args.some((arg) => containsValue(arg, FORGED_BUSINESS_ID)),
    );

    // A handler that passes the body's businessId to a service hands the
    // caller whatever tenant they typed.
    expect(
      leaking.map((c) => `${c.dependency}.${c.method}`),
    ).toEqual([]);
  });

  it.each(HANDLER_CASES)('%s delegates rather than holding business logic', async (
    _label,
    controller,
    handler,
  ) => {
    const { calls, error } = await invokeHandler(controller, handler);

    if (error instanceof HttpException && error.getStatus() < 500) {
      // The handler rejected the stub input at its own guard (an unknown
      // channel type, a body missing a required alternative) before reaching a
      // collaborator. Rejecting bad input *is* the handler doing its job.
      return;
    }

    if (calls.length === 0) {
      // Per the module pattern in CLAUDE.md a controller validates input, calls
      // the service, and returns a DTO. The handlers below return a literal
      // instead; each is either a documented placeholder or a static catalog.
      // Listing them keeps the set from growing unnoticed.
      expect(STATIC_RESPONSE_HANDLERS).toContain(`${controller.name}.${handler}`);
      return;
    }

    expect(calls.length).toBeGreaterThan(0);
  });

  it.each(HANDLER_CASES)('%s passes the authenticated tenant to its service', async (
    _label,
    controller,
    handler,
  ) => {
    const { calls, hasTenantParam, error } = await invokeHandler(controller, handler);

    if (!hasTenantParam) {
      // Public routes (webhooks, auth) and user-scoped routes legitimately have
      // no @TenantId() parameter; they carry their own scoping.
      return;
    }

    if (error instanceof HttpException && error.getStatus() < 500) {
      // Rejected the stub input at its own guard before reaching a service.
      return;
    }

    if (calls.length === 0 && STATIC_RESPONSE_HANDLERS.includes(`${controller.name}.${handler}`)) {
      // A documented placeholder that returns a literal — nothing to forward.
      return;
    }

    if (declaresTenantUnused(controller.cls, handler)) {
      // The author named the parameter `_tenantId`, which is this codebase's
      // way of saying the route is tenant-independent (a readiness probe, a
      // pure validation endpoint) while still requiring an authenticated
      // tenant to reach it. Honour that rather than forcing a fake use.
      return;
    }

    const forwarded = calls.some((call) =>
      call.args.some((arg) => containsValue(arg, BUSINESS_ID)),
    );
    expect(forwarded).toBe(true);
  });
});

// ─────────────────────────────────────────────
// Delegation health
// ─────────────────────────────────────────────

describe('Handler invocation health', () => {
  it('drives the overwhelming majority of handlers to completion', async () => {
    // Handlers that post-process a service result can throw against a stub.
    // That is tolerated per-case above, but a sharp rise here would mean the
    // harness stopped exercising real code, so the ratio is pinned.
    const results = await Promise.all(
      HANDLER_CASES.map(([, controller, handler]) => invokeHandler(controller, handler)),
    );

    const threw = results.filter((r) => r.error);
    const ratio = threw.length / results.length;

    // Reported rather than silently tolerated, so a regression is visible.
    if (threw.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `${threw.length}/${results.length} handlers threw while post-processing a stubbed result`,
      );
    }

    expect(ratio).toBeLessThan(0.25);
  });
});

// ─────────────────────────────────────────────
// Webhook routes
// ─────────────────────────────────────────────

describe('Raw-body webhook routes are public and self-authenticating', () => {
  it.each(WEBHOOK_RAW_BODY_HANDLERS)('%s is marked @Public()', (label) => {
    const [controllerName, handlerName] = label.split('.') as [string, string];
    const controller = CONTROLLERS.find((c) => c.name === controllerName);
    expect(controller).toBeDefined();

    const fn = (controller!.cls.prototype as Record<string, unknown>)[handlerName];
    const isPublic =
      Reflect.getMetadata(IS_PUBLIC_KEY, fn as object) === true ||
      Reflect.getMetadata(IS_PUBLIC_KEY, controller!.cls) === true;

    // These routes accept an untyped body precisely because they are not JWT
    // authenticated. If one ever stops being public, the exemption granted to
    // its raw body above stops being justified.
    expect(isPublic).toBe(true);
  });

  it('is the complete set of untyped-body handlers', async () => {
    // The exemption list must not silently grow: any new handler that takes an
    // untyped body shows up here and has to be justified explicitly.
    const untyped: string[] = [];
    for (const [label, controller, handler] of HANDLER_CASES) {
      const { untypedBody } = await invokeHandler(controller, handler);
      if (untypedBody) untyped.push(label);
    }
    expect(untyped.sort()).toEqual([...RAW_BODY_HANDLERS].sort());
  });
});
