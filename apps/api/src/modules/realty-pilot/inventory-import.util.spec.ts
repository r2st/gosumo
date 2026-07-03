/**
 * Pure inventory-import tests (Phase 8). Verifies project grouping, rupee→paise
 * parsing (plain / grouped / lakh / crore), validation, and 1-based row errors.
 */

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
