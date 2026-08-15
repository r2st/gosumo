'use client';

import { Bot } from 'lucide-react';
import {
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Gauge } from '@/components/charts/gauge';
import { useAutonomyReport } from '@/hooks/use-analytics';
import type { DateRange } from '@/components/analytics/date-range-picker';
import { axisProps, shortDate, toPct, tooltipStyle } from '@/components/analytics/chart-kit';
import { formatDateIST, formatNumber, formatRatioPct, humanizeEnum } from '@/lib/format';

/** Colour each confidence bucket by the routing band its lower bound falls into. */
function bucketColor(bucket: string): string {
  const lower = parseInt(bucket.split('-')[0] ?? '0', 10);
  if (lower >= 90) return 'hsl(var(--success))';
  if (lower >= 70) return 'hsl(var(--primary))';
  return 'hsl(var(--warning))';
}

export function AiSection({ range }: { range: DateRange }) {
  const { data, isLoading, isError, error, refetch } = useAutonomyReport(range);

  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!data) return <EmptyState icon={Bot} title="No AI decisions yet" />;

  const trend = data.timeSeries.map((p) => ({ date: p.date, autonomyRate: toPct(p.autonomyRate) }));
  const maxReason = data.topEscalationReasons[0]?.count || 1;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>AI autonomy rate</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center">
            <Gauge value={toPct(data.summary.autonomyRate)} label="handled without humans" />
            <div className="mt-2 grid w-full grid-cols-2 gap-3 text-center">
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-lg font-semibold">{formatNumber(data.summary.totalDecisions)}</p>
                <p className="text-xs text-muted-foreground">AI decisions</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <p className={`text-lg font-semibold ${data.summary.trend >= 0 ? 'text-success' : 'text-danger'}`}>
                  {data.summary.trend >= 0 ? '+' : ''}
                  {data.summary.trend.toFixed(1)}%
                </p>
                <p className="text-xs text-muted-foreground">vs previous</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Confidence distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {data.confidenceDistribution.length === 0 ? (
              <EmptyState title="No AI decisions yet" className="py-10" />
            ) : (
              <>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.confidenceDistribution} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                      <XAxis dataKey="bucket" {...axisProps} />
                      <YAxis {...axisProps} allowDecimals={false} width={32} />
                      <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'hsl(var(--muted))' }} />
                      <Bar dataKey="count" name="Decisions" radius={[4, 4, 0, 0]}>
                        {data.confidenceDistribution.map((d) => (
                          <Cell key={d.bucket} fill={bucketColor(d.bucket)} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 flex flex-wrap gap-4 text-xs">
                  <Legend color="hsl(var(--warning))" label="< 70 · Escalate" />
                  <Legend color="hsl(var(--primary))" label="70–89 · Draft review" />
                  <Legend color="hsl(var(--success))" label="≥ 90 · Auto-execute" />
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Autonomy trend</CardTitle>
        </CardHeader>
        <CardContent>
          {trend.length === 0 ? (
            <EmptyState title="Not enough data for a trend" className="py-10" />
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                  <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps} />
                  <YAxis {...axisProps} domain={[0, 100]} width={36} tickFormatter={(v) => `${v}%`} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={(l) => formatDateIST(String(l))}
                    formatter={(v: number) => [`${v.toFixed(1)}%`, 'Autonomy']}
                  />
                  <Line type="monotone" dataKey="autonomyRate" name="Autonomy rate" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top escalation reasons</CardTitle>
          </CardHeader>
          <CardContent>
            {data.topEscalationReasons.length === 0 ? (
              <EmptyState title="No escalations — nice!" className="py-10" />
            ) : (
              <ul className="space-y-3">
                {data.topEscalationReasons.slice(0, 8).map((r) => (
                  <li key={r.reason} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-foreground">{r.reason}</span>
                      <span className="text-muted-foreground">{formatNumber(r.count)}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-warning" style={{ width: `${Math.max(4, (r.count / maxReason) * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Autonomy by intent</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {data.intentBreakdown.length === 0 ? (
              <EmptyState title="No intent data" className="py-10" />
            ) : (
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Intent</TH>
                    <TH className="text-right">Count</TH>
                    <TH className="text-right">Autonomy</TH>
                    <TH className="text-right">Confidence</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.intentBreakdown.slice(0, 8).map((i) => (
                    <TR key={i.intent}>
                      <TD className="font-medium">{humanizeEnum(i.intent)}</TD>
                      <TD className="text-right">{formatNumber(i.count)}</TD>
                      <TD className="text-right">{formatRatioPct(i.autonomyRate)}</TD>
                      <TD className="text-right text-muted-foreground">{formatRatioPct(i.avgConfidence)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
