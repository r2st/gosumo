/**
 * Codebase-wide API versioning contract.
 *
 * There is exactly one version, it lives in the URL path, and it is applied
 * once — `app.setGlobalPrefix(API_VERSION)` in `main.ts`. Every controller
 * declares its own path *without* it.
 *
 * That arrangement has one failure mode, and it is silent. A controller
 * written as `@Controller('v1/reports')` mounts at `/v1/v1/reports`: the
 * dashboard 404s on it, the route is absent from Swagger's expected path, and
 * nothing anywhere errors — the app boots fine and every *other* route works.
 * It surfaces when somebody calls that one endpoint, which for an
 * infrequently-used report can be months.
 *
 * This file discovers every controller the same way `swagger-contract.spec.ts`
 * does (Nest's own PATH_METADATA) and asserts the invariant across all of
 * them, so a new controller is covered the moment it exists rather than when
 * somebody remembers to add it to a list.
 */

import * as fs from 'fs';
import * as path from 'path';

import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import {
  API_VERSION,
  DEPRECATION_POLICY,
  RESERVED_PATH_PREFIXES,
} from '../common/versioning/api-version.constants';
import {
  API_DEPRECATION,
  DeprecationNotice,
} from '../common/versioning/deprecation.decorator';

// ─────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────

interface DiscoveredRoute {
  controller: string;
  method: string;
  basePath: string;
  routePath: string;
  fn: (...args: never[]) => unknown;
  cls: NewableFunction;
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

function discover(): { controllers: Array<[string, string]>; routes: DiscoveredRoute[] } {
  const controllers: Array<[string, string]> = [];
  const routes: DiscoveredRoute[] = [];

  for (const file of findControllerFiles(__dirname)) {
    const mod = require(file) as Record<string, unknown>;

    for (const [name, exported] of Object.entries(mod)) {
      if (typeof exported !== 'function' || !name.endsWith('Controller')) continue;
      const basePath = Reflect.getMetadata(PATH_METADATA, exported) as string | undefined;
      if (basePath === undefined) continue;

      controllers.push([name, basePath]);

      const proto = exported.prototype as Record<string, unknown>;
      for (const member of Object.getOwnPropertyNames(proto).sort()) {
        if (member === 'constructor') continue;
        const fn = proto[member];
        if (typeof fn !== 'function') continue;
        const routePath = Reflect.getMetadata(PATH_METADATA, fn) as string | undefined;
        if (routePath === undefined) continue;
        if (Reflect.getMetadata(METHOD_METADATA, fn) === undefined) continue;

        routes.push({
          controller: name,
          method: member,
          basePath,
          routePath,
          fn: fn as (...args: never[]) => unknown,
          cls: exported as NewableFunction,
        });
      }
    }
  }

  controllers.sort((a, b) => a[0].localeCompare(b[0]));
  return { controllers, routes };
}

const { controllers: CONTROLLERS, routes: ROUTES } = discover();

/** First path segment, lowercased, with any leading slash removed. */
const firstSegment = (p: string): string =>
  p.replace(/^\/+/, '').split('/')[0]?.toLowerCase() ?? '';

// ─────────────────────────────────────────────
// The prefix invariant
// ─────────────────────────────────────────────

describe('API versioning contract', () => {
  it('discovered the controllers, so an empty sweep cannot pass silently', () => {
    // Every assertion below iterates this list. A discovery bug that returned
    // nothing would turn the whole file green while checking nothing at all.
    expect(CONTROLLERS.length).toBeGreaterThan(30);
    expect(ROUTES.length).toBeGreaterThan(150);
  });

  describe('no controller writes the version into its own path', () => {
    it.each(CONTROLLERS)('%s mounts at "%s"', (_name, basePath) => {
      // `@Controller('v1/x')` plus the global prefix mounts at `/v1/v1/x`,
      // which 404s and errors nowhere.
      expect(RESERVED_PATH_PREFIXES).not.toContain(firstSegment(basePath));
    });
  });

  describe('no handler writes the version into its own path either', () => {
    it.each(ROUTES.map((r): [string, string] => [`${r.controller}.${r.method}`, r.routePath]))(
      '%s routes to "%s"',
      (_name, routePath) => {
        expect(RESERVED_PATH_PREFIXES).not.toContain(firstSegment(routePath));
      },
    );
  });

  it('applies the version exactly once, in main.ts', () => {
    // The prefix is one call. If a second place ever sets it — a per-module
    // RouterModule, a controller path — the two disagree and only one wins.
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
    const prefixCalls = main.match(/setGlobalPrefix\(/g) ?? [];

    expect(prefixCalls).toHaveLength(1);
    expect(main).toContain('setGlobalPrefix(API_VERSION)');
  });

  it('keeps the version a bare path segment', () => {
    // A prefix with a slash in it produces a double slash when joined with a
    // controller path, and `//conversations` is not the same route.
    expect(API_VERSION).toMatch(/^v\d+$/);
  });
});

// ─────────────────────────────────────────────
// Deprecation notices
// ─────────────────────────────────────────────

/** Every route carrying an `@ApiDeprecated`, with its notice. */
const DEPRECATED: Array<[string, DeprecationNotice]> = ROUTES.map(
  (r): [string, DeprecationNotice | undefined] => [
    `${r.controller}.${r.method}`,
    (Reflect.getMetadata(API_DEPRECATION, r.fn) ??
      Reflect.getMetadata(API_DEPRECATION, r.cls)) as DeprecationNotice | undefined,
  ],
).filter((entry): entry is [string, DeprecationNotice] => entry[1] !== undefined);

describe('deprecation notices', () => {
  // `it.each([])` throws rather than skipping, and nothing is deprecated
  // today. The guard keeps this file honest for the day something is, without
  // making an empty set a failure.
  const whenAny = DEPRECATED.length > 0 ? describe : describe.skip;

  whenAny('every declared notice is well-formed', () => {
    it.each(DEPRECATED)('%s has a parseable "since"', (_name, notice) => {
      // An unparseable date sends no header at all, so the route is marked
      // deprecated in the source and silent on the wire — the exact gap this
      // infrastructure exists to close.
      expect(Number.isNaN(Date.parse(notice.since))).toBe(false);
    });

    it.each(DEPRECATED)('%s has a parseable "sunset" if it has one', (_name, notice) => {
      if (!notice.sunset) return;
      expect(Number.isNaN(Date.parse(notice.sunset))).toBe(false);
    });

    it.each(DEPRECATED)('%s sunsets after it was deprecated', (_name, notice) => {
      if (!notice.sunset) return;
      expect(Date.parse(notice.sunset)).toBeGreaterThan(Date.parse(notice.since));
    });

    it.each(DEPRECATED)('%s gives the policy minimum notice', (_name, notice) => {
      // Three routes deprecated by three people otherwise get three grace
      // periods invented on the spot.
      if (!notice.sunset) return;
      const days = (Date.parse(notice.sunset) - Date.parse(notice.since)) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(DEPRECATION_POLICY.minimumNoticeDays);
    });

    it.each(DEPRECATED)('%s points at a versioned replacement path', (_name, notice) => {
      // A bare `/search/messages` is not a path any client can call — every
      // route on this API lives under the global prefix.
      if (!notice.replacement) return;
      expect(notice.replacement.startsWith(`/${API_VERSION}/`)).toBe(true);
    });

    it.each(DEPRECATED)('%s only enforces a sunset it actually has', (_name, notice) => {
      // `enforceSunset` with no `sunset` is a no-op that reads as a scheduled
      // removal, which is the worst of both.
      if (!notice.enforceSunset) return;
      expect(notice.sunset).toBeDefined();
    });
  });
});
