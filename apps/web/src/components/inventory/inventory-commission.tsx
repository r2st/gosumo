'use client';

import { EyeOff } from 'lucide-react';
import { paiseToRupees } from '@/lib/format';
import type { CommissionTerms } from '@/lib/realty-types';

/** camelCase / snake_case key → "Title Case" label. */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Format one commission-terms value, honouring paise (`*Paise`) and percent (`pct`/`*Pct`) keys. */
function formatValue(key: string, value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'number') {
    if (/paise$/i.test(key)) return paiseToRupees(value);
    if (key === 'pct' || /(pct|percent)$/i.test(key)) return `${value}%`;
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.every((v) => typeof v !== 'object')
      ? value.join(', ')
      : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

/** `flatPaise` → label "Flat" (drop the paise suffix, it's rendered as rupees). */
function labelFor(key: string): string {
  return humanizeKey(key.replace(/Paise$/i, ''));
}

/**
 * CP commission terms — BROKER-ONLY. This surface is the broker console, so the
 * private commission terms are shown here; they are never sent to buyers or the
 * AI. Renders the free-form JSON generically so any recorded shape displays.
 */
export function InventoryCommission({ terms }: { terms: CommissionTerms }) {
  const entries = Object.entries(terms ?? {}).filter(([, v]) => v != null && v !== '');

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No commission terms recorded for this project yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {entries.map(([key, value]) => (
          <div key={key} className="flex flex-col">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              {labelFor(key)}
            </dt>
            <dd className="text-sm font-medium">{formatValue(key, value)}</dd>
          </div>
        ))}
      </dl>
      <p className="flex items-center gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
        <EyeOff className="h-3.5 w-3.5" />
        Broker-only — never shown to buyers or quoted by the AI.
      </p>
    </div>
  );
}
