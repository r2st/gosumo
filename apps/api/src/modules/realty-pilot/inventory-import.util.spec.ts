/**
 * Pure inventory-import tests (Phase 8). Verifies project grouping, rupee→paise
 * parsing (plain / grouped / lakh / crore), validation, and 1-based row errors.
 */

import { ProjectStatus } from '@gosumo/shared';
import type { InventoryImportRow } from '@gosumo/shared';
import { normalizeInventoryRows, parseRupees } from './inventory-import.util';

describe('parseRupees', () => {
  it('parses plain numbers, comma-grouped, lakh, and crore', () => {
    expect(parseRupees(8500000)).toBe(8500000);
    expect(parseRupees('85,00,000')).toBe(8500000);
    expect(parseRupees('85L')).toBe(8500000);
    expect(parseRupees('85 lakh')).toBe(8500000);
    expect(parseRupees('1.2 Cr')).toBe(12000000);
    expect(parseRupees('₹ 1.2cr')).toBe(12000000);
  });

  it('rejects junk and non-positive values', () => {
    expect(parseRupees('abc')).toBeNull();
    expect(parseRupees('')).toBeNull();
    expect(parseRupees(undefined)).toBeNull();
    expect(parseRupees(0)).toBeNull();
  });

  it('rejects strings that pass the shape check but are not a number', () => {
    // `...` and `.` match /^([\d.]+)$/ but parseFloat them to NaN. Without the
    // Number.isFinite guard these would flow through as a NaN price and land
    // in the DB as a NaN paise integer.
    expect(parseRupees('...')).toBeNull();
    expect(parseRupees('.')).toBeNull();
    expect(parseRupees('..L')).toBeNull();
  });

  it('rejects a zero or negative amount that carries a unit suffix', () => {
    expect(parseRupees('0L')).toBeNull();
    expect(parseRupees('0 crore')).toBeNull();
    expect(parseRupees('0.0Cr')).toBeNull();
  });

  it('rejects non-finite and negative plain numbers', () => {
    expect(parseRupees(Number.NaN)).toBeNull();
    expect(parseRupees(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseRupees(-8500000)).toBeNull();
  });

  it('accepts every documented lakh and crore spelling', () => {
    for (const suffix of ['l', 'lac', 'lacs', 'lakh', 'lakhs']) {
      expect(parseRupees(`85${suffix}`)).toBe(8500000);
    }
    for (const suffix of ['cr', 'crore', 'crores']) {
      expect(parseRupees(`1${suffix}`)).toBe(10000000);
    }
  });
});

describe('normalizeInventoryRows', () => {
  it('groups unit rows under one project and converts prices to paise', () => {
    const rows: InventoryImportRow[] = [
      { projectName: 'Skyline', locality: 'Baner', config: '2BHK', allInPrice: '85L', availability: 'AVAILABLE' },
      { projectName: 'skyline', locality: 'baner', config: '3BHK', allInPrice: '1.1Cr' },
    ];
    const { projects, errors } = normalizeInventoryRows(rows);
    expect(errors).toHaveLength(0);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.units).toHaveLength(2);
    expect(projects[0]!.units[0]!.allInPricePaise).toBe(8500000 * 100);
    expect(projects[0]!.units[0]!.availability).toBe('AVAILABLE');
    expect(projects[0]!.units[1]!.allInPricePaise).toBe(11000000 * 100);
  });

  it('accepts a project-only row (no config) and its price band', () => {
    const { projects, errors } = normalizeInventoryRows([
      { projectName: 'Skyline', locality: 'Baner', priceBandMin: '80L', priceBandMax: '1.5Cr' },
    ]);
    expect(errors).toHaveLength(0);
    expect(projects[0]!.units).toHaveLength(0);
    expect(projects[0]!.priceBandMinPaise).toBe(8000000 * 100);
    expect(projects[0]!.priceBandMaxPaise).toBe(15000000 * 100);
  });

  it('errors (1-based) on a missing project identity', () => {
    const { errors } = normalizeInventoryRows([{ config: '2BHK', allInPrice: '80L' } as InventoryImportRow]);
    expect(errors).toEqual([{ row: 1, reason: 'Missing project name or locality' }]);
  });

  it('errors on a unit row without a valid price', () => {
    const { projects, errors } = normalizeInventoryRows([
      { projectName: 'Skyline', locality: 'Baner', config: '2BHK' },
    ]);
    expect(errors[0]!.row).toBe(1);
    expect(errors[0]!.reason).toMatch(/missing an all-in price/);
    // The project is still captured even though its unit was rejected.
    expect(projects).toHaveLength(1);
    expect(projects[0]!.units).toHaveLength(0);
  });

  it('reports the offending value when a unit price is present but unparseable', () => {
    // Distinct from the missing-price message: the broker typed something, and
    // the error has to echo it back or the row is impossible to find in a
    // thousand-line sheet.
    const { projects, errors } = normalizeInventoryRows([
      { projectName: 'Skyline', locality: 'Baner', config: '2BHK', allInPrice: 'ask us' },
    ]);
    expect(errors).toEqual([{ row: 1, reason: 'Invalid unit price: "ask us"' }]);
    expect(projects[0]!.units).toHaveLength(0);
  });

  it('carries optional unit attributes through when present', () => {
    const { projects, errors } = normalizeInventoryRows([
      {
        projectName: 'Skyline',
        locality: 'Baner',
        config: '2BHK',
        allInPrice: '85L',
        carpetSqft: '1,150',
        floor: 7,
        facing: '  East  ',
      },
    ]);
    expect(errors).toHaveLength(0);
    const unit = projects[0]!.units[0]!;
    expect(unit.carpetSqft).toBe(1150);
    expect(unit.floor).toBe(7);
    expect(unit.facing).toBe('East');
  });

  it('omits optional unit attributes that are absent or unparseable', () => {
    const { projects } = normalizeInventoryRows([
      {
        projectName: 'Skyline',
        locality: 'Baner',
        config: '2BHK',
        allInPrice: '85L',
        carpetSqft: 'TBD',
        facing: '   ',
      },
    ]);
    const unit = projects[0]!.units[0]!;
    expect(unit).not.toHaveProperty('carpetSqft');
    expect(unit).not.toHaveProperty('floor');
    expect(unit).not.toHaveProperty('facing');
    expect(unit).not.toHaveProperty('availability');
  });

  it('accepts a floor of zero rather than dropping it as falsy', () => {
    // Ground floor is a real floor. A `? :` on the value instead of a null
    // check would silently lose it.
    const { projects } = normalizeInventoryRows([
      { projectName: 'Skyline', locality: 'Baner', config: '2BHK', allInPrice: '85L', floor: 0 },
    ]);
    expect(projects[0]!.units[0]!.floor).toBe(0);
  });

  it('accepts and upper-cases a valid project status', () => {
    const { projects, errors } = normalizeInventoryRows([
      { projectName: 'Skyline', locality: 'Baner', projectStatus: '  uc  ' },
    ]);
    expect(errors).toHaveLength(0);
    expect(projects[0]!.status).toBe(ProjectStatus.UC);
  });

  it('normalises a valid possession date to ISO', () => {
    const { projects, errors } = normalizeInventoryRows([
      { projectName: 'Skyline', locality: 'Baner', possessionDate: '2027-06-30' },
    ]);
    expect(errors).toHaveLength(0);
    expect(projects[0]!.possessionDate).toBe(new Date('2027-06-30').toISOString());
  });

  it('errors on an unparseable possession date', () => {
    const { projects, errors } = normalizeInventoryRows([
      { projectName: 'Skyline', locality: 'Baner', possessionDate: 'next Diwali' },
    ]);
    expect(errors).toEqual([{ row: 1, reason: 'Invalid possession date: "next Diwali"' }]);
    // The row is rejected outright — no half-built project is emitted.
    expect(projects).toHaveLength(0);
  });

  it('rejects invalid enum values', () => {
    const bad = normalizeInventoryRows([
      { projectName: 'A', locality: 'B', projectStatus: 'NOPE' },
    ]);
    expect(bad.errors[0]!.reason).toMatch(/Invalid project status/);

    const badAvail = normalizeInventoryRows([
      { projectName: 'A', locality: 'B', config: '2BHK', allInPrice: '80L', availability: 'MAYBE' },
    ]);
    expect(badAvail.errors[0]!.reason).toMatch(/Invalid availability/);
  });
});
