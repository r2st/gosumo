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
 * must carry a `business_id` predicate, and creates must set one. A method that
 * legitimately queries across tenants has to be named in one of the three
 * exemption sets below — CROSS_TENANT_LOOKUPS (opaque external identifier),
 * PRE_AUTHENTICATION_LOOKUPS (no tenant exists yet), GLOBAL_SWEEPS (scheduled,
 * returns only the discriminator) — each with the reason written out.
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
  // Razorpay payment-link callback for an EOI: the link id is the gateway's,
  // and the row is what identifies the tenant.
  'RealtyIntegrationsRepository.findAnyEoiByPaymentLink',
  // Data-export archive download: the lookup key is the SHA-256 of a one-time
  // token, so it cannot be scoped by a column the caller supplies. Unlike the
  // gateway lookups above, the request *does* carry a tenant, and
  // `downloadArchive` compares the resolved row's `business_id` and `id`
  // against it before reading a single byte — the archive itself comes back
  // through `findPayload`, which is scoped. The unscoped read resolves the
  // secret; it decides nothing.
  'ExportJobRepository.findByTokenHash',
]);

/**
 * Login-path lookups, which run *before* any tenant is known.
 *
 * A sign-in form supplies an email or a Google subject id and nothing else —
 * there is no JWT yet, so there is no `businessId` to scope by. The row these
 * resolve is precisely what establishes the tenant; every query afterwards uses
 * the `business_id` read back from it.
 *
 * Unlike CROSS_TENANT_LOOKUPS the identifier here is guessable, so the safety
 * property is different and worth stating: resolving the row proves nothing on
 * its own. `login` still verifies a password hash and `handleGoogleLogin` still
 * verifies a Google-issued profile before any token is minted, and both return
 * the same failure whether the row was missing or the credential was wrong.
 */
const PRE_AUTHENTICATION_LOOKUPS = new Set<string>([
  'AuthRepository.findTeamMemberByEmail',
  'AuthRepository.findTeamMemberByGoogleId',
]);

/**
 * Scheduled sweeps that deliberately span every tenant.
 *
 * These are driven by cron/ops entry points with no request tenant at all: they
 * enumerate work across the install and then re-enter the normal scoped path
 * once per business. The rule they must satisfy is that they return only the
 * tenant discriminator (or a bare count) — never tenant *content* — so nothing
 * crosses a boundary even though the query does.
 */
const GLOBAL_SWEEPS = new Set<string>([
  // Retention cron: returns the distinct business_id list, then purges per
  // business through the scoped path.
  'ComplianceRepository.listBusinessIdsWithLeads',
  // Soak-readiness gauge on GET realty/ops/health — a count, no rows.
  'RealtyDlqRepository.countPendingGlobal',
  // Nightly Sheets export: iterates connections and calls exportForBusiness()
  // with each row's own business_id.
  'RealtyIntegrationsRepository.listConnectedByProvider',
  // Stuck-notification recovery sweep (cron, no request tenant): returns only
  // the notification id and its business_id, then re-enters the scoped
  // `findById` per row before touching anything. It must span tenants — the
  // question it asks is *which* tenants are holding notifications whose
  // delivery job was lost.
  'NotificationRepository.findStuckGlobal',
  // Webhook DLQ backlog gauge on GET webhook-log/dlq/stats — a count, no rows.
  'WebhookDlqRepository.countPendingGlobal',
  // Webhook retry recovery sweep (cron, no request tenant): returns only the
  // entry id and its business_id, then re-enters the scoped retry path per
  // row. It must span tenants — a parked webhook can predate any resolvable
  // tenant, so `business_id` is nullable on that table.
  'WebhookDlqRepository.listDueGlobal',
  // AI quality rollup (cron, no request tenant): aggregates one closed time
  // bucket across every tenant, GROUP BY business_id. Each returned group
  // carries its own business_id and every write that follows is keyed by it.
  // It must span tenants — the question is *which* tenants decided anything
  // in the bucket, and asking per tenant would be one full scan per tenant.
  'AiQualityRepository.aggregateWindow',
  // "How far behind is the rollup" — a property of the job, not of a tenant.
  // Returns one timestamp and no rows.
  'AiQualityRepository.latestComputedBucketStart',
  // Export-archive expiry sweep (cron, no request tenant): returns only the job
  // id and its business_id, then expires each through the scoped path. It must
  // span tenants — an archive holding a customer's personal data past its
  // retention window is the thing being swept, and asking per tenant would mean
  // enumerating every business on every tick.
  'ExportJobRepository.findExpiredGlobal',
  // Export-build recovery sweep (cron, no request tenant): same shape and same
  // reason. A job whose build was lost between Postgres and Redis is stranded
  // in PENDING with nothing but its age to distinguish it.
  'ExportJobRepository.findStuckGlobal',
]);

/** Every documented reason a query may legitimately omit the tenant predicate. */
function isExemptFromTenantScoping(label: string): boolean {
  return (
    CROSS_TENANT_LOOKUPS.has(label) ||
    PRE_AUTHENTICATION_LOOKUPS.has(label) ||
    GLOBAL_SWEEPS.has(label)
  );
}

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
 * Repository methods that still query a tenant table with no `business_id` in
 * the predicate.
 *
 * Round 3 closed every entry that was here: the read-then-write pairs now fold
 * the tenant into the write's own `where`, and the methods that never received
 * a `businessId` had one threaded through from their call sites. What remains
 * legitimately cross-tenant moved into the three exemption sets above, each
 * with the property that makes it safe.
 *
 * Both lists are asserted to be *exactly* the set of violations (see
 * `theBaselineIsExact`), so they are now a floor, not a debt register: adding
 * an unscoped query fails the build, and there is nothing left to remove. Keep
 * them empty. If a genuinely tenant-free query is needed, it belongs in an
 * exemption set with a written reason, not here.
 */
const UNSCOPED_READ_BASELINE = new Set<string>([]);

const UNSCOPED_WRITE_BASELINE = new Set<string>([]);

// ─────────────────────────────────────────────
// Recording Prisma double
// ─────────────────────────────────────────────

interface PrismaCall {
  model: string;
  op: string;
  args: Record<string, unknown>;
  /** SQL text, for `$queryRaw`-family calls only. Parameters appear as `?`. */
  sql?: string;
}

/**
 * The SQL text of a `$queryRaw`-family call, with parameters collapsed to `?`.
 *
 * Two call shapes reach here. The tagged-template form (`$queryRaw`...``) is
 * invoked with a TemplateStringsArray and the interpolated values; interleaving
 * the static fragments with the rendered values yields the statement with each
 * bind hole marked. The `...Unsafe` form takes the statement as a plain string.
 *
 * **An interpolated value may itself be SQL.** A repository that composes its
 * WHERE — `` Prisma.join(this.conditions(businessId, f), ' AND ') `` spliced in
 * as `${where}` — puts the tenant predicate in a `Prisma.Sql` *value*, not in
 * the template's static text. Collapsing that to a bare `?` hid the entire
 * clause, so the tenant check below read a correctly-scoped statement as having
 * no `business_id` at all. Worse than the false alarm: it would equally have hidden
 * a composed WHERE that really had dropped the tenant, which is the leak this
 * file exists to catch. `sqlFragmentText` renders those values instead.
 */
function rawSql(args: unknown[]): string {
  const [first, ...values] = args;
  if (typeof first === 'string') return first;
  if (!Array.isArray(first)) return '';
  return first
    .map((chunk, i) => (i < values.length ? `${chunk}${sqlFragmentText(values[i])}` : String(chunk)))
    .join('');
}

/**
 * A value interpolated into a raw template: its own SQL text if it is a
 * `Prisma.Sql` fragment, otherwise `?` for the bind hole it becomes.
 *
 * `Prisma.Sql` flattens nested fragments when it is constructed, so a joined
 * fragment's `strings` already hold the full text and its `values` are plain
 * binds. The recursion is the belt-and-braces case, not the common one.
 */
function sqlFragmentText(value: unknown): string {
  const frag = value as { strings?: unknown; values?: unknown } | null;
  if (!frag || typeof frag !== 'object' || !Array.isArray(frag.strings)) return '?';

  const binds = Array.isArray(frag.values) ? frag.values : [];
  return frag.strings
    .map((chunk, i) => (i < binds.length ? `${chunk}${sqlFragmentText(binds[i])}` : String(chunk)))
    .join('');
}

/**
 * Stands in for a `Prisma.Decimal` column on a read row.
 *
 * `add` is here because a repository that sums two rows' money — merging two
 * contacts' lifetime spend — calls it on the value it read, and a plain number
 * would take the method down before its later writes were recorded.
 */
interface DecimalLike {
  toNumber(): number;
  toString(): string;
  add(other: DecimalLike | number): DecimalLike;
}

function decimalLike(value: number): DecimalLike {
  return {
    toNumber: () => value,
    toString: () => String(value),
    add: (other) => decimalLike(value + (typeof other === 'number' ? other : other.toNumber())),
  };
}

/**
 * The canonical row: what the double returns from a read, and what the harness
 * hands to a parameter that takes a *record* rather than an id.
 *
 * Those are deliberately the same object. A repository method that accepts an
 * already-fetched row (`revertMerge(businessId, merge, …)`) is being handed
 * something its caller got from a read, so the harness models it with what a
 * read returns. Anything missing here makes the method throw part-way, and
 * every query it would have made afterwards goes unrecorded — an unscoped
 * write hiding behind an `undefined.toNumber()`. See the "drives every method
 * to completion" test.
 */
function recordRow(): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: RECORD_ID,
    business_id: BUSINESS_ID,
    tags: [],
    metadata: {},
    profile: {},
    amount_paise: 0,
    created_at: new Date(0),
    updated_at: new Date(0),
    deleted_at: null,
    // Columns that repositories dereference on the row they just read.
    name: null,
    email: null,
    phone: null,
    avatar_url: null,
    total_orders: 0,
    total_spent: decimalLike(0),
    // Read off the row a `SELECT … FOR UPDATE` locks before a balance check.
    amount: decimalLike(0),
    first_seen_at: new Date(0),
    last_interaction_at: null,
    // An audit row handed back to the operation that undoes it: the two
    // contacts it moved rows between, and the snapshot it restores from.
    survivor_id: RECORD_ID,
    duplicate_id: RECORD_ID,
    snapshot: { duplicate: {}, survivorBefore: {}, relocated: {} },
  };
  // An `include: { client: true }` read hands back a row whose relation is
  // itself a row. It is a *copy*, not a self-reference: these rows are now also
  // handed to methods as arguments, and the assertions `JSON.stringify` the
  // arguments a method passed to Prisma. A cycle there throws before a single
  // tenant value is checked, which reads as a repository failure and is not
  // one. One level is what a repository actually dereferences.
  row['client'] = { ...row };
  return row;
}

function makeRecordingPrisma(): { prisma: PrismaService; calls: PrismaCall[] } {
  const calls: PrismaCall[] = [];

  const row = recordRow();

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
        if (model === '$queryRaw' || model === '$queryRawUnsafe') {
          return (...a: unknown[]) => {
            calls.push({ model, op: 'raw', args: {}, sql: rawSql(a) });
            // One row, not none. A raw read that locks a row before deciding
            // something — `SELECT … FOR UPDATE` ahead of a balance check —
            // treats an empty result as "not found" and throws, which hides
            // every query the method would have made afterwards from the
            // isolation assertions. Those later writes are the ones that most
            // need checking.
            return Promise.resolve([row]);
          };
        }
        if (model === '$executeRaw' || model === '$executeRawUnsafe') {
          return (...a: unknown[]) => {
            calls.push({ model, op: 'raw', args: {}, sql: rawSql(a) });
            return Promise.resolve(0);
          };
        }
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
    // Payloads that carry whole rows rather than ids — the two contacts a merge
    // is given, which it reads tags and totals off before writing anything.
    survivor: recordRow(),
    duplicate: recordRow(),
    // Money and score fields get fed to `new Prisma.Decimal(...)`, which throws
    // on undefined and takes the method down before it reaches its query.
    amountRupees: 100,
    subtotal: 100,
    total: 100,
    taxAmount: 0,
    discountAmount: 0,
    responseSpeedScore: 0,
    showupIntegrityScore: 0,
    splitHonoringScore: 0,
    documentationHygieneScore: 0,
    compositeScore: 0,
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

/**
 * True for the parameter a repository method treats as its patch/payload.
 *
 * `params` is in the list because on a repository in this codebase that name is
 * the payload object, not an options bag — `create(params: { businessId, … })`.
 * Filling it with `{}` meant a `create` stamped `business_id: undefined` and
 * read as a repository that forgets its tenant; the bag-shaped parameters are
 * spelled `filters` / `options` / `criteria` and are still handled as bags.
 */
function isDataParameter(name: string): boolean {
  return /(data|dto|input|payload|updates|patch|record|entry|params)$/i.test(name);
}

/**
 * Parameters that take an already-fetched row rather than an id or a patch.
 *
 * These get the same object a read returns (`recordRow`). Left to the fallback
 * they became a bare id string, and every field the method reached for on them
 * was `undefined` — which showed up not as an error but as a write whose
 * `where` was `{ id: undefined }`, indistinguishable from a genuinely unscoped
 * write.
 */
function isRecordParameter(name: string): boolean {
  return /^(merge|survivor|duplicate|client|contact|conversation|row)$/i.test(name);
}

/** Parameters that take a Prisma transaction client. */
function isTransactionParameter(name: string): boolean {
  return /^(tx|trx|prisma|client_?tx)$/i.test(name);
}

/**
 * How the harness fills the data/patch parameter.
 *
 * `full` supplies a wide object so a `create` finds whatever field it reaches
 * for; `empty` supplies `{}` to drive the other side of every
 * `if (data.x !== undefined)` guard.
 */
type DataMode = 'full' | 'empty';

/**
 * Picks a plausible value for a parameter based on its name.
 *
 * `tx` gets the recording double itself, not a second one: a method that takes
 * a transaction client records into the same call log as the method that opened
 * the transaction, which is what the isolation assertions read.
 */
function valueForParameter(
  name: string,
  dataMode: DataMode = 'full',
  tx?: PrismaService,
): unknown {
  if (/^_?(business|tenant)_?id$/i.test(name)) return BUSINESS_ID;
  if (isTransactionParameter(name)) return tx;
  if (isRecordParameter(name)) return recordRow();
  if (isDataParameter(name)) return dataMode === 'empty' ? {} : dataObject();
  // Bulk-write collections. A plural payload parameter has to arrive as an
  // array: a repository that maps over it blows up on a scalar, which reads as
  // a repository bug rather than a harness one. `empty` drives the
  // short-circuit side of the usual `if (rows.length === 0) return` guard.
  if (/(steps|rows|items|entries|records|payloads)$/i.test(name)) {
    return dataMode === 'empty' ? [] : [dataObject()];
  }
  if (/(tags|labels|localities|amenities)$/i.test(name)) return ['alpha'];
  if (/range$/i.test(name)) return { from: new Date(0), to: new Date(1) };
  // `query` is the exception in this group: on a repository it is always the
  // free-text search term (`search(businessId, query: string, filters)`), never
  // an options bag — the bag is spelled `filters` here. Handing it `{}` used to
  // be invisible because the value went straight into a Prisma `contains`,
  // which the recording double never validates; now that search terms are
  // escaped before they get there, a non-string is caught at the call.
  if (/^q(uery)?$|(term|search)$/i.test(name)) return 'search term';
  if (/(filters?|options?|opts|params|criteria|where)$/i.test(name)) return {};
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

async function runMethod(
  repo: DiscoveredRepository,
  method: string,
  dataMode: DataMode = 'full',
): Promise<MethodRun> {
  const { prisma, calls } = makeRecordingPrisma();
  const instance = new repo.cls(prisma);

  const fn = (repo.cls.prototype as Record<string, unknown>)[method];
  const args = parameterNames(fn).map((p) => valueForParameter(p, dataMode, prisma));

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

/**
 * Whether a raw statement reads or writes any table carrying `business_id`.
 *
 * Table names are taken from the positions SQL puts them in — after FROM,
 * JOIN, UPDATE, INSERT INTO, DELETE FROM — and matched against the tenant
 * models parsed from the schema. Names that are not tenant tables (a CTE, a
 * `jsonb_array_elements` call, `businesses` itself) simply do not match, so
 * statements touching only those are not asserted against.
 */
function rawTouchesTenantTable(sql: string): boolean {
  const names = [...sql.matchAll(/\b(?:from|join|update|into)\s+"?(\w+)"?/gi)].map((m) =>
    (m[1] as string).toLowerCase(),
  );
  return names.some((n) => TENANT_MODELS.has(n));
}

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

const READ_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  // `findUnique` is as much a read as `findFirst`, and its `where` takes only a
  // unique key — so on a table whose unique key is `id` it cannot be scoped at
  // all, and the call has to become a `findFirst`. Leaving these two out let
  // `findUniqueOrThrow({ where: { id } })` read any tenant's row unchallenged.
  'findUnique',
  'findUniqueOrThrow',
]);
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

  it('drives every method to completion, not just to its first query', async () => {
    // A method that throws part-way still records the queries it managed to
    // make, so the isolation assertions below pass on a partial trace — the
    // queries after the throw are simply invisible. `mergeClients` was exactly
    // this: it died on `undefined.toNumber()` reading a row the double did not
    // model, three lines before two unscoped `clients.update` calls.
    //
    // Any new entry here is a repository method whose later queries are no
    // longer being checked. Model whatever the double is missing rather than
    // adding to a waiver list.
    const runs = await Promise.all(
      METHOD_CASES.map(async ([label, repo, method]) => ({
        label,
        error: (await runMethod(repo, method)).error,
      })),
    );

    const failed = runs
      .filter((r) => r.error)
      .map((r) => `${r.label}: ${r.error?.message}`);

    expect(failed).toEqual([]);
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

    if (unscoped.length > 0 && isExemptFromTenantScoping(label)) {
      // Documented above: an opaque external identifier, a pre-authentication
      // identity lookup, or a scheduled cross-tenant sweep.
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

    if (unscoped.length > 0 && isExemptFromTenantScoping(label)) return;

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

  /**
   * Raw SQL is checked too, and by a deliberately blunt rule.
   *
   * The model proxy above sees `prisma.conversations.findMany(...)`; it cannot
   * see `prisma.$queryRaw`, which reaches Postgres as opaque text. Every raw
   * statement in the repositories is correctly scoped today, but nothing was
   * asserting it, so the tenant ratchet had a hole exactly the width of the
   * hand-written SQL — the queries least likely to get it right.
   *
   * The rule: a statement naming a tenant table must mention `business_id`.
   * That is weaker than the structured check, which knows *which* WHERE the
   * predicate sits in. It has to be — several of these scope a joined table
   * transitively (`FROM clients c JOIN channel_contacts cc ON cc.client_id =
   * c.id WHERE c.business_id = ?`), which is correct and which a per-table
   * rule would reject. Blunt and honest beats precise and wrong: this catches
   * the statement that forgot the tenant entirely, which is the mistake that
   * actually leaks rows.
   */
  it.each(METHOD_CASES)('%s scopes the raw SQL it runs', async (label, repo, method) => {
    const { calls } = await runMethod(repo, method);

    const unscoped = calls
      .filter((c) => c.op === 'raw' && c.sql)
      .filter((c) => rawTouchesTenantTable(c.sql as string))
      .filter((c) => !/\bbusiness_id\b/i.test(c.sql as string))
      .map((c) => (c.sql as string).replace(/\s+/g, ' ').trim().slice(0, 120));

    // `listBusinessIdsWithLeads` is the one raw statement that spans tenants on
    // purpose; it is in GLOBAL_SWEEPS with the reason written out.
    if (unscoped.length > 0 && isExemptFromTenantScoping(label)) return;

    expect(unscoped).toEqual([]);
  });

  /**
   * The raw check above passes trivially if no raw statement is ever recorded —
   * which is exactly what happened before this change, when the double returned
   * `[]` for `$queryRaw` without noting the call. This asserts the tap is live:
   * the repositories run raw SQL against tenant tables, and the harness sees it.
   */
  it('actually observes the raw SQL the repositories run', async () => {
    const seen: string[] = [];

    for (const [label, repo, method] of METHOD_CASES) {
      const { calls } = await runMethod(repo, method);
      if (calls.some((c) => c.op === 'raw' && c.sql && rawTouchesTenantTable(c.sql))) {
        seen.push(label);
      }
    }

    // eslint-disable-next-line no-console
    console.log(`${seen.length} repository methods run raw SQL against a tenant table`);
    expect(seen.length).toBeGreaterThanOrEqual(15);
  });
});

// ─────────────────────────────────────────────
// Partial updates
// ─────────────────────────────────────────────

/**
 * A partial update must touch only the fields it was given.
 *
 * Most update methods here are hand-written field-by-field
 * (`if (data.name !== undefined) updateData.name = data.name`), and the failure
 * mode is a line that reaches for `data.x ?? null` instead: the column is then
 * nulled out on every PATCH that omits `x`, silently destroying data the caller
 * never mentioned. That is invisible in a test that always sends a full body,
 * which is exactly how these methods are usually exercised.
 *
 * So each method is driven twice — once with a wide patch, once with `{}` — and
 * the empty run is checked for columns being written to `null` that the full
 * run set to a value.
 */
/**
 * Methods that issue an UPDATE but are semantically a *create*, so writing every
 * column — including nulling the ones the caller omitted — is the point rather
 * than the bug. Each needs its reason written out, like the tenant-scoping
 * exemptions above.
 */
const FULL_OVERWRITES = new Set<string>([
  // Reviving a soft-deleted row so its shortcut can be reused. The caller asked
  // to create a new canned response, not to undelete the old one, so every
  // field must come from the new payload and none may survive from the deleted
  // row — an omitted `category`/`channel` has to land as null.
  'CannedResponseRepository.restore',
]);

describe('Partial updates only write the fields they were given', () => {
  const WRITE_ONLY = METHOD_CASES.filter(([label, repo, method]) => {
    if (FULL_OVERWRITES.has(label)) return false;
    const fn = (repo.cls.prototype as Record<string, unknown>)[method];
    return parameterNames(fn).some(isDataParameter);
  });

  it('finds the update methods to check', () => {
    // A drop here means the check below quietly stopped covering anything.
    expect(WRITE_ONLY.length).toBeGreaterThan(40);
  });

  it.each(WRITE_ONLY)('%s does not null out an omitted column', async (_label, repo, method) => {
    const full = await runMethod(repo, method, 'full');
    const empty = await runMethod(repo, method, 'empty');

    const valuedUnderFullPatch = new Set<string>();
    for (const call of full.calls.filter((c) => WRITE_OPS.has(c.op))) {
      const data = (call.args.data ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(data)) {
        if (v !== null && v !== undefined) valuedUnderFullPatch.add(`${call.model}.${k}`);
      }
    }

    const nulled: string[] = [];
    for (const call of empty.calls.filter((c) => WRITE_OPS.has(c.op))) {
      const data = (call.args.data ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(data)) {
        if (v === null && valuedUnderFullPatch.has(`${call.model}.${k}`)) {
          nulled.push(`${call.model}.${k}`);
        }
      }
    }

    // A column here is one the caller can set but cannot leave alone.
    expect(nulled).toEqual([]);
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
      if (isExemptFromTenantScoping(label)) continue;
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

  it('has nothing left in it', () => {
    // The debt is paid. These are zero and must stay zero — a query that
    // genuinely cannot carry a tenant goes in an exemption set with a reason,
    // not back onto a baseline.
    expect(UNSCOPED_READ_BASELINE.size).toBe(0);
    expect(UNSCOPED_WRITE_BASELINE.size).toBe(0);
  });
});
