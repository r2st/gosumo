'use client';

import { cn } from '@/lib/utils';
import { formatDateIST } from '@/lib/format';

/** Compact axis label for a time-series date, e.g. "27 Jun". */
export function shortDate(value: string): string {
  try {
    return formatDateIST(value).replace(/ \d{4}$/, '');
  } catch {
    return value;
  }
}

/** Categorical palette built from theme tokens + a few fixed accents. */
export const SERIES_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--success))',
  'hsl(var(--warning))',
  'hsl(var(--danger))',
  '#0ea5e9',
  '#8b5cf6',
  '#14b8a6',
  '#ec4899',
];

export const CHANNEL_COLORS: Record<string, string> = {
  WHATSAPP: '#25D366',
  INSTAGRAM: '#E1306C',
  SMS: '#0ea5e9',
  WEB_CHAT: 'hsl(var(--primary))',
  EMAIL: '#f59e0b',
};

export const CHURN_COLORS = { low: 'hsl(var(--success))', medium: 'hsl(var(--warning))', high: 'hsl(var(--danger))' };

/** Recharts tooltip content styling, matching the dashboard charts. */
export const tooltipStyle = {
  borderRadius: 8,
  border: '1px solid hsl(var(--border))',
  fontSize: 12,
  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
  backgroundColor: 'hsl(var(--card))',
  color: 'hsl(var(--foreground))',
};

export const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const;
export const axisProps = { tick: AXIS, tickLine: false, axisLine: false } as const;

/** Normalise an autonomy/confidence value that may be a 0-1 ratio or 0-100 percent. */
export function toPct(value: number | undefined | null): number {
  if (value == null || Number.isNaN(value)) return 0;
  return value <= 1 ? value * 100 : value;
}

export function LegendDot({
  color,
  label,
  value,
  className,
}: {
  color: string;
  label: string;
  value?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2 text-sm', className)}>
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-muted-foreground">{label}</span>
      {value && <span className="ml-auto font-medium text-foreground">{value}</span>}
    </div>
  );
}

/** A labelled horizontal bar, used for top-N lists (intents, reasons, channels). */
export function MeterBar({
  label,
  valueLabel,
  fraction,
  color = 'hsl(var(--primary))',
}: {
  label: string;
  valueLabel: string;
  fraction: number; // 0-1
  color?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">{valueLabel}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${Math.max(3, fraction * 100)}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}
