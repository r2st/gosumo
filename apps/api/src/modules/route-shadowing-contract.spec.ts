/**
 * Route-shadowing contract.
 *
 * Nest registers a controller's routes in declaration order and matches the
 * first one that fits. A parameterised segment (`:id`) matches *any* single
 * segment, so a static route declared after it on the same verb and the same
 * arity is unreachable — every request meant for it lands on the dynamic
 * handler instead.
 *
 * That is not a hypothetical. `NotificationController` declared `@Get(':id')`
 * above `@Get('templates')` and `@Get('triggers')`, so `GET /notifications/
 * templates` reached the by-id handler with `id` set to the literal string
 * `"templates"`, hit `UuidValidationPipe`, and came back 400. Both endpoints
 * were dead for as long as they had existed, and nothing failed: the unit tests
 * call the controller methods directly, which bypasses routing entirely, and
 * the by-id handler is a perfectly good handler — it just answers the wrong
 * question. Only an HTTP-level request can see it.
 *
 * This file reads the decorators statically rather than booting an app, so it
 * covers every controller in the repo for the cost of a file scan.
 */

import * as fs from 'fs';
import * as path from 'path';

const HTTP_DECORATORS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head'];

interface DeclaredRoute {
  verb: string;
  /** Path as written in the decorator, '' for a bare `@Get()`. */
  pathTemplate: string;
  segments: string[];
  line: number;
}

/** Every `@Get('…')`-style decorator in a controller file, in declaration order. */
function parseRoutes(source: string): DeclaredRoute[] {
  const pattern = new RegExp(
    `@(${HTTP_DECORATORS.join('|')})\\(\\s*(?:'([^']*)'|"([^"]*)"|\`([^\`]*)\`)?\\s*\\)`,
    'g',
  );

  const routes: DeclaredRoute[] = [];
  for (const match of source.matchAll(pattern)) {
    const pathTemplate = match[2] ?? match[3] ?? match[4] ?? '';
    routes.push({
      verb: match[1]!,
      pathTemplate,
      segments: pathTemplate.split('/').filter(Boolean),
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return routes;
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

const isDynamic = (segment: string): boolean =>
  segment.startsWith(':') || segment.startsWith('*');

/**
 * Does `earlier` swallow every request intended for `later`?
 *
 * Only when they share a verb and a segment count, the earlier route has at
 * least one dynamic segment, the later one has none, and every earlier segment
 * either matches literally or is dynamic. Two dynamic routes of the same shape
 * are a different (and much louder) mistake, and a later route with its own
 * parameters is not reliably shadowed, so neither is asserted here.
 */
function shadows(earlier: DeclaredRoute, later: DeclaredRoute): boolean {
  if (earlier.verb !== later.verb) return false;
  if (earlier.segments.length !== later.segments.length) return false;
  if (!earlier.segments.some(isDynamic)) return false;
  if (later.segments.some(isDynamic)) return false;
  return earlier.segments.every((seg, i) => isDynamic(seg) || seg === later.segments[i]);
}

interface Shadowing {
  file: string;
  earlier: DeclaredRoute;
  later: DeclaredRoute;
}

function findShadowings(): Shadowing[] {
  const found: Shadowing[] = [];

  for (const file of findControllerFiles(__dirname)) {
    const routes = parseRoutes(fs.readFileSync(file, 'utf8'));
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        if (shadows(routes[i]!, routes[j]!)) {
          found.push({
            file: path.relative(__dirname, file),
            earlier: routes[i]!,
            later: routes[j]!,
          });
        }
      }
    }
  }

  return found;
}

describe('route shadowing', () => {
  const shadowings = findShadowings();

  // A green result is only meaningful if the detector can go red. These pin the
  // exact shape that was live in NotificationController, so the assertion below
  // cannot start passing because the parser or the matcher quietly broke.
  describe('the detector itself', () => {
    const routesOf = (source: string) => parseRoutes(source);

    it('flags a static route declared under a same-arity dynamic one', () => {
      const [byId, templates] = routesOf(`
        @Get(':id') a() {}
        @Get('templates') b() {}
      `);
      expect(shadows(byId!, templates!)).toBe(true);
    });

    it('does not flag the same pair once the static route comes first', () => {
      const [templates, byId] = routesOf(`
        @Get('templates') b() {}
        @Get(':id') a() {}
      `);
      expect(shadows(templates!, byId!)).toBe(false);
    });

    it('does not flag routes of different arity', () => {
      const [byId, nested] = routesOf(`
        @Get(':id') a() {}
        @Get('templates/preview') b() {}
      `);
      expect(shadows(byId!, nested!)).toBe(false);
    });

    it('does not flag routes on different verbs', () => {
      const [byId, posted] = routesOf(`
        @Get(':id') a() {}
        @Post('templates') b() {}
      `);
      expect(shadows(byId!, posted!)).toBe(false);
    });

    it('parses a bare decorator as the empty path', () => {
      const [bare] = routesOf(`@Get() list() {}`);
      expect(bare).toMatchObject({ verb: 'Get', pathTemplate: '', segments: [] });
    });
  });

  it('scans a non-trivial number of controllers', () => {
    // Guards the scan itself: a parser that silently matched nothing would make
    // the assertion below pass for the wrong reason.
    expect(findControllerFiles(__dirname).length).toBeGreaterThan(20);
  });

  it('no static route is declared after a dynamic route that swallows it', () => {
    const detail = shadowings.map(
      (s) =>
        `${s.file}: @${s.later.verb}('${s.later.pathTemplate}') at line ${s.later.line} is ` +
        `unreachable — @${s.earlier.verb}('${s.earlier.pathTemplate}') at line ${s.earlier.line} ` +
        `matches it first. Move the static route above the dynamic one.`,
    );

    expect(detail).toEqual([]);
  });
});
