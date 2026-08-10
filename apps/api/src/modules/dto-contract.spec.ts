/**
 * Codebase-wide request-DTO contract tests.
 *
 * `dto-validation.spec.ts` pins specific DTOs by hand. This file does the
 * complementary job: it discovers *every* request DTO in the codebase and
 * asserts the invariants that must hold for all of them. A new module that
 * forgets one of these fails here without anyone remembering to add a case.
 *
 * The invariants, and why each one matters:
 *
 *  1. No request DTO accepts `businessId`. Tenant comes from the JWT via
 *     `@TenantId()` (apps/api/CLAUDE.md). A body-supplied `businessId` that
 *     any handler trusts is a cross-tenant write with no exploit needed —
 *     the attacker just types a different UUID.
 *
 *  2. Every `*Paise` field rejects a non-integer. Money is integer paise
 *     (root rule #4). A float reaching the gateway charges a wrong amount,
 *     and 0.1 + 0.2 arithmetic downstream compounds it.
 *
 *  3. Every field that accepts an ISO date rejects an impossible one. The
 *     calendar validator has to be applied to all of them, not just the ones
 *     someone remembered — a missed field silently rolls 31 Feb to 3 March.
 *
 * Discovery is by filesystem walk, so the coverage of these rules grows with
 * the codebase automatically.
 */

import * as fs from 'fs';
import * as path from 'path';

import { plainToInstance } from 'class-transformer';
import { getMetadataStorage, validateSync } from 'class-validator';

// ─────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────

type DtoClass = new () => object;

interface DiscoveredDto {
  /** `realty-leads/dto` — enough to locate the file from a failure message. */
  location: string;
  name: string;
  cls: DtoClass;
  /** Properties carrying at least one validation rule. */
  properties: string[];
}

function findDtoDirs(root: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === 'dto') out.push(full);
    else findDtoDirs(full, out);
  }
  return out;
}

/**
 * Every exported class that declares validation rules, across every `dto/`
 * directory under `src/modules`.
 *
 * Classes with no validation metadata are response DTOs — they carry only
 * `@ApiProperty()` for Swagger and are never bound to a request body, so the
 * request-side invariants do not apply to them.
 */
function discoverRequestDtos(): DiscoveredDto[] {
  const modulesRoot = path.join(__dirname);
  const found: DiscoveredDto[] = [];
  const storage = getMetadataStorage();

  for (const dir of findDtoDirs(modulesRoot)) {
    const location = path.relative(modulesRoot, dir);

    let mod: Record<string, unknown>;
    try {
      mod = require(dir) as Record<string, unknown>;
    } catch {
      // A `dto/` directory with no barrel index (channel-adapter names its
      // files directly). Nothing to enumerate; the per-file specs cover it.
      continue;
    }

    for (const [name, exported] of Object.entries(mod)) {
      if (typeof exported !== 'function' || !/^[A-Z]/.test(name)) continue;

      const metas = storage.getTargetValidationMetadatas(exported, name, false, false);
      if (metas.length === 0) continue;

      found.push({
        location,
        name,
        cls: exported as DtoClass,
        properties: [...new Set(metas.map((m) => m.propertyName))].sort(),
      });
    }
  }

  found.sort((a, b) => `${a.location}${a.name}`.localeCompare(`${b.location}${b.name}`));
  return found;
}

const REQUEST_DTOS = discoverRequestDtos();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Property names that failed validation for `payload`.
 *
 * Deliberately does not build a fully valid payload: other properties are
 * free to fail for being absent. Each test asserts only on the one property
 * it set, which keeps the checks independent of every DTO's required fields.
 */
function failingProperties(cls: DtoClass, payload: Record<string, unknown>): Set<string> {
  const instance = plainToInstance(cls, payload, { enableImplicitConversion: true });
  const errors = validateSync(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
    // Nested errors surface on the parent property, which is the granularity
    // these assertions work at.
    validationError: { target: false },
  });
  return new Set(errors.map((e) => e.property));
}

function accepts(cls: DtoClass, property: string, value: unknown): boolean {
  return !failingProperties(cls, { [property]: value }).has(property);
}

/** A case list Jest can name, guarding against an empty discovery run. */
function cases<T>(items: T[], label: (item: T) => string): Array<readonly [string, T]> {
  return items.map((item) => [label(item), item] as const);
}

// ─────────────────────────────────────────────
// Discovery sanity
// ─────────────────────────────────────────────

describe('DTO discovery', () => {
  it('finds the request DTOs across the codebase', () => {
    // Guards the whole file: a broken walk would make every test below pass
    // vacuously. The floor is well under the current count so ordinary
    // refactors do not trip it.
    expect(REQUEST_DTOS.length).toBeGreaterThan(150);
  });

  it('spans more than one module', () => {
    const locations = new Set(REQUEST_DTOS.map((d) => d.location));
    expect(locations.size).toBeGreaterThan(20);
  });
});

// ─────────────────────────────────────────────
// 1. Tenant identity is never client-supplied
// ─────────────────────────────────────────────

describe('No request DTO accepts a client-supplied tenant', () => {
  const TENANT_KEYS = /^(business_?id|tenant_?id|org(anisation|anization)?_?id)$/i;

  it('declares no tenant-identifier property anywhere', () => {
    const offenders = REQUEST_DTOS.flatMap((dto) =>
      dto.properties.filter((p) => TENANT_KEYS.test(p)).map((p) => `${dto.location}/${dto.name}.${p}`),
    );

    // Listing offenders rather than asserting a count so a failure says which
    // DTO to fix.
    expect(offenders).toEqual([]);
  });

  it.each(cases(REQUEST_DTOS, (d) => `${d.location}/${d.name}`))(
    '%s strips an injected businessId',
    (_label, dto) => {
      // Even without a declared property, `whitelist: true` must drop the key
      // rather than let it ride along on the instance into a repository call.
      const instance = plainToInstance(dto.cls, { businessId: 'attacker-supplied' }, {
        enableImplicitConversion: true,
      }) as Record<string, unknown>;
      const errors = validateSync(instance as object, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

      const rejected = errors.some((e) => e.property === 'businessId');
      const stripped = !Object.prototype.hasOwnProperty.call(
        plainToInstance(dto.cls, {}, { enableImplicitConversion: true }) as object,
        'businessId',
      );
      expect(rejected || stripped).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────
// 2. Money is integer paise
// ─────────────────────────────────────────────

describe('Monetary fields reject non-integer paise', () => {
  const moneyFields = REQUEST_DTOS.flatMap((dto) =>
    dto.properties
      .filter((p) => /paise$/i.test(p))
      .map((property) => ({ dto, property })),
  );

  it('finds the monetary fields', () => {
    expect(moneyFields.length).toBeGreaterThan(20);
  });

  it.each(cases(moneyFields, (m) => `${m.dto.location}/${m.dto.name}.${m.property}`))(
    '%s rejects a fractional amount',
    (_label, { dto, property }) => {
      // 10.5 paise is not a thing. If this passes, the value reaches Prisma as
      // a float and the gateway charges something the client never authorised.
      expect(accepts(dto.cls, property, 1050.5)).toBe(false);
    },
  );

  it.each(cases(moneyFields, (m) => `${m.dto.location}/${m.dto.name}.${m.property}`))(
    '%s rejects a negative amount',
    (_label, { dto, property }) => {
      expect(accepts(dto.cls, property, -1)).toBe(false);
    },
  );

  it.each(cases(moneyFields, (m) => `${m.dto.location}/${m.dto.name}.${m.property}`))(
    '%s accepts a plain integer amount',
    (_label, { dto, property }) => {
      // The mirror of the two rejections above: the rule must not be so tight
      // that a legitimate amount cannot be sent.
      expect(accepts(dto.cls, property, 150000)).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────
// 3. Date fields are calendar-aware
// ─────────────────────────────────────────────

describe('Every date field rejects an impossible calendar date', () => {
  const VALID_INSTANT = '2026-09-01T10:30:00.000Z';

  /**
   * A string that is indistinguishable from an ISO instant by character class
   * — same digits, separators, `T` and `Z` — but names no date at all. Only a
   * validator that actually parses the value rejects it.
   *
   * Discriminating on this rather than on free text matters: `password` fields
   * carry a complexity `@Matches()` that a real ISO instant happens to satisfy
   * and free text does not, so a looser probe classifies them as date fields
   * and then fails them for accepting 31 February.
   */
  const SHAPED_NON_DATE = '2026-99-99T99:99:99.999Z';

  /**
   * Date fields are found by behaviour, not by name: a property that accepts a
   * well-formed ISO instant but rejects the shaped non-date above is parsing
   * dates. This catches fields the naming conventions would miss and cannot
   * drift out of date the way a hand-maintained list would.
   */
  const dateFields = REQUEST_DTOS.flatMap((dto) =>
    dto.properties
      .filter(
        (property) =>
          accepts(dto.cls, property, VALID_INSTANT) &&
          !accepts(dto.cls, property, SHAPED_NON_DATE),
      )
      .map((property) => ({ dto, property })),
  );

  it('finds the date fields', () => {
    expect(dateFields.length).toBeGreaterThan(15);
  });

  it.each(cases(dateFields, (d) => `${d.dto.location}/${d.dto.name}.${d.property}`))(
    '%s rejects 31 February',
    (_label, { dto, property }) => {
      // The whole point of the codebase-wide sweep: one field still on
      // @IsDateString() is one field that silently rolls to 3 March.
      expect(accepts(dto.cls, property, '2026-02-31T00:00:00Z')).toBe(false);
    },
  );

  it.each(cases(dateFields, (d) => `${d.dto.location}/${d.dto.name}.${d.property}`))(
    '%s rejects 29 February in a common year',
    (_label, { dto, property }) => {
      expect(accepts(dto.cls, property, '2026-02-29T00:00:00Z')).toBe(false);
    },
  );

  it.each(cases(dateFields, (d) => `${d.dto.location}/${d.dto.name}.${d.property}`))(
    '%s still accepts a real leap day',
    (_label, { dto, property }) => {
      expect(accepts(dto.cls, property, '2028-02-29T00:00:00.000Z')).toBe(true);
    },
  );
});
