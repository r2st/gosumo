'use client';

import { Users } from 'lucide-react';
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useClientReport } from '@/hooks/use-analytics';
import type { DateRange } from '@/components/analytics/date-range-picker';
import { CHANNEL_COLORS, CHURN_COLORS, LegendDot, axisProps, shortDate, tooltipStyle } from '@/components/analytics/chart-kit';
import { channelLabel } from '@/components/channel-icon';
import { formatDateIST, formatNumber, humanizeEnum, paiseToRupees } from '@/lib/format';

export function ClientsSection({ range }: { range: DateRange }) {
  const { data, isLoading, isError, error, refetch } = useClientReport(range);

  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!data) return <EmptyState icon={Users} title="No client data" />;

  const churnTotal = data.churnRiskBreakdown.low + data.churnRiskBreakdown.medium + data.churnRiskBreakdown.high;
  const churnRate = churnTotal > 0 ? (data.churnRiskBreakdown.high / churnTotal) * 100 : 0;

  const newVsReturning = [
    { name: 'New', value: data.summary.newClients, color: 'hsl(var(--primary))' },
    { name: 'Returning', value: data.summary.returning, color: '#0ea5e9' },
  ].filter((d) => d.value > 0);

  const channelPrefs = Object.entries(data.channelPreferences ?? {})
    .map(([channel, count]) => ({ channel, label: channelLabel(channel as never), count }))
    .sort((a, b) => b.count - a.count);
  const maxPref = channelPrefs[0]?.count || 1;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Total clients" value={formatNumber(data.summary.total)} icon={Users} />
        <KpiCard label="New clients" value={formatNumber(data.summary.newClients)} icon={Users} hint={`${formatNumber(data.summary.returning)} returning`} />
        <KpiCard label="Avg lifetime value" value={paiseToRupees(data.summary.avgLtv)} icon={Users} />
        <KpiCard label="Churn rate (high)" value={`${churnRate.toFixed(1)}%`} icon={Users} hint={`${formatNumber(data.summary.churnRiskHigh)} clients`} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Client acquisition</CardTitle>
          </CardHeader>
          <CardContent>
            {data.acquisitionTimeSeries.length === 0 ? (
              <EmptyState title="No new clients in this period" className="py-10" />
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.acquisitionTimeSeries} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps} />
                    <YAxis {...axisProps} allowDecimals={false} width={32} />
                    <Tooltip contentStyle={tooltipStyle} labelFormatter={(l) => formatDateIST(String(l))} cursor={{ fill: 'hsl(var(--muted))' }} />
                    <Bar dataKey="newClients" name="New clients" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>New vs returning</CardTitle>
          </CardHeader>
          <CardContent>
            {newVsReturning.length === 0 ? (
              <EmptyState title="No client data" className="py-10" />
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div className="h-40 w-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={newVsReturning} dataKey="value" nameKey="name" innerRadius={44} outerRadius={66} paddingAngle={2}>
                        {newVsReturning.map((d) => (
                          <Cell key={d.name} fill={d.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="w-full space-y-2">
                  {newVsReturning.map((d) => (
                    <LegendDot key={d.name} color={d.color} label={d.name} value={formatNumber(d.value)} />
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Churn risk</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(['high', 'medium', 'low'] as const).map((level) => {
              const value = data.churnRiskBreakdown[level];
              const pct = churnTotal > 0 ? (value / churnTotal) * 100 : 0;
              return (
                <div key={level} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium capitalize text-foreground">{level} risk</span>
                    <span className="text-muted-foreground">
                      {formatNumber(value)} ({pct.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(2, pct)}%`, backgroundColor: CHURN_COLORS[level] }} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Acquisition channels</CardTitle>
          </CardHeader>
          <CardContent>
            {channelPrefs.length === 0 ? (
              <EmptyState title="No channel data" className="py-10" />
            ) : (
              <ul className="space-y-3">
                {channelPrefs.map((c) => (
                  <li key={c.channel} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-foreground">{c.label}</span>
                      <span className="text-muted-foreground">{formatNumber(c.count)}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.max(4, (c.count / maxPref) * 100)}%`, backgroundColor: CHANNEL_COLORS[c.channel] ?? 'hsl(var(--primary))' }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sentiment</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(data.sentimentDistribution ?? {}).length === 0 ? (
              <EmptyState title="No sentiment data" className="py-10" />
            ) : (
              <ul className="space-y-3">
                {Object.entries(data.sentimentDistribution).map(([label, count]) => (
                  <li key={label} className="flex items-center justify-between text-sm">
                    <span className="font-medium text-foreground">{humanizeEnum(label)}</span>
                    <span className="text-muted-foreground">{formatNumber(count)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
