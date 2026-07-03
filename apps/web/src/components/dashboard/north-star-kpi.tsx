'use client';

import { Footprints, Target } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useLeads, useSiteVisits } from '@/hooks/use-realty';
import { NORTH_STAR_GOAL, visitsPer100Leads } from '@/lib/realty-ui';
import { cn } from '@/lib/utils';

/**
 * North Star KPI — site visits per 100 leads, the single conversion metric that
 * best predicts a healthy real-estate desk. Rendered larger and more prominent
 * than the standard KPI row, with a target indicator against the ≥8 goal.
 *
 * Totals are read from the leads and site-visit list endpoints (limit=1, so we
 * only pull the pagination totals). Hidden entirely for non-realty tenants
 * where those endpoints error.
 */
export function NorthStarKpi() {
  const leadsQ = useLeads({ limit: 1 });
  const visitsQ = useSiteVisits({ limit: 1 });

  if (leadsQ.isError || visitsQ.isError) return null;

  const totalLeads = leadsQ.data?.pagination.total ?? 0;
  const totalVisits = visitsQ.data?.total ?? 0;
  const ratio = visitsPer100Leads(totalVisits, totalLeads);
  const onTarget = ratio >= NORTH_STAR_GOAL;
  const loading = leadsQ.isLoading || visitsQ.isLoading;
  const progress = Math.min(100, Math.round((ratio / NORTH_STAR_GOAL) * 100));

  return (
    <Card className="border-accent/40 bg-accent/5 p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <Footprints className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-accent">North Star</p>
              <p className="text-sm font-medium text-muted-foreground">Site visits per 100 leads</p>
            </div>
          </div>

          {loading ? (
            <Skeleton className="mt-4 h-12 w-28" />
          ) : (
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-5xl font-bold tracking-tight tabular-nums">{ratio.toFixed(1)}</span>
              <span className="text-sm text-muted-foreground">
                {totalVisits} visit{totalVisits === 1 ? '' : 's'} · {totalLeads} lead
                {totalLeads === 1 ? '' : 's'}
              </span>
            </div>
          )}
        </div>

        {/* Target indicator */}
        <div className="sm:w-56">
          <div className="flex items-center justify-between">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold',
                onTarget ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700',
              )}
            >
              <Target className="h-3.5 w-3.5" />
              Goal ≥ {NORTH_STAR_GOAL}
            </span>
            {!loading && (
              <span className={cn('text-xs font-medium', onTarget ? 'text-emerald-600' : 'text-amber-600')}>
                {onTarget ? 'On target' : 'Below target'}
              </span>
            )}
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all', onTarget ? 'bg-emerald-500' : 'bg-amber-400')}
              style={{ width: `${loading ? 0 : progress}%` }}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
