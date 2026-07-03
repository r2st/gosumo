'use client';

import { useMemo } from 'react';
import { Award, PieChart } from 'lucide-react';
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { axisProps, SERIES_COLORS, tooltipStyle } from '@/components/analytics/chart-kit';
import { useLeads, useSiteVisits } from '@/hooks/use-realty';
import type { DateRange } from '@/components/analytics/date-range-picker';
import { formatNumber, paiseToRupees } from '@/lib/format';
import { LEAD_STAGES, type Lead, type LeadStage } from '@/lib/realty-types';
import { cn } from '@/lib/utils';

/** The seven reporting buckets, in display order. */
const SOURCE_KEYS = [
  '99acres',
  'MagicBricks',
  'Housing',
  'Meta Ads',
  'Direct',
  'Referral',
  'IVR',
] as const;
type SourceKey = (typeof SOURCE_KEYS)[number];

/**
 * Estimated blended acquisition cost per lead, in paise. Portals and paid ads
 * carry media spend; organic channels (direct / referral) are effectively free.
 * These are planning estimates — the platform does not yet track spend per lead.
 */
const SOURCE_COST_PER_LEAD_PAISE: Record<SourceKey, number> = {
  '99acres': 65_000, // ₹650
  MagicBricks: 55_000, // ₹550
  Housing: 45_000, // ₹450
  'Meta Ads': 28_000, // ₹280
  Direct: 0,
  Referral: 0,
  IVR: 12_000, // ₹120 telephony
};

/** A lead is "qualified" once it reaches QUALIFIED or any later stage. */
const QUALIFIED_INDEX = LEAD_STAGES.indexOf('QUALIFIED');
function isQualified(stage: LeadStage): boolean {
  const i = LEAD_STAGES.indexOf(stage);
  // CLOSED_LOST / DORMANT sit after CLOSED_WON in the enum but aren't "qualified
  // and progressing"; restrict to the forward run QUALIFIED..CLOSED_WON.
  return i >= QUALIFIED_INDEX && i <= LEAD_STAGES.indexOf('CLOSED_WON');
}

/** Map a raw lead onto one of the seven reporting buckets. */
function bucketOf(lead: Lead): SourceKey {
  switch (lead.source) {
    case 'PORTAL': {
      const sub = (lead.subSource ?? '').toLowerCase();
      if (sub.includes('magic')) return 'MagicBricks';
      if (sub.includes('housing')) return 'Housing';
      return '99acres'; // 99acres + any unlabelled portal
    }
    case 'META_LEAD_AD':
      return 'Meta Ads';
    case 'IVR':
      return 'IVR';
    case 'REFERRAL':
    case 'EXCHANGE_INBOUND':
      return 'Referral';
    case 'CTWA':
    case 'WALK_IN':
    case 'MANUAL':
    case 'CSV':
    default:
      return 'Direct';
  }
}

interface SourceRow {
  key: SourceKey;
  total: number;
  qualified: number;
  visits: number;
  costPerQualifiedPaise: number | null;
}

export function SourceRoiSection({ range }: { range: DateRange }) {
  const leadsQ = useLeads({ limit: 200 });
  const visitsQ = useSiteVisits({ from: range.from, to: range.to, limit: 200 });

  const rows = useMemo<SourceRow[]>(() => {
    const leads = leadsQ.data?.data ?? [];
    const visits = visitsQ.data?.data ?? [];

    const bucketByLead = new Map<string, SourceKey>();
    const base = SOURCE_KEYS.reduce(
      (acc, key) => ({ ...acc, [key]: { total: 0, qualified: 0, visits: 0 } }),
      {} as Record<SourceKey, { total: number; qualified: number; visits: number }>,
    );

    for (const lead of leads) {
      const key = bucketOf(lead);
      bucketByLead.set(lead.id, key);
      base[key].total += 1;
      if (isQualified(lead.stage)) base[key].qualified += 1;
    }
    for (const visit of visits) {
      const key = bucketByLead.get(visit.leadId);
      if (key) base[key].visits += 1;
    }

    return SOURCE_KEYS.map((key) => {
      const { total, qualified, visits: visitCount } = base[key];
      const costPerQualifiedPaise =
        qualified > 0 ? Math.round((total * SOURCE_COST_PER_LEAD_PAISE[key]) / qualified) : null;
      return { key, total, qualified, visits: visitCount, costPerQualifiedPaise };
    });
  }, [leadsQ.data, visitsQ.data]);

  const isError = leadsQ.isError || visitsQ.isError;
  const isLoading = leadsQ.isLoading || visitsQ.isLoading;

  // Best source: lowest cost per qualified lead among sources that actually
  // produced qualified leads; ties broken by the larger qualified volume.
  const best = useMemo(() => {
    const eligible = rows.filter((r) => r.costPerQualifiedPaise != null);
    if (eligible.length === 0) return null;
    return eligible.reduce((a, b) => {
      const ca = a.costPerQualifiedPaise ?? Infinity;
      const cb = b.costPerQualifiedPaise ?? Infinity;
      if (cb !== ca) return cb < ca ? b : a;
      return b.qualified > a.qualified ? b : a;
    });
  }, [rows]);

  if (isError)
    return (
      <ErrorState
        onRetry={() => {
          void leadsQ.refetch();
          void visitsQ.refetch();
        }}
      />
    );
  if (isLoading) return <Skeleton className="h-96 w-full" />;

  const totalLeads = rows.reduce((sum, r) => sum + r.total, 0);
  if (totalLeads === 0)
    return (
      <EmptyState
        icon={PieChart}
        title="No leads to compare yet"
        description="Once leads arrive from portals, ads, referrals and IVR, source performance will break down here."
      />
    );

  const chartData = rows.map((r) => ({
    label: r.key,
    Total: r.total,
    Qualified: r.qualified,
    Visits: r.visits,
  }));

  return (
    <div className="space-y-4">
      {best && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 py-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
              <Award className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">
                Best ROI: {best.key}
              </p>
              <p className="text-xs text-muted-foreground">
                {best.costPerQualifiedPaise === 0
                  ? 'Free channel — every qualified lead at zero media cost'
                  : `${paiseToRupees(best.costPerQualifiedPaise)} per qualified lead`}{' '}
                · {formatNumber(best.qualified)} qualified from {formatNumber(best.total)} leads
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Lead sources — volume &amp; quality</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                layout="vertical"
                data={chartData}
                margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
                barCategoryGap={12}
              >
                <XAxis type="number" allowDecimals={false} {...axisProps} />
                <YAxis type="category" dataKey="label" width={82} {...axisProps} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'hsl(var(--muted) / 0.5)' }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Total" fill={SERIES_COLORS[0]} radius={[0, 3, 3, 0]}>
                  {chartData.map((d) => (
                    <Cell
                      key={d.label}
                      fill={best && d.label === best.key ? 'hsl(var(--success))' : SERIES_COLORS[0]}
                    />
                  ))}
                </Bar>
                <Bar dataKey="Qualified" fill={SERIES_COLORS[1]} radius={[0, 3, 3, 0]} />
                <Bar dataKey="Visits" fill={SERIES_COLORS[4]} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Source economics</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Source</TH>
                <TH className="text-right">Leads</TH>
                <TH className="text-right">Qualified</TH>
                <TH className="text-right">Visits</TH>
                <TH className="text-right">Cost / qualified</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => {
                const isBest = best?.key === r.key;
                return (
                  <TR key={r.key} className={cn(isBest && 'bg-emerald-50/60 dark:bg-emerald-500/5')}>
                    <TD className="font-medium">
                      <span className="flex items-center gap-2">
                        {r.key}
                        {isBest && <Badge tone="success">Best ROI</Badge>}
                      </span>
                    </TD>
                    <TD className="text-right">{formatNumber(r.total)}</TD>
                    <TD className="text-right">{formatNumber(r.qualified)}</TD>
                    <TD className="text-right">{formatNumber(r.visits)}</TD>
                    <TD className="text-right font-medium">
                      {r.costPerQualifiedPaise == null
                        ? '—'
                        : r.costPerQualifiedPaise === 0
                          ? 'Free'
                          : paiseToRupees(r.costPerQualifiedPaise)}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          <p className="px-5 py-3 text-[11px] text-muted-foreground">
            Cost per qualified lead uses estimated per-source media spend; organic channels (Direct,
            Referral) carry no media cost.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
