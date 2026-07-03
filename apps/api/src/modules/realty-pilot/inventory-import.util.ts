/**
 * Pilot inventory-import helpers (pure, unit-tested).
 *
 * Broker inventory spreadsheets are almost always "one row per unit": each line
 * repeats the project (name / locality / RERA / price band) and adds a single
 * unit (config / area / price / availability). This normalizer groups those
 * rows back into projects-with-units, validates each field, and converts rupee
 * prices to integer paise (root rule #4) — ready for the migration service to
 * commit via `RealtyInventoryService`. Rows without a usable project identity or
 * a priced unit become 1-based errors (never silently dropped).
 */

import { currencyToPaise, ProjectStatus, UnitAvailability } from '@gosumo/shared';
import type {
  InventoryImportRow,
  NormalizedInventoryProject,
  NormalizedInventoryUnit,
  MigrationRowError,
} from '@gosumo/shared';

const PROJECT_STATUSES = new Set<string>(Object.values(ProjectStatus));
const UNIT_AVAILABILITIES = new Set<string>(Object.values(UnitAvailability));

/**
 * Parse a rupee amount that may be a plain number, a comma-grouped string
 * ("85,00,000"), or carry a lakh/crore suffix ("85L", "1.2 Cr"). Returns null
 * for anything unparseable or non-positive.
 */
export function parseRupees(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;

  const cleaned = value.toString().trim().toLowerCase().replace(/₹/g, '').replace(/,/g, '').replace(/\s+/g, ' ').trim();
  const match = cleaned.match(/^([\d.]+)\s*(l|lac|lacs|lakh|lakhs|cr|crore|crores)?$/);
  if (!match) return null;
  const num = parseFloat(match[1]!);
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = match[2];
  if (!unit) return num;
  if (unit.startsWith('l')) return num * 100000; // lakh
  return num * 10000000; // crore
}

function parseInteger(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number' ? value : parseInt(value.toString().replace(/[,\s]/g, ''), 10);
  return Number.isFinite(num) ? num : null;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.toString().trim();
  return trimmed ? trimmed : undefined;
}

/** Stable grouping key: a project is identified by name + locality (case/space-insensitive). */
function projectKey(name: string, locality: string): string {
  return `${name.toLowerCase().replace(/\s+/g, ' ').trim()}|${locality.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

/**
 * Normalize raw inventory rows into projects-with-units + a 1-based error list.
 * Preserves first-seen project order.
 */
export function normalizeInventoryRows(rows: InventoryImportRow[]): {
  projects: NormalizedInventoryProject[];
  errors: MigrationRowError[];
} {
  const byKey = new Map<string, NormalizedInventoryProject>();
  const order: string[] = [];
  const errors: MigrationRowError[] = [];

  rows.forEach((row, idx) => {
    const rowNumber = idx + 1;
    const name = clean(row.projectName);
    const locality = clean(row.locality);

    if (!name || !locality) {
      errors.push({ row: rowNumber, reason: 'Missing project name or locality' });
      return;
    }

    // Optional project-status validation.
    let status: string | undefined;
    if (row.projectStatus) {
      const s = row.projectStatus.toString().trim().toUpperCase();
      if (!PROJECT_STATUSES.has(s)) {
        errors.push({ row: rowNumber, reason: `Invalid project status: "${row.projectStatus}"` });
        return;
      }
      status = s;
    }

    // Optional possession date validation.
    let possessionDate: string | undefined;
    if (row.possessionDate) {
      const t = Date.parse(row.possessionDate);
      if (Number.isNaN(t)) {
        errors.push({ row: rowNumber, reason: `Invalid possession date: "${row.possessionDate}"` });
        return;
      }
      possessionDate = new Date(t).toISOString();
    }

    const key = projectKey(name, locality);
    let project = byKey.get(key);
    if (!project) {
      const priceBandMin = parseRupees(row.priceBandMin);
      const priceBandMax = parseRupees(row.priceBandMax);
      project = {
        name,
        developer: clean(row.developer),
        locality,
        reraNumber: clean(row.reraNumber),
        possessionDate,
        status,
        ...(priceBandMin != null ? { priceBandMinPaise: currencyToPaise(priceBandMin) } : {}),
        ...(priceBandMax != null ? { priceBandMaxPaise: currencyToPaise(priceBandMax) } : {}),
        units: [],
      };
      byKey.set(key, project);
      order.push(key);
    }

    // A unit is present iff a config is given. A project-only row is valid.
    const config = clean(row.config);
    if (!config) return;

    const rupees = parseRupees(row.allInPrice);
    if (rupees == null) {
      errors.push({
        row: rowNumber,
        reason: row.allInPrice
          ? `Invalid unit price: "${row.allInPrice}"`
          : `Unit "${config}" is missing an all-in price`,
      });
      return;
    }

    let availability: string | undefined;
    if (row.availability) {
      const a = row.availability.toString().trim().toUpperCase();
      if (!UNIT_AVAILABILITIES.has(a)) {
        errors.push({ row: rowNumber, reason: `Invalid availability: "${row.availability}"` });
        return;
      }
      availability = a;
    }

    const unit: NormalizedInventoryUnit = {
      config,
      allInPricePaise: currencyToPaise(rupees),
      ...(parseInteger(row.carpetSqft) != null ? { carpetSqft: parseInteger(row.carpetSqft)! } : {}),
      ...(parseInteger(row.floor) != null ? { floor: parseInteger(row.floor)! } : {}),
      ...(clean(row.facing) ? { facing: clean(row.facing) } : {}),
      ...(availability ? { availability } : {}),
    };
    project.units.push(unit);
  });

  return { projects: order.map((k) => byKey.get(k)!), errors };
}
