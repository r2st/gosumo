import { describe, expect, it } from 'vitest';
import { toCsv, leadsToCsv, LEAD_CSV_COLUMNS } from './csv-export';
import type { Lead } from './realty-types';

const BOM = '﻿';

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'l1',
    businessId: 'b1',
    assignedAgentId: null,
    conversationId: null,
    clientId: null,
    whatsappPhone: '+919800000001',
    altPhone: null,
    email: 'buyer@example.com',
    name: 'Asha Rao',
    languagePref: 'en',
    source: 'WHATSAPP',
    subSource: null,
    listingRef: null,
    firstTouchAt: '2026-06-01T00:00:00.000Z',
    bltc: {
      budgetMinPaise: 5_000_000_00,
      budgetMaxPaise: 8_000_000_00,
      localities: ['Powai', 'Andheri'],
      timelineMonths: 3,
      config: null,
      purpose: 'END_USE',
      financing: null,
    },
    qualScore: 82,
    temperature: 'HOT',
    stage: 'QUALIFIED',
    matchedUnitIds: [],
    extractedFacts: [],
    objections: [],
    promises: [],
    optOut: false,
    shareConsent: false,
    exchangeStatus: 'PRIVATE',
    nextFollowupAt: null,
    lastActivityAt: null,
    createdAt: '2026-06-01T10:30:00.000Z',
    updatedAt: '2026-06-01T10:30:00.000Z',
    ...overrides,
  } as Lead;
}

describe('toCsv', () => {
  it('emits a BOM, header row, and CRLF-separated body', () => {
    const csv = toCsv([{ a: 1, b: 2 }], [
      { header: 'A', value: (r) => r.a },
      { header: 'B', value: (r) => r.b },
    ]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.slice(BOM.length)).toBe('A,B\r\n1,2');
  });

  it('quotes cells containing commas, quotes, or newlines', () => {
    const csv = toCsv([{ v: 'Powai, Mumbai' }, { v: 'say "hi"' }, { v: 'line1\nline2' }], [
      { header: 'V', value: (r) => r.v },
    ]);
    const lines = csv.slice(BOM.length).split('\r\n');
    expect(lines[1]).toBe('"Powai, Mumbai"');
    expect(lines[2]).toBe('"say ""hi"""');
    expect(lines[3]).toBe('"line1\nline2"');
  });

  it('renders null/undefined as empty cells', () => {
    const csv = toCsv([{ v: null as string | null }], [{ header: 'V', value: (r) => r.v }]);
    expect(csv.slice(BOM.length)).toBe('V\r\n');
  });
});

describe('leadsToCsv', () => {
  it('exports the spec columns in order', () => {
    const headers = leadsToCsv([]).slice(BOM.length).trim();
    expect(headers).toBe(LEAD_CSV_COLUMNS.map((c) => c.header).join(','));
    expect(headers).toContain('Name,Phone,Email,Source,Stage,Temperature,Qual Score,Budget,Localities');
  });

  it('formats budget as a rupee range and joins localities', () => {
    const csv = leadsToCsv([makeLead()]);
    const row = csv.slice(BOM.length).split('\r\n')[1];
    expect(row).toContain('Asha Rao');
    expect(row).toContain('+919800000001');
    expect(row).toContain('WHATSAPP');
    expect(row).toContain('Powai; Andheri');
    // budget range separated by " - " forces quoting via the comma-free rupee format
    expect(row).toMatch(/₹.*-.*₹/);
  });

  it('handles a single-sided or missing budget', () => {
    const openEnded = leadsToCsv([makeLead({ bltc: { ...makeLead().bltc, budgetMaxPaise: null } })]);
    expect(openEnded.slice(BOM.length).split('\r\n')[1]).toMatch(/₹/);

    const none = leadsToCsv([
      makeLead({ bltc: { ...makeLead().bltc, budgetMinPaise: null, budgetMaxPaise: null } }),
    ]);
    // Budget cell is empty when both bounds are absent.
    expect(none.slice(BOM.length).split('\r\n')[1]).toContain('Asha Rao');
  });
});
