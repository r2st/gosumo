'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { MessagesSquare } from 'lucide-react';
import { useConversationReportFull } from '@/hooks/use-analytics';
import type { DateRange } from '@/components/analytics/date-range-picker';
import { CHANNEL_COLORS, axisProps, shortDate, tooltipStyle } from '@/components/analytics/chart-kit';
import { channelLabel } from '@/components/channel-icon';
import { formatDateIST, formatDuration, formatNumber, humanizeEnum } from '@/lib/format';

export function ConversationsSection({ range }: { range: DateRange }) {
  const { data, isLoading, isError, error, refetch } = useConversationReportFull(range);

  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!data) return <EmptyState icon={MessagesSquare} title="No conversation data" />;

  const channels = data.channelBreakdown.map((c) => ({ ...c, label: channelLabel(c.channel) }));
  const maxIntent = data.topIntents[0]?.count || 1;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Total conversations" value={formatNumber(data.summary.total)} icon={MessagesSquare} />
        <KpiCard label="Avg resolution" value={formatDuration(data.summary.avgResolutionTimeMs)} icon={MessagesSquare} />
        <KpiCard label="Avg first response" value={formatDuration(data.summary.avgFirstResponseTimeMs)} icon={MessagesSquare} />
        <KpiCard label="CSAT" value={data.summary.csat != null ? `${data.summary.csat.toFixed(1)}/5` : '—'} icon={MessagesSquare} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Conversation volume</CardTitle>
        </CardHeader>
        <CardContent>
          {data.timeSeries.length === 0 ? (
            <EmptyState title="No conversations in this period" className="py-12" />
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.timeSeries} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="cvCreated" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="cvResolved" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--success))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--success))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps} />
                  <YAxis {...axisProps} allowDecimals={false} width={32} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={(l) => formatDateIST(String(l))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="created" name="Created" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#cvCreated)" />
                  <Area type="monotone" dataKey="resolved" name="Resolved" stroke="hsl(var(--success))" strokeWidth={2} fill="url(#cvResolved)" />
                  <Area type="monotone" dataKey="escalated" name="Escalated" stroke="hsl(var(--warning))" strokeWidth={2} fillOpacity={0} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By channel</CardTitle>
          </CardHeader>
          <CardContent>
            {channels.length === 0 ? (
              <EmptyState title="No channel data" className="py-10" />
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={channels} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                    <XAxis type="number" {...axisProps} allowDecimals={false} />
                    <YAxis type="category" dataKey="label" {...axisProps} width={80} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'hsl(var(--muted))' }} />
                    <Bar dataKey="count" name="Conversations" radius={[0, 4, 4, 0]}>
                      {channels.map((c) => (
                        <Cell key={c.channel} fill={CHANNEL_COLORS[c.channel] ?? 'hsl(var(--primary))'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top intents</CardTitle>
          </CardHeader>
          <CardContent>
            {data.topIntents.length === 0 ? (
              <EmptyState title="No intents detected" className="py-10" />
            ) : (
              <ul className="space-y-3">
                {data.topIntents.slice(0, 8).map((intent) => (
                  <li key={intent.intent} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-foreground">{humanizeEnum(intent.intent)}</span>
                      <span className="text-muted-foreground">{formatNumber(intent.count)}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.max(4, (intent.count / maxIntent) * 100)}%` }}
                      />
                    </div>
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
