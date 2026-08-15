/**
 * Service-layer tenant-scoping ratchet.
 *
 * Root rule #1 — every WHERE clause on a tenant table carries `businessId` —
 * is asserted for repositories by `repository-contract.spec.ts`, which drives
 * each method and inspects the query it emits. Services can't be driven that
 * way: they orchestrate, so reaching a given Prisma call means satisfying
 * whatever branch guards it. This file therefore reads the source instead.
 *
 * That trade is deliberate. A static scan can't prove a query is scoped, but it
 * can prove nobody *named* a tenant in one — and an unscoped query on a tenant
 * table is a cross-tenant read until someone argues otherwise. The argument is
 * what `ALLOWED_UNSCOPED` holds: every entry states why that call has no tenant
 * to scope by. Anything not on the list fails.
 *
 * The scan is deliberately shallow in one direction and careful in another:
 *   - Shallow: it asks whether `business_id`/`businessId` appears in the call's
 *     arguments. It does not check the predicate is on the right field, or that
 *     the value is the caller's tenant. Repository-contract covers that ground
 *     for repositories; here the question is only "did anyone think about the
 *     tenant".
 *   - Careful: `where` is frequently built as a local before the call, so
 *     `findMany({ where })` says nothing on its own. When the argument names a
 *     variable, the scan resolves it back to its object-literal initializer.
 *     Without that it reports scoped queries as violations, and a ratchet that
 *     cries wolf gets an ever-growing waiver list until it means nothing.
 *
 * Note the resolver follows *initializers only*. A tenant predicate bolted on
 * afterwards (`where.business_id = x` under an `if`) is not treated as scoping,
 * because it is conditional by construction — those calls need an explicit
 * waiver saying when the tenant is absent. `ChannelsService.getWebChatEmbed`
 * below is exactly that case.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../../../packages/database/prisma/schema.prisma',
);

// ─────────────────────────────────────────────
// Tenant tables, straight from the schema
// ─────────────────────────────────────────────

/**
 * Prisma models carrying a `business_id` column, and the subset where it is
 * nullable.
 *
 * Derived from the schema rather than a hand-kept list so a new tenant table is
 * covered the moment it lands. Nullability matters for reading the waivers
 * below: on `webhook_events` and `audit_logs` a null tenant is a modelled
 * state — a platform-level row — not an accident.
 */
function tenantModelsFromSchema(): {
  tenantModels: Set<string>;
  nullableTenant: Set<string>;
} {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const tenantModels = new Set<string>();
  const nullableTenant = new Set<string>();
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
    if (!current) continue;
    if (/^\s*business_id\s/.test(line)) {
      tenantModels.add(current);
      if (/^\s*business_id\s+String\?/.test(line)) nullableTenant.add(current);
    }
  }

  return { tenantModels, nullableTenant };
}

const { tenantModels: TENANT_MODELS, nullableTenant: NULLABLE_TENANT } =
  tenantModelsFromSchema();

// ─────────────────────────────────────────────
// Documented exemptions
// ─────────────────────────────────────────────

/**
 * Service-layer queries that touch a tenant table without naming a tenant, by
 * design. Keyed `Class.method`, valued with the reason.
 *
 * The shared property: at each of these points there is no tenant to scope by,
 * because the row being read or written is what *establishes* the tenant.
 * Everything downstream uses the `business_id` read back from it. Adding an
 * entry means asserting that property about the new call.
 */
const ALLOWED_UNSCOPED: Record<string, string> = {
  'ChannelAdapterService.persistAndAnnounce':
    'Resolves the channel_account an inbound provider webhook belongs to. The ' +
    'provider posts a channel type and its own external id and nothing else, ' +
    'so there is no tenant yet — this row is what supplies one, and every ' +
    'later step uses the business_id read back from it.',

  'ChannelAdapterService.recordWebhookDelivery':
    'Dedup insert into webhook_events, which runs before the channel_account ' +
    'lookup that resolves the tenant. webhook_events.business_id is nullable ' +
    'precisely for these platform-level rows, and the insert carries no tenant ' +
    'data — only the provider id it deduplicates on.',

  'ChannelAdapterService.markWebhookProcessed':
    'Stamps the webhook_events row this same request just inserted, by the ' +
    'primary key it returned. The id is not tenant-derived and cannot be ' +
    'guessed from a request; scoping it would mean re-deriving a tenant the ' +
    'row does not carry, for a write that only flips a processing flag.',

  'WebChatGateway.handleInit':
    'Resolves a public web-chat widget id to its channel_account. The widget ' +
    'is embedded on an anonymous visitor page, so the socket carries no tenant ' +
    'until this row supplies one.',

  'ChannelsService.findByExternalId':
    'Deliberately cross-tenant webhook resolution, same contract as ' +
    'handleInboundWebhook: the provider supplies only its own external id.',

  'ChannelsService.getWebChatEmbed':
    'Serves the embed snippet for a widget. Reachable from an authenticated ' +
    'dashboard call, where it does scope by business_id, and from the @Public() ' +
    'embed endpoint, where no tenant exists and the channel id is the only ' +
    'credential. The scoping is therefore conditional and applied after the ' +
    'where object is built, which the resolver intentionally does not count.',
};

// ─────────────────────────────────────────────
// Scan
// ─────────────────────────────────────────────

const READ_WRITE_OPS = [
  'findFirst',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'findFirstOrThrow',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
];
const WRITE_OPS = ['create', 'createMany', 'upsert'];
const OPS = [...READ_WRITE_OPS, ...WRITE_OPS];

/** `this.prisma.orders.findMany(`, `this.db.orders.update(`, `tx.orders.create(`. */
const CALL_PATTERN = new RegExp(
  String.raw`(?:this\.prisma|this\.db|\btx)\.(\w+)\.(` + OPS.join('|') + String.raw`)\(`,
  'g',
);

/**
 * Text between the parentheses of the call whose `(` sits at `open`.
 *
 * Brace-counting rather than a regex because Prisma arguments nest objects
 * several levels deep and routinely contain further calls.
 */
function callArguments(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/** The object-literal initializer of `const <name> = { ... }`, if there is one. */
function objectInitializer(src: string, name: string): string | null {
  const decl = new RegExp(
    String.raw`\b(?:const|let|var)\s+` + name + String.raw`\b[^=]*=\s*`,
  ).exec(src);
  if (!decl) return null;
  const start = decl.index + decl[0].length;
  return src[start] === '{' ? callArguments(src, start) : null;
}

function namesTenant(text: string): boolean {
  return text.includes('business_id') || text.includes('businessId');
}

/**
 * Whether the call names a tenant, directly or through a `where`/`data`
 * variable built just above it.
 */
function callNamesTenant(src: string, args: string): boolean {
  if (namesTenant(args)) return true;

  for (const key of ['where', 'data']) {
    // `where: whereClause` — or shorthand `{ where }`.
    const explicit = new RegExp(String.raw`\b${key}\s*:\s*(\w+)\s*(?:,|}|$)`).exec(args);
    const shorthand = new RegExp(String.raw`(?:^|[{,\s])${key}\s*(?:,|}|$)`).test(args);
    const ident = explicit?.[1] ?? (shorthand ? key : null);
    if (!ident) continue;

    const initializer = objectInitializer(src, ident);
    if (initializer && namesTenant(initializer)) return true;
  }

  return false;
}

/** `ClassName.methodName` enclosing the offset — the key waivers are written against. */
function enclosingMethod(src: string, offset: number): string {
  const head = src.slice(0, offset);

  let className = '?';
  for (const m of head.matchAll(/\bclass\s+(\w+)/g)) className = m[1] as string;

  const NON_METHODS = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
    'constructor',
  ]);
  let methodName = '?';
  const methodDecl =
    /^ {2}(?:public |private |protected )?(?:static )?(?:async )?(\w+)\s*[(<]/gm;
  for (const m of head.matchAll(methodDecl)) {
    const name = m[1] as string;
    if (!NON_METHODS.has(name)) methodName = name;
  }

  return `${className}.${methodName}`;
}

interface Finding {
  key: string;
  file: string;
  line: number;
  model: string;
  op: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    // Repositories are covered far more precisely by repository-contract.spec.ts,
    // which observes the query each method actually emits.
    if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.repository.ts')) {
      continue;
    }
    out.push(full);
  }
  return out;
}

function scan(): { findings: Finding[]; tenantCallCount: number } {
  const findings: Finding[] = [];
  let tenantCallCount = 0;

  for (const file of sourceFiles(SRC_ROOT).sort()) {
    const rel = path.relative(SRC_ROOT, file);
    const src = fs.readFileSync(file, 'utf8');

    for (const match of src.matchAll(CALL_PATTERN)) {
      const [, model, op] = match as unknown as [string, string, string];
      if (!TENANT_MODELS.has(model)) continue;
      tenantCallCount++;

      const open = (match.index as number) + match[0].length - 1;
      if (callNamesTenant(src, callArguments(src, open))) continue;

      findings.push({
        key: enclosingMethod(src, match.index as number),
        file: rel,
        line: src.slice(0, match.index).split('\n').length,
        model,
        op,
      });
    }
  }

  return { findings, tenantCallCount };
}

const { findings: FINDINGS, tenantCallCount: TENANT_CALL_COUNT } = scan();

// ─────────────────────────────────────────────
// Assertions
// ─────────────────────────────────────────────

describe('service-layer tenant scoping', () => {
  it('derives tenant tables from the Prisma schema', () => {
    // A schema path that silently stops resolving would empty TENANT_MODELS and
    // make every assertion below vacuous.
    expect(TENANT_MODELS.size).toBeGreaterThan(20);
    expect(TENANT_MODELS.has('orders')).toBe(true);
    expect(TENANT_MODELS.has('messages')).toBe(true);
    expect(NULLABLE_TENANT.has('webhook_events')).toBe(true);
  });

  it('finds service-layer Prisma calls to check', () => {
    // Likewise: if a refactor moves services off `this.prisma` and the pattern
    // matches nothing, this fails rather than reporting a clean scan.
    expect(TENANT_CALL_COUNT).toBeGreaterThan(20);
  });

  it('scopes every query on a tenant table to its tenant', () => {
    const unwaived = FINDINGS.filter((f) => !(f.key in ALLOWED_UNSCOPED));

    const report = unwaived
      .map(
        (f) =>
          `  ${f.file}:${f.line}  ${f.key}  →  ${f.model}.${f.op}\n` +
          `    No business_id in this query. Add one, or — if this call runs ` +
          `before any tenant\n    exists — add "${f.key}" to ALLOWED_UNSCOPED ` +
          `with the reason.`,
      )
      .join('\n\n');

    expect(report).toBe('');
    expect(unwaived).toEqual([]);
  });

  it('has no stale waivers', () => {
    // The ratchet only tightens if waivers disappear once their call is fixed
    // or deleted. A stale entry is a hole nobody is watching.
    const flagged = new Set(FINDINGS.map((f) => f.key));
    const stale = Object.keys(ALLOWED_UNSCOPED).filter((k) => !flagged.has(k));

    expect(stale).toEqual([]);
  });

  it('states a reason for every waiver', () => {
    for (const [key, reason] of Object.entries(ALLOWED_UNSCOPED)) {
      expect(`${key}: ${reason.length}`).toBe(`${key}: ${reason.length}`);
      expect(reason.length).toBeGreaterThan(80);
    }
  });
});

// ─────────────────────────────────────────────
// The scanner's own tests
// ─────────────────────────────────────────────

/**
 * The scan is only as trustworthy as its parsing. These pin the two behaviours
 * that decide whether a real violation is reported: `where`-variable resolution
 * (whose absence produces false positives) and the refusal to follow
 * conditional assignment (whose absence produces false negatives).
 */
describe('tenant-scoping scanner', () => {
  it('accepts a tenant named inline', () => {
    const src = `await this.prisma.orders.findMany({ where: { business_id: businessId } });`;
    expect(callNamesTenant(src, `{ where: { business_id: businessId } }`)).toBe(true);
  });

  it('flags a query with no tenant anywhere', () => {
    const src = `await this.prisma.orders.findMany({ where: { id } });`;
    expect(callNamesTenant(src, `{ where: { id } }`)).toBe(false);
  });

  it('resolves a where built as a named local', () => {
    const src = [
      `const where: Prisma.ordersWhereInput = { business_id: businessId, deleted_at: null };`,
      `return this.prisma.orders.findMany({ where, orderBy: { name: 'asc' } });`,
    ].join('\n');
    expect(callNamesTenant(src, `{ where, orderBy: { name: 'asc' } }`)).toBe(true);
  });

  it('resolves an explicitly named where variable', () => {
    const src = [
      `const filter = { business_id: businessId };`,
      `return this.prisma.orders.findMany({ where: filter });`,
    ].join('\n');
    expect(callNamesTenant(src, `{ where: filter }`)).toBe(true);
  });

  it('flags a named local that omits the tenant', () => {
    const src = [
      `const where = { id, deleted_at: null };`,
      `return this.prisma.orders.findMany({ where });`,
    ].join('\n');
    expect(callNamesTenant(src, `{ where }`)).toBe(false);
  });

  it('does not count a tenant added conditionally after the fact', () => {
    // Conditional by construction — the branch where it is skipped is exactly
    // the one worth reviewing, so this must stay a finding.
    const src = [
      `const where: Record<string, unknown> = { id: channelId };`,
      `if (businessId) where.business_id = businessId;`,
      `return this.prisma.orders.findFirst({ where });`,
    ].join('\n');
    expect(callNamesTenant(src, `{ where }`)).toBe(false);
  });

  it('resolves a create payload built as a named local', () => {
    const src = [
      `const data = { business_id: businessId, total_paise: 100 };`,
      `return this.prisma.orders.create({ data });`,
    ].join('\n');
    expect(callNamesTenant(src, `{ data }`)).toBe(true);
  });

  it('reads arguments across nested objects and calls', () => {
    const args = callArguments(`f({ where: { a: { b: g(1) } }, take: 5 })`, 1);
    expect(args).toBe(`{ where: { a: { b: g(1) } }, take: 5 }`);
  });

  it('attributes a call to its enclosing class and method', () => {
    const src = [
      `export class OrderService {`,
      `  async listOrders(businessId: string) {`,
      `    return this.prisma.orders.findMany({});`,
      `  }`,
      `}`,
    ].join('\n');
    expect(enclosingMethod(src, src.indexOf('this.prisma'))).toBe(
      'OrderService.listOrders',
    );
  });
});
