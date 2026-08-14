/**
 * Contract: no user-supplied search term reaches a Prisma `contains` unescaped.
 *
 * Prisma compiles `contains` to `ILIKE '%' || term || '%'` with the term bound
 * as a parameter — which is why SQL injection is not the exposure here and never
 * was. The exposure is that `%`, `_` and `\` keep their LIKE meaning inside the
 * pattern, so the term stops being a string the caller is searching for and
 * becomes a pattern they are executing against the tenant's data:
 *
 *   q=%      matches every row, from a sequential scan of the whole table
 *   q=50%    matches "500 rupees" — the wrong results, silently
 *   q=\      is unfindable, because `%\%` reads as an escaped percent
 *
 * Measured on 40k rows with migration 0034's GIN index in place, the term "50%"
 * went from a 16.69 ms sequential scan returning 1,622 wrong rows to a 0.35 ms
 * bitmap index scan returning the right 25. The escaping is both the correctness
 * fix and the cost fix.
 *
 * Two things are asserted. The static sweep is the durable half: nothing about a
 * fresh `contains: filters.search` looks wrong at review time, and it behaves
 * perfectly for every search anyone actually types, so only a scan catches the
 * next one. The behavioural tests below it pin that the sweep is checking
 * something real by asserting on the query the repositories emit.
 */

import * as fs from 'fs';
import * as path from 'path';

import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../common/services/prisma.service';
import { escapeLikeTerm } from '../common/utils/search-pattern.util';
import { MessageRepository } from './message/message.repository';
import { ContactRepository } from './contact/contact.repository';
import { ConversationRepository } from './conversation/conversation.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

// ─────────────────────────────────────────────
// Static sweep
// ─────────────────────────────────────────────

describe('no Prisma `contains` is fed a raw search term', () => {
  const SRC_ROOT = path.join(__dirname, '..');

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (entry.name.endsWith('.ts') && !entry.name.includes('.spec.')) out.push(full);
    }
    return out;
  }

  /**
   * The expression each `contains:` is given, paired with where it appears.
   *
   * Only the value up to the next `,` or `}` is taken, which is enough for every
   * spelling in this codebase — the argument is always a single identifier,
   * literal, or call.
   */
  function containsExpressions(file: string): Array<{ line: number; expr: string }> {
    const found: Array<{ line: number; expr: string }> = [];
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        // `contains:` as an object key, not the `.contains(` array method or a
        // property named `contains` in an interface declaration.
        const match = /(?<![.\w])contains:\s*([^,}]+)/.exec(line);
        if (!match) return;
        found.push({ line: i + 1, expr: match[1]!.trim().replace(/;$/, '') });
      });
    return found;
  }

  /** Locals assigned from the escaper, so `contains: search` is recognised. */
  function escapedLocals(file: string): Set<string> {
    const names = new Set<string>();
    const source = fs.readFileSync(file, 'utf8');
    const re = /(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*escape(?:Optional)?LikeTerm\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) names.add(m[1]!);
    return names;
  }

  function offenders(): string[] {
    const bad: string[] = [];

    for (const file of sourceFiles(SRC_ROOT)) {
      const expressions = containsExpressions(file);
      if (expressions.length === 0) continue;

      const locals = escapedLocals(file);
      const rel = path.relative(SRC_ROOT, file);

      for (const { line, expr } of expressions) {
        // A string literal is written by us, not by a caller.
        if (/^['"`]/.test(expr)) continue;
        // A type position (`contains: string[]`) inside an interface
        // declaration, not a Prisma filter. Payment's fraud-signal shape has
        // one; it is a field type, and there is no term to escape.
        if (/^(string|number|boolean)(\[\])?$/.test(expr)) continue;
        if (/^escape(Optional)?LikeTerm\(/.test(expr)) continue;
        if (locals.has(expr)) continue;

        bad.push(`${rel}:${line} contains: ${expr}`);
      }
    }
    return bad;
  }

  it('finds no unescaped search term anywhere in src', () => {
    // Listing the offenders rather than counting them, so a failure names the
    // file and line to fix.
    expect(offenders()).toEqual([]);
  });

  it('is actually scanning files that use `contains`', () => {
    // A scan that matched nothing would pass the assertion above forever,
    // including on the day every escape is removed.
    const withContains = sourceFiles(SRC_ROOT).filter(
      (f) => containsExpressions(f).length > 0,
    );
    expect(withContains.length).toBeGreaterThan(5);
  });
});

// ─────────────────────────────────────────────
// Behavioural — the query the repositories emit
// ─────────────────────────────────────────────

describe('search repositories emit an escaped pattern', () => {
  let messages: MessageRepository;
  let contacts: ContactRepository;
  let conversations: ConversationRepository;
  let prisma: {
    messages: { findMany: jest.Mock };
    clients: { findMany: jest.Mock; count: jest.Mock };
    conversations: { findMany: jest.Mock; count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      messages: { findMany: jest.fn().mockResolvedValue([]) },
      clients: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      conversations: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageRepository,
        ContactRepository,
        ConversationRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    messages = module.get(MessageRepository);
    contacts = module.get(ContactRepository);
    conversations = module.get(ConversationRepository);
  });

  it('escapes a percent in a message search', async () => {
    await messages.search(BUSINESS_ID, '50%', {});

    const where = prisma.messages.findMany.mock.calls[0]![0].where;
    expect(where.text_content.contains).toBe('50\\%');
    // Still scoped and still insensitive — the escaping must not have displaced
    // anything else in the filter.
    expect(where.business_id).toBe(BUSINESS_ID);
    expect(where.text_content.mode).toBe('insensitive');
  });

  it('escapes a bare percent, the term that would return the whole table', async () => {
    await messages.search(BUSINESS_ID, '%', {});

    expect(prisma.messages.findMany.mock.calls[0]![0].where.text_content.contains).toBe('\\%');
  });

  it('leaves an ordinary message search untouched', async () => {
    await messages.search(BUSINESS_ID, 'order confirmed', {});

    expect(prisma.messages.findMany.mock.calls[0]![0].where.text_content.contains).toBe(
      'order confirmed',
    );
  });

  it('escapes across every OR branch of a contact search', async () => {
    // The multi-column searches are the easier ones to half-fix: escaping the
    // name branch and forgetting phone leaves the hole open.
    await contacts.findMany(BUSINESS_ID, { search: '_%' });

    const or = prisma.clients.findMany.mock.calls[0]![0].where.OR as Array<
      Record<string, { contains: string }>
    >;
    expect(or.length).toBeGreaterThan(1);
    for (const branch of or) {
      const field = Object.keys(branch)[0]!;
      expect(branch[field]!.contains).toBe('\\_\\%');
    }
  });

  it('escapes across every OR branch of a conversation search', async () => {
    await conversations.list(BUSINESS_ID, { search: '100%' });

    const or = prisma.conversations.findMany.mock.calls[0]![0].where.OR as Array<
      Record<string, { contains: string }>
    >;
    expect(or.length).toBeGreaterThan(1);
    for (const branch of or) {
      const field = Object.keys(branch)[0]!;
      expect(branch[field]!.contains).toBe('100\\%');
    }
  });

  it('passes an injection-shaped term through as ordinary text', async () => {
    // It was never dangerous — the term is a bound parameter. This pins that
    // the escaping does not mangle it into something unsearchable either.
    const payload = "'; DROP TABLE messages; --";
    await messages.search(BUSINESS_ID, payload, {});

    expect(prisma.messages.findMany.mock.calls[0]![0].where.text_content.contains).toBe(
      escapeLikeTerm(payload),
    );
    expect(prisma.messages.findMany.mock.calls[0]![0].where.text_content.contains).toBe(payload);
  });
});
