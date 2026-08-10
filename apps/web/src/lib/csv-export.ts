import { paiseToRupees } from '@/lib/format';
import type { Lead } from '@/lib/realty-types';

/** A single CSV column: a header plus how to pull its cell value from a row. */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/** Escape one CSV cell per RFC 4180 — quote when it contains a comma, quote, or newline. */
function escapeCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert an array of objects into an RFC 4180 CSV string. A leading UTF-8 BOM is
 * prepended so Excel opens non-ASCII text (₹, Hindi localities) with the right encoding.
 */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((c) => escapeCell(c.header)).join(',');
  const body = rows.map((row) => columns.map((c) => escapeCell(c.value(row))).join(','));
  return '﻿' + [header, ...body].join('\r\n');
}

/** Trigger a browser download of `content` as a file named `filename`. No-op on the server. */
export function downloadCsv(filename: string, content: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Render a lead's budget range as a human-readable rupee string for export. */
function formatBudget(lead: Lead): string {
  const { budgetMinPaise, budgetMaxPaise } = lead.bltc;
  if (budgetMinPaise == null && budgetMaxPaise == null) return '';
  if (budgetMinPaise != null && budgetMaxPaise != null) {
    return `${paiseToRupees(budgetMinPaise)} - ${paiseToRupees(budgetMaxPaise)}`;
  }
  return paiseToRupees(budgetMinPaise ?? budgetMaxPaise);
}

/** Columns for the leads export, matching the spec order. */
export const LEAD_CSV_COLUMNS: CsvColumn<Lead>[] = [
  { header: 'Name', value: (l) => l.name },
  { header: 'Phone', value: (l) => l.whatsappPhone },
  { header: 'Email', value: (l) => l.email },
  { header: 'Source', value: (l) => l.source },
  { header: 'Stage', value: (l) => l.stage },
  { header: 'Temperature', value: (l) => l.temperature },
  { header: 'Qual Score', value: (l) => l.qualScore },
  { header: 'Budget', value: (l) => formatBudget(l) },
  { header: 'Localities', value: (l) => l.bltc.localities.join('; ') },
  { header: 'Timeline (months)', value: (l) => l.bltc.timelineMonths },
  { header: 'Created At', value: (l) => l.createdAt },
];

/** Serialize a list of leads to CSV. */
export function leadsToCsv(leads: Lead[]): string {
  return toCsv(leads, LEAD_CSV_COLUMNS);
}
