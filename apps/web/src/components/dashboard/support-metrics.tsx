'use client';

import { Clock, Inbox, Smile, Target } from 'lucide-react';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { ErrorState } from '@/components/ui/states';
import { useConversationQuality } from '@/hooks/use-analytics';
import { formatDuration } from '@/lib/format';
import type { ConversationQuality } from '@/lib/feature-types';

/**
 * Satisfaction tile copy. The API pools real ratings with a proxy inferred
 * from escalations, SLA breaches and resolution time; the hint says how much
 * of the number is each, so a 4.6 built on two ratings and 300 estimates is
 * not read as 300 happy customers.
 */
export function describeCsat(csat: ConversationQuality['csat'] | undefined): { value: string; hint: string } {
  if (!csat || csat.combinedAverage === null || csat.combinedSampled === 0) {
    return { value: '—', hint: 'No resolved tickets yet' };
  }
  const value = `${csat.combinedAverage.toFixed(1)} / 5`;
  if (csat.proxySampled === 0) return { value, hint: `${csat.explicitResponses} customer ratings` };
  if (csat.explicitResponses === 0) return { value, hint: `Estimated from ${csat.proxySampled} resolved tickets` };
  return { value, hint: `${csat.explicitResponses} rated · ${csat.proxySampled} estimated` };
}

/** Helpdesk headline numbers for the last 30 days (the endpoint's default range). */
export function SupportMetrics() {
  const q = useConversationQuality();
  const d = q.data;

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const csat = describeCsat(d?.csat);
  const waiting = d ? d.volume.pendingHuman + d.volume.escalated : 0;

  return (
    <section aria-labelledby="support-metrics-title">
      <h2 id="support-metrics-title" className="mb-3 font-mono text-xs uppercase tracking-wider text-muted-foreground">
        Support desk · last 30 days
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Open tickets"
          value={String(d?.volume.open ?? 0)}
          hint={waiting > 0 ? `${waiting} waiting on a person` : 'None waiting on a person'}
          icon={Inbox}
          iconClassName="bg-accent text-accent-foreground"
          loading={q.isLoading}
        />
        <KpiCard
          label="Avg first response"
          value={formatDuration((d?.responseTime.avgFirstResponseSeconds ?? 0) * 1000)}
          hint={
            d && d.responseTime.sampleSize > 0
              ? `90% within ${formatDuration(d.responseTime.p90FirstResponseSeconds * 1000)}`
              : 'No replies yet'
          }
          icon={Clock}
          iconClassName="bg-sky-500/15 text-sky-400"
          loading={q.isLoading}
        />
        <KpiCard
          label="Satisfaction"
          value={csat.value}
          hint={csat.hint}
          icon={Smile}
          iconClassName="bg-emerald-500/15 text-emerald-400"
          loading={q.isLoading}
        />
        <KpiCard
          label="Resolution rate"
          value={d ? `${Math.round(d.resolutionRate)}%` : '—'}
          hint={d ? `${d.volume.resolved} of ${d.volume.created} resolved` : undefined}
          icon={Target}
          iconClassName="bg-violet-500/15 text-violet-400"
          loading={q.isLoading}
        />
      </div>
    </section>
  );
}
