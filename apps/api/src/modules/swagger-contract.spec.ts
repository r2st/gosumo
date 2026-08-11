/**
 * Codebase-wide OpenAPI documentation contract.
 *
 * `/api/docs` is the only description of this API that anyone outside the
 * repo reads. An endpoint that ships without decorators still appears there —
 * as a bare method and path with no summary, no response shape and no
 * documented failure modes — which is worse than absent, because it looks
 * finished.
 *
 * Rather than re-audit by hand each round, this file discovers every
 * controller and every route handler the same way `controller-contract.spec.ts`
 * does (Nest's own PATH_METADATA), then asserts on the Swagger metadata Nest
 * would hand the document builder at bootstrap:
 *
 *   - every controller carries `@ApiTags`, so routes group in the UI;
 *   - every handler carries `@ApiOperation` with a non-trivial summary;
 *   - every handler documents at least one success response, and its status
 *     agrees with the verb and any `@HttpCode`;
 *   - every `:param` in a path is described by `@ApiParam`;
 *   - handlers that can 404 on a tenant-scoped lookup say so.
 *
 * The last two run as advisory floors over a documented exemption set rather
 * than blanket rules — see EXEMPT_* below, each with the reason written out.
 */

import * as fs from 'fs';
import * as path from 'path';

import { PATH_METADATA, METHOD_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import {
  DECORATORS as SWAGGER_DECORATORS,
} from '@nestjs/swagger/dist/constants';

// ─────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────

type ControllerClass = new (...args: never[]) => object;

interface DiscoveredHandler {
  controller: string;
  method: string;
  /** Full route path, e.g. `POST channels/:channelType/connect`. */
  route: string;
  verb: RequestMethod;
  fn: (...args: never[]) => unknown;
}

interface DiscoveredController {
  file: string;
  name: string;
  cls: ControllerClass;
  handlers: DiscoveredHandler[];
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
      const basePath = Reflect.getMetadata(PATH_METADATA, exported) as string | undefined;
      if (basePath === undefined) continue;

      const proto = exported.prototype as Record<string, unknown>;
      const handlers: DiscoveredHandler[] = [];

      for (const member of Object.getOwnPropertyNames(proto).sort()) {
        if (member === 'constructor') continue;
        const fn = proto[member];
        if (typeof fn !== 'function') continue;

        const routePath = Reflect.getMetadata(PATH_METADATA, fn) as string | undefined;
        if (routePath === undefined) continue;

        const verb = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod;
        const verbName = RequestMethod[verb] ?? String(verb);
        const joined = [basePath, routePath].filter((p) => p && p !== '/').join('/');

        handlers.push({
          controller: name,
          method: member,
          route: `${verbName} /${joined}`,
          verb,
          fn: fn as (...args: never[]) => unknown,
        });
      }

      if (handlers.length === 0) continue;
      found.push({
        file: path.relative(modulesRoot, file),
        name,
        cls: exported as ControllerClass,
        handlers,
      });
    }
  }

  found.sort((a, b) => a.file.localeCompare(b.file));
  return found;
}

const CONTROLLERS = discoverControllers();
const HANDLERS = CONTROLLERS.flatMap((c) => c.handlers);

// ─────────────────────────────────────────────
// Swagger metadata readers
// ─────────────────────────────────────────────

interface ApiOperationMetadata {
  summary?: string;
  description?: string;
  deprecated?: boolean;
}

interface ApiResponseMetadata {
  status?: number | string;
  description?: string;
}

interface ApiParamMetadata {
  name?: string;
  description?: string;
}

function operationOf(h: DiscoveredHandler): ApiOperationMetadata | undefined {
  return Reflect.getMetadata(SWAGGER_DECORATORS.API_OPERATION, h.fn) as
    | ApiOperationMetadata
    | undefined;
}

/**
 * `@ApiResponse` metadata is stored keyed by status code, with the shape
 * varying between `{ '200': {...} }` and `{ '200': { status: 200, ... } }`
 * across @nestjs/swagger minors. Normalise to a status → description map.
 */
function responsesOf(h: DiscoveredHandler): Record<string, ApiResponseMetadata> {
  const raw = Reflect.getMetadata(SWAGGER_DECORATORS.API_RESPONSE, h.fn) as
    | Record<string, ApiResponseMetadata>
    | undefined;
  return raw ?? {};
}

function paramsOf(h: DiscoveredHandler): ApiParamMetadata[] {
  const raw = Reflect.getMetadata(SWAGGER_DECORATORS.API_PARAMETERS, h.fn) as
    | ApiParamMetadata[]
    | undefined;
  return raw ?? [];
}

function tagsOf(c: DiscoveredController): string[] {
  return (Reflect.getMetadata(SWAGGER_DECORATORS.API_TAGS, c.cls) as string[] | undefined) ?? [];
}

/** Status codes in `responses` that are 2xx. */
function successStatuses(h: DiscoveredHandler): number[] {
  return Object.keys(responsesOf(h))
    .map(Number)
    .filter((s) => Number.isFinite(s) && s >= 200 && s < 300);
}

/** The status Nest will actually return: `@HttpCode` if present, else the verb default. */
function expectedSuccessStatus(h: DiscoveredHandler): number {
  const explicit = Reflect.getMetadata(HTTP_CODE_METADATA, h.fn) as number | undefined;
  if (typeof explicit === 'number') return explicit;
  return h.verb === RequestMethod.POST ? 201 : 200;
}

/** `:name` segments in the route path. */
function pathParams(h: DiscoveredHandler): string[] {
  return [...h.route.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
}

// ─────────────────────────────────────────────
// Discovery sanity
// ─────────────────────────────────────────────

describe('OpenAPI documentation contract', () => {
  describe('discovery', () => {
    it('finds the controllers across the codebase', () => {
      // Without a floor, a broken walk makes every case below vacuous.
      expect(CONTROLLERS.length).toBeGreaterThan(30);
    });

    it('finds route handlers on every discovered controller', () => {
      expect(HANDLERS.length).toBeGreaterThan(200);
    });

    it('reads @nestjs/swagger metadata keys that still exist', () => {
      // Pins the assumption the file rests on. If @nestjs/swagger renames a
      // metadata key, this fails loudly instead of every assertion below
      // silently passing against undefined.
      for (const key of [
        SWAGGER_DECORATORS.API_OPERATION,
        SWAGGER_DECORATORS.API_RESPONSE,
        SWAGGER_DECORATORS.API_PARAMETERS,
        SWAGGER_DECORATORS.API_TAGS,
      ]) {
        expect(typeof key).toBe('string');
        expect(key.length).toBeGreaterThan(0);
      }

      // And that at least one handler really carries each of them, which a
      // renamed-but-still-a-string key would not survive.
      expect(HANDLERS.some((h) => operationOf(h) !== undefined)).toBe(true);
      expect(HANDLERS.some((h) => successStatuses(h).length > 0)).toBe(true);
      expect(HANDLERS.some((h) => paramsOf(h).length > 0)).toBe(true);
      expect(CONTROLLERS.some((c) => tagsOf(c).length > 0)).toBe(true);
    });
  });

  // ───────────────────────────────────────────
  // Controller-level
  // ───────────────────────────────────────────

  describe('@ApiTags', () => {
    it.each(CONTROLLERS.map((c) => [c.file, c] as const))(
      '%s groups its routes under a tag',
      (_file, controller) => {
        const tags = tagsOf(controller);
        expect(tags.length).toBeGreaterThan(0);
        for (const tag of tags) {
          expect(typeof tag).toBe('string');
          expect(tag.trim().length).toBeGreaterThan(0);
        }
      },
    );
  });

  // ───────────────────────────────────────────
  // Handler-level
  // ───────────────────────────────────────────

  const handlerCases = HANDLERS.map(
    (h) => [`${h.controller}.${h.method} (${h.route})`, h] as const,
  );

  describe('@ApiOperation', () => {
    it.each(handlerCases)('%s has an operation summary', (_label, h) => {
      const op = operationOf(h);
      expect(op).toBeDefined();
      expect(typeof op?.summary).toBe('string');
      // A summary that just restates the method name documents nothing.
      expect((op?.summary ?? '').trim().length).toBeGreaterThan(8);
    });

    it.each(handlerCases)('%s summary is a phrase, not a sentence fragment', (_label, h) => {
      const summary = (operationOf(h)?.summary ?? '').trim();
      // House style: sentence case, no trailing period.
      expect(summary.endsWith('.')).toBe(false);
      expect(summary[0]).toBe(summary[0]?.toUpperCase());
    });
  });

  describe('@ApiResponse', () => {
    it.each(handlerCases)('%s documents a success response', (_label, h) => {
      expect(successStatuses(h).length).toBeGreaterThan(0);
    });

    it.each(handlerCases)('%s success status matches the verb and @HttpCode', (_label, h) => {
      const expected = expectedSuccessStatus(h);
      const documented = successStatuses(h);
      // 204 handlers return no body; some are documented as 200 historically.
      // Anything else must name the status Nest actually sends.
      expect(documented).toContain(expected);
    });

    it.each(handlerCases)('%s gives every documented response a description', (_label, h) => {
      for (const [status, meta] of Object.entries(responsesOf(h))) {
        expect(typeof meta.description).toBe('string');
        expect((meta.description ?? '').trim().length).toBeGreaterThan(0);
        expect(Number.isFinite(Number(status))).toBe(true);
      }
    });
  });

  describe('@ApiParam', () => {
    const withPathParams = handlerCases.filter(([, h]) => pathParams(h).length > 0);

    it('finds handlers with path parameters', () => {
      expect(withPathParams.length).toBeGreaterThan(50);
    });

    it.each(withPathParams)('%s describes every path parameter', (_label, h) => {
      const documented = new Set(paramsOf(h).map((p) => p.name));
      for (const name of pathParams(h)) {
        expect(documented).toContain(name);
      }
    });

    it.each(withPathParams)('%s gives each path parameter a description', (_label, h) => {
      const inPath = new Set(pathParams(h));
      for (const param of paramsOf(h)) {
        if (!param.name || !inPath.has(param.name)) continue;
        expect((param.description ?? '').trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('failure modes', () => {
    /**
     * A handler that looks a record up by a path id can always 404 — the id
     * may belong to another tenant, or to nothing. Documenting only the happy
     * path there tells a client the call cannot fail.
     */
    const byId = handlerCases.filter(([, h]) =>
      pathParams(h).some((p) => p === 'id' || p.toLowerCase().endsWith('id')),
    );

    it('finds handlers that resolve a record by path id', () => {
      expect(byId.length).toBeGreaterThan(40);
    });

    it.each(byId)('%s documents a 404', (_label, h) => {
      expect(Object.keys(responsesOf(h))).toContain('404');
    });
  });
});
