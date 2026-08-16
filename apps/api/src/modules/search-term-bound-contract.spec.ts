/**
 * Contract: every free-text search parameter is length-bounded.
 *
 * These terms all end up in a Prisma `contains` with `mode: 'insensitive'`,
 * which Postgres runs as `ILIKE '%term%'` against the GIN trigram indexes
 * migration 0034 added. That is the right plan for a search box and a bad deal
 * for an abusive one: pg_trgm extracts a trigram per character of the pattern
 * and then rechecks every candidate row against the whole pattern, so the cost
 * scales with a value the caller chooses. A query string can carry kilobytes,
 * which turns one ordinary list call into a sustained burn on a database this
 * deployment shares with another service.
 *
 * The conversation inbox has been capped at 200 since its list DTO was written.
 * Seven other search surfaces — contacts, clients, catalog, leads, canned
 * responses, message search and the knowledge base — had no cap at all, which
 * is the failure this file exists to stop recurring: nothing about an
 * unbounded `@IsString()` looks wrong at review time, and the endpoint behaves
 * perfectly for every real search anyone types.
 *
 * Two things are asserted: each known search DTO rejects an over-long term
 * through the real ValidationPipe, and no *new* search parameter is declared
 * without a cap.
 */

import * as fs from 'fs';
import * as path from 'path';

import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import { SEARCH_TERM_MAX_LENGTH } from '../common/validators/search-term.constants';
import { ListContactsQueryDto } from './contact/dto';
import { ListClientsQueryDto } from './client-intelligence/dto';
import { ItemQueryDto } from './catalog/dto';
import { ListCannedResponsesQueryDto } from './canned-response/dto';
import { MessageSearchQueryDto } from './message/dto';
import { SearchKnowledgeQueryDto } from './ai-engine/dto';
import { ListConversationsQueryDto } from './conversation/dto';
import { SearchMessagesQueryDto } from './conversation-search/dto';

/** The exact pipe configuration from main.ts. */
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

const TOO_LONG = 'a'.repeat(SEARCH_TERM_MAX_LENGTH + 1);
const AT_LIMIT = 'a'.repeat(SEARCH_TERM_MAX_LENGTH);

/** [label, DTO, the search property's name] */
const SEARCH_DTOS: Array<[string, unknown, string]> = [
  ['GET /contacts', ListContactsQueryDto, 'search'],
  ['GET /clients', ListClientsQueryDto, 'search'],
  // ListClientsQueryDto carries two independent free-text inputs.
  ['GET /clients (q)', ListClientsQueryDto, 'q'],
  ['GET /catalog/items', ItemQueryDto, 'search'],
  ['GET /canned-responses', ListCannedResponsesQueryDto, 'search'],
  ['GET /messages/search', MessageSearchQueryDto, 'q'],
  ['GET /ai/knowledge/search', SearchKnowledgeQueryDto, 'q'],
  ['GET /conversations', ListConversationsQueryDto, 'q'],
  // Full-text search rather than ILIKE, so the pg_trgm cost story above does
  // not apply — but `websearch_to_tsquery` parses the whole term and a
  // kilobyte-long query is still work the caller chose. Same cap, same reason.
  ['GET /search/messages', SearchMessagesQueryDto, 'q'],
];

describe('search terms are length-bounded', () => {
  it.each(SEARCH_DTOS)('%s rejects a term past the cap', async (_label, dto, prop) => {
    expect(await rejects(dto, { [prop]: TOO_LONG })).toBe(true);
  });

  it.each(SEARCH_DTOS)('%s still accepts a term at the cap', async (_label, dto, prop) => {
    // The bound has to be generous enough that it never fires on a real
    // search; a cap that rejects ordinary input is a bug, not a defence.
    expect(await rejects(dto, { [prop]: AT_LIMIT })).toBe(false);
  });

  it.each(SEARCH_DTOS)('%s accepts an ordinary search', async (_label, dto, prop) => {
    expect(await rejects(dto, { [prop]: 'priya sharma' })).toBe(false);
  });
});

describe('no search parameter is declared without a cap', () => {
  const MODULES_DIR = __dirname;

  /** Every DTO file under src/modules. */
  function dtoFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...dtoFiles(full));
      else if (entry.name.endsWith('.ts') && !entry.name.includes('.spec.') && full.includes(`${path.sep}dto${path.sep}`))
        out.push(full);
    }
    return out;
  }

  /**
   * Search-shaped string properties and whether a `@MaxLength` appears in the
   * decorator block immediately above them.
   */
  function uncappedSearchProps(file: string): string[] {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const found: string[] = [];

    lines.forEach((line, i) => {
      const match = /^\s*(?:readonly\s+)?(search|searchTerm|term|q|query)[?!]\s*:\s*string/.exec(line);
      if (!match) return;
      // Walk back over the contiguous decorator block for this property.
      const block: string[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j]!.trim();
        if (prev === '' || prev.endsWith(';') || prev.endsWith('{') || prev.endsWith('}')) break;
        block.push(prev);
      }
      if (!block.some((l) => l.startsWith('@MaxLength'))) {
        found.push(`${path.relative(MODULES_DIR, file)}:${i + 1} ${match[1]}`);
      }
    });

    return found;
  }

  it('finds no uncapped search parameter in any DTO', () => {
    const offenders = dtoFiles(MODULES_DIR).flatMap(uncappedSearchProps);

    expect(offenders).toEqual([]);
  });

  it('is actually scanning DTO files, not an empty set', () => {
    // A scan that silently matches nothing would pass the assertion above
    // forever, including on the day the caps are removed.
    expect(dtoFiles(MODULES_DIR).length).toBeGreaterThan(10);
  });
});
