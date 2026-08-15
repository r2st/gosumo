import type { NextFunction, Request, Response } from 'express';
import { ErrorCode } from '@gosumo/shared';
import {
  bodyShapeGuard,
  inspectBodyShape,
  MAX_BODY_DEPTH,
  MAX_OBJECT_KEYS,
  type BodyShapeLimits,
} from './body-shape-guard.middleware';

/** Build `{"a":{"a":{ … }}}` nested `depth` levels deep, iteratively. */
function nest(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < depth - 1; i += 1) node = { a: node };
  return node;
}

/** Build an object with `count` distinct scalar keys. */
function wide(count: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < count; i += 1) out[`k${i}`] = i;
  return out;
}

describe('inspectBodyShape', () => {
  describe('bodies it must not touch', () => {
    it.each([
      ['undefined (no parser ran)', undefined],
      ['null', null],
      ['a string body', 'plain text'],
      ['a number', 42],
      ['an empty object', {}],
      ['an empty array', []],
    ])('accepts %s', (_label, body) => {
      expect(inspectBodyShape(body)).toBeNull();
    });

    it('accepts a realistic connect-channel payload', () => {
      expect(
        inspectBodyShape({
          displayName: 'Support',
          phoneNumberId: 'pn-1',
          widgetConfig: {
            theme: { colors: { primary: '#4F46E5', surface: '#fff' } },
            greeting: 'Hi',
          },
        }),
      ).toBeNull();
    });

    it('accepts a 5000-row import, which a DTO explicitly allows', () => {
      // `CsvImportDto` advertises `@ArrayMaxSize(5000)`. Rejecting it here
      // would make the documented ceiling unreachable a second time.
      const rows = Array.from({ length: 5000 }, (_, i) => ({
        name: `Lead ${i}`,
        phone: '+919876543210',
      }));

      expect(inspectBodyShape({ rows })).toBeNull();
    });
  });

  describe('depth', () => {
    it('accepts a body exactly at the limit', () => {
      expect(inspectBodyShape(nest(MAX_BODY_DEPTH))).toBeNull();
    });

    it('rejects one level past the limit', () => {
      expect(inspectBodyShape(nest(MAX_BODY_DEPTH + 1))).toBe('depth');
    });

    it('rejects the pathological case without overflowing its own stack', () => {
      // The whole reason the walk is iterative. A recursive implementation
      // throws RangeError here instead of returning a verdict — which is the
      // vulnerability, not the fix.
      expect(() => inspectBodyShape(nest(50_000))).not.toThrow();
      expect(inspectBodyShape(nest(50_000))).toBe('depth');
    });

    it('counts nesting through arrays, not just objects', () => {
      let node: unknown = 'leaf';
      for (let i = 0; i < MAX_BODY_DEPTH + 5; i += 1) node = [node];

      expect(inspectBodyShape(node)).toBe('depth');
    });

    it('counts each branch from the root, not cumulatively across siblings', () => {
      // Two shallow branches are not one deep one. Getting this wrong would
      // reject ordinary wide-but-flat payloads.
      expect(
        inspectBodyShape({ a: nest(4), b: nest(4), c: nest(4) }, { maxDepth: 6 }),
      ).toBeNull();
    });
  });

  describe('key count', () => {
    it('accepts an object exactly at the limit', () => {
      expect(inspectBodyShape(wide(MAX_OBJECT_KEYS))).toBeNull();
    });

    it('rejects one key past the limit', () => {
      expect(inspectBodyShape(wide(MAX_OBJECT_KEYS + 1))).toBe('keys');
    });

    it('applies the limit to nested objects, not only the root', () => {
      expect(inspectBodyShape({ nested: wide(MAX_OBJECT_KEYS + 1) })).toBe('keys');
    });

    it('exempts arrays, whose length is bounded by the DTO instead', () => {
      const body = { rows: Array.from({ length: MAX_OBJECT_KEYS + 500 }, (_, i) => i) };

      expect(inspectBodyShape(body)).toBeNull();
    });
  });

  describe('what it deliberately does not bound', () => {
    it('accepts a broad shallow tree, which the byte cap already bounds', () => {
      // 400 objects of 400 keys each. Tempting to reject, but any total-value
      // limit low enough to catch this also rejects the 5000-row inventory
      // import the API advertises — and at 4 bytes a value the 1 MB ceiling
      // caps a body near 250,000 values regardless.
      const body = { rows: Array.from({ length: 400 }, () => wide(400)) };

      expect(inspectBodyShape(body)).toBeNull();
    });

    it('walks a large body quickly — the guard must not become the attack', () => {
      const body = { rows: Array.from({ length: 40_000 }, () => ({ a: 1 })) };
      const started = Date.now();

      expect(inspectBodyShape(body)).toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  it('reports a violation when a body breaks both limits at once', () => {
    const body = { a: { ...wide(MAX_OBJECT_KEYS + 1), deep: nest(MAX_BODY_DEPTH + 5) } };

    expect(inspectBodyShape(body)).not.toBeNull();
  });

  it('treats __proto__ as an ordinary key, since JSON.parse does', () => {
    const body = JSON.parse('{"__proto__":{"admin":true}}') as unknown;

    expect(inspectBodyShape(body)).toBeNull();
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });
});

describe('bodyShapeGuard', () => {
  interface RunResult {
    status?: number;
    body?: Record<string, unknown>;
    nextCalled: boolean;
  }

  function run(body: unknown, limits: BodyShapeLimits = {}): RunResult {
    const result: RunResult = { nextCalled: false };

    const req = { body, method: 'POST', url: '/v1/leads' } as Request;
    const res = {
      status(code: number) {
        result.status = code;
        return this;
      },
      json(payload: Record<string, unknown>) {
        result.body = payload;
        return this;
      },
    } as unknown as Response;
    const next: NextFunction = () => {
      result.nextCalled = true;
    };

    bodyShapeGuard(limits)(req, res, next);
    return result;
  }

  it('passes an ordinary body straight through', () => {
    const result = run({ name: 'Asha', phone: '+919876543210' });

    expect(result.nextCalled).toBe(true);
    expect(result.status).toBeUndefined();
  });

  it('answers 400 rather than calling next on a hostile body', () => {
    const result = run(nest(MAX_BODY_DEPTH + 1));

    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(400);
  });

  it('answers in the same shape as every other error response', () => {
    // It runs before the router, so `HttpExceptionFilter` never sees it — the
    // envelope has to be built here or clients need a second parser.
    const result = run(nest(MAX_BODY_DEPTH + 1));

    expect(result.body).toMatchObject({
      statusCode: 400,
      error: ErrorCode.VALIDATION_FAILED,
      path: '/v1/leads',
    });
    expect(typeof result.body?.['timestamp']).toBe('string');
    expect(result.body).toHaveProperty('traceId');
  });

  it('names the limit that was broken and nothing from the body', () => {
    const result = run({ secretField: nest(MAX_BODY_DEPTH + 1) });
    const message = String(result.body?.['message']);

    expect(message).toContain(String(MAX_BODY_DEPTH));
    expect(message).not.toContain('secretField');
  });

  it.each([
    ['depth', nest(MAX_BODY_DEPTH + 1), 'nested'],
    ['keys', wide(MAX_OBJECT_KEYS + 1), 'keys'],
  ])('explains a %s violation in its own terms', (_label, body, expected) => {
    expect(String(run(body).body?.['message'])).toContain(expected);
  });

  it('honours overridden limits', () => {
    expect(run(nest(4), { maxDepth: 3 }).status).toBe(400);
    expect(run(nest(4), { maxDepth: 10 }).nextCalled).toBe(true);
  });
});
