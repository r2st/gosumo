/**
 * `operator_alerts` migration ↔ Prisma model consistency.
 *
 * Migrations here are applied by psql against a database whose end state is the
 * source of truth, and `prisma migrate` is a no-op on flat SQL files. That
 * means nothing checks the two descriptions of this table against each other:
 * a column added to `schema.prisma` and forgotten in the SQL generates a
 * perfectly valid client and fails at runtime on the first insert, in
 * production, on the alerting path — the one path whose failure nobody is
 * alerted about.
 *
 * These cases compare the column names in both directions, and pin the two
 * indexes that are load-bearing but invisible: the unique `dedupe_key` index
 * the raise path relies on to collapse repeats, and the partial
 * `deferred_until` index the release sweep probes (which Prisma cannot express
 * at all, so the model only names it in a comment).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../../../../packages/database/prisma');

const migration = fs.readFileSync(
  path.join(ROOT, 'migrations', '0046_operator_alerts.sql'),
  'utf8',
);
const schema = fs.readFileSync(path.join(ROOT, 'schema.prisma'), 'utf8');

/** The `model operator_alerts { … }` block, field lines only. */
function modelColumns(): string[] {
  const block = /model\s+operator_alerts\s*\{([\s\S]*?)\n\}/.exec(schema);
  expect(block).not.toBeNull();

  const columns: string[] = [];
  for (const raw of ((block as RegExpExecArray)[1] as string).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('///') || line.startsWith('@@')) continue;
    const field = /^(\w+)\s+\S/.exec(line);
    if (!field) continue;
    // Relation fields are not columns.
    if (/@relation\(/.test(line)) continue;
    columns.push(field[1] as string);
  }
  return columns.sort();
}

/** Quoted column names in the CREATE TABLE body. */
function migrationColumns(): string[] {
  const create = /CREATE TABLE IF NOT EXISTS "operator_alerts" \(([\s\S]*?)\n\);/.exec(migration);
  expect(create).not.toBeNull();

  const columns: string[] = [];
  for (const raw of ((create as RegExpExecArray)[1] as string).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('--') || line.startsWith('CONSTRAINT')) continue;
    const col = /^"(\w+)"\s+\S/.exec(line);
    if (col) columns.push(col[1] as string);
  }
  return columns.sort();
}

describe('operator_alerts schema', () => {
  it('describes the same columns in the migration and the Prisma model', () => {
    const columns = modelColumns();
    // Guard against the comparison passing because both parsers found nothing —
    // a regex that stops matching would otherwise turn this file into a no-op.
    expect(columns).toContain('business_id');
    expect(columns.length).toBeGreaterThan(15);

    expect(migrationColumns()).toEqual(columns);
  });

  it('creates the OperatorAlertStatus enum with every value the model declares', () => {
    const block = /enum\s+OperatorAlertStatus\s*\{([\s\S]*?)\n\}/.exec(schema);
    expect(block).not.toBeNull();

    const modelValues = ((block as RegExpExecArray)[1] as string)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+$/.test(line))
      .sort();

    const sqlEnum = /CREATE TYPE "OperatorAlertStatus" AS ENUM \(([\s\S]*?)\);/.exec(migration);
    expect(sqlEnum).not.toBeNull();
    const sqlValues = [...((sqlEnum as RegExpExecArray)[1] as string).matchAll(/'(\w+)'/g)]
      .map((m) => m[1] as string)
      .sort();

    expect(sqlValues).toEqual(modelValues);
  });

  it('makes (business_id, dedupe_key) unique, which is what collapses repeats', () => {
    // Without this index `raise` never sees a P2002 and every re-emitted event
    // becomes another page. The failure is a flood, not an error.
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "operator_alerts_dedupe_key"\s+ON "operator_alerts" \("business_id", "dedupe_key"\)/,
    );
    expect(schema).toContain('@@unique([business_id, dedupe_key], map: "operator_alerts_dedupe_key")');
  });

  it('indexes deferred alerts partially, since Prisma cannot express that', () => {
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS "operator_alerts_deferred_idx"/);
    expect(migration).toMatch(/WHERE "status" = 'DEFERRED'/);
    // The model has no way to declare it, so it must at least point at the
    // migration that owns it — otherwise a schema-first rebuild drops it
    // silently and the release sweep degrades to a full scan.
    expect(schema).toContain('operator_alerts_deferred_idx');
  });

  it('enables row-level security as the tenant-isolation backstop', () => {
    expect(migration).toContain('ALTER TABLE "operator_alerts" ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('operator_alerts_tenant_isolation');
  });

  it('is idempotent, since it is applied by psql against a live database', () => {
    const statements = migration.match(/CREATE (TABLE|INDEX|UNIQUE INDEX)/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    // Every create is guarded; the enum and policy use DO-block guards instead.
    expect(migration.match(/CREATE TABLE(?! IF NOT EXISTS)/g)).toBeNull();
    expect(migration.match(/CREATE INDEX(?! IF NOT EXISTS)/g)).toBeNull();
    expect(migration.match(/CREATE UNIQUE INDEX(?! IF NOT EXISTS)/g)).toBeNull();
  });
});
