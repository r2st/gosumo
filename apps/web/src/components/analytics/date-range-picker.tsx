'use client';

import { useState } from 'react';
import { Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Granularity } from '@/lib/feature-types';

export type RangePreset = 'today' | '7d' | '30d' | '90d' | 'custom';

export interface DateRange {
  from: string; // ISO
  to: string; // ISO
  preset: RangePreset;
  granularity: Granularity;
}

const PRESETS: { key: RangePreset; label: string; days: number }[] = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function granularityFor(preset: RangePreset, fromIso?: string, toIso?: string): Granularity {
  if (preset === 'today') return 'HOUR';
  if (preset === '90d') return 'WEEK';
  if (preset === 'custom' && fromIso && toIso) {
    const days = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86_400_000;
    if (days <= 2) return 'HOUR';
    if (days > 60) return 'WEEK';
  }
  return 'DAY';
}

export function buildRange(preset: RangePreset, custom?: { from: string; to: string }): DateRange {
  if (preset === 'custom' && custom) {
    const from = startOfDay(new Date(custom.from)).toISOString();
    const to = new Date(new Date(custom.to).setHours(23, 59, 59, 999)).toISOString();
    return { from, to, preset, granularity: granularityFor('custom', from, to) };
  }
  const found = PRESETS.find((p) => p.key === preset) ?? PRESETS[2];
  const now = new Date();
  const to = now.toISOString();
  const from =
    found.days === 0
      ? startOfDay(now).toISOString()
      : startOfDay(new Date(now.getTime() - found.days * 86_400_000)).toISOString();
  return { from, to, preset, granularity: granularityFor(preset) };
}

export function defaultRange(): DateRange {
  return buildRange('30d');
}

export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const [showCustom, setShowCustom] = useState(value.preset === 'custom');
  const [customFrom, setCustomFrom] = useState(value.from.slice(0, 10));
  const [customTo, setCustomTo] = useState(value.to.slice(0, 10));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => {
              setShowCustom(false);
              onChange(buildRange(p.key));
            }}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              value.preset === p.key && !showCustom
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setShowCustom((v) => !v)}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            value.preset === 'custom' || showCustom
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Calendar className="h-3.5 w-3.5" /> Custom
        </button>
      </div>

      {showCustom && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5">
          <input
            type="date"
            value={customFrom}
            max={customTo}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="bg-transparent text-sm outline-none"
          />
          <span className="text-muted-foreground">–</span>
          <input
            type="date"
            value={customTo}
            min={customFrom}
            onChange={(e) => setCustomTo(e.target.value)}
            className="bg-transparent text-sm outline-none"
          />
          <button
            onClick={() => onChange(buildRange('custom', { from: customFrom, to: customTo }))}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
