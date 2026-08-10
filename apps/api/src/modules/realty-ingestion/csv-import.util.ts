/**
 * CSV bulk-import helpers (pure, unit-tested).
 *
 * The frontend usually parses the uploaded file to JSON rows, but a robust
 * text parser is provided too (header row + quoted-field aware) so the same
 * logic is testable and reusable. Each row is normalized to a lead candidate;
 * rows without a recoverable E.164 phone become errors (never silently dropped).
 * De-duplication on phone is handled downstream by `ingestLead` (one buyer,
 * one history) — a repeat phone in the file simply merges.
 */

import { normalizeIndianPhone, LeadSource } from '@gosumo/shared';

export interface RawCsvRow {
  phone?: string;
  name?: string;
  email?: string;
  source?: string;
  subSource?: string;
  listingRef?: string;
}

export interface NormalizedCsvRow {
  /** E.164 phone. */
  phone: string;
  name?: string;
  email?: string;
  source: string;
  subSource?: string;
  listingRef?: string;
}

export interface CsvRowError {
  row: number;
  reason: string;
}

/** Column-header aliases → canonical field. Case/space/underscore-insensitive. */
const HEADER_ALIASES: Record<string, keyof RawCsvRow> = {
  phone: 'phone',
  mobile: 'phone',
  phonenumber: 'phone',
  contact: 'phone',
  whatsapp: 'phone',
  name: 'name',
  fullname: 'name',
  email: 'email',
  emailid: 'email',
  source: 'source',
  subsource: 'subSource',
  campaign: 'subSource',
  listing: 'listingRef',
  listingref: 'listingRef',
  property: 'listingRef',
  project: 'listingRef',
};

function canonicalHeader(header: string): keyof RawCsvRow | null {
  const key = header.trim().toLowerCase().replace(/[\s_]+/g, '');
  return HEADER_ALIASES[key] ?? null;
}

/** Split one CSV line honouring double-quoted fields (with "" escaping). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Parse raw CSV text (with a header row) into raw rows keyed by canonical field.
 * Unknown columns are ignored. Blank lines are skipped.
 */
export function parseCsvText(text: string): RawCsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]!).map(canonicalHeader);
  const rows: RawCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const row: RawCsvRow = {};
    headers.forEach((field, idx) => {
      if (!field) return;
      const value = cells[idx];
      if (value !== undefined && value !== '') row[field] = value;
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Normalize a batch of raw rows to lead candidates. Returns the valid
 * candidates and a per-row error list (1-based row numbers, matching how a
 * user reads their spreadsheet — row 1 is the first data row).
 */
export function normalizeCsvRows(rows: RawCsvRow[]): {
  valid: NormalizedCsvRow[];
  errors: CsvRowError[];
} {
  const valid: NormalizedCsvRow[] = [];
  const errors: CsvRowError[] = [];

  rows.forEach((row, idx) => {
    const rowNumber = idx + 1;
    const phone = normalizeIndianPhone(row.phone);
    if (!phone) {
      errors.push({
        row: rowNumber,
        reason: row.phone ? `Invalid phone: "${row.phone}"` : 'Missing phone',
      });
      return;
    }
    valid.push({
      phone,
      name: row.name || undefined,
      email: row.email || undefined,
      source: (row.source as LeadSource) || LeadSource.CSV,
      subSource: row.subSource || undefined,
      listingRef: row.listingRef || undefined,
    });
  });

  return { valid, errors };
}
