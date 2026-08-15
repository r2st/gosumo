'use client';

import { useMemo } from 'react';
import { Filter } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useLeadBoard } from '@/hooks/use-realty';
import { STAGE_LABELS, type LeadStage } from '@/lib/realty-types';
import { formatNumber } from '@/lib/format';

/**
 * The forward buyer journey, in order. Terminal CLOSED_LOST / DORMANT leads drop
 * off the funnel — they represent leakage rather than a stage that is "reached".
 */
const FUNNEL_STAGES: LeadStage[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'VISIT_BOOKED',
  'VISITED',
  'NEGOTIATING',
  'CLOSED_WON',
];

/** Interpolate between two #rrggbb colours; t in [0,1]. */
function lerpColor(from: string, to: string, t: number): string {
  const a = [1, 3, 5].map((i) => parseInt(from.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => parseInt(to.slice(i, i + 2), 16));
  const mix = a.map((c, i) => Math.round(c + (b[i] - c) * t));
  return `#${mix.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// Wide indigo at the top of the funnel → narrow emerald at Closed Won.
const FUNNEL_TOP = '#6366f1'; // indigo-500
const FUNNEL_BOTTOM = '#10b981'; // emerald-500

export function FunnelSection() {
  const { data, isLoading, isError, error, refetch } = useLeadBoard();

  const rows = useMemo(() => {
    const counts: Partial<Record<LeadStage, number>> = {};
    for (const col of data ?? []) counts[col.stage] = col.count;

    // A snapshot of stage occupancy becomes a funnel by cumulating forward: a
    // lead currently in a later stage has, by definition, passed every earlier
    // one. So "reached stage i" = leads sitting at stage i or any later stage.
    const reached = FUNNEL_STAGES.map((_, i) =>
      FUNNEL_STAGES.slice(i).reduce((sum, s) => sum + (counts[s] ?? 0), 0),
    );
    const top = reached[0] || 1;

    return FUNNEL_STAGES.map((stage, i) => {
      const prev = i === 0 ? reached[i] : reached[i - 1];
      const dropOff = prev > 0 ? (prev - reached[i]) / prev : 0;
      return {
        stage,
        label: STAGE_LABELS[stage],
        count: reached[i],
        widthPct: (reached[i] / top) * 100,
        // Next stage's relative width, for the tapering bottom edge.
        nextWidthPct: (reached[Math.min(i + 1, reached.length - 1)] / top) * 100,
        dropOff,
        color: lerpColor(FUNNEL_TOP, FUNNEL_BOTTOM, i / (FUNNEL_STAGES.length - 1)),
        isLast: i === FUNNEL_STAGES.length - 1,
      };
    });
  }, [data]);

  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton className="h-96 w-full" />;

  const total = rows[0]?.count ?? 0;
  if (total === 0)
    return (
      <EmptyState
        icon={Filter}
        title="No leads in the pipeline yet"
        description="As leads are captured and progress through the pipeline, the conversion funnel will build here."
      />
    );

  const closedWon = rows[rows.length - 1]?.count ?? 0;
  const conversion = total > 0 ? (closedWon / total) * 100 : 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-col items-center gap-1 py-6 text-center">
          <p className="text-sm text-muted-foreground">Overall conversion</p>
          <p className="text-3xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
            {conversion.toFixed(1)}%
          </p>
          <p className="text-sm text-muted-foreground">
            {formatNumber(closedWon)} of {formatNumber(total)} leads reach{' '}
            <span className="font-medium text-foreground">Closed Won</span>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lead conversion funnel</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {rows.map((row) => {
            // Centered taper: inset each side of the bottom edge toward the next
            // stage's width, so stacked bars read as a tapering funnel.
            const inset = row.widthPct > 0 ? ((1 - row.nextWidthPct / row.widthPct) / 2) * 100 : 0;
            const clip = row.isLast
              ? undefined
              : `polygon(0 0, 100% 0, ${100 - inset}% 100%, ${inset}% 100%)`;
            return (
              <div
                key={row.stage}
                className="grid grid-cols-[1fr_9rem] items-center gap-3 sm:grid-cols-[1fr_11rem]"
              >
                <div className="flex justify-center">
                  <div
                    className="flex h-11 items-center justify-center rounded-sm transition-all"
                    style={{
                      width: `${Math.max(row.widthPct, 12)}%`,
                      minWidth: 64,
                      backgroundColor: row.color,
                      clipPath: clip,
                    }}
                  >
                    <span className="text-sm font-semibold text-white drop-shadow-sm">
                      {formatNumber(row.count)}
                    </span>
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{row.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.dropOff > 0 ? `▼ ${(row.dropOff * 100).toFixed(0)}% drop-off` : 'Entry stage'}
                  </p>
                </div>
              </div>
            );
          })}
          <p className="pt-2 text-[11px] text-muted-foreground">
            Funnel reflects the current pipeline snapshot; each stage counts leads at that stage or
            beyond. Lost and dormant leads are excluded.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
