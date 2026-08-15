/**
 * Contract: every paginated list endpoint is bounded at both ends.
 *
 * `limit` and `page` are the two numbers a caller picks that a repository then
 * hands to Prisma as `take` and `skip: (page - 1) * limit`. Left unbounded they
 * fail in three distinct ways, all of which were live before this file:
 *
 *  - **Unbounded `limit`.** `?limit=1000000` on catalog search returned the
 *    tenant's whole catalogue with every variant and category joined in. The
 *    DTOs mostly capped this at 100 already; the endpoints reading `limit` as a
 *    bare `@Query()` string did not.
 *  - **Non-numeric input.** `parseInt('abc')` is NaN, and Prisma rejects a NaN
 *    `take` with `PrismaClientValidationError` — which is not a
 *    `PrismaClientKnownRequestError`, so the global filter has no mapping and
 *    returns a generic 500. A caller's typo was logged as a server fault.
 *  - **`?page=0`.** `skip: (0 - 1) * 20` is -20, which Prisma also refuses. Same
 *    500.
 *
 * The fix in every case is the same: read the parameter through a DTO, the way
 * the other hundred-odd list endpoints already do, and let the global
 * ValidationPipe answer 400. This file asserts that no DTO gets added without
 * the bounds, and that no controller goes back to parsing the raw string.
 */

import * as fs from 'fs';
import * as path from 'path';

import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import {
  MAX_PAGE_NUMBER,
  MAX_PAGE_SIZE,
} from '../common/validators/pagination.constants';
import { EffectivePriceQueryDto, SearchItemsQueryDto } from './catalog/dto';
import { MAX_PRICE_QUANTITY } from './catalog/catalog.constants';
import { ListRefundsQueryDto } from './payment/dto';
import { MatchForLeadQueryDto } from './realty-inventory/dto';
import { ListTeamQueryDto } from './tenant/dto/list-team-query.dto';
import { ListApiKeysQueryDto } from './integrations/dto/list-api-keys-query.dto';
import { ListConversationsQueryDto } from './conversation/dto';

// ─────────────────────────────────────────────
// Helpers — the real production pipe
// ─────────────────────────────────────────────

function productionPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
}

function meta(metatype: unknown): ArgumentMetadata {
  return { type: 'query', metatype: metatype as ArgumentMetadata['metatype'] };
}

async function rejects(metatype: unknown, payload: unknown): Promise<boolean> {
  try {
    await productionPipe().transform(payload, meta(metatype));
    return false;
  } catch (err) {
    return err instanceof BadRequestException;
  }
}

async function accepted<T>(metatype: unknown, payload: unknown): Promise<T> {
  return (await productionPipe().transform(payload, meta(metatype))) as T;
}

// ─────────────────────────────────────────────
// The endpoints that used to parse raw strings
// ─────────────────────────────────────────────

/**
 * [label, DTO, the DTO's other required fields, whether it carries a `page`]
 *
 * The base payload matters: the production pipe runs `forbidNonWhitelisted`, so
 * a probe cannot share one payload across DTOs — an extra key is itself a
 * rejection, and every assertion below would pass for the wrong reason.
 */
const CONVERTED: Array<[string, unknown, Record<string, unknown>, boolean]> = [
  ['GET /catalog/items/search', SearchItemsQueryDto, { q: 'saree' }, false],
  ['GET /payments/refunds', ListRefundsQueryDto, {}, true],
  ['POST /realty/leads/:leadId/match', MatchForLeadQueryDto, {}, false],
  ['GET /auth/team', ListTeamQueryDto, {}, false],
  ['GET /api-keys', ListApiKeysQueryDto, {}, false],
];

describe('endpoints that read limit as a raw query string now validate it', () => {
  it.each(CONVERTED)('%s rejects a non-numeric limit rather than 500ing', async (_l, dto, base) => {
    // Previously `parseInt('abc')` → NaN → Prisma validation error → 500.
    expect(await rejects(dto, { ...base, limit: 'abc' })).toBe(true);
  });

  it.each(CONVERTED)('%s rejects a limit past the ceiling', async (_l, dto, base) => {
    expect(await rejects(dto, { ...base, limit: MAX_PAGE_SIZE + 1 })).toBe(true);
  });

  it.each(CONVERTED)('%s rejects a zero or negative limit', async (_l, dto, base) => {
    expect(await rejects(dto, { ...base, limit: 0 })).toBe(true);
    expect(await rejects(dto, { ...base, limit: -1 })).toBe(true);
  });

  it.each(CONVERTED)('%s rejects a fractional limit', async (_l, dto, base) => {
    // A fractional `take` is another PrismaClientValidationError.
    expect(await rejects(dto, { ...base, limit: 10.5 })).toBe(true);
  });

  it.each(CONVERTED)('%s still accepts an ordinary limit', async (_l, dto, base) => {
    // A bound that rejects real input is a bug, not a defence.
    expect(await rejects(dto, { ...base, limit: 25 })).toBe(false);
  });

  it.each(CONVERTED.filter(([, , , hasPage]) => hasPage))(
    '%s rejects page 0, which computed a negative skip',
    async (_l, dto) => {
      expect(await rejects(dto, { page: 0 })).toBe(true);
    },
  );
});

describe('the converted endpoints keep their defaults', () => {
  it('catalog search still defaults to 10 results', async () => {
    const dto = await accepted<SearchItemsQueryDto>(SearchItemsQueryDto, { q: 'saree' });
    expect(dto.limit).toBe(10);
  });

  it('catalog search requires a term and bounds its length', async () => {
    // This route read `q` as a bare @Query() too, so R49's search-term cap —
    // which lives on ItemQueryDto — never applied to it.
    expect(await rejects(SearchItemsQueryDto, {})).toBe(true);
    expect(await rejects(SearchItemsQueryDto, { q: '' })).toBe(true);
    expect(await rejects(SearchItemsQueryDto, { q: 'x'.repeat(201) })).toBe(true);
    expect(await rejects(SearchItemsQueryDto, { q: 'x'.repeat(200) })).toBe(false);
  });

  it('the lead matcher still defaults to 3 matches', async () => {
    // The default matters more here than elsewhere: this route writes the
    // result back with setMatchedUnits, so a limit that silently became NaN
    // replaced the lead's stored matches with an empty set.
    const dto = await accepted<MatchForLeadQueryDto>(MatchForLeadQueryDto, {});
    expect(dto.limit).toBe(3);
  });

  it('refund listing still defaults to page 1, 20 per page', async () => {
    const dto = await accepted<ListRefundsQueryDto>(ListRefundsQueryDto, {});
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  it('refund listing rejects a non-UUID filter instead of passing it to Prisma', async () => {
    expect(await rejects(ListRefundsQueryDto, { paymentId: 'not-a-uuid' })).toBe(true);
    expect(await rejects(ListRefundsQueryDto, { orderId: "' OR 1=1 --" })).toBe(true);
  });
});

describe('page is bounded above, not just below', () => {
  it('rejects an absurd page rather than 500ing on the computed skip', async () => {
    // Past roughly 1e20 the computed skip stops being an integer Prisma
    // accepts. `@Min(1)` alone let that through.
    expect(await rejects(ListConversationsQueryDto, { page: 1e21 })).toBe(true);
    expect(await rejects(ListConversationsQueryDto, { page: MAX_PAGE_NUMBER + 1 })).toBe(true);
  });

  it('still accepts paging deep enough for any real list', async () => {
    expect(await rejects(ListConversationsQueryDto, { page: MAX_PAGE_NUMBER })).toBe(false);
    expect(await rejects(ListConversationsQueryDto, { page: 500 })).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Codebase-wide sweep
// ─────────────────────────────────────────────

describe('no pagination parameter is declared without a bound', () => {
  const MODULES_DIR = __dirname;

  function dtoFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...dtoFiles(full));
      else if (
        entry.name.endsWith('.ts') &&
        !entry.name.includes('.spec.') &&
        full.includes(`${path.sep}dto${path.sep}`)
      )
        out.push(full);
    }
    return out;
  }

  /**
   * Pagination properties whose decorator block carries no `@Max`.
   *
   * Only *request* properties are considered: a response DTO spells the same
   * names (`limit!: number` on a paginated envelope) but carries no validation
   * decorators at all, and there is nothing to bound on the way out. The
   * decorator-block walk below naturally skips those — they have no `@IsInt`.
   */
  function unboundedPaginationProps(file: string): string[] {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const found: string[] = [];

    lines.forEach((line, i) => {
      const match = /^\s*(?:readonly\s+)?(limit|page|offset|pageSize|perPage)\??\s*:\s*number/.exec(
        line,
      );
      if (!match) return;

      const block: string[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j]!.trim();
        if (prev === '' || prev.endsWith(';') || prev.endsWith('{') || prev.endsWith('}')) break;
        block.push(prev);
      }
      // No validation decorators at all → a response field, not a request one.
      if (!block.some((l) => l.startsWith('@IsInt') || l.startsWith('@IsNumber'))) return;

      if (!block.some((l) => l.startsWith('@Max'))) {
        found.push(`${path.relative(MODULES_DIR, file)}:${i + 1} ${match[1]}`);
      }
    });

    return found;
  }

  it('finds no unbounded limit or page in any DTO', () => {
    expect(dtoFiles(MODULES_DIR).flatMap(unboundedPaginationProps)).toEqual([]);
  });

  it('is actually scanning DTO files, not an empty set', () => {
    expect(dtoFiles(MODULES_DIR).length).toBeGreaterThan(10);
  });
});

describe('no controller parses a pagination parameter by hand', () => {
  const MODULES_DIR = __dirname;

  function controllerFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...controllerFiles(full));
      else if (entry.name.endsWith('.controller.ts') && !entry.name.includes('.spec.'))
        out.push(full);
    }
    return out;
  }

  it('declares no pagination parameter as a bare @Query string', () => {
    // The shape this file exists to stop coming back: `@Query('limit') limit?:
    // string` followed by a parseInt. It reads as ordinary NestJS and skips
    // every bound the DTOs carry.
    const offenders = controllerFiles(MODULES_DIR).flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) =>
          /@Query\(\s*['"](limit|page|offset|pageSize|perPage)['"]\s*\)/.test(line),
        )
        .map(({ n, line }) => `${path.relative(MODULES_DIR, file)}:${n} ${line.trim()}`),
    );

    expect(offenders).toEqual([]);
  });

  it('is actually scanning controllers', () => {
    expect(controllerFiles(MODULES_DIR).length).toBeGreaterThan(15);
  });
});

// ─────────────────────────────────────────────
// The same failure, on a number that is money
// ─────────────────────────────────────────────

/**
 * `GET /catalog/items/:itemId/price?quantity=`.
 *
 * The scanner above looks for pagination names, so this one sat outside it for
 * as long as it existed: a bare `@Query('quantity') quantity?: string` run
 * through `parseInt`, feeding `totalPaise: finalPricePaise * quantity`.
 *
 * The consequences are worse than a paginated list's, because the output is a
 * price the AI quotes to a customer and a payment link can be built from:
 * `abc` produced `NaN`, which `JSON.stringify` renders as `null` — a 200
 * response with no price and no error — while `-5` produced a negative total
 * and `1.5` was silently truncated to a quantity nobody asked for.
 */
describe('the price endpoint bounds its quantity', () => {
  it('rejects a non-numeric quantity instead of answering with null', async () => {
    expect(await rejects(EffectivePriceQueryDto, { quantity: 'abc' })).toBe(true);
  });

  it('rejects a negative quantity, which produced a negative price', async () => {
    expect(await rejects(EffectivePriceQueryDto, { quantity: -5 })).toBe(true);
    expect(await rejects(EffectivePriceQueryDto, { quantity: 0 })).toBe(true);
  });

  it('rejects a fractional quantity rather than truncating it', async () => {
    expect(await rejects(EffectivePriceQueryDto, { quantity: 1.5 })).toBe(true);
  });

  it('rejects a quantity that would take the total past a safe integer', async () => {
    // `1e400` parsed to Infinity, which also serialises as null. Paise are an
    // integer by rule #4 or they are not money.
    expect(await rejects(EffectivePriceQueryDto, { quantity: MAX_PRICE_QUANTITY + 1 })).toBe(
      true,
    );
    expect(await rejects(EffectivePriceQueryDto, { quantity: 1e400 })).toBe(true);
  });

  it('keeps the total inside a safe integer at the ceiling', () => {
    // The bound is only worth having if it actually bounds the arithmetic.
    // ₹10,00,000 an item is far past anything in a small-business catalogue.
    const generousItemPricePaise = 1_000_000 * 100;
    expect(MAX_PRICE_QUANTITY * generousItemPricePaise).toBeLessThan(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('still accepts an ordinary quantity, and defaults to one', async () => {
    expect(await rejects(EffectivePriceQueryDto, { quantity: 3 })).toBe(false);
    const dto = await accepted<EffectivePriceQueryDto>(EffectivePriceQueryDto, {});
    expect(dto.quantity).toBe(1);
  });

  it('validates variantId as a uuid, so a junk id is a 400 not a 404', async () => {
    expect(await rejects(EffectivePriceQueryDto, { variantId: 'not-a-uuid' })).toBe(true);
  });
});

describe('no controller runs parseInt on a raw query string', () => {
  // The scanner above is keyed on parameter *names*, which is why `quantity`
  // escaped it for as long as it did. This one is keyed on the mistake itself:
  // any hand-parse of a @Query() value skips the pipe, and what the value is
  // called has nothing to do with whether that is safe.
  const MODULES_DIR = __dirname;

  function controllerSources(dir: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...controllerSources(full));
      else if (entry.name.endsWith('.controller.ts') && !entry.name.includes('.spec.'))
        out.push([path.relative(MODULES_DIR, full), fs.readFileSync(full, 'utf8')]);
    }
    return out;
  }

  it('has no parseInt / parseFloat / Number() over a @Query-bound string', () => {
    const offenders = controllerSources(MODULES_DIR).flatMap(([file, src]) => {
      // The parameter names bound as bare @Query() strings in this file…
      const queryParams = [
        ...src.matchAll(/@Query\(\s*['"]([\w.]+)['"]\s*\)\s*(\w+)/g),
      ].map((m) => m[2]!);
      if (queryParams.length === 0) return [];

      // …and any line that hand-parses one of them.
      return src
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) =>
          queryParams.some((p) =>
            new RegExp(`(parseInt|parseFloat|Number)\\(\\s*${p}\\b`).test(line),
          ),
        )
        .map(({ n, line }) => `${file}:${n} ${line.trim()}`);
    });

    expect(offenders).toEqual([]);
  });
});
