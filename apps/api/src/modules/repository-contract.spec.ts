/**
 * Codebase-wide repository contract tests.
 *
 * Root rule #1: every WHERE clause on a tenant table must include
 * `businessId`. `tenant-isolation.repository.spec.ts` asserts that for a
 * hand-maintained list of mutators. This file asserts it for *every* method on
 * *every* repository, and derives the set of tenant tables from the Prisma
 * schema rather than a list someone has to remember to update.
 *
 * How each method is driven:
 *   - PrismaService is a proxy that records `{ model, op, args }` and resolves
 *     to a benign row.
 *   - Arguments are chosen by reading the compiled parameter names, so
 *     `update(businessId, id, data)` gets a tenant UUID, a record UUID and a
 *     data object in the right positions. This is far more reliable than
 *     guessing by arity, and it means a method renamed from `businessId` to
 *     something unrecognisable shows up as undriveable rather than silently
 *     passing.
 *
 * Every emitted query against a tenant table is then checked: reads and writes
 * must carry a `business_id` predicate, and creates must set one. A method
 * that legitimately queries across tenants — a payment-gateway callback
 * resolving an opaque provider id before any tenant is known — has to be named
 * in CROSS_TENANT_LOOKUPS, with the reason.
 */

import * as fs from 'fs';
import * as path from 'path';

import { PrismaService } from '../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const RECORD_ID = '00000000-0000-4000-b000-000000000001';

// ─────────────────────────────────────────────
// Tenant tables, straight from the schema
// ─────────────────────────────────────────────

/**
 * Prisma models carrying a `business_id` column.
 *
 * Parsed from schema.prisma so a new tenant table is covered the moment it is
 * added, and so a table that loses its `business_id` stops being asserted
 * against instead of failing mysteriously.
 */
function tenantModelsFromSchema(): Set<string> {
  const schemaPath = path.resolve(
    __dirname,
    '../../../../packages/database/prisma/schema.prisma',
  );
  const schema = fs.readFileSync(schemaPath, 'utf8');

  const models = new Set<string>();
  let current: string | null = null;

  for (const line of schema.split('\n')) {
    const modelStart = /^model\s+(\w+)\s*\{/.exec(line);
    if (modelStart) {
      current = modelStart[1] ?? null;
      continue;
    }
    if (line.startsWith('}')) {
      current = null;
      continue;
    }
    if (current && /^\s*business_id\s/.test(line)) models.add(current);
  }

  return models;
}

const TENANT_MODELS = tenantModelsFromSchema();

// ─────────────────────────────────────────────
// Documented exemptions
// ─────────────────────────────────────────────

/**
 * Methods that query a tenant table without a tenant predicate, by design.
 *
 * Each one resolves an opaque identifier issued by an outside system — a
 * payment gateway's own id, a provider message id — at a point where no tenant
 * context exists yet. The identifier is unguessable and globally unique, and
 * the caller scopes everything it does afterwards with the `business_id` it
 * reads back from the row.
 *
 * Adding to this list means asserting that property about the new method.
 */
const CROSS_TENANT_LOOKUPS = new Set<string>([
  // Razorpay/Stripe webhooks arrive with only the gateway's identifiers; the
  // row they resolve is what tells us which business the payment belongs to.
  'PaymentRepository.findPaymentByGatewayId',
  'PaymentRepository.findPaymentByGatewayOrderId',
  'PaymentRepository.findPaymentByLinkId',
  'PaymentRepository.findRefundByGatewayId',
  'PaymentRepository.findInvoiceByPaymentId',
  'PaymentRepository.markWebhookProcessed',
]);

/**
 * Methods that create the business itself, so the tenant id in their queries is
 * one they mint rather than one they were handed. The "never hardcodes another
 * tenant" check does not apply to them.
 */
const BUSINESS_CREATING = new Set<string>([
  'AuthRepository.createTeamMemberWithBusiness',
  'AuthRepository.createOAuthTeamMemberWithBusiness',
]);


/**
 * Pre-existing unscoped queries, recorded so this file can run green while the
 * gap it found is closed incrementally.
 *
 * This is a ratchet, not an amnesty. The lists are asserted to be *exactly*
 * the set of violations (see `theBaselineIsExact`), so a new unscoped query
 * fails the build, and closing one here fails until it is removed from the
 * list. The intended direction is only down.
 *
 * The entries fall into two classes, which differ sharply in risk:
 *
 *  1. Read-then-write. The method does a `findFirst` scoped by `business_id`,
 *     throws if it misses, then writes by primary key —
 *     `BookingRepository.updateBooking` is the clearest example. Safe as
 *     written, but the safety lives in a separate statement from the write, so
 *     an edit that reorders or short-circuits the guard silently removes it.
 *     Folding `business_id` into the write's own `where` costs nothing.
 *
 *  2. No tenant available. The method never receives a `businessId` at all —
 *     `SlaRepository.markMet(id, ...)`, `MessageRepository.getLastN(conversationId, n)`.
 *     These delegate isolation entirely to their callers. Any caller that
 *     passes an identifier it did not itself scope reads or writes across
 *     tenants. Closing these means changing the signature, so each needs its
 *     call sites checked.
 */
const UNSCOPED_READ_BASELINE = new Set<string>([
  'AiEngineRepository.getLastMessages',
  'AiEngineRepository.getRecentIntents',
  'AuthRepository.findTeamMemberByEmail',
  'AuthRepository.findTeamMemberByGoogleId',
  'AuthRepository.findTeamMemberById',
  'CartRepository.findItemByProduct',
  'ComplianceRepository.listBusinessIdsWithLeads',
  'MessageRepository.findByExternalId',
  'MessageRepository.getLastN',
  'NotificationRepository.listActiveTriggersForEvent',
  'RealtyDlqRepository.countPendingGlobal',
  'RealtyExchangeRepository.findSyndicationsInvolving',
  'RealtyIntegrationsRepository.findAnyEoiByPaymentLink',
  'RealtyIntegrationsRepository.listConnectedByProvider',
]);

const UNSCOPED_WRITE_BASELINE = new Set<string>([
  'AddressRepository.softDelete',
  'AddressRepository.update',
  'AuthRepository.linkGoogleAccount',
  'AuthRepository.updateLastLogin',
  'AuthRepository.updateTeamMember',
  'BookingRepository.deleteBlock',
  'BookingRepository.deleteConnection',
  'BookingRepository.updateBooking',
  'BookingRepository.updateConnection',
  'BookingRepository.upsertAvailability',
  'BookingRepository.upsertConnection',
  'CartRepository.clearCoupon',
  'CartRepository.clearItems',
  'CartRepository.markConverted',
  'CartRepository.removeItem',
  'CartRepository.setCoupon',
  'CartRepository.touch',
  'CartRepository.updateItemQuantity',
  'CatalogRepository.updateItem',
  'CatalogRepository.updateItemStock',
  'CatalogRepository.updateVariantStock',
  'ClientIntelligenceRepository.findOrCreateClient',
  'ClientIntelligenceRepository.updateClientProfile',
  'ClientIntelligenceRepository.updateIntelligenceScores',
  'ConversationRepository.incrementHumanMessageCount',
  'ConversationRepository.update',
  'ConversationRepository.updateLastMessageAt',
  'CouponRepository.incrementUsage',
  'HitlRepository.updateTask',
  'MessageRepository.setReactions',
  'NotificationRepository.upsertPreference',
  'OrderRepository.updateOrderStatus',
  'PaymentRepository.updateInvoiceStatus',
  'PaymentRepository.updatePaymentStatus',
  'PaymentRepository.updateRefundStatus',
  'RealtyDlqRepository.update',
  'RealtyExchangeRepository.softDeleteResaleListing',
  'RealtyExchangeRepository.softDeleteSyndication',
  'RealtyExchangeRepository.updateResaleListing',
  'RealtyExchangeRepository.updateSyndication',
  'RealtyIntegrationsRepository.recordSync',
  'RealtyIntegrationsRepository.upsertConnection',
  'SlaRepository.markBreachedOnly',
  'SlaRepository.markEscalated',
  'SlaRepository.markMet',
]);

// ─────────────────────────────────────────────
// Recording Prisma double
// ─────────────────────────────────────────────

interface PrismaCall {
  model: string;
  op: string;
  args: Record<string, unknown>;
}

function makeRecordingPrisma(): { prisma: PrismaService; calls: PrismaCall[] } {
  const calls: PrismaCall[] = [];

  const row = {
    id: RECORD_ID,
    business_id: BUSINESS_ID,
    tags: [],
    metadata: {},
    amount_paise: 0,
    created_at: new Date(0),
    updated_at: new Date(0),
    deleted_at: null,
  };

  const modelProxy = (model: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string | symbol) => {
          if (typeof op !== 'string' || op === 'then') return undefined;
          return (args: Record<string, unknown> = {}) => {
            calls.push({ model, op, args });
            if (op === 'count') return Promise.resolve(0);
            if (op === 'aggregate') return Promise.resolve({ _sum: {}, _count: 0, _avg: {} });
            if (op === 'findMany' || op === 'groupBy') return Promise.resolve([]);
            if (op === 'updateMany' || op === 'deleteMany') return Promise.resolve({ count: 1 });
            return Promise.resolve(row);
          };
        },
      },
    );

  const prisma: PrismaService = new Proxy(
    {},
    {
      get: (_t, model: string | symbol) => {
        if (typeof model !== 'string') return undefined;
        if (model === 'then') return undefined; // not a thenable
        if (model === '$transaction') {
          return (arg: unknown) =>
            typeof arg === 'function'
              ? (arg as (tx: unknown) => unknown)(prisma)
              : Promise.all((arg as unknown[]) ?? []);
        }
        if (model === '$queryRaw' || model === '$queryRawUnsafe') return () => Promise.resolve([]);
        if (model === '$executeRaw' || model === '$executeRawUnsafe') return () => Promise.resolve(0);
        return modelProxy(model);
      },
    },
  ) as unknown as PrismaService;

  return { prisma, calls };
}

// ─────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────

type RepositoryClass = new (prisma: PrismaService) => Record<string, unknown>;

interface DiscoveredRepository {
  file: string;
  name: string;
  cls: RepositoryClass;
  methods: string[];
}

function findRepositoryFiles(root: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) findRepositoryFiles(full, out);
    else if (entry.name.endsWith('.repository.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

function discoverRepositories(): DiscoveredRepository[] {
  const found: DiscoveredRepository[] = [];

  for (const file of findRepositoryFiles(__dirname)) {
    const mod = require(file) as Record<string, unknown>;

    for (const [name, exported] of Object.entries(mod)) {
      if (typeof exported !== 'function' || !name.endsWith('Repository')) continue;

      const proto = exported.prototype as Record<string, unknown>;
      const methods = Object.getOwnPropertyNames(proto).filter(
        (m) => m !== 'constructor' && typeof proto[m] === 'function',
      );
      if (methods.length === 0) continue;

      found.push({
        file: path.relative(__dirname, file),
        name,
        cls: exported as RepositoryClass,
        methods: methods.sort(),
      });
    }
  }

  found.sort((a, b) => a.file.localeCompare(b.file));
  return found;
}

const REPOSITORIES = discoverRepositories();

// ─────────────────────────────────────────────
// Building arguments from parameter names
// ─────────────────────────────────────────────

/**
 * A data object wide enough that a `create(data)` method finds whatever field
 * it reaches for. Both casings of the tenant key are present because
 * repositories vary in whether they take the camelCase DTO field or the
 * snake_case column name.
 */
function dataObject(): Record<string, unknown> {
  return {
    businessId: BUSINESS_ID,
    business_id: BUSINESS_ID,
    id: RECORD_ID,
    clientId: RECORD_ID,
    conversationId: RECORD_ID,
    messageId: RECORD_ID,
    orderId: RECORD_ID,
    paymentId: RECORD_ID,
    leadId: RECORD_ID,
    userId: RECORD_ID,
    name: 'contract-test',
    title: 'contract-test',
    slug: 'contract-test',
    content: 'contract-test',
    text: 'contract-test',
    email: 'contract@example.invalid',
    phone: '+919876543210',
    status: 'ACTIVE',
    type: 'GENERIC',
    channel: 'WHATSAPP',
    amountPaise: 1000,
    quantity: 1,
    tags: [],
    metadata: {},
    filter: {},
    isActive: true,
  };
}

/** Reads the compiled parameter list; `[]` when it cannot be parsed. */
function parameterNames(fn: unknown): string[] {
  if (typeof fn !== 'function') return [];
  const source = Function.prototype.toString.call(fn);
  const open = source.indexOf('(');
  if (open === -1) return [];

  // Walk to the matching close paren so default values containing parens do
  // not truncate the list.
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [];

  return source
    .slice(open + 1, close)
    .split(',')
    .map((p) => p.split('=')[0]!.trim())
    .filter(Boolean);
}

/** Picks a plausible value for a parameter based on its name. */
function valueForParameter(name: string): unknown {
  if (/^_?(business|tenant)_?id$/i.test(name)) return BUSINESS_ID;
  if (/(data|dto|input|payload|updates|patch|record|entry)$/i.test(name)) return dataObject();
  if (/(filters?|options?|opts|query|params|criteria|where)$/i.test(name)) return {};
  if (/(ids|list)$/i.test(name)) return [RECORD_ID];
  if (/(limit|offset|page|size|count|days|hours|minutes|score|index|n)$/i.test(name)) return 20;
  if (/(date|since|until|from|to|now|before|after|at)$/i.test(name)) return new Date(0);
  if (/(enabled|active|is[A-Z]|has[A-Z]|include)/.test(name)) return true;
  if (/id$/i.test(name)) return RECORD_ID;
  if (/(status|type|channel|kind|direction|reason|role|band)$/i.test(name)) return 'ACTIVE';
  return RECORD_ID;
}

interface MethodRun {
  calls: PrismaCall[];
  error?: Error;
  /** False when the method took no arguments this harness could supply. */
  driven: boolean;
}

async function runMethod(repo: DiscoveredRepository, method: string): Promise<MethodRun> {
  const { prisma, calls } = makeRecordingPrisma();
  const instance = new repo.cls(prisma);

  const fn = (repo.cls.prototype as Record<string, unknown>)[method];
  const args = parameterNames(fn).map(valueForParameter);

  let error: Error | undefined;
  try {
    await (fn as (...a: unknown[]) => unknown).apply(instance, args);
  } catch (err) {
    error = err as Error;
  }

  return { calls, error, driven: calls.length > 0 };
}

/** Every repository method, flattened, with a Jest-friendly label. */
const METHOD_CASES = REPOSITORIES.flatMap((repo) =>
  repo.methods.map((method) => [`${repo.name}.${method}`, repo, method] as const),
);

/** Reads the tenant predicate out of a `where` clause, including `AND` arrays. */
function whereCarriesTenant(where: unknown, depth = 0): boolean {
  if (!where || typeof where !== 'object' || depth > 5) return false;

  const clause = where as Record<string, unknown>;
  if (clause.business_id !== undefined) return true;
  if (clause.businessId !== undefined) return true;

  for (const key of ['AND', 'OR', 'NOT', 'some', 'every', 'is'] as const) {
    const nested = clause[key];
    if (Array.isArray(nested)) {
      if (nested.some((n) => whereCarriesTenant(n, depth + 1))) return true;
    } else if (nested && whereCarriesTenant(nested, depth + 1)) {
      return true;
    }
  }

  // A relation filter such as `{ conversation: { business_id } }`.
  return Object.values(clause).some(
    (v) => v && typeof v === 'object' && !Array.isArray(v) && whereCarriesTenant(v, depth + 1),
  );
}

const READ_OPS = new Set(['findFirst', 'findMany', 'count', 'aggregate', 'groupBy']);
const WRITE_OPS = new Set(['update', 'updateMany', 'delete', 'deleteMany']);
const CREATE_OPS = new Set(['create', 'createMany', 'upsert']);

// ─────────────────────────────────────────────
// Discovery sanity
// ─────────────────────────────────────────────

describe('Repository discovery', () => {
  it('finds the repositories across the codebase', () => {
    expect(REPOSITORIES.length).toBeGreaterThan(25);
  });

  it('finds their methods', () => {
    expect(METHOD_CASES.length).toBeGreaterThan(300);
  });

  it('reads the tenant tables out of the Prisma schema', () => {
    // If the schema path or the parse breaks, every isolation assertion below
    // would pass vacuously.
    expect(TENANT_MODELS.size).toBeGreaterThan(50);
    expect(TENANT_MODELS.has('messages')).toBe(true);
    expect(TENANT_MODELS.has('conversations')).toBe(true);
    expect(TENANT_MODELS.has('payments')).toBe(true);
    // `businesses` is the tenant itself, keyed by `id`, not `business_id`.
    expect(TENANT_MODELS.has('businesses')).toBe(false);
  });

  it('drives most repository methods to a real query', () => {
    // The harness is only as good as its ability to actually invoke methods.
    // A drop here means the assertions below stopped covering anything.
    return Promise.all(METHOD_CASES.map(([, repo, method]) => runMethod(repo, method))).then(
      (runs) => {
        const driven = runs.filter((r) => r.driven).length;
        // eslint-disable-next-line no-console
        console.log(`${driven}/${runs.length} repository methods reached a Prisma call`);
        expect(driven / runs.length).toBeGreaterThan(0.75);
      },
    );
  });
});

// ─────────────────────────────────────────────
// Tenant isolation
// ─────────────────────────────────────────────

describe('Every repository query on a tenant table is tenant-scoped', () => {
  it.each(METHOD_CASES)('%s scopes its reads to one business', async (label, repo, method) => {
    const { calls } = await runMethod(repo, method);

    const unscoped = calls
      .filter((c) => TENANT_MODELS.has(c.model) && READ_OPS.has(c.op))
      .filter((c) => !whereCarriesTenant(c.args.where))
      .map((c) => `${c.model}.${c.op}`);

    if (unscoped.length > 0 && CROSS_TENANT_LOOKUPS.has(label)) {
      // Documented above: resolves an opaque external identifier before any
      // tenant is known.
      return;
    }

    if (UNSCOPED_READ_BASELINE.has(label)) {
      // Known gap, pinned. Asserting the violation still exists means removing
      // the entry is required the moment it is fixed.
      expect(unscoped.length).toBeGreaterThan(0);
      return;
    }

    // A read with no tenant predicate returns another business's rows.
    expect(unscoped).toEqual([]);
  });

  it.each(METHOD_CASES)('%s scopes its writes to one business', async (label, repo, method) => {
    const { calls } = await runMethod(repo, method);

    const unscoped = calls
      .filter((c) => TENANT_MODELS.has(c.model) && WRITE_OPS.has(c.op))
      .filter((c) => !whereCarriesTenant(c.args.where))
      .map((c) => `${c.model}.${c.op}`);

    if (unscoped.length > 0 && CROSS_TENANT_LOOKUPS.has(label)) return;

    if (UNSCOPED_WRITE_BASELINE.has(label)) {
      expect(unscoped.length).toBeGreaterThan(0);
      return;
    }

    // A bare primary-key write happily mutates another business's row.
    expect(unscoped).toEqual([]);
  });

  it.each(METHOD_CASES)('%s stamps a business on the rows it creates', async (
    _label,
    repo,
    method,
  ) => {
    const { calls } = await runMethod(repo, method);

    const unstamped = calls
      .filter((c) => TENANT_MODELS.has(c.model) && CREATE_OPS.has(c.op))
      .filter((c) => {
        const data = c.args.data ?? (c.args.create as unknown);
        const rows = Array.isArray(data) ? data : [data];
        return rows.some((r) => {
          if (!r || typeof r !== 'object') return true;
          const row = r as Record<string, unknown>;
          // Prisma accepts either the scalar column or a nested connect.
          return (
            row.business_id === undefined &&
            row.businessId === undefined &&
            row.businesses === undefined &&
            row.business === undefined
          );
        });
      })
      .map((c) => `${c.model}.${c.op}`);

    // A row created without a tenant is invisible to every scoped read
    // afterwards, and RLS will reject it outright.
    expect(unstamped).toEqual([]);
  });

  it.each(METHOD_CASES)('%s never hardcodes a tenant other than its argument', async (
    label,
    repo,
    method,
  ) => {
    if (BUSINESS_CREATING.has(label)) return;

    const { calls } = await runMethod(repo, method);

    const serialised = JSON.stringify(
      calls.map((c) => c.args),
      (_k, v) => (v instanceof Date ? v.toISOString() : v),
    );

    // Every tenant value in the emitted queries must be the one passed in.
    const tenantValues = serialised.match(/"business_?[Ii]d":"([^"]+)"/g) ?? [];
    for (const match of tenantValues) {
      expect(match).toContain(BUSINESS_ID);
    }
  });
});

// ─────────────────────────────────────────────
// The ratchet
// ─────────────────────────────────────────────

describe('The unscoped-query baseline is exact', () => {
  /** Recomputes the violation sets from scratch. */
  async function actualViolations(): Promise<{ reads: string[]; writes: string[] }> {
    const reads: string[] = [];
    const writes: string[] = [];

    for (const [label, repo, method] of METHOD_CASES) {
      if (CROSS_TENANT_LOOKUPS.has(label)) continue;
      const { calls } = await runMethod(repo, method);

      const tenantCalls = calls.filter((c) => TENANT_MODELS.has(c.model));
      if (tenantCalls.some((c) => READ_OPS.has(c.op) && !whereCarriesTenant(c.args.where))) {
        reads.push(label);
      }
      if (tenantCalls.some((c) => WRITE_OPS.has(c.op) && !whereCarriesTenant(c.args.where))) {
        writes.push(label);
      }
    }

    return { reads: reads.sort(), writes: writes.sort() };
  }

  it('lists exactly the repositories that read without a tenant predicate', async () => {
    const { reads } = await actualViolations();
    // Equality in both directions is what makes this a ratchet: a new
    // violation fails, and so does a fixed one that was left on the list.
    expect(reads).toEqual([...UNSCOPED_READ_BASELINE].sort());
  });

  it('lists exactly the repositories that write without a tenant predicate', async () => {
    const { writes } = await actualViolations();
    expect(writes).toEqual([...UNSCOPED_WRITE_BASELINE].sort());
  });

  it('is shrinking, not growing', () => {
    // A plain visibility check on the size of the debt. Lower these numbers
    // when entries are removed; they must never be raised.
    expect(UNSCOPED_READ_BASELINE.size).toBeLessThanOrEqual(14);
    expect(UNSCOPED_WRITE_BASELINE.size).toBeLessThanOrEqual(45);
  });
});
