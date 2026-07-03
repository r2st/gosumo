/**
 * sheets-row-mapper unit tests — the pure lead/inventory → spreadsheet-row
 * mapping. No I/O; verifies column order, paise→rupee conversion, BLTC coverage,
 * and header alignment.
 */

import {
  paiseToRupeeCell,
  leadToRow,
  buildLeadsSheet,
  unitToRow,
  buildInventorySheet,
} from './sheets-row-mapper';
import { LEADS_SHEET_HEADERS, INVENTORY_SHEET_HEADERS } from '../realty-integrations.constants';
import type { LeadResponseDto } from '../../realty-leads/realty-leads.service';
import type {
  ProjectResponseDto,
  UnitResponseDto,
} from '../../realty-inventory/realty-inventory.service';

const CREATED = new Date('2026-07-01T10:00:00Z');

function makeLead(overrides: Partial<LeadResponseDto> = {}): LeadResponseDto {
  return {
    id: 'lead-1',
    businessId: 'biz-1',
    assignedAgentId: 'agent-9',
    conversationId: null,
    clientId: null,
    whatsappPhone: '+919876543210',
    altPhone: null,
    email: 'buyer@example.com',
    name: 'Rahul Sharma',
    languagePref: 'hinglish',
    source: 'PORTAL',
    subSource: '99acres',
    listingRef: 'Wakad 2BHK',
    firstTouchAt: CREATED,
    bltc: {
      budgetMinPaise: 5000000_00,
      budgetMaxPaise: 7500000_00,
      localities: ['Wakad', 'Baner'],
      timelineMonths: 3,
      config: '2BHK',
      purpose: 'END_USE',
      financing: 'NEEDS_LOAN',
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
    exchangeStatus: 'NONE',
    nextFollowupAt: null,
    lastActivityAt: CREATED,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectResponseDto> = {}): ProjectResponseDto {
  return {
    id: 'proj-1',
    businessId: 'biz-1',
    name: 'Godrej Emerald',
    developer: 'Godrej Properties',
    locality: 'Thane West',
    reraNumber: 'P51700000123',
    possessionDate: new Date('2027-12-01T00:00:00Z'),
    status: 'UC',
    amenities: [],
    priceBandMinPaise: null,
    priceBandMaxPaise: null,
    factSheetDocId: null,
    commissionTerms: {},
    networkVisibility: 'PRIVATE',
    isActive: true,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function makeUnit(overrides: Partial<UnitResponseDto> = {}): UnitResponseDto {
  return {
    id: 'unit-1',
    businessId: 'biz-1',
    projectId: 'proj-1',
    config: '2BHK',
    carpetSqft: 720,
    builtupSqft: 950,
    floor: 12,
    facing: 'East',
    basePricePaise: 6500000_00,
    allInPricePaise: 7200000_00,
    availability: 'AVAILABLE',
    verifiedAt: CREATED,
    isFresh: true,
    networkVisibility: 'PRIVATE',
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

describe('paiseToRupeeCell', () => {
  it('converts integer paise to a 2dp rupee string', () => {
    expect(paiseToRupeeCell(2500000)).toBe('25000.00');
    expect(paiseToRupeeCell(99)).toBe('0.99');
  });

  it('returns empty string for null/undefined', () => {
    expect(paiseToRupeeCell(null)).toBe('');
    expect(paiseToRupeeCell(undefined)).toBe('');
  });
});

describe('leadToRow', () => {
  it('emits a cell for every Leads header column (aligned length)', () => {
    const row = leadToRow(makeLead());
    expect(row).toHaveLength(LEADS_SHEET_HEADERS.length);
  });

  it('carries all BLTC fields with paise converted to rupees', () => {
    const row = leadToRow(makeLead());
    expect(row).toContain('5000000.00'); // budget min in rupees (₹50L)
    expect(row).toContain('7500000.00'); // budget max in rupees (₹75L)
    expect(row).toContain('Wakad, Baner'); // localities joined
    expect(row).toContain('2BHK');
    expect(row).toContain(3); // timeline months
    expect(row).toContain('END_USE');
    expect(row).toContain('NEEDS_LOAN');
  });

  it('includes stage, temperature, source and assigned agent', () => {
    const row = leadToRow(makeLead());
    expect(row).toContain('QUALIFIED');
    expect(row).toContain('HOT');
    expect(row).toContain('PORTAL');
    expect(row).toContain('agent-9');
  });

  it('renders opt-out as YES/NO and tolerates empty optional fields', () => {
    const row = leadToRow(
      makeLead({ optOut: true, name: null, email: null, altPhone: null }),
    );
    expect(row).toContain('YES');
    // Name column empty
    expect(row[1]).toBe('');
  });
});

describe('buildLeadsSheet', () => {
  it('prepends the header row and one row per lead', () => {
    const sheet = buildLeadsSheet([makeLead(), makeLead({ id: 'lead-2' })]);
    expect(sheet).toHaveLength(3);
    expect(sheet[0]).toEqual([...LEADS_SHEET_HEADERS]);
  });
});

describe('unitToRow / buildInventorySheet', () => {
  it('joins project details with unit availability + pricing', () => {
    const row = unitToRow(makeUnit(), makeProject());
    expect(row).toHaveLength(INVENTORY_SHEET_HEADERS.length);
    expect(row).toContain('Godrej Emerald');
    expect(row).toContain('Thane West');
    expect(row).toContain('P51700000123');
    expect(row).toContain('7200000.00'); // all-in price rupees (₹72L)
    expect(row).toContain('AVAILABLE');
    expect(row).toContain('YES'); // isFresh
  });

  it('flattens project→units into a single sheet with a header', () => {
    const sheet = buildInventorySheet([
      { project: makeProject(), units: [makeUnit(), makeUnit({ id: 'unit-2' })] },
      { project: makeProject({ id: 'proj-2' }), units: [] },
    ]);
    expect(sheet[0]).toEqual([...INVENTORY_SHEET_HEADERS]);
    expect(sheet).toHaveLength(3); // header + 2 units (empty project contributes none)
  });
});
