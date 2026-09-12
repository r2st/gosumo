/**
 * Append-only ratchet for root rules #6 and #7.
 *
 *   #6  Messages are append-only. Never update message content after storage.
 *   #7  audit_logs is append-only. No UPDATE or DELETE ever runs on this table.
 *
 * `audit_logs` is protected in the database by `audit_logs_no_update` /
 * `audit_logs_no_delete`, so a stray write there fails loudly at runtime — but
 * only at runtime, in production, from whichever code path someone added
 * without a test. `messages` has no such trigger, and the rule is subtler
 * than "no updates": delivery status, read receipts, AI attribution,
 * reactions and metadata legitimately change after the row is written. What
 * must not change is what was *said* — the content, who said it, in which
 * conversation, and when.
 *
 * This file reads the source and asserts both rules for every Prisma call in
 * the API:
 *
 *   - No `update`/`updateMany`/`upsert`/`delete`/`deleteMany` on `audit_logs`,
 *     and no raw SQL that names the table in an UPDATE or DELETE.
 *   - No `delete`/`deleteMany` on `messages`, and no raw SQL that deletes from
 *     it.
 *   - Every `messages.update*`/`upsert` whose `data` literal names one of the
 *     IMMUTABLE_MESSAGE_FIELDS is a finding. A `data` that is not an object
 *     literal at the call site is also a finding, because the scan cannot see
 *     what it writes.
 *
 * A finding fails the file unless it is in ALLOWED_MESSAGE_REWRITES, keyed by
 * `Class.method`, with the reason written out. The only entries today are the
 * DPDPA erasure paths, which overwrite content precisely because the law says
 * the customer may demand it. The list is also checked for staleness: an
 * entry that no longer matches a finding fails too, so a waiver cannot outlive
 * the code it excused.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..');

/**
 * Columns on `messages` that record what was said, by whom, where and when.
 * Everything else on the row (status, receipts, AI attribution, reactions,
 * metadata, search_vector) is derived or operational and may change.
 */
const IMMUTABLE_MESSAGE_FIELDS = new Set([
  'content',
  'text_content',
  'sender_type',
  'sender_id',
  'direction',
  'type',
  'conversation_id',
  'business_id',
  'channel_account_id',
  'sequence',
  'campaign_id',
  'sent_at',
  'created_at',
]);

const ALLOWED_MESSAGE_REWRITES: Record<string, string> = {
  'ComplianceRepository.anonymizeConversationMessages':
    'DPDPA right-to-erasure for one conversation. Clears sender_id and ' +
    'text_content on the customer side so the row survives for auditability ' +
    'but no longer identifies anyone. The overwrite is the point.',

  'ComplianceRepository.anonymizeOldMessages':
    'Retention sweep: same erasure as above, applied to every customer ' +
    'message older than the configured cutoff.',
};

// ─────────────────────────────────────────────
// Source scanning
// ─────────────────────────────────────────────

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

/** Text of the balanced `(...)` starting at `open`, which must be a `(`. */
function callArguments(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/**
 * The object literal assigned to `data:` inside a call's arguments, or null
 * when `data` is not an inline literal (a variable, a spread, a helper call).
 */
function dataLiteral(args: string): string | null {
  const m = /\bdata\s*:\s*\{/.exec(args);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < args.length; i++) {
    const ch = args[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return args.slice(open, i + 1);
    }
  }
  return null;
}

/** Top-level keys of an object literal — those at brace depth 1. */
function topLevelKeys(literal: string): string[] {
  const keys: string[] = [];
  const KEY = /^\s*(?:\.\.\.)?([A-Za-z_]\w*)\s*(?=[:,}])/;
  let depth = 0;
  let i = 0;
  while (i < literal.length) {
    const ch = literal[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;

    // A key can only begin right after the opening brace or a separator, and
    // only at depth 1 — anything deeper belongs to a nested object.
    if (depth === 1 && (ch === '{' || ch === ',')) {
      const m = KEY.exec(literal.slice(i + 1));
      if (m) {
        keys.push(m[1] as string);
        i += m[0].length;
      }
    }
    i++;
  }
  return keys;
}

function enclosingMethod(src: string, offset: number): string {
  const head = src.slice(0, offset);
  let className = '?';
  for (const m of head.matchAll(/\bclass\s+(\w+)/g)) className = m[1] as string;

  const NON_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor']);
  let methodName = '?';
  const methodDecl = /^ {2}(?:public |private |protected )?(?:static )?(?:async )?(\w+)\s*[(<]/gm;
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
  detail: string;
}

interface Scan {
  auditLogWrites: Finding[];
  messageDeletes: Finding[];
  messageRewrites: Finding[];
  rawSql: Finding[];
  messageUpdateCount: number;
}

const AUDIT_LOG_WRITE = /\.audit_logs\.(update|updateMany|upsert|delete|deleteMany)\(/g;
const MESSAGE_DELETE = /\.messages\.(delete|deleteMany)\(/g;
const MESSAGE_UPDATE = /\.messages\.(update|updateMany|upsert)\(/g;
const RAW_SQL = /\$(?:executeRaw|queryRaw|executeRawUnsafe|queryRawUnsafe)\b/g;

function scan(): Scan {
  const result: Scan = {
    auditLogWrites: [],
    messageDeletes: [],
    messageRewrites: [],
    rawSql: [],
    messageUpdateCount: 0,
  };

  for (const file of sourceFiles(SRC_ROOT).sort()) {
    const rel = path.relative(SRC_ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    const lineOf = (i: number): number => src.slice(0, i).split('\n').length;
    const at = (m: RegExpMatchArray, detail: string): Finding => ({
      key: enclosingMethod(src, m.index as number),
      file: rel,
      line: lineOf(m.index as number),
      detail,
    });

    for (const m of src.matchAll(AUDIT_LOG_WRITE)) {
      result.auditLogWrites.push(at(m, `audit_logs.${m[1]}`));
    }
    for (const m of src.matchAll(MESSAGE_DELETE)) {
      result.messageDeletes.push(at(m, `messages.${m[1]}`));
    }

    for (const m of src.matchAll(MESSAGE_UPDATE)) {
      result.messageUpdateCount++;
      const open = (m.index as number) + m[0].length - 1;
      const literal = dataLiteral(callArguments(src, open));
      if (literal === null) {
        result.messageRewrites.push(at(m, `messages.${m[1]} with a non-literal \`data\``));
        continue;
      }
      const touched = topLevelKeys(literal).filter((k) => IMMUTABLE_MESSAGE_FIELDS.has(k));
      if (touched.length > 0) {
        result.messageRewrites.push(at(m, `messages.${m[1]} writes ${touched.join(', ')}`));
      }
    }

    for (const m of src.matchAll(RAW_SQL)) {
      // The template that follows the tag; enough to name the table and verb.
      const window = src.slice(m.index as number, (m.index as number) + 600);
      const verb = /\b(UPDATE|DELETE\s+FROM)\s+(?:"?public"?\.)?"?(audit_logs|messages)"?/i.exec(window);
      if (verb) {
        result.rawSql.push(at(m, `${(verb[1] as string).toUpperCase()} ${verb[2]} via ${m[0]}`));
      }
    }
  }

  return result;
}

/**
 * Rendered as a string and compared to '' so the failure output is the list
 * of offending call sites rather than a diff of Finding objects.
 */
function report(findings: Finding[], advice: string): string {
  if (findings.length === 0) return '';
  const lines = findings.map((f) => `  ${f.file}:${f.line}  ${f.key}  — ${f.detail}`);
  return `${advice}\n${lines.join('\n')}`;
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('append-only contract (root rules #6 and #7)', () => {
  const result = scan();

  it('scans the API source and finds the message status writers', () => {
    // If this drops to zero the scan is looking in the wrong place, and every
    // other assertion in this file passes vacuously.
    expect(result.messageUpdateCount).toBeGreaterThanOrEqual(3);
  });

  describe('audit_logs', () => {
    it('is never updated, upserted or deleted through Prisma', () => {
      expect(
        report(result.auditLogWrites, 'audit_logs is append-only (root rule #7). Found:'),
      ).toBe('');
    });
  });

  describe('messages', () => {
    it('are never deleted through Prisma', () => {
      expect(
        report(result.messageDeletes, 'messages are append-only (root rule #6). Found:'),
      ).toBe('');
    });

    it('never have their content, sender, conversation or timestamps rewritten', () => {
      const unwaived = result.messageRewrites.filter((f) => !(f.key in ALLOWED_MESSAGE_REWRITES));
      expect(
        report(
          unwaived,
          'A messages.update writes a field that records what was said, by whom, ' +
            'where or when (root rule #6). Status, receipts, AI attribution, ' +
            'reactions and metadata may change; these may not. If this is a ' +
            'legally-mandated erasure, add the method to ALLOWED_MESSAGE_REWRITES ' +
            'with the reason.',
        ),
      ).toBe('');
    });

    it('has no stale waivers', () => {
      const flagged = new Set(result.messageRewrites.map((f) => f.key));
      const stale = Object.keys(ALLOWED_MESSAGE_REWRITES).filter((k) => !flagged.has(k));
      // A waiver that no longer matches a finding is a hole nobody is watching.
      expect(stale).toEqual([]);
    });
  });

  it('has no raw SQL that updates or deletes either table', () => {
    expect(
      report(
        result.rawSql,
        'Raw SQL bypasses both the Prisma scan and, for messages, any guard at all:',
      ),
    ).toBe('');
  });

  // ── the scanner itself ──

  describe('scanner', () => {
    it('reads top-level keys of a data literal without descending into nested objects', () => {
      const literal = `{
        status,
        metadata: { content: 'nested is fine', text_content: 'also fine' },
        delivered_at: x ? new Date(x) : undefined,
        ...rest,
      }`;
      expect(topLevelKeys(literal)).toEqual(['status', 'metadata', 'delivered_at', 'rest']);
    });

    it('treats a non-literal data as unreviewable', () => {
      expect(dataLiteral('({ where: { id }, data })')).toBeNull();
      expect(dataLiteral('({ where: { id }, data: patch })')).toBeNull();
      expect(dataLiteral('({ where: { id }, data: { status } })')).toBe('{ status }');
    });
  });
});
