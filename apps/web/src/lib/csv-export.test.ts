import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadCsv, toCsv, leadsToCsv, LEAD_CSV_COLUMNS } from './csv-export';
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

describe('downloadCsv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clicks a temporary anchor carrying the filename, then cleans it up', () => {
    // The whole export button rides on this: an anchor is created, clicked and
    // removed within one tick, so nothing observable is left in the document.
    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    const click = vi.fn();
    const realCreate = document.createElement.bind(document);
    const anchor = realCreate('a');
    anchor.click = click;
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'a' ? anchor : realCreate(tag),
    );

    downloadCsv('leads.csv', 'A,B\r\n1,2');

    expect(click).toHaveBeenCalledOnce();
    expect(anchor.download).toBe('leads.csv');
    expect(anchor.href).toContain('blob:mock-url');
    expect(createObjectURL).toHaveBeenCalledOnce();
    // The object URL has to be revoked or every export leaks the blob for the
    // lifetime of the tab.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(document.body.contains(anchor)).toBe(false);

    vi.unstubAllGlobals();
  });

  it('builds a UTF-8 text/csv blob so Excel reads ₹ and Devanagari correctly', () => {
    let seen: BlobPropertyBag | undefined;
    const createObjectURL = vi.fn(() => 'blob:mock-url');
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    // Stub the click too: letting jsdom follow a real anchor logs a
    // "Not implemented: navigation" warning on every run.
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') el.click = vi.fn();
      return el;
    });
    const RealBlob = globalThis.Blob;
    vi.stubGlobal(
      'Blob',
      class extends RealBlob {
        constructor(parts: BlobPart[], options?: BlobPropertyBag) {
          super(parts, options);
          seen = options;
        }
      },
    );

    downloadCsv('leads.csv', 'A\r\n₹1');

    expect(seen?.type).toBe('text/csv;charset=utf-8;');
    vi.unstubAllGlobals();
  });

  it('is a no-op on the server, where there is no document', () => {
    // Next.js may evaluate this module during SSR; touching `document` there
    // would crash the render rather than just skipping the download.
    const doc = globalThis.document;
    // @ts-expect-error — deliberately simulating the server environment.
    delete globalThis.document;
    expect(() => downloadCsv('leads.csv', 'A,B')).not.toThrow();
    globalThis.document = doc;
  });
});
